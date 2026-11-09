# Architecture

MyHQ is a local app: a Next.js server, a SQLite file, a small MCP server, and
`claude -p` processes started on demand. This document describes how a run
works, what the app stores, how the work is split into delivery slices, and
how the assistant on Telegram works.

## 1. How it runs

### A run

A run is one `claude -p` process started by the app for one agent. The command
is built from the room and role definition in the home directory:

- `--append-system-prompt-file`: the role prompt (`roles/<agent>.md`).
- `--model`: the model of the agent (`opus`, `sonnet` or `haiku`), or the one
  its `modelFor` gives for the motive of the run, or its prepare command's.
- `--effort`: the agent's `effort`, when it has one (or its prepare
  command's for this run).
- `--exclude-dynamic-system-prompt-sections`: the CLI's per-machine sections
  (working directory, environment, git status) go to the first user message
  instead of the system prompt, so the system prompt of an agent stays the
  same from run to run and is read from the cache.
- `--allowedTools`: the agent's whitelist of tools. A write rule loses its
  path on the way (`Write(models/**)` is passed as `Write`): the paths are
  enforced by MyHQ's write guard (see "The write guard" below), not by the
  CLI. Every other rule (`Bash(git *)`, `mcp__hq__*`) is passed as written.
- `--output-format stream-json --verbose`: the event stream (`--verbose` is
  required in print mode). It animates the room and feeds the activity log.
- `--mcp-config`: a JSON file generated per run, with the HQ MCP server and
  the extra servers the agent is allowed to use.
- `--max-budget-usd`: the cap on the cost of one run.
- `--strict-mcp-config`: only the servers of that file, none of the user's.
- `--setting-sources project,local`: the user's personal settings (hooks,
  plugins) do not run inside agents. The local settings of the working
  directory carry the write guard's hook.
- `--disallowedTools`: deployment and schema push commands, denied to every
  agent whatever its whitelist says, plus the agent's own `disallowedTools`.
- `--add-dir`: the directories the agent may read besides its working
  directory (`addDirs`, by default the target repository for an agent that
  reads files and has no worktree). They are read-only: the write guard
  refuses any write there.
- `--tools`: only the built-in tools of the whitelist exist for the agent
  (none when it only uses MCP tools), so nothing outside it can run.

The process starts in the agent's own working directory and receives the run
context through environment variables (`HQ_DB_PATH`, `HQ_RUN_ID`,
`HQ_AGENT_ID`, `HQ_ROOM`, and `HQ_WORK_DIR`, the working directory that
`hq_submit` reads attachments from); the app's own variables, Telegram token included,
are never passed on. The one exception is `HQ_CLAUDE_OAUTH_TOKEN`: when set,
it becomes the process's `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from
`claude setup-token`, to run unattended on a subscription). Tool search is
turned off (`ENABLE_TOOL_SEARCH=false`) so that the MCP tools are listed from
the start. MCP startup is made blocking (`MCP_CONNECTION_NONBLOCKING=0`,
`MCP_CONNECT_TIMEOUT_MS=60000`): by default CLI 2.1.183 connects the servers
in the background and sends the first request at once, so a server slower to
start than the CLI is still `pending` and the agent works without its tools
(it then writes tool calls as text and invents a result). The runner checks
the start event too: when a server listed there is not `connected`, the run
is stopped at once, before its first event is read, and fails with the end
reason `mcp_not_connected`; it is started again once, a few seconds later,
with the same task and the tasks it had claimed. Only a second failure (or a
retry that cannot start) is alerted, like any other failed run. The prompt of
a room agent's run gives what MyHQ already knows, so that the agent spends no
model call to ask for it: the user's new decisions on its submissions (marked
seen, as `hq_read_decisions` does; given back when the run stops before it
reaches the model) and its role memory (the values of `hq_memory_read`, up to
20 000 characters, the keys beyond only named). It tells the agent that MyHQ
closes its task with its final message (a run that ends well marks its tasks
`done`), so that `hq_task_update` is only called to report `blocked`. An
agent with a `prepare` command gets it run first, which may skip the turn or
add context (`home-layout.md`, "Run options"). The prompt of
every run ends with today's date, the weekday spelled out in the home's
`language` and the time zone of `HQ_TIMEZONE`, so that no agent works the
weekday out by itself. The Claude Code binary is not
modified and runs on the user's own plan, which is the frame the subscription
terms allow. There is no Agent SDK.

`--max-turns` does not exist in CLI 2.1.183: the per-run cap goes through
`--max-budget-usd`. Check the flags again when the CLI version changes.

**The per-run MCP config does not outlive its start.** The `--mcp-config` file
(`data/runs/<run id>.mcp.json`) holds the `${NAME}` placeholders already
expanded, so the mail passwords and other secrets of the home are in it in
clear. It is written with owner-only permissions where the OS has them (mode
`0600`; Windows ignores it) and deleted by the runner, never kept:

- as soon as the `system`/`init` event arrives. With blocking MCP startup the
  CLI emits it after it loaded the file and connected its servers, so nothing
  reads the file after that (deduced from the startup order, not instrumented);
- in any case when the run ends (the `finally` of the runner): success,
  failure, engine error, abort, timeout, or a run that never sent an init
  event;
- when the app process exits with runs in progress (the exit hook).

The retry of a run stopped for an MCP server not connected is a new run with
its own id: it writes its own file and deletes it the same way. A deletion
that fails (a file still held open) is tried again at the end of the run, and
the startup sweep catches what remains. At startup the app also deletes every
`data/runs/<number>.mcp.json` left by earlier versions or by a crash (it logs
how many); no other file of that folder is touched. The run journal
(`<run id>.jsonl`, the stream-json lines) and the `events` table hold no
expanded secret: they carry server names and statuses, not the config. The
assistant chat per-turn config (`data/assistant/chat/`) gets the same
owner-only mode and is deleted after its turn.

### Engines

A run is executed by an engine behind a single interface, roughly
`run(input) -> AsyncIterable<RunEvent>`. There is one engine at first,
`ClaudeEngine` (`claude -p`). A second engine, `LocalEngine`, is planned in the
interface from the start but not implemented: an OpenAI-compatible endpoint
(Ollama, LM Studio) on a machine of the user. It would take sorting, watching,
summaries and first drafts, while Claude keeps the final writing of anything
published, analysis and code. Enabling it is a decision taken on measurements,
not on intuition: every run records its tokens and estimated cost (the
stream-json output provides them), and the app shows the share of the plan
consumed by runs over the week.

### The HQ MCP server

A stdio MCP server, shipped in the app, is the agents' only door to the office.
It reads its context from the environment (database path, run id, agent id,
room) and writes directly to SQLite. Eighteen tools, all validated with zod:

| Tool | Purpose |
|---|---|
| `hq_message(to, text, room?, expects?)` | Send a message to another agent: of the sender's room, or with `room` of a shared room or of a room that ordered from the sender's (see "Shared rooms"). `expects` (`reply`, `action`, `none`) says whether it must wake the recipient (see "The portier"). |
| `hq_submit(type, title, body, payload, forRoom?)` | Submit an item to the approval queue (an informational type of `notifyTypes` is stored `unseen` and waits under « À regarder », see section 5; `"urgent": true` in its payload sends its alert even during the quiet hours). `forRoom`: a shared room's delivery to the room that ordered it. `attachments`: files to validate with the item (see "Files joined to an item"). `onApprove`: messages MyHQ delivers itself when the item is approved (see "Executing an approved item"). |
| `hq_ask(title, context?, questions)` | Ask the owner questions when a decision of theirs is truly needed to go on (see "Questions from the agents"). `questions`: at least one (20 at most, a technical guard), each `{ question, header?, options: 2 to 6 of { label, description? }, multiSelect? }`. MyHQ always adds an « Autre » answer with free text. The agent finishes its turn after asking; the answers wake it with a new task. |
| `hq_status(text)` | Say in a few words what the agent is doing (60 characters at most, the home's language, no technical detail): at the start of the run and at each notable step. Stored with its time and its run (`run_statuses`, migration 21), it writes nothing else (see "The activity bubble"). |
| `hq_task_update(status, note)` | Report the state of the current task. |
| `hq_read_decisions()` | Read the user's decisions not yet seen by this agent (each one is given once). |
| `hq_memory_read(key)` | Read a value of the agent's role memory. |
| `hq_memory_write(key, value)` | Write a value of the agent's role memory. |
| `hq_pending()` | List the items waiting for the user's decision, in every room, oldest first: id, room, agent, `forRoom`, type, title, `submittedAt`, never the body. Read-only, for agents that write a brief or a recap. |
| `hq_items(id?, status?, type?)` | Read the state of items at any time (read-only, it marks nothing seen). With `id`: the `body` (cut to `maxChars`, 20000 by default and 60000 at most, `bodyTruncated`), type, title, `status`, `decidedAt` and `note` of the decision, `remarks` (the annotations, with their points), producing `room` and `agent`, `forRoom`, and `files` (name and, when the copy is on disk, its `path`). Without `id`: the recent items (30 days, by last activity, newest first, at most 50, `truncated` when more) that the agent may read, filtered by `status` and `type`. See "Reading the state of an item". |
| `hq_rooms()` | List the shared rooms and their agents (id and name): the studios an agent may order from. Read-only. |
| `hq_suggest_agent(need)` | For an order nobody in the office can do: the need goes to the receptionist, which proposes a new agent to the user (see "Proposing a missing agent"). At most one per need text in 24 hours. |
| `hq_blocked()` | Supervisor only: read the Standard, every entry but its own (see "The supervisor"). Read-only. |
| `hq_relaunch(kind, id, message?)` | Supervisor only: « Relancer » an entry of the Standard, with its guards, once per task. |
| `hq_blocked_note(kind, id, text, handOff?)` | Supervisor only: a sentence for the owner on an entry of the Standard; `handOff` hands it to the owner. |
| `hq_run_status(runId)` | Supervisor only: a run as it checks it, with MyHQ's hints on its activity (see "Long runs"). Read-only. |
| `hq_run_extend(runId, minutes)` | Supervisor only: 10 to 60 more minutes for a long run, never past its hard limit. |
| `hq_run_stop(runId, reason)` | Supervisor only: interrupts a stuck run, with the reason shown on the Standard. |

Everything an agent wants to show or have approved goes through this server,
so everything is logged.

With `HQ_READ_ONLY=1` the server needs no `HQ_RUN_ID` and registers only
`hq_memory_read` and `hq_items`: it is how a question to an agent reads its
memory and the items (see "Questions to an agent").

**The database is shared by several processes.** The app and the HQ MCP
server of every run open the same SQLite file, each connection in WAL mode
with a busy timeout of 10 s (`openDb`, `BUSY_TIMEOUT_MS`, set before anything
else). The timeout only covers a statement that starts outside a transaction
or a `BEGIN IMMEDIATE`: a deferred transaction that reads, then writes, fails
at once with `SQLITE_BUSY` ("database is locked") when another process wrote
in between, whatever the timeout. So every transaction that writes after a
read is `.immediate()` (`hq_read_decisions`, `hq_submit`, `hq_message`, the
decisions, the start of a run). A tool that meets a database error returns an
explicit error result (`toolErrorText`): it says that nothing was read or
written, that it is not an empty result, and to call the tool again, never to
submit the item a second time. `hq_submit` also refuses an obvious duplicate:
an item of the same agent with the same type, title and body that is still
waiting (`pending`, `unseen`) or was approved in the last 24 hours is not
stored again; the answer gives its id, its status, `duplicate: true` and a
note. The receptionist's proposals are not concerned (they are checked when
approved).

**The server runs from a frozen copy.** Each run starts this server, and it
opens the database in service and migrates it. Started from the sources of the
repository folder, it would run whatever is in that folder at that moment:
the uncommitted code of an agent (or of the developer) working there would run
in production. So `npm run build` ends with `scripts/build-mcp.ts` (esbuild,
a development dependency), which bundles `src/mcp/server.ts` and the app
modules it imports into `build/mcp/server.mjs`, next to a copy of
`templates/roles` (the folder is ignored by Git). The npm packages stay
external and are read from `node_modules` (`better-sqlite3` is native). The
runner (`hqMcpServerCommand`) starts that copy with `node build/mcp/server.mjs`,
so a deployment is what runs, until the next `npm run build`. The new copy is
built beside the old one and swapped in, and a failed build keeps the old one.
When the copy is missing (development, tests) the runner falls back to the
sources through tsx and logs a warning once per process (`no frozen HQ MCP
server`): seeing it in the service's logs means the build was not run. The
assistant's chat never starts this server (its per-turn config holds only the
chat's own servers), and `npm run mcp` still runs the sources by hand.

### Reading the state of an item

`hq_read_decisions` gives a decision once, then marks it seen: a later run that
needs to know where an item stands (« is the revised script approved? ») had no
way to look it up, forgot, and told another agent that nothing was approved
while the item had been for hours (a social agent held a whole chain this way).
`hq_items` is the read-only answer: it can be called any number of times, and
it never marks anything seen nor touches `seen_by_agent_at`.

- **By id** (`hq_items { id }`): `id`, `type`, `title`, `status` (`pending`,
  `approved`, `rejected`, `revise`, `unseen`, `seen`), `room` and `agent` (the
  producer), `forRoom`, `submittedAt`, `decidedAt`, `note` (the decision's
  general note), `remarks` (the annotations: `quote`, `comment` and, for a
  remark on a file, its `point`), `files` (each `{ name, path? }`) and the
  content: `body`, cut to `maxChars` (default 20000, at most 60000, `maxChars`
  being only for a read by id) with `bodyTruncated` when it was cut. This is
  what lets an agent read the text of an approved item it did not write (the
  script a studio must produce from). `path` is the absolute path of MyHQ's
  frozen copy, `<home>/data/attachments/<approvalId>/<fileId><ext>`, given only
  when the file is on disk: read it, never change it (whether the agent's tools
  may open it is up to its `allowedTools`).
- **List** (`hq_items {}`, optional `status` and `type`): the items active in
  the last 30 days (created or decided), newest first, at most 50 (`truncated`
  says when there were more). Each entry: the same fields without `note`,
  `remarks`, `files` and the body. `status`, `type` and `maxChars` do not
  combine with the wrong mode (the filters with `id`, `maxChars` without it).
- **Who may read what.** An agent reads the items of its room (which includes
  the ones it produced), and those delivered for its room (`for_room`) by a
  shared room. An agent of a shared room also reads the items of the rooms that
  ordered from its room, traced by the tasks of its room that came from a
  message of another room (`tasks.from_room`): a studio sees what its
  requester approved. A room that is not shared never gains access to a studio
  by being answered by it. Anything else is a tool error that says the item is
  out of reach (which says nothing about its status), distinct from « No item
  #N exists ».
- **Prompts.** Every run prompt ends its tool presentation with: before saying
  that an item is not approved, or does not exist, check it with `hq_items`,
  and read the content of an item with `hq_items` and its id. It also asks for
  the final report in the language of the home (`language` in `myhq.json`,
  English by default), whatever the language of the task or of the role.

### Routines

An internal scheduler (`src/server/routines.ts`) starts runs at set times from
the `cron` of each agent in `room.json`: one expression (the routine work of
the role), or a list of `{ "cron", "task" }` (several routines, each with its
own task). A button, `/run` and the API start one by hand. The cron parser is
MyHQ's own (`src/server/cron.ts`, five fields with ranges, steps, lists and
names, the classic day-of-month or day-of-week rule): MyHQ only needs "does
this minute match" and "when is the next one", not a scheduling library.

- **Switch.** Nothing starts by itself until `HQ_SCHEDULER=on` (default
  `off`). The scheduler starts with the app and is held by one process per
  home (`data/scheduler.lock`), so a second MyHQ on the same home does not
  fire twice.
- **Time zone.** Expressions are read on the wall clock of `HQ_TIMEZONE`
  (an IANA name, the machine's zone by default). A minute skipped by a
  daylight saving change does not fire; a repeated one fires once.
- **Armed.** Each agent's routines are armed or not. `armed` in `room.json`
  is the initial value (default `false`); once changed from the agent's card
  (switch) or from Telegram (`/arm <room>/<agent>`, `/disarm`), the value
  stored in the database (`agents.armed`) wins. A disarmed routine that comes
  due is journaled as `skipped_unarmed` and starts nothing.
- **Guards.** A firing goes through the same code as any run: one run at a
  time per agent (lock) and the daily cap on the total number of runs
  (`HQ_MAX_RUNS_PER_DAY`, conservative default). Start with a few armed
  agents and raise the cap after a week of measurements.
- **No catch-up.** The scheduler re-reads the home every 15 seconds (a room
  edited by hand or added by onboarding is picked up without a restart) and
  plans each routine from the moment it first sees it. A routine found more
  than five minutes late (machine asleep, app stopped) is dropped.
- **Journal.** Every firing writes a row to `routine_firings`: agent, cron,
  task, scheduled time, outcome (`started`, `skipped_busy`, `skipped_cap`,
  `skipped_unarmed` or `error`) and run id. The interface shows the latest
  ones, `GET /api/routines` returns them, `/status` lists the last five.
- **Budget share.** With `HQ_WEEKLY_BUDGET_USD` (the user's own calibration
  of his plan), the meter and `/status` show the share of it spent by the
  runs of the week (Monday to today).

### Per-agent options

- `worktree`: a Git worktree of the target repository inside the home
  (`git worktree add`, branch `hq/<agent>`), created before a run when it is
  missing, and on approval of an onboarding proposal. The agent works in it.
- `disallowedTools`: added to the global deny list for this agent (for a
  developer: `git push`, merges, migrations, deploy commands).
- `addDirs`: directories passed as `--add-dir`. An agent that reads files
  (`Read`, `Glob` or `Grep` in its whitelist) and has no worktree reads the
  target repository by default.
- `resources`: shared resources its runs hold, such as `gpu` (see "Shared
  resources" below).
- `supervisor`: the supervisor of the Standard (see "The supervisor" below).

### The approval cycle

A submission creates an item in the `pending` state. The user can:

- **approve**: the item becomes `approved` and the handler of its type runs
  (for example: mark a draft as scheduled, copy a reply to the clipboard and
  open its thread, or merge a pull request through `gh`);
- **reject**: the item becomes `rejected`, with a reason;
- **revise**: the item goes back to the agent as a new task, with the user's
  comment (`revise` state), and the agent is woken at once (see "Wake-ups").

A decision can be reconsidered: an `approved` or `rejected` item can still be
sent back with a revise (`PATCH /api/approvals/[id]` with `revise`), and an item
already in `revise` accepts another one only if its note or remarks differ.
The decision the item had goes to `approvals.decision_history` (JSON, oldest
first, `decisionHistory` in the API), the new revise replaces it, and the
agent reads it through `hq_read_decisions` like any other (the item is unseen
again). Approving and rejecting stay final. A revision does not undo the
approval's effects: when the agent already executed the item (`onApproval:
"task"`, its task done), the desk says so (`actionDone`) and warns that the
action, a sent mail for example, cannot be undone.

**Informational items.** An item of a `notifyTypes` type (a mail alert, a brief)
asks for no decision, but it must not vanish either, so it has its own
life cycle: `hq_submit` stores it `unseen` (marked as read by its agent, no
`decided_at`), and « Vu » moves it to `seen`, where it stays in the history.
It is never `pending`: `decideApproval` refuses it (`APPROVAL_NOT_DECIDABLE`),
`hq_pending`, `/pending`, the preamble and the `À valider` count do not see it,
`hq_read_decisions` never returns it, and since no task is written for it, no
wake-up (`wakeAgents`) is ever triggered by it or by « Vu ». Migration 11
widened the `status` constraint of `approvals` (a table rebuild, as for `tasks`)
to add `unseen` and `seen`; the items stored before it, born `approved` with the
note « notification » (and `decided_at = created_at`), stay as they are, read as
`informational` and shown in the history. The desk shows the `unseen` ones in a
section « À regarder (n) » above the tabs, the tab title counts them apart
(« (2) (1 à regarder) MyHQ »), and each one has two actions: **Vu**
(`POST /api/approvals/[id]/seen`, `markApprovalSeen`, idempotent) and
**Demander à Rom2**, a small box pre-filled with « Prépare une réponse à ce
mail » that sends the request to the chat (`POST /api/approvals/[id]/ask`, the
same `ChatService.ask` as `POST /api/chat`, channel `desk`, the reply lands in the
conversation panel) with the item's id, type, title, agent, room and body
(cut at 8000 characters) as context, then marks the item seen. A chat that does
not answer (budget, timeout) leaves the item in « À regarder » and the reason is
shown.

On the desk, a pending item has **one main button** next to a discreet
« Refuser ». With no general comment and no remark on a passage it reads
« Approuver » and approves; as soon as the field « Commentaire pour l'agent
(facultatif) » (always there) holds a text, or at least one remark is drafted,
it reads « Envoyer à retravailler » and sends a `revise` carrying them
(`primaryDecision` in `src/ui/primary-decision.ts`). Approving can therefore
never drop a draft remark silently. « Refuser » opens its own field, « Motif du
refus (obligatoire) ». The history items have « Demander une révision », which
opens the annotation list (the drafts kept for that item) and the general
note.

On the desk, a revise (or a reject) can also carry **annotations**: selecting a
passage of the body offers « Annoter », which opens a comment box under the
passage; the remarks are listed in « Remarques (n) » beside the body (under it
on a phone) and their passages are highlighted. They live in the page until
the decision is sent, nothing is stored before. Once sent they are stored with
the decision (`approvals.annotations`, JSON), shown read-only on the history
item, and written for the agent, as a numbered list then the general note, in
the revision task and in the `note` that `hq_read_decisions` returns (see
`api.md`, `PATCH /api/approvals/[id]`). A passage is identified by its text in
the *rendered* body and its offset there (`position`), so a sentence that
occurs twice maps to the right one. With annotations, the general comment of a
revise is optional.

The same decision can be taken from Telegram, with the same effect as in the
office, except that annotations are not available there: a decision taken from
Telegram carries its note only, and a revise with annotations made on the desk
changes nothing on Telegram. The alert has two buttons, Approuver and Refuser;
a revision is a **reply** (Telegram's « Répondre ») to the alert with a text,
which becomes the note of the `revise` (the item is found from the `(#id)` tag
in the first line of the replied message, see `src/assistant/replies.ts`; a
reply to an item that is no longer pending, or to a message without a tag, is
an ordinary message to the chat).

#### Questions from the agents

`hq_ask` lets an agent ask the owner questions instead of guessing or
submitting a deliverable at random. The role of the agent decides whether it has
the tool (`mcp__hq__hq_ask` in `allowedTools`, or `mcp__hq__*`); the prompt of
every run (`buildPrompt`) carries a short rule: ask only what blocks you,
concrete options, all the questions at once, then finish the turn.

An asked set of questions is one item of the approval queue (`src/server/questions.ts`):
type `question`, status `pending`, the questions (and the agent's optional
`context`) in the payload, a readable text of them in the body (for the history
and the search). The same questions (title and text) still waiting, or answered
in the last 24 hours, are not asked twice. The supervisor of the Standard and
the receptionist cannot ask.

- **On the desk** the card shows the context, then each question with its
  options (radio buttons, check boxes for `multiSelect`) and « Autre » with a
  text field. « Répondre » is enabled when every question has an answer
  (`src/ui/question-model.ts`). The main button of the other items does not
  apply. « Refuser » (with a reason) stays for a question that has no place.
- **Answering** is approving the item with `answers` (`decisionSchema`,
  `PATCH /api/approvals/[id]`, see `api.md`): checked against the questions,
  kept in `payload.answers` and, as « Q : ... / R : ... » lines, in the
  decision note, and it gives the agent a `revise` task holding its questions
  and each answer, so the agent is woken exactly like for a revision (same
  reason `revise`, same `onRevise: "queue"` opt-out, same lock and daily cap).
  No approval task, command or relay runs. A question is never sent back
  (`QUESTION_NOT_REVISABLE`).
- **On Telegram** the alert is a first message (who asks, the title, the
  context, the « Ouvrir » link, a « Refuser » button), then one message per
  question: the numbered options, and a button per option (a multi-select
  question ticks them, then « Valider la sélection »). Pressing an option answers
  a single-select question and shows the answer on its message. « Autre » is a
  reply to the question's message with a text (on a multi-select question,
  together with the options ticked). The answers given are kept (in memory, for
  the items still open) until the last question is answered, when the item is
  answered as on the desk. A question message is found from the `(#12, 2/3)`
  tag of its first line, so a reply works after a restart. Without
  HQ_TELEGRAM_POLLING the messages carry no button and send the owner to the desk.

#### Folded items on the desk

Every item of the desk (the `À regarder` ones, the pending ones and the history)
is folded by default into one compact line, which is a real button
(`aria-expanded`, so Enter and Space work): the colour chip of its room, the
agent, a type label, the title, a one-line excerpt and the age (« il y a 2 h »,
refreshed each minute; the date of the decision for a history item). The excerpt
(`src/ui/excerpt.ts`) is the first meaningful line of the body read from the same
Markdown tree the body is rendered from (Markdown stripped, first non-empty
heading, paragraph, list item, quote, code or table line), cut at about 120
characters on a word. On a phone the line wraps in two (who, type and age, then
title and excerpt). Clicking it unfolds the whole item as it always was (body,
annotations, the main button, « Demander une révision », every action); an
unfolded body stays mounted when folded again, so a note being typed is kept.
Which items are unfolded is held by the desk by id, so a refresh from the live
stream, a switch of tab or a decision elsewhere never folds an item the user
opened. A deep link `/bureau#approval-<id>` unfolds its item and scrolls to it, and
« Tout déplier / Tout replier » acts on what is on screen.

#### Acting on an approved item

The user posts replies himself, so an approved item has to hand him the text
and the thread. The rule is generic: it applies to any approval whose
`payload.url` is an http(s) link (other URLs are ignored), and it never posts
anything on its own.

- **On the desk**: every such item, pending or in the history, has a
  « Copier le texte » button (it copies the body with
  `navigator.clipboard.writeText`, called inside the click handler; without
  clipboard access it falls back to the legacy copy command, then to showing the
  text selected; the button briefly confirms) next to « Ouvrir le lien ». After
  a click on Approuver the desk shows the history, where the approved item
  carries both controls in a highlighted block with the hint « Copié ? Colle-le
  dans le fil. ».
- **On Telegram**: when such an item is approved (button or `/approve`), once
  the alert message is edited (or the `/approve` answer sent), the assistant
  sends one plain message that is exactly the body (cut at 4000 characters like
  every message, no Markdown stripping, so it can be copied as is), then one
  message with the link. Items without a link only get the decision.

No API change: the body and `payload.url` are already in the approval DTO.

#### Pull requests and blog posts on a branch

Agents never push. A developer agent (or a writer that commits articles)
commits on a local branch of its worktree, `hq/<agent>-<slug>`, and submits a
`pull_request` (or `blog_post`) item whose payload carries
`{ "branch", "sha", "title", "summary" }`, never a pull request number.
Approving it merges nothing and pushes nothing; it hands over, like an item
with a link:

- **On the desk**: the pending item shows its branch and commit; once
  approved, a highlighted block gives the branch, the commit and the two
  commands to run from the target repository, with « Copier la commande »:
  `git push -u origin <branch>` and
  `gh pr create --head <branch> --title "<title>" --body "<summary>"`.
  The title and summary are flattened to one line without quotes or
  expansion characters, so the line runs as is in sh, PowerShell or cmd. A
  branch name that is not a plain Git ref gets no hand-over.
- **On Telegram**: after the decision, one message with the branch and the
  commit, then one message that is exactly the two commands.

The user pushes, opens the pull request and merges himself.

#### Room proposals

Approving a `room_proposal` (see section 3) is the one decision that writes
something: the room in the home. If that fails (a room of that name exists,
the proposal is invalid, a worktree cannot be created), nothing is written,
the item stays pending with an explicit error, and it can still be rejected.
The proposal's "HQ agents" block for the project's `CLAUDE.md` is never
written by MyHQ: the desk shows it with « Copier le bloc », and Telegram sends
it as a message of its own after the decision.

#### Agent proposals

Approving an `agent_proposal` (see "Proposing a missing agent") writes
`rooms/<room>/roles/<id>.md` and appends the agent to that room's
`room.json`, routines disarmed, creates its worktree when it has one, and
syncs the home: the agent is live without a restart. A room that is not in
the home (`ROOM_NOT_FOUND`), an id or a role file already taken
(`AGENT_EXISTS`), or a room that would be invalid (`AGENT_PROPOSAL_INVALID`,
for example a working directory outside the home) leave the room exactly as
it was, and the item stays pending with the error, as for a room proposal.

#### Executing an approved item

An agent whose `room.json` sets `onApproval: "task"` acts on its own approved
items: approving one creates the task « Exécute l'item approuvé n° <id> :
<title> » (one per approval, source `approval`) and wakes the agent (below).
The agent finds the task in its prompt and acts through its own tools, for
example an MCP server of the home that reads `data/hq.db` (through the
`${HQ_DB_PATH}` placeholder), checks that the item is approved and sends it.
When the run fails, the item stays `approved` and the task goes back to the
mailbox for the agent's next run.

**Without a model turn.** A turn just to call `mail_send` or `cal_apply` on an
item the owner approved costs 15 to 20 s and a few cents for no judgement. With
`onApproval: "command"`, the agent names a command of its home
(`approvalCommand`, program then arguments, relative to the home), and MyHQ runs
it the moment the item is approved (`src/server/approval-command.ts`, started by
`decideApproval` after its transaction, in the background):

- the command reads `{ "item": { id, room, agent, kind, title, body, payload,
  note } }` on stdin (`note`: the owner's note of the approval), runs in the
  home with the agents' safe environment plus `MYHQ_HOME`, without a shell, for
  120 s at most;
- exit 0 with `{ "ok": true, "note"?: string }` on stdout executes the item: its
  `approval` task is written `done` with the note, so `actionDone` holds, and
  the DTO's `actionNote` (shown on the approved item of the desk, « Exécuté par
  MyHQ : ... ») carries the note. No run, no wake-up;
- anything else falls back to `"task"`: the task is written pending with the
  error under its text and `wakeAgents` wakes the agent (`wakesAgent` treats
  `"command"` like `"task"` for an approval task, which only exists then).

Each command run is one row of `approval_commands` (`ok`, `note`, `error`, its
start and end).

**Orders on approval.** An item that must go on to another agent (Social's
approved script, to the studio that produces it) says so at submission:
`hq_submit` `onApprove: [{ to: "room/agent", text }]`, its recipients checked
then as `hq_message` checks them, stored in `approval_relays`. On approval,
within the decision's transaction, `deliverRelays` writes each message in the
submitter's name with the item's title, body and files (the paths of MyHQ's
copies) appended and `expects: "action"`, so the recipient is woken without the
portier, and has it in hand: no turn is lost asking for « the text of #39 ».
The submitter gets no approval task for it (its `onApproval` `"task"` or
`"queue"` is not applied; a `"command"` still runs). The messages are delivered
once (`delivered_at`); an informational item records none.

#### Files joined to an item

An agent that delivers a render (a video, an image, a sound, a 3D part, a PDF)
joins it to its item: `hq_submit` takes `attachments: [{ path, caption? }]`
(at most 10), so that the owner validates the render itself from the desk or
his phone, not a description of it.

- **Checked before anything is written** (`src/server/attachments.ts`): a path
  relative to the agent's working directory (`HQ_WORK_DIR`, its worktree when
  it has one). An absolute path (POSIX, drive letter or UNC), a `..` segment,
  or a link that leads out once resolved (`realpath` of the file outside the
  `realpath` of the directory) is refused, as is a missing file, an empty one,
  an extension outside the list (mp4, webm, mov; png, jpg, jpeg, webp, gif;
  wav, mp3, ogg, flac, m4a; 3mf, stl, glb; pdf) and a file above the cap
  (`HQ_ATTACHMENT_MAX_MB`, 200 MB by default). The error tells the agent what
  to do (copy a render made elsewhere into its directory first), within the
  same run.
- **Copied at submission.** Each file is copied to
  `<home>/data/attachments/<approvalId>/<fileId><ext>` in one pass that also
  computes its sha256, inside the transaction that inserts the item: a failed
  copy leaves neither item nor files. What the owner validates no longer
  changes when the agent touches its file again. The name on disk is built
  from integers and the whitelisted extension; the original name, the MIME
  type (from the extension), the size, the sha256 and the caption are in
  `approval_files` (migration 13, no foreign key so that a rebuild of
  `approvals` never cascades onto it). Migration 14 creates the same table
  and index with `IF NOT EXISTS`: the database in service had reached version
  13 through an abandoned draft of that migration, so the real one never ran
  there. A new database goes through 13 then 14 (which changes nothing); the
  one in service gets the table at 14, and both end with the same schema.
- **Served by id.** `GET /api/approvals/<id>/files/<fileId>` looks the file up
  by both ids and serves the copy with its MIME type and range requests (206),
  which Safari on iOS needs to play and seek in a video. No path from the
  request reaches the disk. The approval shape lists the files (`files`).
- **On the desk** (`src/ui/attachments.tsx`, drawn by the item card, so on
  every pending and history item): above the body, a video player
  (`controls`, `playsInline`, `preload="metadata"`), an image that opens in
  full in a dialog (a CAD agent's `<part>_planche.png` included), an audio
  player, a 3D viewer for a part (below) and a download link for a PDF, with
  its preview when the agent joined an image of the same name (`fiche.png`
  for `fiche.pdf`; `piece.png` for `piece.3mf` is shown while the part loads;
  that image is then not shown on its own).
  Under a video or a sound, « Annoter à cet instant » pauses the player and
  opens the remark box of the annotations with the quote « <file> à <time> »
  (« clip-01.mp4 à 0:12 »). The remark joins the others (no `position`, so it
  comes after the remarks on the text) and a revision sends it to the agent
  in the numbered list, as any remark.
- **A remark on a point of an image or of a video's frame**: « Annoter un
  point » under an image (and in its enlarged view), then a click or a tap on
  the image, pins the point and opens the remark box with the quote
  « cover.png, point à 62 % de la largeur et 18 % de la hauteur ». The point is
  stored as shares of the image's own width and height from its left and top
  edges (`{ fileId, kind: "image", x, y }`, kept to the thousandth): the click
  is measured against the box where the picture is drawn, so the same spot
  gives the same point in the preview, on a phone and in the enlarged view.
  The same button under a video pauses it and takes the next click on the
  paused frame (the player's controls are under a transparent layer until
  then): the point carries the time (`{ fileId, kind: "video", x, y, t }`, `t`
  in seconds, to the millisecond) and the quote says both (« clip-01.mp4 à
  0:12, point à 40 % ; 70 % »). A video is drawn whole in its player
  (`object-fit: contain`), so the bands beside or above the frame are left out
  of the measure and a click on them pins nothing (`containBox` and
  `pointInPicture` in `src/ui/attachments-model.ts`). « Annoter à cet instant »
  stays for a remark on the moment with no point. The pins of the remarks are
  drawn over the picture, numbered as in « Remarques (n) », in the preview and
  in the enlarged view; on a video a pin shows while the playback is within
  half a second of its time (the player reports its time about four times a
  second), or when its remark is open. A click on a pin opens its remark (and
  brings the video back to its time, paused); in the list of remarks, « Voir
  le point » does the same for any remark on a point (an image, a video, a 3D
  part): its file comes into view and its remark opens. The revision task
  gives the agent the point under the remark, in percent from the left and top
  edges, with the time for a video (see `api.md`).
- **The 3D viewer** (`src/ui/model-viewer.tsx`, `src/ui/model-load.ts`) draws a
  3MF, an STL or a GLB with three.js, the second runtime dependency of the UI
  after PixiJS, pinned to an exact version. `attachments.tsx` loads it with
  `next/dynamic` and `ssr: false`, and each format's loader (`ThreeMFLoader`,
  `STLLoader`, `GLTFLoader`) is a further dynamic import: three.js is fetched
  only when an item shows a part (about 185 kB gzipped for a 3MF, measured on
  the build), never on the other pages. The part is read in its own frame, the
  one of build123d and of the slicers: millimetres, Z up. A 3MF says its unit
  (`<model unit>`, millimetre by default, read from the package with three's
  copy of fflate), an STL is in millimetres, a GLB (metres, Y up) is scaled by
  1000 and turned so that its Y is Z. The part is set on a grid (centred in X
  and Y, its lowest point on the plane, a power of ten per cell), with its
  overall dimensions in millimetres (X × Y × Z) and the grid step. It turns,
  zooms and moves with the mouse or the fingers (`OrbitControls`); « Face »,
  « Dessus », « Côté » and « Iso » turn the camera (the front is seen from -Y)
  and the corner button goes back to the initial view (iso). The light comes
  from the sky and from the camera, the edges sharper than 40 degrees are
  drawn, and the scene is drawn only when something moved. Without WebGL, or
  when a file cannot be read, the viewer says so and the download stays.
- **A remark on a point of a part**: « Annoter un point », then a click or a
  tap on the part (a press that moves turns the part instead). The point is
  found by a ray cast from the camera, then given in the part's frame,
  whatever its placement on the grid, with the normal of the face hit, turned
  towards the camera. The remark box opens with the quote « piece.3mf, point
  (12,4 ; -3,0 ; 8,5) mm, face +Z » (coordinates to the tenth of a millimetre;
  « face ±X/Y/Z » within 5 degrees of an axis, else « normale (0,71 ; 0,00 ;
  0,71) »). The remark is stored with its `point` (`{ fileId, kind: "model",
  x, y, z, normal }`, see `api.md`) in the same `approvals.annotations` JSON
  column: the field is optional, so no migration was needed and the remarks
  stored before read as they did. `kind` came with the points on images and
  videos; a 3D point stored before has none and still reads as a 3D point (the
  zod schema is a union of the three kinds, the 3D one with an optional
  `kind`). It comes after the remarks on the text, and the
  revision task gives the agent its exact point under it (see `api.md`). The
  pins of the remarks on that file are drawn over the part, numbered as in
  « Remarques (n) », dimmed when the part hides them; a click on a pin opens
  its remark (to change or remove it while the item is pending, read-only on
  the history).
- **On Telegram**, see section 5.

### Messages between agents

A message addressed to an agent creates a task for it, handled at once (a run
woken as below) unless the recipient has `onMessage: "queue"`, or the portier
lets it wait (below), in which case it waits for its next run. There is no
real-time dialogue between models: mailboxes, readable and cheap.

### The portier

Two agents that answer each other wake each other: on the day of the first
video, Social and Motion exchanged 21 « received » in 30 minutes, at about
0.45 $ for each wake of Motion on Opus. The anti ping-pong window spaces those
wakes out; the portier removes the ones that serve nothing. The idea is the one
of Claude Code's own subagents: a small model reads a short note instead of a
large model reading its whole context again.

`wakeAgents` asks `messageGate` (`src/server/portier.ts`) before it wakes an
agent for a pending `message` task, after the anti ping-pong window:

1. **The sender's word.** `hq_message` `expects` is stored per task in
   `message_wake`. `"none"` never wakes (the message waits for the next run),
   `"reply"` and `"action"` wake at once. Without it, a question mark in the
   message wakes at once.
2. **Off.** The portier off for the home (`myhq.json` `portier.enabled: false`,
   read at each wake-up) or for the agent (`room.json` `portier: false`): the
   message wakes, as before.
3. **The verdict.** A verdict already stored for the task decides: `wake` wakes,
   `skip` leaves the message in the mailbox.
4. **The call.** Otherwise the message waits while the portier reads it: one
   `claude -p` call (`--output-format json --model <portier.model> --system-prompt
   <short> --tools "" --strict-mcp-config --setting-sources project,local
   --effort low --max-budget-usd 0.05`, no `--mcp-config`, in a scratch folder
   of the system's temporary directory so that no `CLAUDE.md` of the home is
   read, with the agents' safe environment) for every pending message of the
   agent it has not read yet (10 at most). The prompt gives the recipient's
   name, the first paragraph of its role, the messages (2000 characters each at
   most, with their sender) and the rules: skip an acknowledgement, a thanks, a
   status that asks nothing; wake a request, an order, a question, a deliverable
   the agent waits for, a decision, an error; when in doubt, wake. The answer is
   one JSON line, `{"verdict":"wake"|"skip","reason":"..."}` (a leading `wake`
   or `skip` is read too). The verdict is stored in `portier_verdicts` (the
   tasks it covers, the reason, the model, the cost and tokens the CLI reports,
   the duration, the error), linked to each task in `message_wake`, and a `wake`
   calls `wakeAgents` again, which now starts the run.

A call in progress is remembered in the process (per database and task), so the
many `wakeAgents` calls of a run's tool results never start a second one. **It
fails open**: a call that cannot start, fails, takes more than 60 s, or answers
something unreadable is stored as a `wake` with its error, and the agent is
woken. An app that stops during a call loses nothing: without a stored verdict,
the next wake-up asks again.

A message that waits by design (`expects: "none"`, or a `skip` verdict) is taken
by the agent's next run, whatever starts it, and the Standard does not list it
as stuck (`waitsForNextRun`). `/reglages` shows the setting, the count and cost
of the last 7 days and the 20 latest verdicts (`recentVerdicts`).

A verdict costs a fraction of a cent: one call measured on Haiku 5.5 (an
acknowledgement, judged skip) read about 1300 tokens, wrote 133 and cost
0.00033 $ in 3.7 s, against about 0.45 $ for a wake of an agent on Opus. The
cost of each verdict is recorded with it.

Migration 18 adds `message_wake`, `portier_verdicts`, `approval_relays` and
`approval_commands`, idempotent as every migration after 14.

### Shared rooms

A room whose `room.json` sets `shared: true` is a studio every room may order
from (`home-layout.md`, "Shared rooms"). `syncHome` mirrors the flag into
`rooms.shared`, so the HQ MCP server, which only reads the database, knows it;
a room is one of the home when its `synced_at` is the latest one (every room is
written with the same instant), so a room removed from the home stops being
reachable.

- **Orders.** `hq_message` with `room` reaches an agent of another room when
  that room is shared, or when the recipient ordered from the sender's room:
  a task of the sender's room records who sent it (`tasks.from_room`,
  `tasks.from_agent`), and any agent of a studio may write back to an agent
  found there. Anything else is a tool error. The message is stored with the
  recipient's room (`messages.to_room`, null within a room) and becomes a task
  of the recipient (source `message`, so `wakeAgents` wakes it per its
  `onMessage`), whose text says who wrote and how to answer.
- **Deliveries.** `hq_submit` with `forRoom` (an agent of a shared room only,
  to a room of the home only) stores `approvals.for_room`. The item keeps its
  producing room and agent (`room`, `agent_id`): `decideApproval`,
  `hq_read_decisions`, revisions and `onApproval` work on them as for any item.
  What shows it by room uses the room that ordered: the spines and the colour
  of `GET /api/desk`, the desk card (« creation pour planygo »), the Telegram
  alert and `/pending`; the API gives `forRoom` for any other view that groups
  by room (`forRoom ?? room`).
- **Prompts.** Each run's prompt names the other shared rooms the agent may
  order from, and tells an agent of a shared room to deliver with `forRoom`
  and to answer with `hq_message` and the room that ordered. `hq_rooms` lists
  the shared rooms and their agents.
- The owner's requests (desk, chat, `/run`, `POST /api/runs`) reach any agent
  of any room, as before.

Migration 12 adds `rooms.shared`, `messages.to_room`, `tasks.from_room`,
`tasks.from_agent`, `approvals.for_room` and `runs.resources`, all nullable or
with a default, so the rows that exist read as before.

### Shared resources

An agent's `resources` (for example `["gpu"]`) are stored on each of its runs
(`runs.resources`, JSON) when the run is recorded. `launchRun` checks, in the
same immediate transaction as the agent lock and the daily cap, that no run in
progress holds one of them (`src/server/resources.ts`), and throws
`RESOURCE_BUSY` (409) otherwise. The waits are the ones of a busy agent:
`wakeAgents` and the chat requests leave the task pending, and since it is
newer than the agent's last run, the end of the run that holds the resource
(which calls `wakeAgents`) starts it; a routine is journaled `skipped_busy`;
a manual start returns the error. `GET /api/state` gives each agent its
`resources` and `waitingFor`, the resources another run holds while a task
waits in its mailbox, which the agent sheet shows (« En attente : gpu
occupé »). MyHQ only sees its own runs: work started outside MyHQ on the same
GPU is not part of the lock.

### Wake-ups

Agents work when they receive work. `wakeAgents` (`src/server/runner.ts`)
starts a run, at once, for each agent that has a pending task created since its
last run started, of source:

| Task | Run reason | Wakes the agent |
|---|---|---|
| `revise` (a revise decision, or the answers to an item of questions) | `revise` | unless `onRevise: "queue"` |
| `message` (`hq_message`) | `message` | unless `onMessage: "queue"` |
| `approval` (an approved item) | `approval` | when `onApproval: "task"` (with `"queue"` the task waits; without the field there is no task) |
| `chat` (a request of the chat) | `chat` | always |
| `revise` of a `room_proposal` | `revise` | the onboarding agent, always (see below) |
| a need (`message` of `_hq/onboarding`), `revise` of an `agent_proposal` | `agent_need`, `revise` | the receptionist, always (see "Proposing a missing agent") |

A task typed to an agent in the conversation panel (`desk`) starts its run
directly. The run's task is "Handle the pending tasks of your mailbox", and the
mailbox lists them. The app process calls `wakeAgents` after each decision, on
each tool result of a run (an `hq_message` is written by the HQ MCP server,
another process: the tool result is when the app notices it) and at the end of
each run. Consequences:

- Same agent lock, shared resources and daily cap as any run. A busy agent,
  or one whose resource another run holds, is woken again when that run ends
  (its task is newer than the agent's last run); with the cap reached, the
  task waits (see "The daily cap" below).
- A run that fails gives its mailbox tasks back; they are older than that run,
  so the agent is not woken again in a loop: they wait for its next run.
- A run interrupted because MyHQ stopped (`cancelled`, see "Stopping and
  restarting") does not count, once: the tasks it gives back wake the agent
  again after the restart. A task whose resumed run is interrupted again (two
  interruptions since it was created) waits for the agent's next run, so an
  app that crashes during a run does not resume it in a loop.
- A message from an agent goes through the portier (see "The portier"): it may
  wait for the recipient's next run instead of waking it.
- A message from an agent wakes its recipient at most once per window per pair
  of agents (`HQ_MESSAGE_WAKE_MINUTES`, 10 by default, 0 to wake at each
  message): when a run of the recipient started for a message (reason
  `message`) took a message of the same sender less than a window ago, the new
  message waits in the mailbox. Another task of the recipient (another
  sender, a revision, a chat request) still wakes it, and its run takes the
  waiting message too; otherwise the scheduler's tick (every 15 s, see "The
  daily cap") wakes it once the window is over. Two agents that answer each
  other ("received", "still waiting") then wake each other once per window,
  not at each message; `"queue"` on one of them stops it altogether.

#### Stopping and restarting

A stop of the app (pm2 `stop` or `restart`, Ctrl+C) waits for the runs in
progress (`installShutdown`, `src/server/runner.ts`). On SIGINT, SIGTERM or the
`shutdown` message that pm2 sends with `shutdown_with_message` (on Windows a
signal kills a process outright, so `ecosystem.config.cjs` sets it), no run
starts any more (`SHUTTING_DOWN`, 503: a wake-up leaves the task pending, a
routine journals an error), the runs in progress get
`HQ_SHUTDOWN_GRACE_SECONDS` (90 s by default) to end, then the ones still
going are interrupted: `cancelled`, summary « Interrupted: MyHQ stopped during
the run. », no failure alert, their mailbox tasks back to `pending` and their
own instruction `blocked`, as for a failed run. Then `installShutdown` runs its
cleanup (`src/instrumentation.ts`): the HTTP servers of the process are closed
(`closeServers`, `src/server/exit.ts`: the port is freed and the event streams are
cut) and the Telegram long poll is aborted, so that the next instance does not
meet a 409. Then the process exits. A second signal exits at once. Next.js would
stop the server on its own on these signals: `NEXT_MANUAL_SIG_HANDLE=true` (in
`ecosystem.config.cjs`) leaves them to MyHQ, which therefore has to close the
server and exit itself. pm2's `kill_timeout` (100 s) must stay above the grace.

The exit is `exitProcess` (`src/server/exit.ts`), not `process.exit`: Node waits
for the threads of its pool before it really exits, so one call blocked there (a
name lookup while the network is down, a stalled disk) leaves a process that
"exited" alive, holding port 4242, until pm2 kills it `kill_timeout` later, or for
ever once pm2 has lost track of it. `exitProcess` runs the `exit` listeners (lock
release, run recovery) and kills the process outright, which waits for nothing.
A timer cuts a stop that got stuck anywhere else, 15 s after the grace. `npm run
deploy` checks after each restart that the port is held by the process pm2
follows (`README.md`, "Running as a service").

A process killed outright leaves its runs `running` and their tasks
`in_progress`. At startup, `app()` first takes the home for its process
(`data/app.lock`, the pid of the owner; a lock of a dead process is taken
over), then closes those runs as `cancelled` and gives back every task still
`in_progress` whose run is not in progress (interrupted, failed, or none):
`recoverInterruptedRuns` and `releaseOrphanTasks`. The first tick of the
scheduler then wakes them by the rules above. A second MyHQ started on the same
home while the first one still runs (pm2 starting an instance while an earlier
one holds the port) does not own it: it leaves the runs of the first one alone
and wakes nobody.

`GET /api/runs/active` lists the runs in progress and says whether the app is
stopping; `npm run wait-idle` polls it until nothing runs, so that a deployment
starts in a quiet moment (`README.md`, "Running as a service").

#### The daily cap

The cap counts the runs started on the local calendar day (`runsToday`), all
agents together. When it is reached, every start is refused with
`DAILY_CAP_REACHED` and the tasks stay pending. Three things make that visible
and temporary:

- **Resuming.** `resumeWaitingTasks` (`src/server/runner.ts`) is called at each
  tick of the scheduler's timer (every 15 s, and once at startup), scheduler on
  or off. It does nothing while `runsToday` is at the cap; as soon as it is not
  (the day changed, or the cap was raised on `/reglages`), it calls `wakeAgents`,
  so the waiting tasks are woken in the same order (task id) and under the same
  rules (`onApproval`, `onMessage`, `onRevise`, the lock, the resources, and the
  cap again: tasks beyond it wait for the next day). The check is stateless, so
  a restart of the app after midnight resumes them as well. A run that ends
  still calls `wakeAgents` itself, which is what frees a busy agent or
  resource.
- **One alert a day.** The first refusal for the cap of a day sends a Telegram
  alert (`src/server/cap-alert.ts`): the cap, the number of pending tasks, and
  when `HQ_PUBLIC_URL` is set a line `Réglages : <url>/reglages`. The day is
  marked by an empty file in `<data>/cap-alerts/<YYYY-MM-DD>` (day in
  `HQ_TIMEZONE`, created exclusively, older markers removed). A send that fails
  or is not configured removes the marker, so a later refusal tries again.
- **The chat is told.** The core's facts given to the chat (`runs` field of the
  preamble) say "Plafond atteint" once the cap is reached, with the instruction
  not to promise that the work is in progress.

#### Revising a room proposal

The onboarding agent (`_hq/onboarding`) is in no room of the home and runs
only for a path (`POST /api/onboarding`), so the wake-up above does not know
it. `wakeOnboarding` (`src/server/onboarding.ts`), called by `wakeAgents`,
covers it. A `revise` decision on a `room_proposal` creates a `revise` task
for `_hq/onboarding` (the text is the remarks then the general note, as for
any revision) and relaunches onboarding at once, with reason `revise`, on the
repository of the proposal (its `room.targetRepo`, relative to the home). The
run prompt starts with
`REVISION RUN`: it gives the previous proposal (title, room and agents,
the text its agent wrote) and the user's revision, and asks for a new
`room_proposal` that answers each remark. The new proposal is a new item
(the old one stays sent back), and approving it still refuses a room name that
exists. Consequences:

- Same lock (one onboarding run at a time) and daily cap as any run. A busy
  onboarding agent is woken again when its run ends. A run takes the
  revisions of its own repository only; the others wait for their turn.
- A revision is not woken again by a failing run (the task is older than that
  run, per repository), as for the other agents.
- A pending revision is also taken when the app starts (`app()`, once per
  process), so a revision decided while the app was down or busy runs after the
  next restart without manual action.
- A revision whose repository is gone is blocked, with a note.
- A rejection ends the matter: no task, no run. A pending revision task whose
  item is no longer in `revise` (rejected or approved since) is stale and
  ignored, by `wakeOnboarding` and by any run. `hq_submit` also refuses a new
  `room_proposal` for a repository whose latest room proposal was rejected,
  unless the run was started by the owner (`POST /api/onboarding` or the chat:
  a run without a `reason`).

### The Standard

The `blocked` source of the desk (`src/server/blocked.ts`, shown by the phone
of the default desk, « Standard ») lists what is stuck at the agents of every
room, so that nothing waits in silence:

- **Blocked tasks**: every task `blocked`, with its note (an agent's
  `hq_task_update`, for example). The instruction of a failed or interrupted
  run is not listed here but with its run.
- **Pending tasks nothing takes**: a task `pending` for more than 15 minutes
  (since it was created) that no wake-up will take on its own. A task newer
  than the run of its agent in progress is not listed (the end of that run
  wakes the agent); a task that waits by design is not either (`onMessage`,
  `onRevise` or `onApproval` set to `"queue"`). The reason is the probable
  one MyHQ knows, in this order: the agent is busy with a run whose end will
  not take it, MyHQ is stopping, the daily cap is reached, a shared resource
  (the GPU) is held by another run, the anti ping-pong window of the pair, a
  failed run gave it back, two interruptions in a row, or simply no wake-up
  that takes it (a task older than the agent's last run, a `manual` one).
- **Failed or interrupted runs** that ended in the last 24 hours and whose
  tasks were not taken again: the run's own instruction, still blocked, and
  the mailbox tasks it gave back, still pending (recognized as the pending
  tasks of the agent without a run that were given back at the instant the run
  ended). A later run of the agent with the same instruction that ended done
  (or runs) means the work was taken again: the run is not listed.

Each entry gives its room (and colour), its agent, since when (the block, the
creation of the pending task, the end of the run), the reason in one sentence
and the text of the task (for a run, its instruction then the tasks it gave
back). The count of the object is the number of agents
stuck, not of entries. Two actions, with a light confirmation on the page:

- **Relancer** (`POST /api/blocked/relaunch`): the tasks of the entry go back
  to `pending` (without a run) and the agent is woken at once by a run that
  takes its mailbox, reason `relaunch`, under the usual rules (agent lock,
  shared resources, daily cap). When the run cannot start, the tasks stay
  pending, the answer says why (`waiting`), and the entry stays on the
  Standard with its reason. A relaunched task is older than the agent's runs,
  so the automatic wake-ups do not take it: the next run of the agent, or
  another relaunch, does.
- **Clore** (`POST /api/blocked/close`): the tasks of the entry are `done`
  with the note « Close par le propriétaire. ». Nothing wakes.

An entry also shows the latest note of the supervisor on its tasks (« Note de
<its name> : ... », see below). An entry the supervisor handed to the owner is
marked « Remis au propriétaire », drawn apart and listed first, whatever its
age.

### The supervisor

An agent with `"supervisor": true` in its `room.json` does for the owner what
the owner did by hand: it reads the Standard, checks the facts, writes to the
agent concerned with the proof, relays a dependency to the right link,
relaunches what failed for a passing reason, and hands to the owner, with one
sentence, what needs a decision. Its role prompt says how
(`src/server/supervisor.ts` holds the mechanics). `syncHome` mirrors the flag
into the `supervisors` table, which the HQ MCP server reads.

- **Rights.** `hq_blocked` lists the entries of the Standard, the
  supervisor's own excepted, with what `listBlocked` gives: `target` (the
  `{ kind, id }` that `hq_relaunch` and `hq_blocked_note` take: `task` for a
  blocked or pending task, `run` for a failed or interrupted run), room,
  agent, state, since, reason, the text of the task (1500 characters at most,
  `textTruncated`), its task ids, the supervisor's last `note`, `handedOff`,
  and `relaunched` (a supervisor already relaunched one of its tasks).
  `hq_message` reaches any agent of any room (an agent it wrote to may answer
  it, as a studio's requester can). `hq_items` reads the items of every room.
- **Limits.** It approves, rejects and closes nothing: those are the owner's,
  on the desk and Telegram, never an MCP tool. Its `hq_submit` takes only the
  type `owner_note`, stored informational (`unseen`, it never waits for a
  decision). Any other agent that calls `hq_blocked`, `hq_relaunch` or
  `hq_blocked_note` gets a tool error that says the tool is the supervisor's.
- **Relaunch.** `hq_relaunch` follows « Relancer »: the guards of a run
  (agent lock, shared resources, daily cap) are checked first, in the HQ MCP
  server, with the app's cap and anti ping-pong window passed to the run
  (`HQ_MAX_RUNS_PER_DAY`, `HQ_MESSAGE_WAKE_MINUTES`). When one holds, nothing
  changes (`relaunched: false`, `waiting` with its code) and it does not count:
  the supervisor tries again later. Otherwise the tasks go back to pending, the
  optional `message` (the proof, the missing text) joins them as a message of
  the supervisor, and a row of `supervisor_relaunches` is recorded. The app
  starts the run (reason `relaunch`) from `wakeAgents`, before the mailbox
  wake-ups, so on the tool result of that very call, and that run takes the
  whole mailbox: the relaunched tasks and the message together. The row keeps
  the run, or the code of what held it back at that moment (the app stopping,
  a race): its tasks then stay pending, as with the button.
- **Once per task.** A task that a supervisor relaunch covers is never
  relaunched by a supervisor again (`ALREADY_RELAUNCHED`). When an entry with
  such a task is on the Standard again once the relaunch was handled (its run
  failed, the agent blocked it again, or the run could not start), MyHQ hands
  it to the owner with a note in the supervisor's name (« <its name> l'a déjà
  relancée une fois et elle est encore coincée... »). The owner's own
  « Relancer » is not counted.
- **Notes.** `hq_blocked_note` stores one row of `blocked_notes` per task of
  the entry (text, supervisor, run, `handed_off`). The Standard shows the
  latest one of an entry; `handOff: true` hands it to the owner. A note never
  changes a task.
- **Rules first.** Much of the supervisor's method is a written rule, and MyHQ
  applies it itself before it wakes the supervisor (`settleByRule`, from
  `entryRule`). Each entry carries the code of why it is stuck (`cause`) and
  the words of whoever wrote it (`detail`: a run's summary, a blocked task's
  note):
  - **a passing technical failure never relaunched is relaunched once**, in
    MyHQ's name: an interrupted run (`cancelled`, or two interruptions in a
    row), a task held by a busy agent whose run will not take it, and a failed
    run or a blocked task whose words name an MCP server not connected, the GPU
    (a resource) busy, an interruption, `SQLITE_BUSY` or a locked database, or
    the daily cap (relaunched once the cap is lifted). It goes through
    `requestRelaunch`, the supervisor's own path (once per task, the guards of a
    run); MyHQ starts the run at once (`startRelaunchRequests`) and writes a
    note on the entry (« MyHQ l'a relancée une fois tout seul : ... », shown as
    a note of « MyHQ »). A guard that passes on its own (the agent busy, a
    resource, the cap) changes nothing and the next tick tries again; another
    one (an agent no longer in the home) leaves the entry to the supervisor;
  - **an entry already relaunched that is stuck again goes to the owner** with
    a note (`handOffRelaunched`: in the supervisor's name for its relaunch, in
    MyHQ's for MyHQ's own);
  - **what starts again on its own is left alone**: a pending task held by the
    daily cap, a resource, the anti ping-pong window or a stop of MyHQ;
  - **everything else goes to the supervisor**: the blocks in free text (an
    agent's note, a run that failed for another reason, a timeout, a stop, the
    hard limit) and the states no rule covers.
- **Wake-ups.** At each tick of the scheduler's timer (every 15 s, scheduler
  on or off, by the process that owns the home), `watchStandard` looks at the
  open entries: not the supervisor's own, not handed to the owner, not settled
  by a rule. When one
  has a task never given to the supervisor (`standard_announced`), the
  supervisor is woken at once (reason `standard`) with a task that lists the
  new entries (20 at most, `hq_blocked` gives the rest). Otherwise, while open
  entries remain, it is woken for a review at most every 30 minutes after its
  last run for the Standard, with a task that lists them all. A busy
  supervisor, a busy resource or the cap records nothing: the next tick tries
  again. Only the first supervisor of the home (room, then agent order) is
  woken. Its messages wake their recipients like any other, under the anti
  ping-pong window of the pair.

Migration 16 adds the tables `supervisors`, `blocked_notes`,
`supervisor_relaunches` and `standard_announced` (idempotent, as every
migration after 14).

### Long runs

A run has a soft deadline, `HQ_RUN_TIMEOUT_MINUTES` (30 by default) after its
start, and a hard limit, `HQ_RUN_HARD_LIMIT_MINUTES` (180 by default; the soft
deadline never comes after it). The budget of the run (`--max-budget-usd`)
stays the CLI's to apply, whatever the deadlines say. The runner owns the
timer; `src/server/long-runs.ts` decides what happens each time it fires,
from the run's row of `run_deadlines` (written at the start of every run: its
budget, its next deadline, its hard limit), which the HQ MCP server writes to
as well.

- **Without a supervisor** in the home, the run is interrupted at the soft
  deadline as it always was: `failed`, « Timed out after 30 minutes
  (HQ_RUN_TIMEOUT_MINUTES). ». So is a run of the supervisor itself: nobody
  checks it.
- **With a supervisor**, MyHQ does not interrupt the run. It wakes the
  supervisor (the first one of the home, reason `long_run`) with a task that
  starts with « Long run to check: run #12 of room/agent (name) », gives its
  duration, its task, and what to call, and the deadline moves 5 minutes later
  while it decides. A check is a run like another one: agent lock, shared
  resources, daily cap.
- **The summary in the task.** MyHQ puts in that task a compact summary of the
  run (`runDigest`): its duration, its tokens and estimated cost against its
  budget, the extensions and checks so far, the hints below (minutes since the
  last event, activity of the last 10 minutes, identical calls repeated), its
  20 latest tool events (call or result, with their time) and its latest text.
  It holds what `hq_run_status` gives, so the supervisor decides without
  calling it (one model call less per check). When the summary cannot be made,
  the task asks it to read `hq_run_status`, as before.
- **`hq_run_status { runId }`** gives the run (agent, room, task, status,
  start, minutes), its deadlines (`deadlineAt`, `hardDeadlineAt`,
  `extensions`, `checks`, `slices`, `stopRequested`), its cost against its
  budget (`cost.usd`, `cost.budgetUsd`, `cost.shareOfBudget`, `cost.tokens`:
  while it runs, an estimate from the tokens of its journal
  `data/runs/<id>.jsonl`, each model call once, at the API prices of the
  current Opus, Sonnet and Haiku, `estimated: true`; once it ended, its
  recorded cost), its 20 latest events with their time (`events`: `at`,
  `type`, a one-line `detail`), `lastEventAt`, and MyHQ's hints:
  `minutesSinceLastEvent`, `eventsLast10Minutes`, `toolCallsLast10Minutes`,
  `trailingIdenticalCalls` (the identical tool calls, same tool and same
  input, in a row at the end) and `mostRepeatedCall` among the 30 latest tool
  calls.
- **`hq_run_extend { runId, minutes }`** (10 to 60) moves the deadline to
  `minutes` from now, never earlier than it was and never past the hard limit
  (`cappedByHardLimit` then), and counts the extension. When the run still
  works at its new deadline, the supervisor is woken again.
- **`hq_run_stop { runId, reason }`** records the stop; the app interrupts the
  run on the tool result of that call (`applyRunStops`, from `wakeAgents`,
  and at each tick of the scheduler's timer). The run ends `failed` as a run
  that timed out (its own instruction blocked, its mailbox tasks back to
  pending, the failure alert), with the summary « Stopped by <name>
  (supervisor) after N minutes: <reason> », and its line of the Standard says
  « Le tour #12 a été arrêté par <name> : <reason> ».
- **No answer.** When the wait is over without a decision, or when the check
  cannot start (supervisor busy, daily cap, failure), the run goes on for a
  slice of `HQ_RUN_TIMEOUT_MINUTES`, then the supervisor is asked again, and
  so on: a run is never interrupted for want of an answer. MyHQ puts one note
  per run on the Standard, a blocked task of the supervisor whose reason is
  « Pas de réponse de <name> sur le tour #12 de <agent>... », kept up to date
  at each slice; the owner relaunches it (the supervisor then checks the run)
  or closes it.
- **The hard limit** interrupts the run whatever the extensions: `failed`,
  « Interrupted at the hard limit of 180 minutes (HQ_RUN_HARD_LIMIT_MINUTES),
  after N extension(s). », and on the Standard « Le tour #12 a été interrompu
  au plafond de 180 min. ».

The three tools are refused to any other agent, as the supervisor's other
tools are, and a supervisor never decides on its own run (`OWN_RUN`) nor on a
run that ended (`NOT_RUNNING`). Migration 17 adds the table `run_deadlines`.

### Why a run started

Each run stores a `reason` (`runs.reason`, null when started from the desk,
`/run` or a routine; for `modelFor` and `prepare`, the motive of such a run
is `routine` or `manual`): the `reason` of `POST /api/runs` from a script of the
home (for example a mail listener calling with `reason: "mail"`), or MyHQ's
own `approval`, `message`, `revise`, `chat`, `agent_need`, `relaunch` (the
Standard, or the supervisor's `hq_relaunch`), `standard` (the supervisor
woken for the Standard) and `long_run` (the supervisor woken to check a long
run). It is in the Run shape (API, live stream, daily
export) and on the start event, so the feed shows « Début du tour (sonnet),
motif : mail ». When `HQ_TRIGGER_TOKEN` is set, a request with a reason must
carry it as a bearer token (`api.md`); the desk sends no reason.

### Questions to an agent

A run is how an agent works: it costs a full turn, takes the agent's lock,
counts in the daily cap and answers with an item in the queue. To ask an agent
something (how it makes its videos, where it stands, what it would do), the
owner writes to it instead, from the field of the agent's sheet (every message
is a question, `POST /api/rooms/<room>/agents/<agent>/ask`). The agent answers
itself, in the background, and the answer shows in the thread in Markdown.

`askAgent` (`src/server/agent-questions.ts`) starts one `claude -p` through the
same engine as a run (`ClaudeEngine`, `buildClaudeArgs`), with the agent's own
model, effort and prompt cache duration, its working directory as cwd (a
scratch folder of `data/runs/questions/` when it does not exist yet: a
question never creates it) and its `addDirs`. The system prompt is the agent's
role followed by a « Question mode » block: the owner asks, this is not a task;
answer in the home's language, short and concrete, from what you know and what
you can read; you write nothing, submit nothing, send nothing; a request for
work is proposed as a run, never done (see "A task or a discussion" below).
The user message names the agent, gives the earlier exchanges of the
discussion (the last 10 answered ones, each answer cut to 2000 characters,
with what became of the run it proposed), the question
(4000 characters at most, zod), the agent's memory (as a run's briefing gives
it, `memoryText`) and the date line.

**Read only, by configuration.** The prompt is not the guard:

- `--tools Read Glob Grep`: no other built-in tool exists for the turn (no
  Bash, Edit, Write, NotebookEdit, Task, and no WebFetch or WebSearch unless
  the agent has them, below).
- `--allowedTools` lists those three and `mcp__hq__hq_memory_read`,
  `mcp__hq__hq_items`; `--disallowedTools` adds every built-in tool that
  writes, runs or fetches and every HQ tool that writes, on top of the global
  deny list, whatever the project settings of the working directory allow.
- **The web, for an agent that already reads it.** When the agent's own
  `allowedTools` hold `WebSearch` or `WebFetch` (a rule such as
  `WebFetch(domain:...)` counts), the question keeps them
  (`questionWebTools`): they join `--tools` and `--allowedTools` and leave the
  deny list. They read only, and no write tool exists beside them. The
  question mode block then tells the agent to search before answering anything
  that may have changed (a release, a model, a price, a rule), never from
  memory, each fact with its source and date, the facts that matter read on
  their official page rather than in search snippets, and to put nothing personal in
  a query or a URL. An agent whose job is to stay current (a documentalist)
  answers from the latest news, not from its training. The other agents keep
  the three read tools.
- `--mcp-config` holds the HQ server alone, never the agent's own servers, in
  read-only mode: `HQ_READ_ONLY=1` and no `HQ_RUN_ID` (a question is not a
  run). In that mode the server registers only `hq_memory_read` and `hq_items`,
  so a tool that writes does not even exist. `hq_read_decisions` is left out
  on purpose: it marks the decisions it gives as seen, a write, and the next
  run would miss them.
- No write guard is needed (no write tool exists); the one a run installed in
  the working directory stays, and fails closed without its configuration.
- `--max-budget-usd` is 1 $, or the agent's own budget when it is lower.

**Not a run.** Nothing goes into `runs`, `events` or `tasks`: the agent's last
run and the feed do not change, the daily cap does not count it, nothing is
woken at its end, and the agent lock is not taken (a question is answered
while the agent works). The guards are its own: one question at a time per
agent (`QUESTION_BUSY`, 409), none while the app stops (`SHUTTING_DOWN`), and
5 minutes at most: past that the process is killed and the question ends
`failed` with `timeout`, its tokens still recorded. A question the app's stop
or a crash left `running` is closed `failed` (`interrupted`) at the next start,
as the interrupted runs are, and its per-question MCP file is swept with
theirs.

**Metered.** Each question is a row of `agent_questions` (migration 19): the
question, the full answer (read from the CLI's result line, the engine's
summary being cut), `status` (`running`, `done`, `failed`), `error` (`timeout`,
`budget`, `error`, `interrupted`), the model the CLI reports, the four token
counts, the cost (`total_cost_usd`: each question is a fresh `claude -p`, so
it is its own), the tool calls and their names. `GET /api/usage` gives their
totals for today and the week (`questions`), the weekly budget counts them,
the whiteboard adds them to the cost of the day and of the week, and the
meter lists them as « Questions aux agents ». The raw output is kept as
`data/runs/questions/<id>.jsonl`.

**The discussion.** One per agent: its questions since the last « Nouvelle
discussion » (`DELETE` on the same route), oldest first. A reset only sets
`cleared_at`: the rows stay, so their cost stays in the meter, and a reset is
refused while a question is in progress. The sheet reads its thread again
every 2 seconds while a question waits, and shows « <agent> réfléchit à ta
question… »; the floor does not animate it.

A question measured on Sonnet costs a few cents: the role, the question-mode
block and the CLI's own system prompt are written to the cache the first
time, read from it the next ones, and each file the agent reads adds its
tokens. On Opus count about five times more.

#### A task or a discussion

Every message of the sheet is a question: the agent reads it in question
mode and decides what the owner wants. The « Question mode » block tells it
apart: a wish to talk (a question, an opinion, where it stands, how it works)
gets a plain answer; a request for work (make, redo, produce, write, send,
fix...) is never done, and the agent never says it is. It says in one short
sentence that it proposes a run, which starts once the owner confirms, then ends its answer with a tagged block,
alone on its last lines, that holds the task of that run, reworded, complete
and self-contained (what to do, on what, with the details of the discussion
that matter, what to deliver):

```text
D'accord, je lance un tour pour refaire le clip B.

<run-proposal>
Refais le clip B avec la nouvelle musique (piste 2), puis dépose-le pour validation.
</run-proposal>
```

A tag pair rather than JSON or a code fence: Markdown leaves it alone, an
answer that shows code cannot be mistaken for it, and a missing or broken
block degrades to a plain answer. `parseRunProposal`
(`src/server/run-proposal.ts`, pure) splits the answer when the question
ends: the last complete block is the task (out of a code fence the model may
have wrapped it in, at most 20000 characters like any run's task); every
block and every stray tag leave the text, so what a broken block held stays
readable. The answer is stored without the block; the task goes to
`question_proposals` (migration 20: the question, the task, `pending`,
`launched` with the run, or `dismissed`, and when it was decided).

**Nothing starts without the owner.** Under the answer the sheet shows a
card: « C'est une tâche. Je lance un tour pour : » and the task, with
« Lancer le tour » and « On en parle d'abord ». No route starts a run from an
answer by itself; only `POST .../ask/<question>/proposal` with
`{ "action": "launch" }` does (`decideProposal`), through `startRun`, the
same path as the desk's « Lancer un tour »: the agent lock, the shared
resources and the daily cap refuse it the same way (the proposal then stays
pending, to launch later), and the run has no `reason`, like any run started
by hand. `dismiss` sets it aside. A proposal is decided once
(`PROPOSAL_DECIDED`), and the card keeps what became of it after a reload
(the run launched, with a button that shows its line in the thread, or set
aside). The context of the next questions says it too, after the answer
(« You proposed a run: ... The owner started it (run #12) »), so that the
agent knows where the discussion stands.

### The write guard

The CLI's path rules cannot be trusted with the limit of an agent's writes.
Measured on CLI 2.1.318 in print mode: `Write(**)`, `Write(./**)` or
`Write(/**)` sometimes refuse a write in the working directory ("Claude
requested permissions to write ..., but you haven't granted it yet", in the
middle of a run where an earlier write passed); a bare `Write` lets a write
land outside the working directory (`../outside.txt`); and
`--permission-mode acceptEdits` lets one land in any `--add-dir`, which MyHQ
gives for reading. So MyHQ enforces the paths itself
(`src/server/write-guard.ts`, `src/server/write-guard-hook.mjs`):

- Before a run whose rules allow a write, the runner installs a Claude Code
  `PreToolUse` hook in `<working directory>/.claude/settings.local.json`
  (loaded by `--setting-sources project,local`). MyHQ's entry goes first, a
  previous one is replaced, every other setting and hook of the file is kept;
  a file that is not a JSON object fails the run with an explicit error. The
  hook is in exec form (`command`: the Node binary, `args`: the script, no
  shell, so no quoting issue on Windows), matches `Write|Edit|MultiEdit|NotebookEdit`,
  and has `onFailure: "block"`: a hook that cannot run blocks the write.
- The same file turns on the CLI's own
  `permissions.blockWritesOutsideWorkingDirectories` (Claude Code 2.1.314
  and later; older versions ignore it), a second layer that refuses writes
  outside the working directories even if the hook does not run. It is not
  enough alone: it counts the `--add-dir` folders as working directories,
  and only the hook keeps them read-only. Neither bounds `Bash`.
- In a worktree, the file stays out of Git as the skills do: a
  `.claude/.gitignore` of MyHQ's ignores `settings.local.json` and itself (no
  Git command, nothing shared with the other worktrees). A repository with
  its own `.claude/.gitignore` keeps it untouched, and Git must already
  ignore the settings file there, otherwise the run fails with an explicit
  error rather than leave a file an agent could commit.
- The script is plain JavaScript started with `node` (no `tsx`, no
  dependency), the frozen copy of `build/mcp` made by `npm run build` (the
  sources without one), so that an agent editing this repository never
  changes the guard of the runs in service. The run's configuration reaches it
  in the `MYHQ_WRITE_GUARD` environment variable (the agent cannot change the
  environment of its own CLI): the working directory, the patterns its write
  rules allow there (`Write`, `Write(**)`, `Write(./**)`, `Write(/**)`: the
  whole folder; `Write(models/**)`: only `models/`; the rules of all the write
  tools add up), the patterns its `disallowedTools` write rules forbid, and
  for the chat its `writeDirs`.
- For each call, the hook resolves the path (against the session's `cwd`
  when relative; the deepest existing part through `realpath`, so links,
  junctions and short names cannot lead out; a dangling link is refused) and
  compares it by whole segments, without case on Windows and macOS. Patterns
  are anchored at the working directory: `**` any depth, `*` and `?` within
  a segment, a pattern without a wildcard also covers what lies under it;
  `//absolute`, `~/` and `..` patterns grant nothing. A write outside the
  roots, in an `--add-dir`, under a deny pattern, or on
  `.claude/settings.json` or `.claude/settings.local.json` (the hook itself)
  is refused: exit code 2, and a reason on stderr that the CLI shows to the
  model (what was refused, why, and where it may write). Otherwise the hook
  says nothing (exit code 0, no output) and the CLI's own permission flow
  goes on. Any error (no configuration, unreadable input) is a refusal.
- An agent whose rules allow no write gets no hook: the CLI refuses its
  writes in print mode. The `--disallowedTools` write rules are still passed
  to the CLI as written (they deny correctly on 2.1.318), the guard being the
  enforcement that does not depend on the CLI version.
- The `Bash` rules are passed unchanged and still hold on 2.1.318 (a command
  outside them is refused, a `disallowedTools` pattern denies), but they do not
  limit paths: a whitelisted `python *`, `cp *` or `mkdir *` can write
  anywhere. The guard covers the file tools only.

The assistant's chat gets the same guard (see "The assistant on Telegram").

### Security

The app holds no production secret. Agents write only in their own working
directory, which is a dedicated Git worktree for agents that write code; the
file tools are held to it by the write guard.
Deployment tools and anything like `db:push`, `vercel` or `eas submit` are
denied to every agent. Agents that read the web have no file-writing tool
outside their directory. Anything published under a project's name goes
through the approval queue.

## 2. The technology

- **App**: Next.js 16, TypeScript (strict), Tailwind. Not deployed: `npm run dev`
  during development, then a local service for real use (`next build`, then
  `next start -p 4242`, managed by pm2 with an `ecosystem.config.cjs` file).
  `npm run build` also freezes the HQ MCP server that every run starts (see
  "The HQ MCP server").
  Closing the terminal or rebooting the machine must not stop the app: on
  Windows a scheduled task restarts pm2 at boot, on Linux `pm2 startup` does it.
  The app listens on localhost only until remote access is decided.
- **Data**: SQLite (`better-sqlite3`), one file in the home's `data/`
  directory, ignored by Git. Idempotent SQL migrations in the code. Tables:
  `rooms`, `agents` (with the armed state of their routines), `runs`,
  `events`, `messages`, `tasks`, `approvals`, `memories`, `routine_firings`,
  `chat_turns` (the assistant's chat turns, metered), `agent_questions` (the
  owner's questions to the agents, metered, see "Questions to an agent").
  Each run stores `input_tokens`, `output_tokens`, `cost_usd`,
  `started_at`, `ended_at`, `status` (`running`, `done`, `failed`,
  `cancelled`), a `summary` and a `reason`. A task comes from a run's own
  instruction (`manual`), a message, a revision or an approved item
  (`approval`).
- **Real time**: Server-Sent Events from the app to the browser.
- **The room view** (slice 4): an isometric pixel art floor on a canvas
  (PixiJS, the one runtime dependency added for it, pinned to an exact version
  and loaded only on `/`, the floor) with character sheets in four directions
  (standing, walking, typing), driven by the real events of the stream-json
  output. See section 7.
- **Rooms and roles**: `room.json` and `roles/*.md` in the home directory,
  loaded and validated at startup (see `home-layout.md`).
- **The assistant on Telegram**: the Bot API through `fetch`, with the token and
  chat id in `.env.local`. Without a token, nothing is sent and nothing
  crashes. A system toast is an option, never a requirement. See section 5.
- **Portability**: relative paths, SQLite, no dependency on one OS apart from
  optional notifications.

## 3. Initialization and onboarding

Starting with MyHQ happens at three levels, from the widest to the narrowest.
The principle is the same everywhere: the first gesture of the HQ for a project
is itself submitted to the user's approval.

1. **Initialize the HQ (once per machine): `npm run init`.** The script
   (`scripts/init.ts`) creates the home (`rooms/`, `data/`, a `.gitignore`)
   or keeps an existing one as it is (a home that is a separate repository
   only needs `MYHQ_HOME`), checks that the `claude` CLI is installed
   (`claude --version`) and signed in (`claude auth status --json`), asks for
   the Telegram token and chat id (optional), the daily cap, the port and the
   time zone, writes `.env.local` from `.env.example`, creates the database
   and prints how to start the service with pm2. It can be run again: the
   previous `.env.local` is kept as `.env.local.bak` and every value it held is
   carried over unless answered again, and migrations are idempotent. Answers
   are read line by line from stdin, so they can be piped; an empty or
   missing answer keeps the value shown between brackets. It does not start
   the service itself: `npm run build` and `pm2 start` stay explicit.
2. **Add a room (once per project): the onboarding agent.** Not a form. The
   user gives the path of the target repository (relative to the home, or
   absolute): « Ajouter une salle » on the team, `/salle <path>` on Telegram,
   or `POST /api/onboarding`. The path field of the form has a « Parcourir »
   button next to it: a folder explorer (`dir-browser.tsx`, over
   `GET /api/fs/dirs`) walks the projects root, the parent folder of the home
   or `projectsRoot` of `myhq.json`, and writes the path of the folder chosen
   in the field. MyHQ starts a run of its own onboarding agent,
   in a reserved room `_hq` that no folder can take, with the same lock and
   daily cap as any run: Sonnet, `--max-budget-usd` from
   `HQ_ONBOARDING_MAX_BUDGET_USD` (0.5 by default), the role prompt shipped in
   `templates/onboarding.md`, the target repository as working directory, the
   templates folder and the `rooms/` folder of the home as `--add-dir`, the built-in tools `Read`, `Glob` and
   `Grep` available but not pre-approved (in print mode Claude Code reads
   inside its working directories only, and nothing outside them), and the
   `hq_submit` and `hq_task_update` tools. The run prompt gives the target,
   the rooms that already exist, the rooms and their agents (the same list as
   the agent mode, `home-roster.ts`: id, name, model, the first line of the
   role, and a mark on the shared studios), the templates (`templates/roles/*.md`) and
   the payload to submit. It must not propose an agent whose trade a shared
   studio already holds: the agents of the new room order that work from the
   studio (`hq_message` with `room`), and the proposal says so. It also states the language of the home (`language`
   in `myhq.json`, `en` by default): the agent writes the proposal, the role
   prompts and the "HQ agents" block in that language, translating the English
   templates (the translated prompt travels as `content` of the role), and
   titles the item « Proposition de salle : ... » for a French home:

   ```json
   {
     "room": { "name": "...", "targetRepo": "...", "agents": [ { "id": "dev", "...": "room.json fields" } ] },
     "roles": { "dev": { "template": "dev", "values": { "project": "...", "targets": ["..."], "audience": "...", "features": ["..."], "autonomy": "A", "guardrails": ["..."] }, "notes": "optional Markdown" } },
     "claudeMd": "## HQ agents ..."
   }
   ```

   `hq_submit` checks a `room_proposal` at once, so the agent can fix it in
   the same run: `room.json` against the room schema (role paths become
   `roles/<id>.md`, every routine is disarmed), one role per agent,
   instantiated from its template (`{{project}}`, `{{targets}}`,
   `{{audience}}`, `{{features}}`, `{{autonomy}}`, `{{guardrails}}`; a list
   becomes a Markdown list; em and en dashes are replaced), and the
   `CLAUDE.md` block. The stored item carries the final files, and its body
   shows the full `room.json`, every role and the block: the user approves
   exactly what will be written. On approval, MyHQ writes `rooms/<name>/`
   (never over an existing room), loads it back, creates the worktree of each
   agent that has one (`git worktree add`, branch `hq/<agent>`), and syncs the
   home: the room is live without a restart. Rejection and revision work as
   for any item (a revision relaunches onboarding at once on the same
   repository, see "Revising a room proposal"; a rejection ends the matter).
3. **Initialize the target project (minimal and standard).** The same
   onboarding item proposes a short "HQ agents" block for the project's
   `CLAUDE.md`: how to run the tests, where the docs live, what is forbidden
   (deployment, migrations, pushing), the branch and pull request
   conventions, and the reminder that everything public goes through the
   approval queue. MyHQ never writes it: it is handed to the user, like the
   text of an approved reply. The dedicated worktree lives in the home and
   only adds Git's own bookkeeping to the repository. Nothing else lands in the
   project: no `.hq/` directory, no dependency. A project can leave the HQ
   without a trace (`git worktree remove`).

### Proposing a missing agent

When work is needed that no agent covers, the receptionist (the onboarding
agent, `_hq/onboarding`) proposes one agent for it, in agent mode. As for a
room, it is a proposal the user approves, never a form.

**Asking.** Three doors, one path:

- `POST /api/agents/propose { need, room? }` (`api.md`), for the desk or a
  script: a need task and its run at once, or the error (`AGENT_BUSY`,
  `DAILY_CAP_REACHED`) with nothing kept, as `POST /api/onboarding`.
- The chat's `propose_agent` action (`home-layout.md`, "Chat actions"), when a
  request of the owner matches no agent: same, but a busy receptionist or the
  cap leave the need waiting for its next run, as a chat request.
- `hq_suggest_agent { need }`, for a room agent given an order nobody can do.
  The HQ MCP server only writes the need (it cannot start runs); the app
  starts the run on the tool result, through `wakeOnboarding`. At most one
  suggestion per need text (case and spacing aside) in 24 hours, whatever
  became of it unless it was blocked: a repeat answers `queued: false`.

A need is a task of `_hq/onboarding` with source `message` (no agent can
write to `_hq` with `hq_message`, so every such task is a need): its text is
the need, `from_room` the room it comes from (or the room the owner names),
`from_agent` the agent that asked (null for the owner).

**The run.** `startAgentNeedRun` (`src/server/agent-need.ts`) starts a run of
the receptionist with the same lock and daily cap as any run, reason
`agent_need`, task « Propose an agent for the need: <need> », taking that one
task. Its role prompt is `templates/agent-proposal.md`; its working directory
is the home's `rooms/` folder (every `room.json` and role); its `--add-dir`
are the role templates and the technology catalogue; its tools are `Read`,
`Glob` and `Grep` (read-only, not pre-approved) and `hq_submit`,
`hq_task_update`. The run prompt gives the need and who asked, the rooms and
their agents (model, tools, routines, role file), the role templates, the
language of the home and the payload. It also gives the catalogue, summarized
by `src/server/catalog.ts`: for each target repository of a room, its
`package.json` (name, description, dependencies, devDependencies, scripts),
`pyproject.toml` (name, dependencies) and the first lines of its README; then
each folder of `catalog.dirs` in `myhq.json` (`home-layout.md`), its own
manifests and each top-level Markdown note with its frontmatter. The role
asks for one agent that duplicates none (a need already covered is closed
`blocked` with the agent to ask), in the right room (a shared studio for a
craft that serves several projects), using the technologies actually present,
with the minimal tools, a sensible model and budget, and the reason of these
choices.

**The proposal.** `hq_submit` with type `agent_proposal`, accepted from the
receptionist only (a room agent is told to use `hq_suggest_agent`):

```json
{
  "room": "demo",
  "agent": { "id": "illustrator", "name": "Illustrator", "model": "sonnet", "allowedTools": ["Read", "mcp__hq__hq_submit"], "maxBudgetUsd": 1 },
  "rolePrompt": "# Illustrator ...",
  "reason": "Why this agent, its tools, model and budget.",
  "need": "The need, as asked.",
  "requestedBy": "the owner"
}
```

It is checked at once, so that the receptionist can fix it in the same run:
the agent against the agent schema of `room.json` (`role` is MyHQ's and left
out, `armed` is forced to false), a role prompt with no `{{placeholder}}`, a
room of the home and an id it does not have yet. Em and en dashes are
replaced. The body gets, after the receptionist's own text, a readable summary
(« Agent proposé » : room, agent, model, budget, tools, routine, who asked,
the need, why), the role prompt and the `room.json` entry: the desk renders it
like a room proposal (type label « Agent »), and the remarks on passages work
the same. Approving it writes the agent (see "Agent proposals" in section 1).

**Revising.** A revision gives the receptionist a `revise` task and relaunches
it at once on the same need (reason `revise`, same task text), through
`wakeOnboarding`, as for a room proposal: the prompt starts again from the need
and adds `REVISION RUN`, the previous proposal and the user's remarks; the
answer is a new item. A rejection relaunches nothing. A room onboarding run
never takes the needs or the revisions of agent proposals, and an agent-mode run
takes only its own task. As for the other agents, a need is not woken again
by a run that failed after it was created, and a pending need is taken when
the app starts.

## 4. Delivery slices

Each slice ends with an acceptance criterion that is demonstrated, not
described, and no mechanism is built before its first real use.

1. **The core.** The app, the database, the HQ MCP server, one agent running
   headless, the live event feed, and the approval queue with approve, reject
   and revise. The first room is written by hand: that is the price of a quick
   first real run. Acceptance: a real run of the first agent submits an item,
   the user approves it, and the item moves to `approved` with the information
   needed to act on it. The run shows tokens and cost.
2. **The assistant on Telegram.** Notifications, approval from the phone,
   conversation in natural language, and commands loaded from the home
   directory. Acceptance: from the phone, the user gets an answer, runs a
   command defined in their home, and approves an item.
   Status: built (section 5) and covered by tests against a fake Bot API;
   the acceptance is demonstrated once the previous reader of the bot is
   switched off and polling is turned on.
3. **The team and onboarding.** Any number of agents per room, with roles that
   become generic templates; cron, integrations through MCP servers, the
   per-agent lock and the daily cap, and an optional daily export of the
   agents' journal to a folder of the user's choice. The onboarding agent and
   `myhq init` arrive with this slice. Acceptance: three scheduled agents run
   for a week with no intervention other than approvals, and a second room is
   onboarded from an existing repository through the approval queue.
   Status: built on the MyHQ side (routines, arming, journal, budget share,
   role templates, `npm run init`, onboarding, daily export, per-agent
   worktree, deny list and read directories), covered by tests with a fake
   engine, and one real onboarding run on Haiku (a fixture of its stream is
   in the tests). The acceptance is demonstrated once `HQ_SCHEDULER=on` in a
   real home.
4. **The animated room.** The canvas, characters animated by the stream-json
   events, the team feed (messages between agents) and a whiteboard with the
   state of the routines and the user's key numbers. Acceptance: one can see an
   agent typing during its run, then walking to the user's desk to drop off a
   submission.
   Status: built (section 7) and covered by tests that replay the fixtures on a
   fake clock; the acceptance is demonstrated with `scripts/replay-fixture.ts`
   on the real SSE stream, and with a real run once the scheduler is on.
   A first version of the whiteboard already exists: the `/roadmap` page shows
   `<home>/docs/roadmap.json` (slices, items, open points, journal) and updates
   live when the file changes (a `roadmap` event on the SSE feed, see `api.md`).

## 5. The assistant on Telegram

The code lives in `src/assistant/`. It has two modes, chosen by
`HQ_TELEGRAM_POLLING`:

- **Send only** (default). MyHQ sends plain text alerts: an item waits for
  approval, a run failed. A bot can only have one reader (two `getUpdates`
  loops on the same token steal each other's messages), so this is the mode
  to keep while another program still reads the bot.
- **Polling** (`HQ_TELEGRAM_POLLING=true`). The bridge starts with the app
  (`instrumentation.ts`) and reads updates by long polling (`getUpdates`, no
  inbound port). A lock file holding the process id
  (`<home>/data/assistant/bridge.lock`) keeps a second MyHQ process from
  polling the same home; a lock left by a dead process is taken over. The
  position in the update queue is kept in `<home>/data/assistant/offset.txt`
  and moves before an update is handled, so an update that crashes is never
  replayed. At startup, `setMyCommands` publishes the core commands and the
  extensions' commands. `GET /api/state` reports `assistant.polling`.

Only the chat `HQ_TELEGRAM_CHAT_ID` is served; anything from another chat is
logged and ignored. Every update is validated with zod; one that does not
match is logged and skipped. Replies go out as plain text: Markdown marks
(bold, headings, code) are removed, em and en dashes become commas or hyphens,
and long replies are cut at 4000 characters, at a line break when possible.
While a long action runs (chat turn, transcription) the "typing" indicator
stays on.

A text message (typed, or transcribed from a voice note) goes through, in
order:

1. **The pending question**, if any (see buttons below), unless the text is a
   command: it becomes the reason or the comment of the decision, or, for chat
   actions held for confirmation, « oui » executes them and « non » drops
   them (any other text drops them and goes on). A question expires after one
   hour; the user is told, and the message goes on.
2. **Core commands**: `/start`, `/new` (the next chat turn starts a new
   conversation, and the conversation MyHQ keeps is emptied), `/pending` (id,
   room and agent, title), `/approve <id>`,
   `/reject <id> <reason>`, `/revise <id> <comment>`, `/run <room>/<agent>
   [task]` (same lock and cap as the API), `/status` (runs and cost today and
   this week, the conversation's messages and cost this week, the share of
   the weekly budget when `HQ_WEEKLY_BUDGET_USD` is
   set, runs left under the cap, the scheduler's state, agents' states with,
   for those that have routines, whether they are armed and their next fire,
   and the last five routine firings), `/arm <room>/<agent>` and `/disarm
   <room>/<agent>` (the armed state of the agent's routines), `/salle <path>`
   (an onboarding run for a repository, see section 3). Decisions go through
   `decideApproval`, the same code as `PATCH /api/approvals/[id]`.
3. **Extensions** of the home, in the order of `assistant.json`: the first
   non-null answer is sent and nothing else runs (contract in
   `home-layout.md`).
4. **The chat**: `claude -p` in the configured working directory, the message
   on stdin, `--continue` to resume the conversation (retried without it when
   the CLI says there is nothing to continue), `--output-format stream-json
   --verbose` (MyHQ reads the final answer, the tools the turn called and its
   usage from the stream), the home's system prompt file with
   `--system-prompt-file` when `chat.systemPrompt` is set (it replaces the
   CLI's default prompt; the `CLAUDE.md` of the working directory is no longer
   the lever), the conversation MyHQ keeps (`chat_messages`: the exchanges and
   what the bot sent on its own, given back at the start of a turn as a
   delimited transcript when the turn does not resume, and as the bot's
   messages since the last exchange when it does; `chat.resume: "history"`
   drops `--continue` altogether, as any non-Claude engine would; see
   `home-layout.md`), the optional preamble (`chat.preamble`: a delimited
   block of the facts of that instant, the date and time, the pending items
   and today's runs, then the output of a command of the home, 600 characters
   at most, the command's part cached a minute and never waited for beyond its
   timeout) right before the user's words, and the
   same isolation as an agent run (environment cleaned, `--setting-sources
   project,local`, `--strict-mcp-config`, `--tools` limited to the whitelist,
   tool search off, deploy commands denied, `--max-budget-usd` from
   `HQ_CHAT_MAX_BUDGET_USD`). The optional `chat.mcpServers` of
   `assistant.json` are written to a per-turn `--mcp-config` file (same shape
   and `${NAME}` placeholders as an agent's, plus `HQ_DB_PATH`, `HQ_ROOM` =
   `_chat`, `HQ_AGENT_ID` = `chat` and `HQ_RUN_ID` = a turn id; never the `hq`
   server; the file is deleted after the turn), and `chat.allowedTools` may
   name their tools. Each turn installs the write guard in the chat's `cwd`
   (its settings file kept out of Git: the `cwd` is usually a folder of a
   versioned home): the chat writes only in its `cwd` and in the folders of
   `chat.writeDirs` (also passed as `--add-dir` unless covered), never in the
   other `addDirs`. This holds whatever `chat.permissionMode` says:
   `acceptEdits` alone would let the chat write in every `--add-dir`. Its
   write rules reach the CLI without their path, as an agent's do. After a successful reply, the action files of
   `chat.requests.dir` are taken first (`src/assistant/actions.ts`): `approve`,
   `reject`, `revise`, `run`, `arm` and `disarm`, whitelisted by
   `chat.requests.actions`, executed with the code of the buttons and the
   commands, each with one French line appended to the reply; when the turn
   called an untrusted tool (the web tools, `chat.untrustedTools`, any chat MCP
   server not marked `"untrusted": false`), they wait for the user's « oui »
   as a pending question of one hour instead, so that a mail or a page cannot
   get anything approved. Then the directory
   is scanned for requests (`src/assistant/requests.ts`): each `{ room, agent, task,
   reason? }` file becomes a pending task (source `chat`) of that agent and a
   run starts at once under the usual lock and cap (reason `chat`, or the
   given one); the file is deleted, a malformed one is moved to
   `<dir>/rejected/`. This is how the chat hands an action to an agent without
   holding its tools. The requests are handled before the reply is built,
   because the chat writes its answer without knowing whether the run could
   start: when it could not (busy agent, busy shared resource, daily cap), the
   core appends a factual French line to the reply, as for the actions (« Noté
   (tâche #161), mais Agenda ne peut pas tourner avant minuit : plafond de 60
   tours atteint... »). The history keeps what the user read. The optional `afterReply` command runs after each
   reply, its output logged only.

**One pipeline, two channels.** The chat turn (step 4 above, the actions, the
requests, the guard, the history, the meter) is one class, `ChatService`
(`src/assistant/chat-service.ts`), that the Telegram `Assistant` and the HTTP
route `POST /api/chat` (the conversation panel of the desk and of the floor)
both call. It is one object per home, kept on `globalThis` like the bridge, so the
two channels meet in the same place:

- **One turn at a time.** A single queue serializes the turns across channels
  (a message, a « oui » that executes held actions, a `/new`): a message that
  comes during a turn waits for it and is answered in order. The state (`running`,
  `queued`, the held confirmation) is published, and the panel shows « Rom2
  répond à un autre message » while its own message waits.
- **Held actions are shared.** The question that waits for a yes lives in the
  service, so a confirmation asked on Telegram can be answered on the desk and
  the other way round. Only the desk's panel has no commands: its text goes
  straight to the held actions' answer, then to the chat. The Telegram-only
  parts stay in `Assistant`: commands, extensions, voice notes and files, the
  buttons, the hand-over of an approved item, the typing indicator.
- **Selection lists.** A reply that holds a GFM task list (`- [ ] 1. label`, at
  most 12 items, `src/assistant/choices.ts`) is a list of choices: the service
  puts `choices` in the `TurnResult`, `POST /api/chat` returns them and every
  stored reply carries them (computed from its text, nothing more is stored).
  On the desk the panel draws them as checkboxes with « Envoyer la sélection »
  and « Tout » / « Rien », for the last message of the conversation only, and
  posts « Sélection : 1, 3, 5 » (the leading ids, or the full labels when there
  is none) as a normal message. On Telegram the `Assistant` sends the reply text
  with an inline keyboard (one ☐ / ☑ toggle per item, label cut at 40
  characters, then « Valider la sélection » and « Annuler »); a toggle edits the
  keyboard in place, « Valider » queues the same message through the chat
  pipeline as if typed (after the messages already waiting), « Annuler » only
  removes the keyboard. The ticks live in `PendingSelections` (by message id,
  kept an hour like a pending question, then the press answers that the list
  expired). Both ways the round trip is an ordinary user message and reply, so
  it is in the history.
- **Every message knows its channel** (`chat_messages.channel`: `telegram` or
  `desk`), and the history is the one conversation, whatever the channel.
- **Tasks for agents.** `POST /api/chat` with `to` does not ask the chat: it is
  `startRun` with the text as the task (reason `desk`, the usual lock and cap),
  recorded in the conversation as a message to that agent and a bot message of
  kind `dispatch`, so the next chat turn knows about it.
- **The `chat` event.** `recordChatMessage` and `clearChatHistory` publish on an
  in-process hub (`src/server/chat-hub.ts`, on `globalThis` like the roadmap's),
  and `GET /api/events` forwards it as the `chat` event, so that both channels
  stay in sync without polling. Everything that writes the conversation runs in
  the app process, which is why no table of changes is needed.

**What goes out without being asked.** Besides the alerts above, two options
of the home send text on their own, in both modes:

- `notifyTypes` in `myhq.json`: informational items. `hq_submit` stores an
  item of a listed type `unseen` (and marked read by its agent); the app sends
  it as one message, an alert line then its body as is, with a single **Vu**
  button (polling mode only, like the decision buttons; callback `hq:w:<id>`).
  A text (alert line and body) over `NOTIFICATION_TEXT_LIMIT` (1500
  characters) is cut at the end of a paragraph or of a sentence when one falls
  in the second half of the window, else at a word (`cutAlertBody`), and ends
  with « … » then « Lire la suite : <url>/bureau#approval-<id> » (or
  « (suite dans MyHQ, item #<id>) » without HQ_PUBLIC_URL): a long post is read
  on the desk, not in four messages. A shorter one ends with « Ouvrir : ... ».
  The button does what the
  desk's « Vu » does and edits the alert to add « Vu ». It stays on the desk
  under « À regarder » until seen, is never in the pending list, `/pending` or
  `hq_pending`, and never triggers `onApproval` nor wakes an agent. For a mail
  alert: the user reads it, there is nothing to decide. The MCP server finds the home's
  `myhq.json` from `HQ_DB_PATH` (`<home>/data/hq.db`).
- `quietHours` in `myhq.json` (`{ "start": "21:00", "end": "08:00" }`, wall
  clock of the home's time zone): during the range, the sweep
  (`notifyPendingApprovals`, `src/server/notify.ts`) leaves the informational
  items unsent and unmarked (`notified_at` stays null), except those whose
  payload says `"urgent": true`, which go at once. The first sweep after the
  end of the range sends the items created before that end as one text: a
  heading (`strings.notify.quietDigest`), then each item with its link, cut like
  a single one is (the limit shrinks with their number, down to 400 characters,
  so that the whole is one message when it can be; several messages only past
  4000 characters), without « Vu » buttons; a single item held goes the usual
  way, with its button. Since the sweeps otherwise run only
  during and after runs, the app also sweeps every minute while the key is set
  (`startQuietHours`, started by `src/instrumentation.ts`, the key read again
  each time). The desk is not affected: an item held is under « À regarder »
  from the moment it is submitted. Pending approvals, failure alerts and run
  summaries are never held. The range is read apart from the rest of the file
  (`src/server/quiet-hours.ts`), from the home of the database
  (`<home>/data/hq.db`), so no caller passes it.
- `notifyRuns: "summary"` on an agent in `room.json`: when its run ends
  `done`, its summary is sent as a plain message (Markdown marks removed, cut
  at 4000 characters). This is how a morning brief or an evening recap agent
  delivers its text: the agent's final text is the message, there is no item
  to approve. The summary is kept at about 4000 characters by the engine, so a
  longer text is cut.

Messages are handled one at a time, in order. Button presses are handled at
once, even during a long chat turn. In polling mode a pending-approval alert
carries two buttons: **Approuver** decides at once and edits the alert to
show the decision (its buttons go away), then hands over the body and the link
of an item that has an http(s) `payload.url` (see the approval cycle);
**Refuser** asks for the reason, which the next text message answers. A
revision is a reply to the alert: the text of the reply is the note of the
revision, and the alert shows the decision like it does for a button. The
`hq:v:<id>` code of the old « À retravailler » button is still read, with its
former behaviour (it asks for the comment), for alerts still on screen.
Failure alerts stay plain text.

**Links to the desk.** When `HQ_PUBLIC_URL` is set (the address of the desk
from another device, see the README on Tailscale), an alert about an item and
a notification end with « Ouvrir : <url>/bureau#approval-<id> », a failure alert
with « Ouvrir : <url>/bureau#run-<id> », and a brief or summary with
« Bureau : <url>/bureau » (`src/server/public-url.ts`). The floor, the home
page, sends an old `/#approval-<id>` or `/#run-<id>` on to the desk page with
its hash. The desk follows these
hashes on load and on `hashchange` (`src/ui/deep-link.ts`): the tab of the
item (pending or history; an « À regarder » item sits above the tabs), unfolded,
scrolled into view and ringed for a moment;
a run scrolls the feed to its start. An unknown id is ignored. Unset, nothing
changes.

**Files on Telegram.** The alert of a pending item with files lists their
names (« Fichiers joints : clip-01.mp4, cover.png ») and carries the first
file, in the agent's order, that a bot may upload (`src/server/telegram-media.ts`):
a video up to 50 MB with `sendVideo`, an image up to 10 MB with `sendPhoto`,
a sound up to 50 MB with `sendAudio`. The alert text becomes the caption (cut
at 1024 characters) and keeps its buttons; pressing one edits the caption
(`editMessageCaption`) instead of the text. A video above 50 MB gets a JPEG
thumbnail (`sendPhoto`) when `HQ_FFMPEG_BIN` names an ffmpeg binary
(optional, unset by default for portability; the thumbnail is kept next to
the copy). Otherwise, or when Telegram refuses the upload, the alert is the
text as before, with its link to the item when `HQ_PUBLIC_URL` is set. A 3D
part or a PDF alone stays text. Informational items are sent as before.

Voice notes and audio files are downloaded to `<home>/data/assistant/voice/`,
transcribed by the home's `transcribe` command, deleted, then handled as text.
Photos (largest size) and documents are saved into the home's `dropDir` under a
free name, with a companion `.md` note holding the caption when there is one.
The Bot API does not hand over files above 20 MB; the user is told.

A caption is a request of the owner about the file. Once the file is stored and
acknowledged (« Reçu »), and when the conversation is configured, the caption
goes through the chat pipeline like a typed message: the text is the caption
followed by a bracketed line with the stored file's absolute path, its kind
(photo or document) and the instruction to read it with the `Read` tool, which
displays images and PDFs (`strings.assistant.files.attached`). The reply goes
out on Telegram as for any text, and the exchange (with that text) is recorded
in the chat history. Without a caption, or with the conversation off, nothing
changes: the file is stored and acknowledged, no turn starts. A file that
could not be stored never reaches the chat. The caption is never taken for a
yes: it drops the actions held for confirmation, like any other message.

Two things follow from the file being outside content. The drop folder must be
readable for the turn: `ChatService.converse` takes an `attachmentDir`, and
`buildChatArgs` adds it as an extra `--add-dir` unless the chat's working
folder or one of its `addDirs` already contains it (the usual case when the
drop folder is inside a vault listed in `chat.addDirs`); a plain text message
never widens the chat's reach. And what a photo or a PDF says is an untrusted
read: when such a turn called `Read`, the actions it asked for wait for the
user's « oui » exactly as after a mail or a web page (the guard above, with
`Read` counted as untrusted for that turn only; the same tool in an ordinary
turn stays trusted).

The assistant's chat is not a run: it does not count towards the daily cap and
is not in the `runs` table. Each turn, answered or failed, is recorded in
`chat_turns` instead: engine, model, status and failure reason, the four token
counts, the cost, the number of tool calls and their names. The cost is the
turn's own: with `--continue` the CLI reports the whole resumed conversation
(`total_cost_usd` and `modelUsage` add up the session, `usage` is the turn's),
so MyHQ keeps the last total reported in `data/assistant/chat/cost-ledger.json`
and records the difference (`src/assistant/chat-cost.ts`; an estimate from the
turn's share of the session's tokens when that file is lost). A turn that comes
more than `chat.freshAfterMinutes` (60) after the previous one does not use
`--continue`: the CLI's cache is gone, and a new conversation with the last
exchanges of `chat_messages` is far cheaper than writing the old one again
(`src/assistant/chat-resume.ts`). `GET /api/usage`
gives its totals for today and the week next to each agent's (`agents`,
`chat`), the desk's meter lists the week per agent and for the conversation,
and `/status` adds a line for the conversation. This is the measure that says
which work to move to a local engine first.

## 6. Daily export and integrations

### Daily export

When the home has a `myhq.json` with an `export` section, MyHQ writes one JSON
file per day, `<export.dir>/<YYYY-MM-DD>.json`: the runs started, the messages
sent and the approvals created or decided during that calendar day of
`HQ_TIMEZONE`, in the shapes of the API (`date`, `timeZone`, `generatedAt`,
`runs`, `messages`, `approvals`). The previous day is written once
`export.hour` (local, 1 by default) has passed; the check runs at start and
every ten minutes and only writes a day whose file is missing, so a day missed
while the app was stopped is written at the next start. `POST /api/export`
writes a day on demand (and replaces its file). Without `myhq.json`, or
without its `export` section, nothing happens. It is just a folder: what reads
it (a notes vault, a backup) is the user's business.

### Integrations through MCP servers

An integration is an MCP server declared in an agent's `mcpServers` in
`room.json` (see `home-layout.md`), with its secrets as `${NAME}` placeholders
expanded from `.env.local` into the per-run `--mcp-config` file. Tools are
whitelisted by exact name (`mcp__<server>__<tool>`), never with a wildcard,
and anything that publishes or merges is left out of the whitelist (or added
to `disallowedTools`). There is no other integration mechanism: no API client
of MyHQ's own.

**HTTP servers with OAuth (for example Metricool): what works and what does
not.** What was checked with Claude Code 2.1.183 (`claude --help`, `claude
mcp add --help`):

- Declaring the server works: `room.json` accepts
  `{ "type": "http", "url": "..." }`, and `--strict-mcp-config` loads it from
  the per-run file, like any other.
- A static credential does not fit: `headers` are passed as written (only
  `env` and `args` are expanded), so a bearer token would have to sit in
  `room.json`, which MyHQ refuses to recommend. Expanding `headers` would be a
  small, deliberate change, to decide when a server needs it.
- OAuth needs a browser: `claude mcp add --transport http <name> <url>`
  (with `--client-id`, `--client-secret` or `--callback-port` for servers
  that require a registered client) registers the server, and the sign-in
  happens in an interactive session (`/mcp`). A `claude -p` run cannot open
  that sign-in. Whether a headless run declared through `--mcp-config` and
  `--strict-mcp-config` reuses the token stored by that interactive sign-in
  (same server name and URL), and whether it is refreshed between runs, could
  not be verified without the user's own account, and is not documented by
  the CLI's help. It must be tested once by the user with a single cheap run
  (check the server's `status` in the run's `start` event: `connected`, or
  `needs-auth` / `failed`).
- The connectors of claude.ai are not visible to `claude -p`, and MyHQ does
  not extract tokens or write its own API client. If the test above fails,
  the honest fallback is the simplest one: the agent submits its posts as
  text drafts (`social_post` items) and the user schedules them himself.

## 7. The room view

The home page `/` is the floor, drawn in isometric pixel art as a small
agency (`/room`, its old address, redirects there, in `next.config.ts`):
cutaway rooms (back walls at full height with windows and a door, a low rim
in front) on a wooden hall. The lobby holds the user's own desk, a filing cabinet with the "to
approve" tray (its paper pile and its count) and, on one floor, the reception
counter; offices hold the agents' workstations (desk, screen, chair), a
bookshelf, plants and a rug; the meeting room has its table, its whiteboard and
a coffee corner, the kitchen a coffee corner and sofas. The carpets and tiles
of the rooms, the rug borders, the sofa pillows and the band of the counter
take the room's colour (`room.json` `color`, a pastel of it for the floors),
or a neutral look without one. The figures of the whiteboard (runs of the day
against the cap, cost of the runs and the questions to the agents, share of the weekly budget, routines armed, next fire
and last firing: the numbers of `/api/usage` and `/api/routines`) are a card
in a corner of the canvas, each one flashing when it changes. The canvas takes
the whole width and the height that is left under the header and above the
strip of agents. The desk, the page that works everywhere (the items to
decide, the team, the feed), is `/bureau`: a click on the user's own office
opens it (below). When the home has several rooms, buttons choose the floor
shown. Every page has the same navigation in its header (`site-nav.tsx`):
« L'étage » (`/`), « Le bureau » (`/bureau`), « Feuille de route », « Réglages ».

**Pixel art, zoom and pan.** The art (`public/iso/`, built by
`scripts/iso/`, formats in `scripts/iso/README.md`) is only ever drawn at a
whole number of device pixels per art pixel, one at least, with nearest
sampling, no mipmaps and whole pixel positions (`roundPixels`), so it stays
sharp. The canvas holds one pixel per device pixel (`autoDensity`), is
displayed with `image-rendering: pixelated`, and under a fractional pixel
ratio (125 %, 150 %) is moved by the fraction of a device pixel the page lays
it out at, so the browser never resamples it. On load, or with the « Vue
d'ensemble » button, the floor takes the largest such zoom that fits the
canvas, centred; when even one device pixel per art pixel is too big (a
1280 to 1440 pixel screen for the single floor, a phone), it stays at one and
the rest is a drag away (the floor of one room then shows its offices). Zooming
out goes further, down to the zoom where the whole floor fits the canvas
with a margin (`minZoomFor` and `fitZoom` of `floor-view.ts`, never under
0.15): under one, the steps are that minimum, then 0.35, 0.5 and 0.75 when
they are clearly above it, and the art is sampled linearly (a slightly soft
overview rather than rows of pixels dropped); from one up, nearest sampling
and whole steps as above. Under one, text that would pile up goes away by CSS
scale (`labelDetail`): the wide bubbles (activity, « réfléchit ») under 0.75
CSS pixel per art pixel, the names and small marks under 0.5; a decision's
« ? » and the tray counter always stay, and an agent keeps a click target of
at least 10 CSS pixels.
The wheel zooms, one whole step per notch, around the pointer (a trackpad's
two finger scroll cannot be told apart from a wheel for sure, so it zooms
too, and its pinch arrives as the wheel with ctrl); a drag (a mouse, one
finger) pans; a pinch and the + and - buttons zoom. A click on a room flies to
it, and always closer than the overview: at the whole zoom nearest to the one
where the room (walls and signboard included) fills the view, and at least one
step closer than the overview, so a big room overflows the view a little
rather than being only recentred (never more than FOCUS_OVERFLOW, 1.75 times,
along its tighter side; `focusZoom` of `floor-view.ts`). The centre of the
room's box (signboard included) goes to the middle of the view, so a room
bigger than the view overflows it evenly on both sides; on a wide screen, the
middle of the part of the canvas left of the room's sheet it opens (below);
when the sheet closes, the room goes back to the middle of the whole canvas,
unless the view moved since (a drag, a zoom, the overview). The flight passes through the zoom levels only (whole steps from one up) so every frame
stays crisp, at once under `prefers-reduced-motion`. A click on the floor
outside the rooms, or the « Vue d'ensemble » button, flies back to the
overview and closes the room's sheet. A click on an agent still opens its
sheet, on a room's counter its pile, on the user's own office the desk.

**Templates.** The floor is not computed: it is one of three hand-designed
templates by number of agents, data in floor cells in
`src/ui/floor-templates.ts` (small for 1 to 3 agents: the lobby, an office of
three, a meeting room with a coffee corner; medium for 4 to 6: an office of six
and a kitchen; large for 7 to 12: two offices of six). A room lists its
position and size, its floor, the kind of each back wall cell (plain, window,
door), the openings of its front rim, its furniture and desks (a workstation
and the chair the floor set gives it), and its aisles; the hall lists its
cells and its lanes. Agents fill the desks in order; the chairs left empty stay
empty. A back wall hides about four cells behind it, so the rooms are laid out
so that none hides another: the back row climbs like a staircase (an office to
the +x of the lobby and entirely behind it, which reads as a row across the
screen), a second office follows four cells away on the same line, and the
front row stands four cells away from the lanes and is entered by a door in
its back wall from the hall behind it. Walls make sense: a door or an opening
of a rim always leads onto the hall, never outside; a window only looks
outside, never onto the hall or another room; nothing tall (a bookshelf, the
whiteboard, a cabinet, a tall plant) stands in front of a window, and nothing
in front of a door. `layoutRoom`
(`room-layout.ts`) turns the template into pieces, offices (chair, seat, the
way the agent faces, the aisle cell next to it) and a graph of the aisles and
lanes. Tests check that no cell of a room and no point of a route is behind
another room's wall, that no route goes through a wall or a piece of
furniture, that pieces never share a cell, that the walls follow the rules
above and that the hall is in one piece. More than 12 agents are listed
under the floor but have no office on it.

**The single floor.** With `floor.layout: "room-per-project"` in `myhq.json`
(`home-layout.md`; the default, `"floor-per-project"`, is the floor of one
room above), `/` draws the whole home as one floor where each room of the
home is a suite of its own (`layoutFloor`, `src/ui/floor-plan.ts`): a block
with its own back walls, windows and front rim, like the rooms of the
templates. The lobby is the entrance, at the front corner of the floor (the
bottom of the screen): the main corridor runs along the front from its
opening, the spine climbs from the same corner along the right edge to the
back, and ribs branch off the spine. Each row of suites, right-aligned on the
spine, stands on a rib and opens onto it: the front row on the main corridor,
the lobby at its right end, the user's own office beside it, then the room
of the reception (`reception.room`). The rows are as wide as their own suites, the rooms shared out so
the rows stay even, and the arrangement is the most compact one, two rows at
least from two rooms. A back wall hides about four cells behind it, its
signboard about five, so a corridor runs along the front of the suites it
serves and keeps clear of any other back wall: between a rib and the back
walls of the row in front of it lies their shadow (four cells), two suites
side by side keep four cells apart (a sign hides nothing beside its room), and
that shadow, mostly covered by the walls on screen, is a garden
(the `grass` tile of the floor set). No block hides another, no corridor runs
behind a wall and every window looks onto the garden. A suite is six cells
deep and as long as its team needs (`roomLength`): two rows of workstations
facing the back wall (desk, chair, aisle, twice), two cells per desk, the
column of the aisle to the opening with a tall plant at its top, a bookshelf,
a whiteboard, plants or a printer in the places left, and for a team of six or
more a coffee nook (the coffee corner, a sofa on a rug); its carpet takes its
own colour. A room with `decor: "library"` (`home-layout.md`) keeps the same
desks and aisles on a wooden floor, lines its walls with shelves of books (a
ladder among them), puts reading tables in the places left and, instead of the
nook, a reading wing of three cells beyond the aisle (an armchair, a floor lamp
and a side table on a rug, piles of books). There is no desk for the user in a suite: what waits for the
user's decision there is on its counter, next to its signboard (below), and
its agents drop what they submit in its opening (`owners` of the layout, the
cell inside the opening, facing the back wall). The lobby (eight by eight)
holds the reception counter, the receptionist behind it, the coffee corner, a
sofa by a rug, and the counter and the drop spot of the onboarding room `_hq`,
where room proposals land.

The user's own office (`ownerOffice`, a block of OFFICE_LENGTH by six cells
beside the lobby, `layout.office`) is the desk's scene itself: the hub's
room, its props at the same places and its lights, rendered by
`scripts/iso/` at the size of the office with the floor's wall height, one
sprite of the floor set (`office` of `floor.json`) drawn instead of its tiles,
walls and furniture: the sage walls, the window with the big plant under it,
the lit floor lamp in the corner, the clock and the picture, the low
bookshelf, the walnut desk with its screen, lamp, post-its, phone, newspaper,
the calendar, the armchair on its rug. Its pile (one folder per item waiting
for a decision, fourteen at most, each spine in its room's colour) and its
letter tray (the letters of the desk's tray, five at most) are the hub's
states, drawn over it as the counts change. Nobody works there, unless the
home seats its owner in its chair (`floor.owner` of `myhq.json`, see
`home-layout.md`: typing while a turn of the chat is in progress; a click on
the owner opens the chat); a click anywhere else on it opens the desk, `/bureau`. On a floor of one room
(`"floor-per-project"`), the user's desk and tray of the lobby (« Votre
bureau ») play that part: a click on them opens `/bureau`.

**Signboards.** Every block of the single floor (the suites, the lobby, the
user's office) carries a signboard on its back wall along x, like a shop sign
on a roof: a board standing on two short posts on top of the wall, facing the
viewer, centred, in the room colour (a neutral slate without one) with a
frame a shade darker. It is floor art (`sign` of `floor.json`, built by
`scripts/iso/`): a left end, middle segments and a right end, as many
segments as the name and the logo need (`room-signs.ts`, `planSign`), never
longer than the wall (the logo goes first, then the end of the name). The
name is written in capitals on the face with the pixel font of the floor set
(`font` of `floor.json`), each pixel of a glyph a square of two by two on the
face's own stairs (the face falls one pixel every two columns, like the
wall), in paper white or ink black, whichever contrasts most with the board.
The board is centred on its wall, unless the room has a counter.
A room whose `room.json` has a `logo` (`GET /api/rooms/<room>/logo`) shows it
on the left of the name, reduced to the height of the face without blending
any colour (`shrinkLogo`: each pixel takes the colour that covers most of its
block, or a detail in strong contrast with it), outlined in the ink when its
colours are too close to the board's. The names are on the canvas only; the
room buttons at the top and the list « À signer, par salle » under the floor
name every room for the keyboard and screen readers. A sign rises to
SIGN_TOP voxels (79, the wall 64): the hiding rules count it on the whole
length of the wall, so it never hides a room or a corridor.

**Counters.** Every suite and the lobby carry a counter beside their name: a
short board of the same art (COUNTER_SEGMENTS segments, COUNTER_LENGTH
voxels) with the number of items of that room waiting for the user's
decision (`pendingByRoom` of the view, an item delivered by a shared room
counting for the room that ordered it; 99 at most), in the same pixel font.
When the back wall along x holds both boards, the counter stands right after
the name and the pair is centred on the wall; otherwise (a short room) the
counter stands on the other back wall, by the corner, and the name's board
starts by the corner too, so the two meet there (drawn as the mirror image of
the same art, the number still read left to right). At zero the counter is
quiet: a pale board of the room colour, a soft ink. Above zero it takes the
room colour and the ink that contrasts most with it, and flashes lighter for
a quarter of a second every 1.6 seconds (never under
`prefers-reduced-motion`). It follows the stream. A click on it opens the
page of the pile of decisions filtered to that room. The hiding rules count
the counter as high as a sign on both places it may stand.

The tests run every
rule above on generated homes of 1 to 8 rooms of 1 to 12 agents, check that
blocks stand apart with their walls, that the lobby is the front corner where
the corridors start, and that rooms and corridors take most of the floor's box
(the garden only the rest). The page shows every agent of the home in the
strip, the receptionist last; the buttons at the top fly the view to a room
(as a click on it does) and carry its count. A click on a room's counter (or the list « À
signer, par salle » under the floor, its equivalent for the keyboard and
screen readers) opens the page of the pile of decisions filtered to that room,
`/bureau/<id>?room=<room>` (section 8). An agent carries what it submits to the
opening of its own room, a delivery of a shared room (`forRoom`) to the
opening of the room that ordered it, and a message to an agent of another room
(`hq_message` with `room`) is a walk along the corridors to that agent's desk.
The floor is meant to be panned (a drag, a swipe) and zoomed (the wheel, a
pinch, a click on a room); its overview is centred on the whole, at one device
pixel per art pixel at least.

**The reception.** Onboarding is an agent too (section 3), and it is
the one agent that no room owns: its runs belong to the reserved room `_hq`. So
that it is visible, every template has a reception counter in its lobby (the
receptionist stands behind it, where the floor set's `staff` cell is,
`lobby.reception` in `floor-templates.ts`), but the counter is
drawn on **one floor of the home only**: the `reception.room` of `myhq.json`,
by default the room called `assistant`, otherwise the first room (`GET
/api/state` gives it as `reception.room`, `resolveReceptionRoom` in
`reception.ts`). The other floors keep a plain lobby. On that floor the model
(`room-model.ts`) adds the receptionist to the agents of the room, with the key
`_hq/onboarding`, and feeds it the runs, events and approvals of `_hq` (the
store routes them): it sleeps when idle, types while a run reads the repository,
and on `hq_submit` of its `room_proposal` steps out from behind the counter
to the tray (the same kind of trip as an agent's, the folder lands in the tray,
the count rises), then goes back; a failed run puts a question mark over it.
Its name tag reads « Accueil » (`strings.room.reception`),
its chip is the last of the strip with its state, and clicking either opens its
sheet: what it does, the « Ajouter une salle » form (the component of the desk's
form, `add-room.tsx`, which calls `POST /api/onboarding`) and its recent
onboarding runs with their target repository and cost (from `reception.runs` of
the state, kept up to date by the stream). Its sheet is
`public/sprites/iso-receptionist.png` (headset), built by `scripts/iso/`; the
old `onboarding.sprite` of a home is no longer drawn. To see it without a real run:
`npx tsx scripts/replay-fixture.ts test/fixtures/stream-json-onboarding.jsonl --agent onboarding`.

**Pieces.**

- `src/ui/room-model.ts`: the pure animation model. It takes the entities the
  page already receives (the `/api/state` snapshot, then the SSE `run`, `event`
  and `approval` messages) and gives a visual state per agent. No canvas, no
  real clock: time is a number of milliseconds passed in by the caller, so the
  tests replay the fixtures (`test/room-model.test.ts`) on a fake clock.
  `src/ui/room-layout.ts` builds the floor from a template and plans the
  routes, in voxels of the floor set (16 per cell); `src/ui/room-store.ts`
  keeps one model per room outside React.
- `src/ui/iso-floor.ts`: the floor set's format (`floor.json`, checked with
  zod), the scene of a floor as things to draw (tiles, floor shadows and rugs
  flat, then the boxes of walls, rims and furniture), the depth order
  (`compose.mjs`'s rule: a box that ends before another on x or y is drawn
  first) and the character sheet rows.
- `src/ui/room-renderer.ts`: PixiJS drawing behind a small interface (create,
  draw a scene, resize, pan, zoom, set the density, destroy). The flat layer is
  built once per floor and colour; walls, furniture and standing characters
  are sorted again when a standing character moves; a seated character is drawn
  inside its chair, between the chair's `under` and `over` frames (the
  backrest in front of it). Tint masks are sprites tinted with the room colour.
  `src/ui/room-labels.ts`: every piece of text of the floor (the name over
  each head, bubbles, the user's desk, the tray count) is an HTML element over
  the canvas, at whole CSS pixels, in the page fonts and colors (CSS
  variables), with the box of a tag or a bubble drawn by CSS. No font is
  drawn in the canvas, so text is sharp at any zoom and in both themes (the
  names on the signboards are pixel art of the floor set, drawn like the rest
  of the art).
  `src/ui/room-canvas.tsx` imports the renderer dynamically in an effect
  (never on the server), owns the frame loop, the pointers (drag, pinch,
  click on an agent, a desk, the office or a room), the wheel, the zoom
  buttons, the whiteboard card, the density and the alignment of the canvas
  on the device pixels. `src/ui/room-signs.ts`: the signboards (their length,
  the ink, the logo reduced, the face painted), pure.
  `src/ui/room.tsx` is the page: header, rooms, the canvas or the compact band,
  the strip of agents, the sheet.
- Walking follows routes of the layout (`routeToOffice`, `routeToUser`; the
  receptionist's spot behind the counter is a seat like an office's): from the
  chair to the aisle cell next to it, along the aisles of the room, out by an
  opening of its front rim, along the lanes of the hall (the shortest way in
  the graph of aisles and lanes, Dijkstra), into the other room, to the aisle
  cell next to the colleague's chair or in front of the tray. Every leg is
  along x or y, so a character walks in the four directions of its sheet,
  facing the way it goes; the frame of the walk follows the distance walked.
- Characters: an agent's own sheet is `agents[].isoSprite` (contract in
  `home-layout.md`, route in `api.md`); otherwise one of the four neutral
  people of `public/sprites/iso-person-*.png`, picked from the agent's key so
  it never changes. The old top-down `sprite` is accepted and no longer drawn.

**What the stream does** (durations are named constants of `room-model.ts`):

| Entity | Effect |
|---|---|
| `run` running | The agent is awake at its desk, seated; a new run clears a question mark. |
| `tool_call` | Types for 2.5 s. |
| `text` | Thought bubble with the first 64 characters, for 5 s (the stream does not keep `thinking` blocks), unless the agent's own words (`hq_status`) are up. |
| `tool_call` `mcp__hq__hq_status` | The bubble of activity over the head says its `text` (see "The activity bubble"); nothing else moves. |
| any other `tool_call` | Types for 2.5 s; the tool, in a few words, becomes the safety net of the bubble of activity. |
| `tool_call` `mcp__hq__hq_message` | Gets up and walks the aisles and the hall to the chair of `input.to`, faces it and talks for 3 s, walks back and sits. A recipient that is not in the room makes it an ordinary tool call. |
| `tool_call` `mcp__hq__hq_submit` | Walks to the tray of the lobby carrying a folder, stays 2.2 s, drops it in the tray, walks back. The tray counter rises at the drop, not when the `approval` event arrives. |
| run `failed`, `end` failed, or `hq_task_update` with `status: blocked` | A question mark, until the user decides an item of that agent or the next run starts. It overrides typing and thinking, not a walk, and it does not fall asleep. |
| no run for 60 s | Asleep. |
| `approval` | Moves the tray counter (pending items shown). |

Trips queue behind each other (three waiting at most). Every state has a text
label (types, thinks, "drops an item"...) in `strings.ts`.

**The activity bubble.** During a run, a small bubble over the head of the
agent says what it is doing, in its words: the `text` of its latest
`hq_status`. The prompt of every run (`buildPrompt`) asks the agent to call
it at the start and at each notable step, a few words in the home's language,
60 characters at most, no technical detail (an agent whose `allowedTools`
is explicit needs `mcp__hq__hq_status` in it; `mcp__hq__*` covers it). The
MCP server stores it (`run_statuses`: run, room, agent, text, time) and
writes nothing else; the floor learns it from the tool call itself, which the
run's event stream already carries to the page (`tool_call` events), checked
with the same rule as the server (`normalizeStatus` of
`src/ui/activity.ts`: one line, 60 characters at most as given, not blank),
so that both agree on what is a status. The latest status wins for 2 minutes
(`ANNOUNCE_MS`); then, or when the agent never said anything, its last
other tool says it instead, translated by code, without a model
(`toolActivity`): Read « lit brief.md », Grep and Glob « cherche dans les
fichiers », Write and Edit « écrit script.md », WebSearch « cherche sur le
web », a Bash command by what it runs (ffmpeg « monte la vidéo », Remotion
« fait le rendu vidéo », python, node or curl « lance un script », git
« met à jour le code », tests « lance les vérifications »), `hq_submit`
« dépose un item », `hq_message` « écrit à writer », the tool of another
MCP server « utilise courrier ». A status stays as long as no tool came after
it. The bubble shows 30 characters at most, cut with « … », in the box of the
other bubbles (a small tail under its middle), above the name tag and never
over it. The agent's own words win over a thought bubble; the words of the
safety net give way to one for its 5 s. Both give way to the question mark
and to a visit, and never show between runs (an agent that
waits or sleeps has none). A click on it opens the agent's sheet, as a click
on the character does. Reduced motion changes nothing: the bubble does not
move. The chip of the agent under the floor and the header of its sheet show
the same words in full (« Au travail : rend le clip B, 2 sur 3 »). A page
opened during a run gets the latest status and the last tool call of the run
from `/api/state` (`activity` of each agent), so the bubble is there at
once.

**Accessibility.** The canvas complements the desk and is `aria-hidden`. Under
it a list gives, for each agent, its name, its state in text and a button that
opens its sheet. A single polite live region says the changes of a coarse state
(asleep, working, visiting, carrying an item, stuck): typing and thinking come
and go too often to be announced. The name of an agent is always written, over
its head, seated or walking: colour never carries the identity alone. The zoom
buttons are real buttons with French labels, outside the hidden canvas.

**Performance and motion.** The canvas is drawn at the device pixel ratio
(`autoDensity`, redrawn at the new density when a zoom changes it), always at a
whole number of device pixels per art pixel (see above).
The loop draws only while the tab is visible and the canvas
on screen (`visibilitychange`, `IntersectionObserver`); the SSE stream keeps
feeding the model, which is a function of time, so the room catches up on
return. Idle, the room redraws at 10 frames per second (slow animations and the
coffee steam), walking at the screen rate. With `prefers-reduced-motion`
nobody walks or sways: poses are held on their first frame, a move is a short
crossfade, nothing flashes on the board, and the room is redrawn when its state
changes (a timer at the next change), which is about no frame at all when idle.
Under 40 rem of width the page scrolls as before and the canvas is not
mounted: a compact band (the board figures, the tray count, one agent per
line) and a "Voir la pièce" button that mounts it on demand, most of the
screen high, the floor fitted (offices first) and draggable.

**The sheet of an agent** (click on a character, or its chip under the
floor; `agent-sheet.tsx`) is a conversation with it, laid out like a
messaging app:

- **The header**: the agent's name, its room and its state in one line
  (« Au travail : rend le clip B, 2 sur 3 » with the words of its bubble of
  activity, « Réfléchit à ta question… », « Dort », « Disponible », a failed
  last run, a shared resource it waits for: `sheetState` of
  `agent-thread-model.ts`, pure).
- **One thread**, oldest first: the owner's messages and the agent's answers
  (questions to the agent, see "Questions to an agent"), its runs in one line
  each (time, status, duration, cost and the end of its summary; unfolded,
  the whole summary, its task and a link to the run on the desk; the steps it
  announced with `hq_status`, time and text, the latest three shown, the
  current one in front while the run goes on, the earlier ones folded), the items it
  submitted (title, status, a link to the desk) and its questions (`hq_ask`)
  that wait for the owner, with « Répondre ». A day line separates the days.
  The server aggregates it (`readThread` of `src/server/agent-thread.ts`,
  `GET /api/rooms/<room>/agents/<agent>/thread`) from the tables that hold
  each of them, without copying anything: the discussion since its last
  reset, the latest 15 runs and the latest 20 items. The interface turns it
  into lines (`threadLines`, pure). It is read again when the agent's last run
  starts or ends, when one of its items comes or is decided, at each new
  status of the agent (a moment after its tool call, for the server to store
  it), and every 2 seconds while a question waits for its answer.
- **One field at the bottom**, « Écris à <agent> », and a send button: Enter
  sends, Shift+Enter goes to the next line. Each message is a question to the
  agent. « Nouvelle discussion » takes the messages and answers out of the
  thread (`cleared_at`); its runs and items stay.
- **The gear** opens the technical side instead of the thread: a run without
  a task (« Lancer un tour », the role's usual work), the role file, model,
  tools and resources, the routines and their arming switch, and the journal
  of the recent runs (`FeedRow` of `feed.tsx`, rebuilt from the events the
  page holds).

A side panel on a wide screen; under 48 rem the whole screen, the field at the
bottom and a visible « Retour » in the header. Escape closes the gear, then
the sheet, and focus returns to what opened it. On a wide screen the field has
the focus when it opens; on a phone the way back has it, so that the keyboard
does not cover the thread.

**The sheet of a room** (single floor: a click on a room, or its button at
the top; `room-sheet.tsx`, the figures in `room-sheet-model.ts`, pure): the
same panel, for the room: its name, its colour and logo (the logo on the
colour, like its signboard); what waits for the user's decision (the count of
the room's desk, a link to « À signer » filtered to the room); the runs and
cost of the day (`agents.today` of `/api/usage`); and each agent, as a button
that opens its own sheet (closing it comes back to the room's): its state
(works, waits for a decision of the user, waits for a shared resource, stuck,
failed, asleep), one line on what it does (the latest thought of its running
run) or did (the first line of its last summary), the time of its last run,
and its routines in words (« Du lundi au vendredi à 8 h », from `schedule` of
the state, `schedule.ts`; the cron expression when words would not help),
armed or not, with their next fire. The lobby's sheet is the reception's, its
agent the receptionist. Built from the page's model, it follows the stream;
the routines and their arming come again from `GET /api/routines` every
minute and after each run.

**The conversation panel** (`chat-panel.tsx`, `use-chat.ts`; on `/` and
on `/bureau`): a button in the header (and the key `c`, when nothing is being typed)
slides in a panel titled with the assistant's name (`strings.chat`), the same
conversation as Telegram's (`GET /api/chat/history`, then the `chat` events of
the stream, loaded again after each reconnection). The user's messages are
right-aligned, the chat's replies left-aligned, what the bot sent on its own
(alerts, notifications, run summaries, the confirmation of a task sent to an
agent) is a muted card labelled with its kind; a message from Telegram says so. The
row of chips under the log chooses the recipient: the assistant (default), or one
agent of the room shown (all the agents on `/bureau`), each with its state as a dot and
in text. Enter sends, Shift+Enter makes a new line. A message to the assistant
is `POST /api/chat`; to an agent, the same route with `to`, which starts a run at
once, so that it shows up in the feed and walks the floor. While a turn runs the
panel says « Rom2 écrit », or « Rom2 répond à un autre message » when this
message waits behind one (another channel's, or an earlier one); held actions
show a card with « Oui » and « Non », which send the answer through the same
route; `/new` calls `DELETE /api/chat/history`. On a wide screen the panel is
docked at 380 px on the right and the page gives up that width, so the canvas
re-fits (it already follows the size of its box); under 40 rem it is a sheet over
the whole screen and the page behind is inert. Colors, fonts and tokens are
the floor's (`.chat-*` rules of `globals.css`, with the desk's tokens as
fallbacks on `/bureau`); the panel's entrance and the dots of the typing indicator
stop under `prefers-reduced-motion`.

**Without a real run.** `scripts/replay-fixture.ts` plays a fixture into a
throwaway demo home, one event per second, so that the real SSE stream animates
the room (README, "Trying the room without a real run").

**Choices and measures.**

- PixiJS rather than a hand-written 2D canvas: the plan decides it and richer
  animations can use it. Fifteen sprites would not need it. The cost is about
  168 kB gzipped (572 kB minified; esbuild estimate of the renderer chunk, under
  the 250 kB threshold), paid on the floor only, since the module is a dynamic
  import. The renderer is behind an interface, so a canvas 2D one can replace it
  without touching the model.
- The tray counts the items of the shown room; on the single floor, each
  room's counter counts the items of its room (`pendingByRoom` of the view), an
  item delivered by a shared room counting for the room that ordered it.

## 8. The desk objects

The desk (`/bureau`, a click on the user's office of the floor) opens on a scene, the hub: the user's office in isometric
pixel art, where each object on the desk is a module (a pile of items to sign,
a mail tray, a newspaper, post-its, a wall calendar, a phone, the Standard of
what is stuck). It stands on the model, the data, the API and one page per
object.

- **The model** (`src/server/desk.ts`): `desk.objects` of `myhq.json` lists the
  objects, each `{ id, object, label, source }` (schema and defaults in
  `home-layout.md`). It is read apart from the rest of the file, so an invalid
  block falls back to the default desk without touching `notifyTypes` or the
  export. A source of the core is read from the database at each request
  (`approvals`, `watch:<type>`, `summaries`, `chat`, `blocked`); a command of the home
  goes through `DeskCommands` (`src/server/desk-command.ts`): the system shell
  in the home, the environment of the home's other commands, a timeout (the
  desk does not wait for a program that keeps the output open after the shell
  is killed), its stdout validated by zod, the result cached a short while,
  one run shared by concurrent requests, a failure kept as a value (an error
  state with its code), stderr in the log only.
- **The API**: `GET /api/desk` gives every object with its count and items
  (and the room colour of each pending item for a pile, so the scene can paint
  the spines); `GET /api/events` sends a `desk` message when a count or the
  state of an object changes. The counts are read every three seconds while a
  stream is open (one watcher per home, shared by every stream, started with
  the first and stopped with the last); a command is run again only when its
  cache is stale. The first reading is the baseline and is not announced.
- **The pages**, `/bureau/<id>` (`src/ui/desk-module.tsx`,
  `desk-module-views.tsx`): the navigation of every page (« Le bureau »
  marked, since a module belongs to the desk), the label and the count,
  the connection state, and the interface of the object, chosen by its kind
  and its source. A pile of `approvals` is the desk's own approval cards
  (`Desk`: folded lines, annotations, the main button, every action, the
  history tab). A tray of `watch:` sources lists its unseen items with « Vu »
  and « Demander à » the assistant, oldest or newest first, then the ones
  already seen (`WatchDesk`). The newspaper is a reading view: a masthead with
  the day, the latest brief or recap as the lead story, the others in columns
  on a wide screen; an unseen brief can be marked read there. The calendar
  shows today in large and the next seven days beside it (under it on a phone),
  each with its events and its free slots, read-only. The post-its are notes,
  numbered as the list numbers them, the late ones marked. An object on
  `blocked` is the Standard (see "The Standard" in section 1): one card per
  entry, its room chip and colour, its agent, « depuis 2 h », the reason, the
  text of the task folded, and « Relancer » and « Clore », each asking a
  light confirmation in the card before it acts; what the action did (the run
  started, or why the agent could not be woken) is said above the list. A
  phone on `chat` is the conversation panel as the page itself. Any other
  pairing gets a plain list. Each page follows the live stream like the desk
  does (`useHq`), and reads `GET /api/desk` again on each `desk` message
  (`useDesk`).
- **Seen**: opening a page marks its object seen (`POST /api/desk/<id>/seen`,
  the `desk_seen` table, migration 15), once per opening. The `summaries` and
  `chat` sources of that object then count only what came after: the count of
  the newspaper falls back to its unseen briefs when its page is opened, and a
  summary that arrives later counts again, instead of the whole day until
  midnight. The other sources keep their own logic (`home-layout.md`, "Seen").
- **Deep links** keep working: `/bureau#approval-<id>` opens the item on the
  desk (the floor sends an old `/#approval-<id>` there), and the items of a
  module link to `/bureau/<id>#approval-<id>`, which
  unfolds and rings the item on the page of the pile or the tray.
  `/bureau/<id>?room=<room>` (the counter of a room of the single floor)
  shows the pile of `approvals` filtered to that room (its own items and the
  deliveries ordered from a shared room), with a « Filtré sur » chip whose
  cross goes back to the whole pile.
- **The hub** (`src/ui/hub.tsx`, the mapping in `src/ui/hub-scene.ts`), at the
  top of `/bureau`: the scene composed in the browser from `public/iso/hub/` (format
  in `scripts/iso/README.md`). Each object of the scene takes the state that
  matches its desk object: the pile has one folder per pending item (14 at
  most), each spine tinted with the room colour of its item, oldest at the
  bottom (`spines`, a neutral grey for a room without a colour); the tray has
  as many letters as its count (5 at most), the monitor as many post-its; the
  newspaper is there when its count is not zero; the phone lights its lamp
  when its count is above zero (for the Standard, an agent stuck), and the wall calendar marks today (the
  browser's day). The tint masks are applied as the build does (colour times
  the grey of the mask), cached per frame and colour. The scene is drawn at
  1x on an offscreen canvas, then on the page at the largest integer scale in
  device pixels that fits the width (and, on a wide screen, the window height
  minus room for what follows), with nearest neighbour sampling, so nothing is
  blurred whatever the pixel ratio. A small pixel badge (a 3 x 5 font) sits
  over each object that holds something: its count, 99+ beyond, « ! » for a
  command in error. A kind the home's desk does not configure is drawn empty
  and does nothing.
  Each configured object is a link to `/bureau/<id>` laid over its hit box,
  in the order of the home's desk, named for a screen reader with its label
  and count; keyboard focus draws its hover frame (lifted, two rings) and a
  tooltip with its label. The pointer is resolved per pixel (the alpha of the
  frames drawn), since some hit boxes overlap (the post-its, the pile, the
  newspaper): the object under the pointer gets the hover frame and the
  tooltip, and a click opens it. An object with nothing drawn (no post-it, no
  newspaper) is listed under the scene (« Aussi sur le bureau »). The scene
  follows `useDesk`, so it changes on each `desk` event without a reload; the
  phone's lamp blinks while its count is above zero, unless
  `prefers-reduced-motion` asks otherwise. On a phone (under 40rem) the scene
  fits the width and a list of the modules follows it (label, count, link);
  should the assets fail to load, that list stands in for the scene.
  Under the scene, the desk keeps its folded items (« À regarder », then « À
  valider » and the history), so `/bureau#approval-<id>` works as before; the meter
  comes after them on a wide screen.
