import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { decideApproval, decisionSchema } from "../server/approvals";
import type { Env, HqConfig } from "../server/config";
import type { Db, RunRow } from "../server/db";
import { HqError } from "../server/errors";
import { getState, type ApprovalDto } from "../server/feed";
import { loadHome } from "../server/rooms";
import { startOnboarding as defaultStartOnboarding } from "../server/onboarding";
import { listFirings, schedulerInfo, setArmed } from "../server/routines";
import { startRun as defaultStartRun, type StartRunRequest } from "../server/runner";
import { ZERO_USAGE } from "../server/engine";
import { getUsage, recordChatTurn } from "../server/usage";
import { formatCost, formatDateTime } from "../ui/format";
import { branchHandover, claudeMdHandover, payloadUrl } from "../ui/model";
import { strings } from "../ui/strings";
import { parseButtonData } from "./approval-buttons";
import { askChat, chatEnv, type ChatOutcome, type ChatRunner } from "./chat";
import {
  CORE_COMMANDS,
  isCoreCommand,
  parseAgentArgs,
  parseApproveArgs,
  parseCommand,
  parseNoteArgs,
  parseRunArgs,
  type CoreCommandName,
} from "./commands";
import type { AssistantCommand, AssistantContext, LoadedExtension } from "./extension";
import type { AssistantConfig } from "./home-config";
import { PendingQuestions, type PendingQuestion } from "./pending";
import { processChatRequests } from "./requests";
import { extensionEnv } from "./settings";
import { fillTemplate, runShell } from "./shell";
import type { BotCommand, CallbackQuery, Telegram, TelegramMessage, Update } from "./telegram";
import { splitMessage, toTelegramMessages } from "./text";

/** The Bot API refuses to hand over files above 20 MB. */
export const FILE_LIMIT_BYTES = 20 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
const AFTER_REPLY_TIMEOUT_MS = 2 * 60_000;
const TELEGRAM_COMMAND_LIMIT = 100;

type Decision = "approved" | "rejected" | "revise";

export type AssistantDeps = {
  telegram: Telegram;
  chatId: string;
  config: HqConfig;
  db: Db;
  assistant: AssistantConfig;
  extensions: LoadedExtension[];
  /** The app's environment (process.env). */
  env: Env;
  chatMaxBudgetUsd: number;
  runChat?: ChatRunner;
  startRun?: (request: StartRunRequest) => RunRow;
  startOnboarding?: (request: { path: string }) => RunRow;
  log?: (message: string) => void;
  typingIntervalMs?: number;
  questions?: PendingQuestions;
};

/** Local `YYYY-MM-DD HHhMM`, for the names of received files. */
function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}`;
}

/** A file name safe on every OS, or null when nothing usable is left. */
export function safeFileName(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = path.posix
    .basename(name.replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned ? cleaned.slice(0, 180) : null;
}

/** `name`, or `base (2).ext`, `base (3).ext`... so that nothing is overwritten. */
export function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${base} (${n})${ext}`;
  return candidate;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handles the updates of the one chat MyHQ serves: core commands, approval
 * buttons and their follow-up questions, the home's extensions, voice notes,
 * files, and the conversation with `claude -p`.
 */
export class Assistant {
  private readonly log: (message: string) => void;
  private readonly questions: PendingQuestions;
  private readonly extEnv: Env;
  private continueChat = true;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AssistantDeps) {
    this.log = deps.log ?? ((message) => console.log(`[assistant] ${message}`));
    this.questions = deps.questions ?? new PendingQuestions();
    this.extEnv = extensionEnv(deps.env);
  }

  /** Core commands, then the extensions' commands (a core name always wins). */
  commandMenu(): BotCommand[] {
    const menu: BotCommand[] = CORE_COMMANDS.map((command) => ({
      command,
      description: strings.assistant.commands[command] ?? command,
    }));
    for (const { extension } of this.deps.extensions) {
      for (const command of extension.commands) {
        if (menu.some((c) => c.command === command.command)) {
          this.log(`extension ${extension.name}: /${command.command} is already taken, left out of the menu`);
          continue;
        }
        menu.push({ command: command.command, description: command.description });
      }
    }
    return menu.slice(0, TELEGRAM_COMMAND_LIMIT);
  }

  /**
   * Button presses are handled at once; messages are handled one after the
   * other, so that a long chat turn never runs twice at the same time.
   */
  async handleUpdate(update: Update): Promise<void> {
    if (update.callback_query) {
      try {
        await this.handleCallback(update.callback_query);
      } catch (error) {
        this.log(`button press failed: ${describe(error)}`);
      }
      return;
    }
    const message = update.message;
    if (!message) return;
    if (String(message.chat.id) !== this.deps.chatId) {
      this.log(`message from chat ${message.chat.id} ignored (not the configured chat)`);
      return;
    }
    this.queue = this.queue
      .then(() => this.handleMessage(message))
      .catch((error) => {
        this.log(`message failed: ${describe(error)}`);
        return this.reply(strings.assistant.internalError);
      })
      .catch(() => undefined);
  }

  /** Resolves when every queued message has been handled. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Sends a reply as plain text, cut at 4000 characters. Never throws. */
  async reply(text: string): Promise<void> {
    for (const part of toTelegramMessages(text)) {
      try {
        await this.deps.telegram.sendMessage(this.deps.chatId, part);
      } catch (error) {
        this.log(`reply not sent: ${describe(error)}`);
        return;
      }
    }
  }

  /** Keeps the "typing..." indicator on while `work` runs. */
  private async withTyping<T>(work: () => Promise<T>): Promise<T> {
    const ping = () => void this.deps.telegram.sendChatAction(this.deps.chatId, "typing").catch(() => undefined);
    ping();
    const timer = setInterval(ping, this.deps.typingIntervalMs ?? 4_000);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  // --- Messages -------------------------------------------------------------

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (message.voice || message.audio) return this.handleVoice(message);
    if (message.photo?.length || message.document) return this.handleFile(message);
    if (message.text?.trim()) return this.handleText(message.text);
    return this.reply(strings.assistant.unsupported);
  }

  /** Text, typed or transcribed: pending question, core command, extensions, then chat. */
  async handleText(text: string): Promise<void> {
    const command = parseCommand(text);
    if (!command) {
      const pending = this.questions.peek();
      if (pending.status === "expired") {
        await this.reply(strings.assistant.questionExpired(pending.question.approvalId));
      } else if (pending.status === "active") {
        this.questions.clear();
        return this.answerQuestion(pending.question, text.trim());
      }
    }
    if (command && isCoreCommand(command.name)) return this.runCore(command.name, command.args);
    for (const { extension } of this.deps.extensions) {
      let answer: string | null;
      try {
        answer = await extension.handle(text, this.contextFor(extension.name));
      } catch (error) {
        this.log(`extension ${extension.name} failed: ${describe(error)}`);
        return this.reply(strings.assistant.extensionError(extension.name));
      }
      if (answer !== null && answer !== undefined) {
        if (String(answer).trim()) await this.reply(String(answer));
        return;
      }
    }
    return this.converse(text);
  }

  private contextFor(name: string): AssistantContext {
    return {
      chatId: this.deps.chatId,
      home: this.deps.config.home,
      env: this.extEnv as NodeJS.ProcessEnv,
      reply: (text) => this.reply(text),
      log: (message) => this.log(`[${name}] ${message}`),
    };
  }

  // --- Core commands --------------------------------------------------------

  private async runCore(name: CoreCommandName, args: string): Promise<void> {
    const t = strings.assistant;
    switch (name) {
      case "start":
        return this.reply(t.welcome(this.extensionCommands().map((c) => c.command)));
      case "new":
        this.continueChat = false;
        return this.reply(t.newConversation);
      case "pending":
        return this.reply(this.pendingList());
      case "approve": {
        const parsed = parseApproveArgs(args);
        if (!parsed) return this.reply(t.usage.approve);
        let approval: ApprovalDto;
        try {
          approval = this.decide(parsed.id, "approved");
        } catch (error) {
          return this.reply(this.errorText(error));
        }
        await this.reply(t.decided(parsed.id, strings.desk.decision[approval.status]));
        return this.handOver(approval);
      }
      case "reject":
      case "revise": {
        const parsed = parseNoteArgs(args);
        if (!parsed) return this.reply(t.usage[name]);
        return this.reply(this.decideText(parsed.id, name === "reject" ? "rejected" : "revise", parsed.note));
      }
      case "run": {
        const parsed = parseRunArgs(args);
        if (!parsed) return this.reply(t.usage.run);
        const start =
          this.deps.startRun ?? ((request: StartRunRequest) => defaultStartRun(request, { config: this.deps.config }));
        try {
          const run = start(parsed);
          return this.reply(t.runStarted({ id: run.id, room: run.room, agent: run.agent_id }));
        } catch (error) {
          return this.reply(this.errorText(error));
        }
      }
      case "status":
        return this.reply(this.statusText());
      case "salle": {
        if (!args || args.length > 1_000) return this.reply(t.usage.salle);
        const start =
          this.deps.startOnboarding ??
          ((request: { path: string }) => defaultStartOnboarding(request, { config: this.deps.config }));
        try {
          const run = start({ path: args });
          return this.reply(t.onboardingStarted({ id: run.id, path: args }));
        } catch (error) {
          return this.reply(this.errorText(error));
        }
      }
      case "arm":
      case "disarm": {
        const parsed = parseAgentArgs(args);
        if (!parsed) return this.reply(t.usage[name]);
        try {
          const armed = setArmed(this.deps.config, this.deps.db, parsed.room, parsed.agent, name === "arm");
          return this.reply(t.armed({ ...parsed, armed }));
        } catch (error) {
          return this.reply(this.errorText(error));
        }
      }
    }
  }

  private extensionCommands(): AssistantCommand[] {
    return this.deps.extensions.flatMap(({ extension }) => extension.commands);
  }

  private pendingList(): string {
    const rows = this.deps.db
      .prepare(
        `SELECT a.id, a.room, a.title, COALESCE(g.name, a.agent_id) AS agent
         FROM approvals a LEFT JOIN agents g ON g.room = a.room AND g.id = a.agent_id
         WHERE a.status = 'pending' ORDER BY a.id`,
      )
      .all() as { id: number; room: string; title: string; agent: string }[];
    if (rows.length === 0) return strings.assistant.pendingEmpty;
    return [strings.assistant.pendingTitle(rows.length), ...rows.map((row) => strings.assistant.pendingLine(row))].join(
      "\n",
    );
  }

  private statusText(): string {
    const t = strings.assistant.status;
    const usage = getUsage(this.deps.db, this.deps.config.maxRunsPerDay, this.deps.config.weeklyBudgetUsd);
    const state = getState(this.deps.db, loadHome(this.deps.config.home), schedulerInfo(this.deps.config));
    const agents = state.rooms.flatMap((room) =>
      room.agents.map((agent) => {
        const line = t.agent({ room: room.name, agent: agent.name, state: strings.team.state[agent.state] });
        if (agent.routines.length === 0) return line;
        const next = agent.routines
          .map((routine) => routine.nextAt)
          .filter((at): at is string => at !== null)
          .sort()[0];
        return line + t.routines({ armed: agent.armed, next: next ? formatDateTime(next) : null });
      }),
    );
    const firings = listFirings(this.deps.db, 5).map((firing) =>
      t.firing({
        at: formatDateTime(firing.scheduledAt),
        room: firing.room,
        agent: firing.agentId,
        outcome: strings.routines.outcome[firing.outcome] ?? firing.outcome,
        runId: firing.runId,
      }),
    );
    const budget = usage.budget;
    return [
      t.today(usage.today.runs, formatCost(usage.today.costUsd)),
      t.week(usage.week.runs, formatCost(usage.week.costUsd)),
      t.chatWeek(usage.chat.week.turns, formatCost(usage.chat.week.costUsd)),
      ...(budget
        ? [t.budget(Math.round(budget.share * 100), formatCost(budget.spentUsd), formatCost(budget.weeklyUsd))]
        : []),
      t.cap(usage.cap.remaining, usage.cap.maxRunsPerDay),
      t.scheduler(state.scheduler),
      "",
      t.agentsTitle,
      ...(agents.length > 0 ? agents : [t.noAgent]),
      ...(firings.length > 0 ? ["", t.firingsTitle, ...firings] : []),
    ].join("\n");
  }

  // --- Decisions ------------------------------------------------------------

  /** Same code path as PATCH /api/approvals/[id]. Throws HqError or ZodError. */
  private decide(id: number, decision: Decision, note?: string) {
    return decideApproval(
      this.deps.db,
      id,
      decisionSchema.parse({ decision, ...(note ? { note } : {}) }),
      this.deps.config,
    );
  }

  private decideText(id: number, decision: Decision, note?: string): string {
    try {
      const approval = this.decide(id, decision, note);
      return strings.assistant.decided(id, strings.desk.decision[approval.status]);
    } catch (error) {
      return this.errorText(error);
    }
  }

  /**
   * The user posts approved replies himself: when the item points to a thread
   * (an http(s) `payload.url`), sends the body as a plain message of its own
   * (to copy it on the phone, cut at 4000 as usual), then the link. An
   * approved pull request or blog post with a local branch gets the branch,
   * then the push and `gh pr create` commands as a message of their own. An
   * approved room proposal gets the "HQ agents" block for the project's
   * CLAUDE.md, which MyHQ never writes itself.
   */
  private async handOver(approval: ApprovalDto): Promise<void> {
    const url = payloadUrl(approval.payload);
    const branch = branchHandover(approval);
    const claudeMd = claudeMdHandover(approval);
    let parts: string[];
    if (url) parts = [...splitMessage(approval.body), url];
    else if (branch) parts = [strings.assistant.branchHandover(branch.branch, branch.sha), branch.commands];
    else if (claudeMd) parts = [strings.assistant.claudeMdHandover(claudeMd.targetRepo), ...splitMessage(claudeMd.text)];
    else return;
    for (const part of parts) {
      try {
        await this.deps.telegram.sendMessage(this.deps.chatId, part);
      } catch (error) {
        this.log(`approved item #${approval.id} not handed over: ${describe(error)}`);
        return;
      }
    }
  }

  private errorText(error: unknown): string {
    if (error instanceof HqError) return strings.errors.byCode[error.code] ?? strings.errors.generic;
    if (error instanceof z.ZodError) return strings.errors.byCode.INVALID_INPUT ?? strings.errors.generic;
    this.log(`unexpected error: ${describe(error)}`);
    return strings.assistant.internalError;
  }

  private async answerQuestion(question: PendingQuestion, note: string): Promise<void> {
    try {
      const approval = this.decide(question.approvalId, question.decision, note);
      const label = strings.desk.decision[approval.status];
      await this.markAlert(question.alert, label);
      await this.reply(strings.assistant.decided(question.approvalId, label));
    } catch (error) {
      await this.reply(this.errorText(error));
    }
  }

  /** Shows the decision on the alert and removes its buttons. */
  private async markAlert(alert: PendingQuestion["alert"], label: string): Promise<void> {
    if (!alert) return;
    try {
      await this.deps.telegram.editMessageText(
        this.deps.chatId,
        alert.messageId,
        strings.assistant.alertDecided(alert.text, label),
      );
    } catch (error) {
      this.log(`alert not updated: ${describe(error)}`);
    }
  }

  private async handleCallback(query: CallbackQuery): Promise<void> {
    const from = String(query.message?.chat.id ?? query.from.id);
    if (from !== this.deps.chatId) {
      this.log(`button press from chat ${from} ignored (not the configured chat)`);
      return;
    }
    const tg = this.deps.telegram;
    const button = parseButtonData(query.data);
    if (!button) {
      await tg.answerCallbackQuery(query.id);
      return;
    }
    const alert = query.message ? { messageId: query.message.message_id, text: query.message.text ?? "" } : null;
    const row = this.deps.db.prepare("SELECT status FROM approvals WHERE id = ?").get(button.approvalId) as
      | { status: keyof typeof strings.desk.decision }
      | undefined;
    if (!row) {
      await tg.answerCallbackQuery(query.id, strings.errors.byCode.APPROVAL_NOT_FOUND);
      return;
    }
    if (row.status !== "pending") {
      await tg.answerCallbackQuery(query.id, strings.errors.byCode.APPROVAL_ALREADY_DECIDED);
      await this.markAlert(alert, strings.desk.decision[row.status]);
      return;
    }
    if (button.action === "approve") {
      let approval: ApprovalDto;
      try {
        approval = this.decide(button.approvalId, "approved");
      } catch (error) {
        await tg.answerCallbackQuery(query.id, this.errorText(error));
        return;
      }
      const label = strings.desk.decision[approval.status];
      await tg.answerCallbackQuery(query.id, label);
      await this.markAlert(alert, label);
      await this.handOver(approval);
      return;
    }
    const decision = button.action === "reject" ? "rejected" : "revise";
    this.questions.ask({ decision, approvalId: button.approvalId, alert });
    await tg.answerCallbackQuery(query.id);
    await this.reply(
      decision === "rejected"
        ? strings.assistant.askReject(button.approvalId)
        : strings.assistant.askRevise(button.approvalId),
    );
  }

  // --- Conversation ---------------------------------------------------------

  private async converse(text: string): Promise<void> {
    const chat = this.deps.assistant.chat;
    if (!chat) return this.reply(strings.assistant.chat.notConfigured);
    const startedAt = new Date().toISOString();
    const outcome = await this.withTyping(() =>
      askChat({
        chat,
        text,
        continue: this.continueChat,
        bin: this.deps.config.claudeBin,
        env: chatEnv(this.deps.env),
        maxBudgetUsd: this.deps.chatMaxBudgetUsd,
        mcp: {
          dir: path.join(this.deps.config.dataDir, "assistant", "chat"),
          dbPath: this.deps.config.dbPath,
          appEnv: this.deps.env,
        },
        run: this.deps.runChat,
      }),
    );
    this.meter(outcome, chat.model, startedAt);
    if (outcome.ok) {
      this.continueChat = true;
      this.log(`chat answered (${outcome.costUsd.toFixed(4)} USD)`);
      await this.reply(outcome.text.trim() || strings.assistant.chat.empty);
      if (chat.requestsDir) {
        processChatRequests(chat.requestsDir, {
          config: this.deps.config,
          db: this.deps.db,
          startRun: this.deps.startRun,
          log: this.log,
        });
      }
      await this.afterReply(chat.afterReply, chat.cwd);
      return;
    }
    this.log(`chat failed (${outcome.reason}): ${outcome.detail.slice(0, 500)}`);
    if (outcome.reason === "budget") {
      this.continueChat = true;
      return this.reply(strings.assistant.chat.budget);
    }
    if (outcome.reason === "timeout") {
      return this.reply(strings.assistant.chat.timeout(Math.round(chat.timeoutMs / 60_000)));
    }
    return this.reply(strings.assistant.chat.failed(outcome.detail.slice(0, 500)));
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
    const result = await runShell(command, { cwd, env: this.extEnv, timeoutMs: AFTER_REPLY_TIMEOUT_MS });
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 1000);
    const status = result.timedOut ? "timed out" : `exited with ${result.code}`;
    this.log(`afterReply ${status}${output ? `: ${output}` : ""}`);
  }

  // --- Voice notes and files ------------------------------------------------

  private async handleVoice(message: TelegramMessage): Promise<void> {
    const file = (message.voice ?? message.audio)!;
    const template = this.deps.assistant.transcribe;
    if (!template) return this.reply(strings.assistant.voice.notConfigured);
    if ((file.file_size ?? 0) > FILE_LIMIT_BYTES) return this.reply(strings.assistant.voice.tooLarge);
    const ext = path.extname(safeFileName(message.audio?.file_name) ?? "") || ".oga";
    const destination = path.join(this.deps.config.dataDir, "assistant", "voice", `voice-${Date.now()}${ext}`);
    let text: string | null = null;
    try {
      const result = await this.withTyping(async () => {
        await this.deps.telegram.download(file.file_id, destination);
        return runShell(fillTemplate(template, destination), {
          cwd: this.deps.config.home,
          env: this.extEnv,
          timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        });
      });
      if (result.timedOut || result.code !== 0) {
        const why = result.timedOut ? "timeout" : `code ${result.code}`;
        this.log(`transcription failed (${why}): ${result.stderr.trim().slice(0, 500)}`);
      } else {
        text = result.stdout.trim();
      }
    } catch (error) {
      this.log(`voice note not downloaded: ${describe(error)}`);
    } finally {
      fs.rmSync(destination, { force: true });
    }
    if (text === null) return this.reply(strings.assistant.voice.failed);
    if (!text) return this.reply(strings.assistant.voice.empty);
    this.log(`voice note transcribed (${text.length} characters)`);
    return this.handleText(text);
  }

  private async handleFile(message: TelegramMessage): Promise<void> {
    const t = strings.assistant.files;
    const dropDir = this.deps.assistant.dropDir;
    if (!dropDir) return this.reply(t.notConfigured);
    const photo = message.photo?.length
      ? message.photo.reduce((best, size) => (size.width * size.height > best.width * best.height ? size : best))
      : null;
    const piece = photo ?? message.document!;
    if ((piece.file_size ?? 0) > FILE_LIMIT_BYTES) return this.reply(t.tooLarge);
    const wanted = photo
      ? t.photoName(stamp())
      : (safeFileName(message.document?.file_name) ?? t.documentName(stamp()));
    try {
      fs.mkdirSync(dropDir, { recursive: true });
      const name = freeName(dropDir, wanted);
      await this.deps.telegram.download(piece.file_id, path.join(dropDir, name));
      const caption = message.caption?.trim();
      if (caption) {
        const note = freeName(dropDir, `${name.slice(0, name.length - path.extname(name).length)}.md`);
        fs.writeFileSync(path.join(dropDir, note), `${caption}\n\n![${name}](${encodeURI(name)})\n`, "utf8");
      }
      this.log(`file received: ${name}${caption ? " (with caption)" : ""}`);
      return this.reply(t.received(name, path.basename(dropDir)));
    } catch (error) {
      this.log(`file not received: ${describe(error)}`);
      return this.reply(t.failed);
    }
  }
}
