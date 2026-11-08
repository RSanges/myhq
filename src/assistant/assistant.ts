import fs from "node:fs";
import path from "node:path";
import { liveConfig, type Env, type HqConfig } from "../server/config";
import { markApprovalSeen } from "../server/approvals";
import { answerSchema, answerText, parseQuestionPayload, QUESTION_TYPE, type Answer, type Question } from "../server/questions";
import type { Db, RunRow } from "../server/db";
import { getState, type ApprovalDto } from "../server/feed";
import { loadHome } from "../server/rooms";
import { startOnboarding as defaultStartOnboarding } from "../server/onboarding";
import { listFirings, schedulerInfo, setArmed } from "../server/routines";
import { startRun as defaultStartRun, type StartRunRequest } from "../server/runner";
import { getUsage } from "../server/usage";
import { formatCost, formatDateTime } from "../ui/format";
import { branchHandover, claudeMdHandover, payloadUrl } from "../ui/model";
import { strings } from "../ui/strings";
import { parseButtonData } from "./approval-buttons";
import { selectionMessage } from "./choices";
import type { ChatRunner } from "./chat";
import { ChatService, type TurnOptions, type TurnResult } from "./chat-service";
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
import { confirmationAnswer } from "./actions";
import { PendingSelections, type PendingQuestions, type DecisionQuestion } from "./pending";
import { parseQuestionData, questionKeyboard, type QuestionButton } from "./question-buttons";
import { replyTarget } from "./replies";
import { parseSelectionData, selectionKeyboard } from "./selection-buttons";
import { extensionEnv } from "./settings";
import { fillTemplate, runShell } from "./shell";
import type { BotCommand, CallbackQuery, InlineKeyboard, Telegram, TelegramMessage, Update } from "./telegram";
import { splitMessage, toTelegramMessages } from "./text";

/** The Bot API refuses to hand over files above 20 MB. */
export const FILE_LIMIT_BYTES = 20 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
const TELEGRAM_COMMAND_LIMIT = 100;
/** The most items of questions whose partial answers (given from Telegram) are kept at once. */
const MAX_OPEN_QUESTIONS = 50;

type Decision = "approved" | "rejected" | "revise";

/** The message a reply answers (see `replyTarget`). */
type RepliedMessage = NonNullable<TelegramMessage["reply_to_message"]>;

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
  /** The selection keyboards waiting to be ticked. */
  selections?: PendingSelections;
  /** The chat pipeline shared with the HTTP routes; one is made from the other dependencies when left out. */
  chatService?: ChatService;
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
  private readonly selections: PendingSelections;
  private readonly extEnv: Env;
  private readonly chat: ChatService;
  /** The answers given from Telegram to the questions of items not answered yet (hq_ask), by item then question. */
  private readonly questionAnswers = new Map<number, Map<number, Answer>>();
  /** The options ticked on a multi-select question that is not validated yet, by "<item>:<question>". */
  private readonly ticked = new Map<string, Set<number>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AssistantDeps) {
    this.log = deps.log ?? ((message) => console.log(`[assistant] ${message}`));
    this.extEnv = extensionEnv(deps.env);
    this.chat =
      deps.chatService ??
      new ChatService({
        config: deps.config,
        db: deps.db,
        chat: deps.assistant.chat,
        // The home's commands (afterReply, preamble) never see the Telegram variables.
        env: deps.env,
        chatMaxBudgetUsd: deps.chatMaxBudgetUsd,
        runChat: deps.runChat,
        startRun: deps.startRun,
        log: this.log,
        questions: deps.questions,
      });
    this.questions = this.chat.questions;
    this.selections = deps.selections ?? new PendingSelections();
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
    this.enqueue(() => this.handleMessage(message));
  }

  /** Runs `job` after the messages before it. A failure is logged and answered, never thrown. */
  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue
      .then(job)
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
    await this.send(text);
  }

  /** Like `reply`; a keyboard goes under the last part, whose id and text are returned (null when nothing went out). */
  private async send(text: string, keyboard?: InlineKeyboard): Promise<{ messageId: number; text: string } | null> {
    const parts = toTelegramMessages(text);
    let last: { messageId: number; text: string } | null = null;
    for (const [index, part] of parts.entries()) {
      try {
        const withKeyboard = keyboard && index === parts.length - 1;
        last = { messageId: await this.deps.telegram.sendMessage(this.deps.chatId, part, withKeyboard ? keyboard : undefined), text: part };
      } catch (error) {
        this.log(`reply not sent: ${describe(error)}`);
        return null;
      }
    }
    return last;
  }

  /** Turns the "typing..." indicator on; returns the function that turns it off. */
  private startTyping(): () => void {
    const ping = () => void this.deps.telegram.sendChatAction(this.deps.chatId, "typing").catch(() => undefined);
    ping();
    const timer = setInterval(ping, this.deps.typingIntervalMs ?? 4_000);
    return () => clearInterval(timer);
  }

  /** Keeps the "typing..." indicator on while `work` runs. */
  private async withTyping<T>(work: () => Promise<T>): Promise<T> {
    const stop = this.startTyping();
    try {
      return await work();
    } finally {
      stop();
    }
  }

  // --- Messages -------------------------------------------------------------

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (message.voice || message.audio) return this.handleVoice(message);
    if (message.photo?.length || message.document) return this.handleFile(message);
    if (message.text?.trim()) return this.handleText(message.text, message.reply_to_message);
    return this.reply(strings.assistant.unsupported);
  }

  /**
   * Text, typed or transcribed: a reply to one of our alerts, pending question,
   * core command, extensions, then chat.
   */
  async handleText(text: string, replyTo?: RepliedMessage): Promise<void> {
    const command = parseCommand(text);
    if (!command) {
      if (replyTo && (await this.handleReply(text.trim(), replyTo))) return;
      const pending = this.questions.peek();
      if (pending.status === "expired") {
        const question = pending.question;
        await this.reply(
          "actions" in question
            ? strings.assistant.actions.expired
            : strings.assistant.questionExpired(question.approvalId),
        );
      } else if (pending.status === "active") {
        this.questions.clear();
        const question = pending.question;
        if (!("actions" in question)) return this.answerQuestion(question, text.trim());
        // Held actions run on a yes only; anything else drops them.
        const answer = confirmationAnswer(text);
        if (answer === "yes") return this.sendResult(await this.chat.confirm(text, "telegram", question.actions));
        if (answer === "no") return this.sendResult(await this.chat.cancel(text, "telegram"));
        this.log(`${question.actions.length} held chat action(s) dropped`);
        await this.reply(strings.assistant.actions.dropped);
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
    // A reply to one of our messages that nothing above took: the chat gets the message it answers, or « C'est fait » means nothing.
    const quoted = (replyTo?.text ?? replyTo?.caption)?.trim();
    return this.converse(quoted ? strings.assistant.inReplyTo(quoted, text) : text);
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
        try {
          await this.chat.newConversation();
        } catch (error) {
          this.log(`chat history not cleared: ${describe(error)}`);
        }
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
        `SELECT a.id, a.room, a.for_room, a.title, COALESCE(g.name, a.agent_id) AS agent
         FROM approvals a LEFT JOIN agents g ON g.room = a.room AND g.id = a.agent_id
         WHERE a.status = 'pending' ORDER BY a.id`,
      )
      .all() as { id: number; room: string; for_room: string | null; title: string; agent: string }[];
    if (rows.length === 0) return strings.assistant.pendingEmpty;
    // A delivery of a shared room says where it goes: « creation pour planygo ».
    const line = (row: (typeof rows)[number]) =>
      strings.assistant.pendingLine({ ...row, room: row.for_room ? strings.studio.forRoom(row.room, row.for_room) : row.room });
    return [strings.assistant.pendingTitle(rows.length), ...rows.map(line)].join("\n");
  }

  private statusText(): string {
    const t = strings.assistant.status;
    const config = liveConfig(this.deps.config);
    const usage = getUsage(this.deps.db, config.maxRunsPerDay, config.weeklyBudgetUsd);
    const state = getState(this.deps.db, loadHome(config.home), schedulerInfo(config));
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
    return this.chat.decide(id, decision, note);
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
    return this.chat.errorText(error);
  }

  /**
   * A reply to one of our messages. Replying to the alert of a pending item
   * with a text sends the item back to its agent: the text is the note of the
   * revision. Returns false when the reply is about nothing we can act on (an
   * unknown message, an item already decided or informational): the text then
   * goes on as an ordinary message.
   */
  private async handleReply(text: string, replied: RepliedMessage): Promise<boolean> {
    const target = replyTarget(replied.text ?? replied.caption);
    if (!target) return false;
    const row = this.deps.db.prepare("SELECT status, type FROM approvals WHERE id = ?").get(target.approvalId) as
      | { status: string; type: string }
      | undefined;
    if (row?.status !== "pending") return false;
    if (row.type === QUESTION_TYPE) {
      await this.answerByReply(target.approvalId, target.question, text, replied);
      return true;
    }
    const alert = replied.text === undefined && replied.caption !== undefined
      ? { messageId: replied.message_id, text: replied.caption, media: true }
      : { messageId: replied.message_id, text: replied.text ?? "" };
    await this.answerQuestion({ decision: "revise", approvalId: target.approvalId, alert }, text);
    return true;
  }

  // --- Questions of the agents (hq_ask) ---------------------------------------

  /** The questions of an item of questions, null when the item is not one (or is gone). */
  private loadQuestions(id: number): { status: string; questions: Question[] } | null {
    const row = this.deps.db.prepare("SELECT status, type, payload FROM approvals WHERE id = ?").get(id) as
      | { status: string; type: string; payload: string }
      | undefined;
    if (!row || row.type !== QUESTION_TYPE) return null;
    const asked = parseQuestionPayload(JSON.parse(row.payload));
    return asked ? { status: row.status, questions: asked.questions } : null;
  }

  /** The item is over (answered or decided elsewhere): what was kept for it goes. */
  private forgetQuestions(id: number): void {
    this.questionAnswers.delete(id);
    for (const key of this.ticked.keys()) if (key.startsWith(`${id}:`)) this.ticked.delete(key);
  }

  /**
   * Keeps the answer to one question, shows it on the question's message (the
   * buttons go), and, once every question of the item has one, answers the
   * item: the agent is woken with them. Returns how far the item is.
   */
  private async recordAnswer(
    id: number,
    questions: readonly Question[],
    index: number,
    answer: Answer,
    message: { messageId: number; text: string },
  ): Promise<{ done: number; complete: boolean }> {
    const t = strings.assistant.question;
    this.ticked.delete(`${id}:${index}`);
    const mine = this.questionAnswers.get(id) ?? new Map<number, Answer>();
    mine.set(index, answer);
    this.questionAnswers.set(id, mine);
    // A few items at most are kept open: the oldest goes first.
    while (this.questionAnswers.size > MAX_OPEN_QUESTIONS) this.questionAnswers.delete(this.questionAnswers.keys().next().value!);
    await this.editMessage(message.messageId, t.answered(message.text, answerText(questions[index]!, answer)));
    if (mine.size < questions.length) return { done: mine.size, complete: false };
    try {
      this.chat.decide(id, "approved", undefined, questions.map((_, i) => mine.get(i)!));
      await this.reply(t.complete(id));
    } catch (error) {
      await this.reply(this.errorText(error));
    }
    this.forgetQuestions(id);
    return { done: mine.size, complete: true };
  }

  /** A press on the keyboard of a question: pick an option, or tick it and validate on a multi-select question. */
  private async handleQuestionPress(query: CallbackQuery, press: QuestionButton): Promise<void> {
    const tg = this.deps.telegram;
    const t = strings.assistant.question;
    const item = this.loadQuestions(press.approvalId);
    if (!item) {
      await tg.answerCallbackQuery(query.id, strings.errors.byCode.APPROVAL_NOT_FOUND);
      return;
    }
    const message = query.message;
    if (item.status !== "pending") {
      // Decided elsewhere (the desk, a refusal): the question is shown as it was, without buttons.
      this.forgetQuestions(press.approvalId);
      await tg.answerCallbackQuery(query.id, strings.errors.byCode.APPROVAL_ALREADY_DECIDED);
      if (message) await this.editMessage(message.message_id, message.text ?? "");
      return;
    }
    const question = item.questions[press.question];
    if (!question || !message) {
      await tg.answerCallbackQuery(query.id, t.gone);
      return;
    }
    const shown = message.text ?? "";
    const key = `${press.approvalId}:${press.question}`;
    let answer: Answer;
    if (press.action === "option") {
      if (press.option >= question.options.length) {
        await tg.answerCallbackQuery(query.id);
        return;
      }
      if (!question.multiSelect) {
        answer = { options: [press.option] };
      } else {
        const selected = this.ticked.get(key) ?? new Set<number>();
        if (!selected.delete(press.option)) selected.add(press.option);
        this.ticked.set(key, selected);
        await tg.answerCallbackQuery(query.id);
        const labels = question.options.map((option) => option.label);
        await this.editMessage(message.message_id, shown, questionKeyboard(press.approvalId, press.question, labels, true, selected));
        return;
      }
    } else {
      const selected = this.ticked.get(key);
      if (!question.multiSelect || !selected || selected.size === 0) {
        await tg.answerCallbackQuery(query.id, t.pickOne);
        return;
      }
      answer = { options: [...selected].sort((a, b) => a - b) };
    }
    const progress = await this.recordAnswer(press.approvalId, item.questions, press.question, answer, {
      messageId: message.message_id,
      text: shown,
    });
    await tg.answerCallbackQuery(query.id, progress.complete ? undefined : t.saved(progress.done, item.questions.length));
  }

  /**
   * « Autre »: a reply to the message of a question answers it with the text
   * (on a multi-select question, together with the options ticked so far).
   */
  private async answerByReply(id: number, index: number | null, text: string, replied: RepliedMessage): Promise<void> {
    const t = strings.assistant.question;
    const item = this.loadQuestions(id);
    if (!item) return;
    if (index === null) return this.reply(t.replyToQuestion);
    const question = item.questions[index];
    if (!question) return this.reply(t.gone);
    const ticked = question.multiSelect ? [...(this.ticked.get(`${id}:${index}`) ?? [])].sort((a, b) => a - b) : [];
    const answer = answerSchema.safeParse({ options: ticked, other: text });
    if (!answer.success) return this.reply(strings.errors.byCode.INVALID_INPUT ?? strings.errors.generic);
    const progress = await this.recordAnswer(id, item.questions, index, answer.data, {
      messageId: replied.message_id,
      text: replied.text ?? "",
    });
    if (!progress.complete) await this.reply(t.saved(progress.done, item.questions.length));
  }

  private async answerQuestion(question: DecisionQuestion, note: string): Promise<void> {
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
  private async markAlert(
    alert: DecisionQuestion["alert"],
    label: string,
    format: (text: string, label: string) => string = strings.assistant.alertDecided,
  ): Promise<void> {
    if (!alert) return;
    try {
      // An alert that carries a file (a video, a photo, a sound) has a caption, not a text.
      const text = format(alert.text, label);
      if (alert.media) await this.deps.telegram.editMessageCaption(this.deps.chatId, alert.messageId, text.slice(0, 1024));
      else await this.deps.telegram.editMessageText(this.deps.chatId, alert.messageId, text);
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
    const choice = parseSelectionData(query.data);
    if (choice) return this.handleSelection(query, choice);
    const asked = parseQuestionData(query.data);
    if (asked) return this.handleQuestionPress(query, asked);
    const button = parseButtonData(query.data);
    if (!button) {
      await tg.answerCallbackQuery(query.id);
      return;
    }
    const message = query.message;
    const alert = message
      ? message.text === undefined && message.caption !== undefined
        ? { messageId: message.message_id, text: message.caption, media: true }
        : { messageId: message.message_id, text: message.text ?? "" }
      : null;
    const row = this.deps.db.prepare("SELECT status FROM approvals WHERE id = ?").get(button.approvalId) as
      | { status: keyof typeof strings.desk.decision }
      | undefined;
    if (!row) {
      await tg.answerCallbackQuery(query.id, strings.errors.byCode.APPROVAL_NOT_FOUND);
      return;
    }
    if (button.action === "seen") {
      // « Vu » on an informational alert: same code path as the desk's button.
      try {
        markApprovalSeen(this.deps.db, button.approvalId);
      } catch (error) {
        await tg.answerCallbackQuery(query.id, this.errorText(error));
        return;
      }
      await tg.answerCallbackQuery(query.id, strings.desk.decision.seen);
      await this.markAlert(alert, strings.desk.decision.seen, strings.assistant.alertSeen);
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

  // --- Selection lists ------------------------------------------------------

  /** A press on the keyboard of a selection list: toggle an item, send the selection, or drop it. */
  private async handleSelection(query: CallbackQuery, button: NonNullable<ReturnType<typeof parseSelectionData>>): Promise<void> {
    const tg = this.deps.telegram;
    const t = strings.assistant.selection;
    const message = query.message;
    if (!message) {
      await tg.answerCallbackQuery(query.id);
      return;
    }
    const selection = this.selections.get(message.message_id);
    if (!selection) {
      // Over (an hour, a restart): the list is shown as it was, without buttons.
      await tg.answerCallbackQuery(query.id, t.expired);
      await this.editMessage(message.message_id, message.text ?? "");
      return;
    }
    if (button.action === "toggle") {
      if (button.index >= selection.choices.length) {
        await tg.answerCallbackQuery(query.id);
        return;
      }
      if (!selection.selected.delete(button.index)) selection.selected.add(button.index);
      await tg.answerCallbackQuery(query.id);
      await this.editMessage(message.message_id, selection.text, selectionKeyboard(selection.choices, selection.selected));
      return;
    }
    if (button.action === "cancel") {
      this.selections.remove(message.message_id);
      await tg.answerCallbackQuery(query.id);
      await this.editMessage(message.message_id, t.cancelled(selection.text));
      return;
    }
    if (selection.selected.size === 0) {
      await tg.answerCallbackQuery(query.id, t.nothing);
      return;
    }
    // The selection goes through the pipeline as if it had been typed, after the messages already waiting.
    const text = selectionMessage(selection.choices, selection.selected);
    this.selections.remove(message.message_id);
    await tg.answerCallbackQuery(query.id);
    await this.editMessage(message.message_id, t.sent(selection.text, text));
    this.log(`selection sent (${selection.selected.size} of ${selection.choices.length})`);
    this.enqueue(() => this.handleText(text));
  }

  /** Replaces a message's text and keyboard. Never throws. */
  private async editMessage(messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.deps.telegram.editMessageText(this.deps.chatId, messageId, text, keyboard);
    } catch (error) {
      this.log(`selection message not updated: ${describe(error)}`);
    }
  }

  // --- Conversation ---------------------------------------------------------

  /** Sends what a chat turn gave back (with the keyboard of a selection list), then hands over the items it approved. */
  private async sendResult(result: TurnResult): Promise<void> {
    const keyboard = result.choices ? selectionKeyboard(result.choices, new Set()) : undefined;
    const sent = await this.send(result.reply, keyboard);
    if (sent && result.choices) this.selections.add(sent.messageId, { choices: result.choices, selected: new Set(), text: sent.text });
    for (const approval of result.approved) await this.handOver(approval);
  }

  private async converse(text: string, options: TurnOptions = {}): Promise<void> {
    if (!this.chat.configured) return this.reply(strings.assistant.chat.notConfigured);
    const stopTyping = this.startTyping();
    try {
      // The reply goes out as soon as it is known, the work that follows it (requests, afterReply) does not hold it back.
      await this.chat.converse(
        text,
        "telegram",
        async (result) => {
          stopTyping();
          await this.sendResult(result);
        },
        options,
      );
    } finally {
      stopTyping();
    }
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
    return this.handleText(text, message.reply_to_message);
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
    let name: string;
    let caption: string | undefined;
    try {
      fs.mkdirSync(dropDir, { recursive: true });
      name = freeName(dropDir, wanted);
      await this.deps.telegram.download(piece.file_id, path.join(dropDir, name));
      caption = message.caption?.trim();
      if (caption) {
        const note = freeName(dropDir, `${name.slice(0, name.length - path.extname(name).length)}.md`);
        fs.writeFileSync(path.join(dropDir, note), `${caption}\n\n![${name}](${encodeURI(name)})\n`, "utf8");
      }
      this.log(`file received: ${name}${caption ? " (with caption)" : ""}`);
      await this.reply(t.received(name, path.basename(dropDir)));
    } catch (error) {
      this.log(`file not received: ${describe(error)}`);
      return this.reply(t.failed);
    }
    // A caption is a request of the owner about the file: it goes to the chat, with the file's path.
    if (caption && this.chat.configured) {
      return this.converseAboutFile(caption, path.join(dropDir, name), photo ? "photo" : "document", dropDir);
    }
  }

  /**
   * The caption of a received file, as a message of the owner to the chat. Like
   * any message that is not a yes it drops the actions held for confirmation.
   * The file's content is an untrusted read: the chat service holds the
   * actions that follow it for a yes.
   */
  private async converseAboutFile(caption: string, file: string, kind: "photo" | "document", dir: string): Promise<void> {
    if (this.questions.heldActions()) {
      this.questions.clear();
      this.log("held chat action(s) dropped");
      await this.reply(strings.assistant.actions.dropped);
    }
    this.log(`caption of ${path.basename(file)} sent to the chat`);
    return this.converse(strings.assistant.files.attached({ caption, file, kind }), { attachmentDir: dir });
  }
}
