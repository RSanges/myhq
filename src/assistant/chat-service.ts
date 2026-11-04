import path from "node:path";
import { decideApproval, decisionSchema } from "../server/approvals";
import { publishChat, type ChatTurnState } from "../server/chat-hub";
import {
  chatTranscript,
  clearChatHistory,
  recordChatMessage,
  type ChatChannel,
  type ChatMessageDto,
  type ChatRole,
  type ChatTarget,
} from "../server/chat-history";
import { getConfig, type Env, type HqConfig } from "../server/config";
import { getDbAt, type Db, type RunRow } from "../server/db";
import { ZERO_USAGE } from "../server/engine";
import { HqError } from "../server/errors";
import type { ApprovalDto } from "../server/feed";
import { proposeAgent } from "../server/agent-need";
import { findAgent, startRun as defaultStartRun, type RunnerDeps, type StartRunRequest } from "../server/runner";
import { loadHome } from "../server/rooms";
import { recordChatTurn } from "../server/usage";
import { strings } from "../ui/strings";
import { confirmationAnswer, describeAction, isUntrustedTool, takeChatActions, type ChatAction } from "./actions";
import { extractChoices, type Choice } from "./choices";
import { askChat, chatEnv, composeChatInput, type ChatOutcome, type ChatRunner } from "./chat";
import { EMPTY_ASSISTANT_CONFIG, loadAssistantConfig, type ChatConfig } from "./home-config";
import { PendingQuestions } from "./pending";
import { Preamble } from "./preamble";
import { CHAT_REASON, processChatRequests } from "./requests";
import { readSettings } from "./settings";
import { runShell } from "./shell";
import { setArmed } from "../server/routines";
import { z } from "zod";

const AFTER_REPLY_TIMEOUT_MS = 2 * 60_000;

/** Run reason of a task typed on the desk and addressed to an agent. */
export const DESK_REASON = "desk";

/** What one chat turn gave back, whatever the channel. */
export type TurnResult = {
  /** False when the turn did not answer (budget, timeout, error): `reply` then says why, and nothing was recorded. */
  ok: boolean;
  /** The text to show: the chat's answer, followed by the core's own lines. */
  reply: string;
  /** Actions held until the user says yes (after the turn read a mail or a page), if any. */
  pendingConfirmation: { summary: string } | null;
  /** The messages the turn added to the conversation (the user's, then the reply). */
  messages: ChatMessageDto[];
  /** Items approved by the turn's actions, for the channel to hand over (Telegram sends their body). */
  approved: ApprovalDto[];
  /** The reply's task list (a selection list to tick), null when it has none or too many items. */
  choices: Choice[] | null;
};

export type DispatchResult = { reply: string; run: RunRow; messages: ChatMessageDto[] };

/**
 * What a message adds to a turn. `attachmentDir`: the message points to a file
 * received from outside (a photo, a PDF) that sits in this folder. The folder
 * is made readable for the turn, and reading anything during it counts as an
 * untrusted read: the file's content could have asked for the actions that follow.
 */
export type TurnOptions = { attachmentDir?: string };

/** Called with the result as soon as it is known, before the work that follows a reply (requests, afterReply). */
export type Deliver = (result: TurnResult) => Promise<void> | void;

export type ChatServiceDeps = {
  config: HqConfig;
  db: Db;
  /** The `chat` section of assistant.json, or null when the conversation is not configured. */
  chat: ChatConfig | null;
  /** The app's environment (process.env). */
  env: Env;
  chatMaxBudgetUsd: number;
  runChat?: ChatRunner;
  startRun?: (request: StartRunRequest) => RunRow;
  /** The engine of the receptionist's runs started by `propose_agent` (tests). */
  agentNeed?: Pick<RunnerDeps, "engine" | "send">;
  log?: (message: string) => void;
  questions?: PendingQuestions;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The chat turn pipeline, shared by every channel (Telegram, the desk's
 * panel): the transcript and the preamble, the model, the actions and
 * requests the turn asked for, the guard that holds them for a yes after an
 * untrusted read, the history. One turn runs at a time: a message that comes
 * while another is being answered waits its turn, in order.
 */
export class ChatService {
  /** The one question waiting for an answer (held actions, or a Telegram reason). Shared with the Telegram bridge. */
  readonly questions: PendingQuestions;
  private readonly log: (message: string) => void;
  private readonly preamble: Preamble;
  private continueChat = true;
  private tail: Promise<void> = Promise.resolve();
  private running = false;
  private queued = 0;

  constructor(private readonly deps: ChatServiceDeps) {
    this.log = deps.log ?? ((message) => console.log(`[assistant] ${message}`));
    this.questions = deps.questions ?? new PendingQuestions();
    this.preamble = new Preamble({ db: deps.db, config: deps.config, env: deps.env, log: this.log });
  }

  /** Whether the conversation can answer (the `chat` section of assistant.json exists). */
  get configured(): boolean {
    return this.deps.chat !== null;
  }

  state(): ChatTurnState {
    const held = this.questions.heldActions();
    return {
      running: this.running,
      queued: this.queued,
      pendingConfirmation: held ? { summary: strings.assistant.actions.summary(held.map(describeAction)) } : null,
    };
  }

  private emitState(): void {
    publishChat({ type: "turn", turn: this.state() });
  }

  /** Runs `job` when the turns before it are over. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.queued++;
    this.emitState();
    const result = this.tail.then(async () => {
      this.queued--;
      this.running = true;
      this.emitState();
      try {
        return await job();
      } finally {
        this.running = false;
        this.emitState();
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves when every turn queued so far has ended. */
  idle(): Promise<void> {
    return this.tail;
  }

  // --- Entry points ------------------------------------------------------------

  /**
   * A message of the user to the chat, from a channel that has no commands
   * (the desk's panel). Held actions are answered first: « oui » executes
   * them, « non » drops them, any other text drops them and goes on as a
   * message. Resolves as soon as the reply is known.
   */
  ask(text: string, channel: ChatChannel): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      this.enqueue(async () => {
        const notes: string[] = [];
        const t = strings.assistant.actions;
        const held = this.questions.peekConfirmation();
        if (held.status === "expired") notes.push(t.expired);
        if (held.status === "active" && "actions" in held.question) {
          this.questions.clear();
          const answer = confirmationAnswer(text);
          if (answer === "yes") return this.confirmNow(text, channel, held.question.actions, resolve, notes);
          if (answer === "no") return this.cancelNow(text, channel, resolve, notes);
          this.log(`${held.question.actions.length} held chat action(s) dropped`);
          notes.push(t.dropped);
        }
        return this.converseNow(text, channel, resolve, notes);
      }).then(resolve, reject);
    });
  }

  /** A message to the chat (the caller has handled commands, extensions and held actions). */
  converse(text: string, channel: ChatChannel, deliver?: Deliver, options: TurnOptions = {}): Promise<TurnResult> {
    return this.enqueue(() => this.converseNow(text, channel, deliver, [], options));
  }

  /** The user said yes to held actions: they run now, and the results are the reply. */
  confirm(text: string, channel: ChatChannel, actions: ChatAction[]): Promise<TurnResult> {
    return this.enqueue(() => this.confirmNow(text, channel, actions, undefined, []));
  }

  /** The user said no to held actions. */
  cancel(text: string, channel: ChatChannel): Promise<TurnResult> {
    return this.enqueue(() => this.cancelNow(text, channel, undefined, []));
  }

  /** `/new`: the conversation starts over (after the turn in progress, if any). */
  newConversation(): Promise<void> {
    return this.enqueue(async () => {
      this.continueChat = false;
      if (this.questions.peekConfirmation().status === "active") this.questions.clear();
      clearChatHistory(this.deps.db);
    });
  }

  /**
   * The text becomes the task of an agent and a run starts at once, with the
   * lock and the daily cap of any run (`AGENT_BUSY`, `DAILY_CAP_REACHED`
   * are thrown). The chat is not involved, so it does not wait for its turn.
   */
  dispatch(text: string, to: ChatTarget, channel: ChatChannel = "desk"): DispatchResult {
    const { agent } = findAgent(this.deps.config, to.room, to.agent);
    const start = this.deps.startRun ?? ((request: StartRunRequest) => defaultStartRun(request, { config: this.deps.config }));
    const run = start({ room: to.room, agent: agent.id, task: text, reason: DESK_REASON });
    const reply = strings.chat.dispatched(agent.name, run.id);
    const target = { room: to.room, agent: agent.id };
    const messages = [
      this.remember("user", text, null, { channel, to: target }),
      this.remember("bot", reply, "dispatch", { channel, to: target }),
    ].filter((message): message is ChatMessageDto => message !== null);
    this.log(`task for ${to.room}/${agent.id} from the ${channel}: run #${run.id} started`);
    return { reply, run, messages };
  }

  // --- The pipeline ------------------------------------------------------------

  private async converseNow(
    text: string,
    channel: ChatChannel,
    deliver: Deliver | undefined,
    notes: string[],
    options: TurnOptions = {},
  ): Promise<TurnResult> {
    const chat = this.deps.chat;
    const t = strings.assistant;
    const done = async (result: TurnResult) => {
      await deliver?.(result);
      return result;
    };
    const failure = (reply: string): TurnResult => ({
      ok: false,
      reply: [...notes, reply].join("\n\n"),
      pendingConfirmation: this.state().pendingConfirmation,
      messages: [],
      approved: [],
      choices: null,
    });
    if (!chat) return done(failure(t.chat.notConfigured));
    const startedAt = new Date().toISOString();
    // MyHQ keeps the conversation: a fresh turn gets the transcript, a turn
    // that resumes the CLI's conversation only what the bot sent since.
    const resume = chat.resume === "cli" && this.continueChat;
    const transcript = (since: "all" | "lastExchange") =>
      chatTranscript(this.deps.db, { turns: chat.historyTurns, maxChars: chat.historyMaxChars, since });
    // The facts of this instant come last, right before the user's words.
    const preamble = chat.preamble ? await this.preamble.build(chat.preamble) : null;
    const freshText = composeChatInput([transcript("all"), preamble], text);
    const outcome = await askChat({
      chat,
      text: resume ? composeChatInput([transcript("lastExchange"), preamble], text) : freshText,
      freshText,
      continue: resume,
      ...(options.attachmentDir ? { extraDirs: [options.attachmentDir] } : {}),
      bin: this.deps.config.claudeBin,
      env: chatEnv(this.deps.env),
      maxBudgetUsd: this.deps.chatMaxBudgetUsd,
      mcp: {
        dir: path.join(this.deps.config.dataDir, "assistant", "chat"),
        dbPath: this.deps.config.dbPath,
        appEnv: this.deps.env,
      },
      run: this.deps.runChat,
    });
    this.meter(outcome, chat.model, startedAt);
    if (outcome.ok) {
      this.continueChat = true;
      this.log(`chat answered (${outcome.costUsd.toFixed(4)} USD)`);
      // Actions asked for in this turn: executed now, or held for a yes when
      // the turn read untrusted content (a mail, a web page), whose text could
      // have asked for them. The core's own lines close the reply.
      const lines: string[] = [];
      let approved: ApprovalDto[] = [];
      if (chat.requestsDir) {
        const taken = takeChatActions(chat.requestsDir, chat.actions, this.log);
        lines.push(...taken.refused);
        if (taken.actions.length > 0) {
          const untrusted =
            outcome.tools === undefined
              ? ["(unknown)"]
              : [
                  ...new Set(
                    outcome.tools.filter(
                      // A Read in a turn about a received file may have read that file.
                      (tool) => isUntrustedTool(tool, chat) || (options.attachmentDir !== undefined && tool === "Read"),
                    ),
                  ),
                ];
          if (untrusted.length > 0) {
            this.questions.ask({ actions: taken.actions });
            this.log(`chat actions held for confirmation (untrusted: ${untrusted.join(", ")})`);
            lines.push(t.actions.confirm(taken.actions.map(describeAction)));
          } else {
            const executed = this.executeActions(taken.actions);
            lines.push(...executed.lines);
            approved = executed.approved;
          }
        }
      }
      // The notes (held actions dropped or expired) are part of what the user reads, so they are kept with it.
      const answer = [...notes, outcome.text.trim() || t.chat.empty, ...(lines.length ? [lines.join("\n")] : [])].join("\n\n");
      const messages = [
        this.remember("user", text, null, { channel }),
        this.remember("assistant", answer, null, { channel }),
      ].filter((message): message is ChatMessageDto => message !== null);
      const result: TurnResult = {
        ok: true,
        reply: answer,
        pendingConfirmation: this.state().pendingConfirmation,
        messages,
        approved,
        choices: extractChoices(outcome.text),
      };
      await done(result);
      if (chat.requestsDir) {
        processChatRequests(chat.requestsDir, {
          config: this.deps.config,
          db: this.deps.db,
          startRun: this.deps.startRun,
          log: this.log,
        });
      }
      await this.afterReply(chat.afterReply, chat.cwd);
      return result;
    }
    this.log(`chat failed (${outcome.reason}): ${outcome.detail.slice(0, 500)}`);
    if (chat.requestsDir) {
      // Actions of a turn that did not answer are never executed.
      const dropped = takeChatActions(chat.requestsDir, chat.actions, this.log).actions.length;
      if (dropped > 0) this.log(`${dropped} chat action(s) of the failed turn dropped`);
    }
    if (outcome.reason === "budget") {
      this.continueChat = true;
      return done(failure(t.chat.budget));
    }
    if (outcome.reason === "timeout") return done(failure(t.chat.timeout(Math.round(chat.timeoutMs / 60_000))));
    return done(failure(t.chat.failed(outcome.detail.slice(0, 500))));
  }

  private async confirmNow(
    text: string,
    channel: ChatChannel,
    actions: ChatAction[],
    deliver: Deliver | undefined,
    notes: string[],
  ): Promise<TurnResult> {
    const { lines, approved } = this.executeActions(actions);
    const reply = [...notes, lines.join("\n")].join("\n\n");
    const messages = [
      this.remember("user", text, null, { channel }),
      this.remember("assistant", reply, null, { channel }),
    ].filter((message): message is ChatMessageDto => message !== null);
    const result: TurnResult = {
      ok: true,
      reply,
      pendingConfirmation: this.state().pendingConfirmation,
      messages,
      approved,
      choices: null,
    };
    await deliver?.(result);
    return result;
  }

  private async cancelNow(text: string, channel: ChatChannel, deliver: Deliver | undefined, notes: string[]): Promise<TurnResult> {
    const reply = [...notes, strings.assistant.actions.cancelled].join("\n\n");
    const messages = [
      this.remember("user", text, null, { channel }),
      this.remember("assistant", reply, null, { channel }),
    ].filter((message): message is ChatMessageDto => message !== null);
    const result: TurnResult = {
      ok: true,
      reply,
      pendingConfirmation: this.state().pendingConfirmation,
      messages,
      approved: [],
      choices: null,
    };
    await deliver?.(result);
    return result;
  }

  // --- Actions -----------------------------------------------------------------

  /** Same code path as PATCH /api/approvals/[id]. Throws HqError or ZodError. */
  decide(id: number, decision: "approved" | "rejected" | "revise", note?: string): ApprovalDto {
    return decideApproval(
      this.deps.db,
      id,
      decisionSchema.parse({ decision, ...(note ? { note } : {}) }),
      this.deps.config,
    );
  }

  /** The French text of a failure, for a line of a reply. */
  errorText(error: unknown): string {
    if (error instanceof HqError) return strings.errors.byCode[error.code] ?? strings.errors.generic;
    if (error instanceof z.ZodError) return strings.errors.byCode.INVALID_INPUT ?? strings.errors.generic;
    this.log(`unexpected error: ${describe(error)}`);
    return strings.assistant.internalError;
  }

  /**
   * Executes actions the chat asked for, one at a time, with the code of the
   * buttons and of the commands (`decideApproval`, `startRun`, `setArmed`,
   * and `proposeAgent` of `POST /api/agents/propose`):
   * same lock, cap and errors. Returns one French line per action and the
   * items approved, to hand over like a button does.
   */
  private executeActions(actions: ChatAction[]): { lines: string[]; approved: ApprovalDto[] } {
    const t = strings.assistant;
    const lines: string[] = [];
    const approved: ApprovalDto[] = [];
    for (const action of actions) {
      const what = describeAction(action);
      try {
        switch (action.action) {
          case "approve": {
            const approval = this.decide(action.approvalId!, "approved");
            approved.push(approval);
            lines.push(t.decided(approval.id, strings.desk.decision[approval.status]));
            break;
          }
          case "reject":
          case "revise": {
            const decision = action.action === "reject" ? "rejected" : "revise";
            const approval = this.decide(action.approvalId!, decision, action.note);
            lines.push(t.decided(approval.id, strings.desk.decision[approval.status]));
            break;
          }
          case "propose_agent": {
            // As a chat request: when the receptionist is busy or the cap is reached, the need waits for its next run.
            const { run } = proposeAgent(
              { need: action.need!, ...(action.room ? { room: action.room } : {}) },
              { config: this.deps.config, queue: true, ...(this.deps.agentNeed ?? {}) },
            );
            lines.push(run ? strings.agentProposal.chat.started(run.id) : strings.agentProposal.chat.queued);
            break;
          }
          case "run":
          case "arm":
          case "disarm": {
            const room = this.roomOf(action);
            if (typeof room !== "string") {
              lines.push(t.actions.failed(what, room.error));
              break;
            }
            if (action.action === "run") {
              const start =
                this.deps.startRun ??
                ((request: StartRunRequest) => defaultStartRun(request, { config: this.deps.config }));
              const run = start({
                room,
                agent: action.agent!,
                ...(action.task ? { task: action.task } : {}),
                reason: CHAT_REASON,
              });
              lines.push(t.runStarted({ id: run.id, room: run.room, agent: run.agent_id }));
            } else {
              const armed = setArmed(this.deps.config, this.deps.db, room, action.agent!, action.action === "arm");
              lines.push(t.armed({ room, agent: action.agent!, armed }));
            }
            break;
          }
        }
      } catch (error) {
        lines.push(t.actions.failed(what, this.errorText(error)));
      }
    }
    this.log(`chat actions executed: ${actions.map((a) => a.action).join(", ")}`);
    return { lines, approved };
  }

  /** The room of an action on an agent: the one given, or the only room that has that agent. */
  private roomOf(action: ChatAction): string | { error: string } {
    if (action.room) return action.room;
    const rooms = loadHome(this.deps.config.home)
      .rooms.filter((room) => room.agents.some((agent) => agent.id === action.agent))
      .map((room) => room.name);
    if (rooms.length === 1) return rooms[0]!;
    return {
      error:
        rooms.length === 0
          ? strings.assistant.actions.unknownAgent(action.agent!)
          : strings.assistant.actions.ambiguousAgent(action.agent!, rooms),
    };
  }

  // --- Records -----------------------------------------------------------------

  /** Adds a message to the conversation MyHQ keeps. Never throws. */
  private remember(
    role: ChatRole,
    text: string,
    kind: string | null,
    options: { channel: ChatChannel; to?: ChatTarget },
  ): ChatMessageDto | null {
    try {
      return recordChatMessage(this.deps.db, role, text, kind, options);
    } catch (error) {
      this.log(`chat history not recorded: ${describe(error)}`);
      return null;
    }
  }

  /** Records the turn for the meter (`chat_turns`). Never throws. */
  private meter(outcome: ChatOutcome, model: string, startedAt: string): void {
    try {
      recordChatTurn(this.deps.db, {
        engine: "claude",
        model: outcome.model ?? model,
        status: outcome.ok ? "done" : "failed",
        reason: outcome.ok ? null : outcome.reason,
        usage: outcome.usage ?? ZERO_USAGE,
        costUsd: outcome.costUsd ?? 0,
        tools: outcome.tools ?? [],
        startedAt,
        endedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.log(`chat turn not metered: ${describe(error)}`);
    }
  }

  /** The home's post-reply command: its output goes to the log only. */
  private async afterReply(command: string | null, cwd: string): Promise<void> {
    if (!command) return;
    const result = await runShell(command, { cwd, env: this.deps.env, timeoutMs: AFTER_REPLY_TIMEOUT_MS });
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 1000);
    const status = result.timedOut ? "timed out" : `exited with ${result.code}`;
    this.log(`afterReply ${status}${output ? `: ${output}` : ""}`);
  }
}

// Shared across module instances (instrumentation, route bundles, dev reloads):
// the Telegram bridge and the HTTP routes must use the same service, or two
// turns could run at once.
const globalForService = globalThis as unknown as { __myhqChatServices?: Map<string, ChatService> };

/**
 * The chat service of the app's home, created on first use from the home's
 * assistant.json (a missing or invalid one means no conversation) and the
 * app's environment. `overrides` only count for the call that creates it.
 */
export function getChatService(config: HqConfig = getConfig(), overrides: Partial<ChatServiceDeps> = {}): ChatService {
  const services = (globalForService.__myhqChatServices ??= new Map());
  const existing = services.get(config.dbPath);
  if (existing) return existing;
  const log = overrides.log ?? ((message: string) => console.log(`[assistant] ${message}`));
  const env = overrides.env ?? process.env;
  let chat: ChatConfig | null;
  if ("chat" in overrides) chat = overrides.chat ?? null;
  else {
    try {
      chat = loadAssistantConfig(config.home).chat;
    } catch (error) {
      log(`invalid assistant.json, the conversation is off: ${describe(error)}`);
      chat = EMPTY_ASSISTANT_CONFIG.chat;
    }
  }
  let chatMaxBudgetUsd = overrides.chatMaxBudgetUsd;
  if (chatMaxBudgetUsd === undefined) {
    try {
      chatMaxBudgetUsd = readSettings(env).chatMaxBudgetUsd;
    } catch (error) {
      log(`invalid assistant environment: ${describe(error)}`);
      chatMaxBudgetUsd = 0.5;
    }
  }
  const service = new ChatService({ ...overrides, config, db: getDbAt(config.dbPath), chat, env, chatMaxBudgetUsd, log });
  services.set(config.dbPath, service);
  return service;
}
