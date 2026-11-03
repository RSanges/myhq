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
- `--model`: the model of the agent (`opus`, `sonnet` or `haiku`).
- `--allowedTools`: the agent's whitelist of tools.
- `--output-format stream-json --verbose`: the event stream (`--verbose` is
  required in print mode). It animates the room and feeds the activity log.
- `--mcp-config`: a JSON file generated per run, with the HQ MCP server and
  the extra servers the agent is allowed to use.
- `--max-budget-usd`: the cap on the cost of one run.
- `--strict-mcp-config`: only the servers of that file, none of the user's.
- `--setting-sources project,local`: the user's personal settings (hooks,
  plugins) do not run inside agents.
- `--disallowedTools`: deployment and schema push commands, denied to every
  agent whatever its whitelist says, plus the agent's own `disallowedTools`.
- `--add-dir`: the directories the agent may read besides its working
  directory (`addDirs`, by default the target repository for an agent that
  reads files and has no worktree).
- `--tools`: only the built-in tools of the whitelist exist for the agent
  (none when it only uses MCP tools), so nothing outside it can run.

The process starts in the agent's own working directory and receives the run
context through environment variables (`HQ_DB_PATH`, `HQ_RUN_ID`,
`HQ_AGENT_ID`, `HQ_ROOM`); the app's own variables, Telegram token included,
are never passed on. The one exception is `HQ_CLAUDE_OAUTH_TOKEN`: when set,
it becomes the process's `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from
`claude setup-token`, to run unattended on a subscription). Tool search is
turned off (`ENABLE_TOOL_SEARCH=false`) so that the MCP tools are listed from
the start. The Claude Code binary is not
modified and runs on the user's own plan, which is the frame the subscription
terms allow. There is no Agent SDK.

`--max-turns` does not exist in CLI 2.1.183: the per-run cap goes through
`--max-budget-usd`. Check the flags again when the CLI version changes.

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
room) and writes directly to SQLite. Seven tools, all validated with zod:

| Tool | Purpose |
|---|---|
| `hq_message(to, text)` | Send a message to another agent. |
| `hq_submit(type, title, body, payload)` | Submit an item to the approval queue (an informational type of `notifyTypes` is stored already approved, see section 5). |
| `hq_task_update(status, note)` | Report the state of the current task. |
| `hq_read_decisions()` | Read the user's decisions not yet seen by this agent. |
| `hq_memory_read(key)` | Read a value of the agent's role memory. |
| `hq_memory_write(key, value)` | Write a value of the agent's role memory. |
| `hq_pending()` | List the items waiting for the user's decision, in every room, oldest first: id, room, agent, type, title, `submittedAt`, never the body. Read-only, for agents that write a brief or a recap. |

Everything an agent wants to show or have approved goes through this server,
so everything is logged.

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

### The approval cycle

A submission creates an item in the `pending` state. The user can:

- **approve**: the item becomes `approved` and the handler of its type runs
  (for example: mark a draft as scheduled, copy a reply to the clipboard and
  open its thread, or merge a pull request through `gh`);
- **reject**: the item becomes `rejected`, with a reason;
- **revise**: the item goes back to the agent as a new task, with the user's
  comment (`revise` state).

The same decision can be taken from Telegram, with the same effect as in the
office.

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

#### Executing an approved item

An agent whose `room.json` sets `onApproval: "task"` acts on its own approved
items: approving one creates the task « Exécute l'item approuvé n° <id> :
<title> » (one per approval, source `approval`) and wakes the agent (below).
The agent finds the task in its prompt and acts through its own tools, for
example an MCP server of the home that reads `data/hq.db` (through the
`${HQ_DB_PATH}` placeholder), checks that the item is approved and sends it.
MyHQ never acts on the item itself. When the run fails, the item stays
`approved` and the task goes back to the mailbox for the agent's next run.

### Messages between agents

A message addressed to an agent creates a task for it, handled at its next run,
or at once when the recipient has `onMessage: "run"` (below). There is no
real-time dialogue between models: mailboxes, readable and cheap.

### Wake-ups

`wakeAgents` (`src/server/runner.ts`) starts a run, at once, for each agent
that has a pending task of source `approval` (with `onApproval: "task"`, run
reason `approval`) or `message` (with `onMessage: "run"`, run reason
`message`) created since its last run started. The run's task is "Handle the
pending tasks of your mailbox", and the mailbox lists them. The app process
calls it after each decision, on each tool result of a run (an `hq_message`
is written by the HQ MCP server, another process: the tool result is when the
app notices it) and at the end of each run. Consequences:

- Same agent lock and daily cap as any run. A busy agent is woken again when
  its run ends (its task is newer than that run); with the cap reached, the
  task waits for the agent's next run.
- A run that fails gives its mailbox tasks back; they are older than that run,
  so the agent is not woken again in a loop: they wait for its next run.
- Two agents with `onMessage: "run"` writing to each other keep waking each
  other until the daily cap.

### Why a run started

Each run stores a `reason` (`runs.reason`, null when started from the desk,
`/run` or a routine): the `reason` of `POST /api/runs` from a script of the
home (for example a mail listener calling with `reason: "mail"`), or MyHQ's
own `approval` and `message`. It is in the Run shape (API, live stream, daily
export) and on the start event, so the feed shows « Début du tour (sonnet),
motif : mail ». When `HQ_TRIGGER_TOKEN` is set, a request with a reason must
carry it as a bearer token (`api.md`); the desk sends no reason.

### Security

The app holds no production secret. Agents write only in their own working
directory, which is a dedicated Git worktree for agents that write code.
Deployment tools and anything like `db:push`, `vercel` or `eas submit` are
denied to every agent. Agents that read the web have no file-writing tool
outside their directory. Anything published under a project's name goes
through the approval queue.

## 2. The technology

- **App**: Next.js 16, TypeScript (strict), Tailwind. Not deployed: `npm run dev`
  during development, then a local service for real use (`next build`, then
  `next start -p 4242`, managed by pm2 with an `ecosystem.config.cjs` file).
  Closing the terminal or rebooting the machine must not stop the app: on
  Windows a scheduled task restarts pm2 at boot, on Linux `pm2 startup` does it.
  The app listens on localhost only until remote access is decided.
- **Data**: SQLite (`better-sqlite3`), one file in the home's `data/`
  directory, ignored by Git. Idempotent SQL migrations in the code. Tables:
  `rooms`, `agents` (with the armed state of their routines), `runs`,
  `events`, `messages`, `tasks`, `approvals`, `memories`, `routine_firings`,
  `chat_turns` (the assistant's chat turns, metered).
  Each run stores `input_tokens`, `output_tokens`, `cost_usd`,
  `started_at`, `ended_at`, `status` (`running`, `done`, `failed`,
  `cancelled`), a `summary` and a `reason`. A task comes from a run's own
  instruction (`manual`), a message, a revision or an approved item
  (`approval`).
- **Real time**: Server-Sent Events from the app to the browser.
- **The room view** (slice 4): a 2D canvas (PixiJS, the one runtime dependency
  added for it, pinned to an exact version and loaded only on `/room`) with
  sprite sheets and a few animations per character (typing, walking, thinking,
  sleeping), driven by the real events of the stream-json output. See section 7.
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
   or `POST /api/onboarding`. MyHQ starts a run of its own onboarding agent,
   in a reserved room `_hq` that no folder can take, with the same lock and
   daily cap as any run: Sonnet, `--max-budget-usd` from
   `HQ_ONBOARDING_MAX_BUDGET_USD` (0.5 by default), the role prompt shipped in
   `templates/onboarding.md`, the target repository as working directory, the
   templates folder as `--add-dir`, the built-in tools `Read`, `Glob` and
   `Grep` available but not pre-approved (in print mode Claude Code reads
   inside its working directories only, and nothing outside them), and the
   `hq_submit` and `hq_task_update` tools. The run prompt gives the target,
   the rooms that already exist, the templates (`templates/roles/*.md`) and
   the payload to submit. It also states the language of the home (`language`
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
   for any item (a revision note reaches the next onboarding run).
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
   command: it becomes the reason or the comment of the decision. A question
   expires after one hour; the user is told, and the message goes on.
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
   name their tools. After a successful reply, the optional `chat.requests.dir`
   is scanned (`src/assistant/requests.ts`): each `{ room, agent, task,
   reason? }` file becomes a pending task (source `chat`) of that agent and a
   run starts at once under the usual lock and cap (reason `chat`, or the
   given one); the file is deleted, a malformed one is moved to
   `<dir>/rejected/`. This is how the chat hands an action to an agent without
   holding its tools. The optional `afterReply` command runs after each
   reply, its output logged only.

**What goes out without being asked.** Besides the alerts above, two options
of the home send text on their own, in both modes:

- `notifyTypes` in `myhq.json`: informational items. `hq_submit` stores an
  item of a listed type already `approved`, with the note « notification »
  (and marked seen by its agent); the app sends it in full, an alert line then
  its body as is, cut in messages of 4000 characters, without buttons. It is
  in the desk's history, never in the pending list, `/pending` or
  `hq_pending`, and it never triggers `onApproval`. For a mail alert: the user
  reads it, there is nothing to decide. The MCP server finds the home's
  `myhq.json` from `HQ_DB_PATH` (`<home>/data/hq.db`).
- `notifyRuns: "summary"` on an agent in `room.json`: when its run ends
  `done`, its summary is sent as a plain message (Markdown marks removed, cut
  at 4000 characters). This is how a morning brief or an evening recap agent
  delivers its text: the agent's final text is the message, there is no item
  to approve. The summary is kept at about 4000 characters by the engine, so a
  longer text is cut.

Messages are handled one at a time, in order. Button presses are handled at
once, even during a long chat turn. In polling mode a pending-approval alert
carries three buttons: **Approuver** decides at once and edits the alert to
show the decision (its buttons go away), then hands over the body and the link
of an item that has an http(s) `payload.url` (see the approval cycle);
**Refuser** and **À retravailler**
ask for the reason or the comment, which the next text message answers.
Failure alerts stay plain text.

Voice notes and audio files are downloaded to `<home>/data/assistant/voice/`,
transcribed by the home's `transcribe` command, deleted, then handled as text.
Photos (largest size) and documents are saved into the home's `dropDir` under a
free name, with a companion `.md` note holding the caption when there is one.
The Bot API does not hand over files above 20 MB; the user is told.

The assistant's chat is not a run: it does not count towards the daily cap and
is not in the `runs` table. Each turn, answered or failed, is recorded in
`chat_turns` instead: engine, model, status and failure reason, the four token
counts, the cost, the number of tool calls and their names. `GET /api/usage`
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

`/room` (linked from the header of `/`, with a link back) is the floor of a
project, drawn as the plan of a small agency: offices of different sizes (a
cell for one agent, a double office for two who talk often, a corner office),
closed by walls with a door gap onto corridors that loop around a lobby, a
meeting room with a long table and the whiteboard (runs of the day against the
cap, cost, share of the weekly budget, routines armed, next fire and last
firing: the numbers of `/api/usage` and `/api/routines`), an open kitchen with
the coffee machine, a lounge, storage, windows along the outer walls, and the
user's own office next to a lobby whose console holds the "to approve" tray and
its count. Each office is sized to its desk and furnished (desk, chair, shelf,
plant, sofa), the name of its agent is on a plate beside its door. The canvas
takes the whole width and the height that is left under the header and above the
strip of agents, so the floor fits on one screen with no scrolling; the plan is
scaled uniformly and centered, characters are about 60 px on a 1080p screen. It
is a separate page because the canvas weighs something and must be able to
stop; `/` stays the desk that works everywhere. When the home has several
rooms, buttons choose the floor shown.

**Templates.** The plan is not computed from a grid: it is one of three
hand-designed templates by number of agents, data in
`src/ui/floor-templates.ts` (small for 1 to 3 agents, medium for 4 to 7, large
for 8 to 12). A template lists its rooms with their position, size, door,
desks and furniture, the center lines of its corridors, its windows and its
lobby; agents fill the desks in order, and the desks left empty are drawn
vacant. `layoutRoom` (`room-layout.ts`) turns the template into walls,
furniture, offices and a graph of the corridors. A template can be refined, or
a fourth one added, without touching the renderer or the model. More than 12
agents are listed under the floor but have no office on it.

**Pieces.**

- `src/ui/room-model.ts`: the pure animation model. It takes the entities the
  page already receives (the `/api/state` snapshot, then the SSE `run`, `event`
  and `approval` messages) and gives a visual state per agent. No canvas, no
  real clock: time is a number of milliseconds passed in by the caller, so the
  tests replay the fixtures (`test/room-model.test.ts`) on a fake clock.
  `src/ui/room-layout.ts` builds the plan from a template and plans the routes;
  `src/ui/room-store.ts` keeps one model per room outside React.
- `src/ui/room-renderer.ts`: PixiJS drawing of shapes and sprites behind a
  small interface (create, draw a scene, resize, set the density, destroy).
  `src/ui/room-labels.ts`: every piece of text of the floor (name plates, the
  whiteboard, the tray count, bubbles, the name of a character that is away
  from its office) is an HTML element over the canvas, placed from the same
  world coordinates and scale, in the page fonts and colors (CSS variables),
  with the box of a plate or a bubble drawn by CSS. Nothing is drawn as text
  in the canvas, so text is sharp at any zoom and in both themes.
  `src/ui/room-canvas.tsx` imports the renderer dynamically in an effect
  (never on the server), owns the frame loop, the pointer and the density.
  `src/ui/room.tsx` is the page: header, rooms, the canvas or the compact band,
  the strip of agents, the sheet.
- Walking follows routes of the layout (`routeToOffice`, `routeToUser`): from
  the seat round the desk, through the door of the office, along the shortest
  way of the corridors (a graph built from their center lines, Dijkstra), then
  through the other door to where a visitor stands, or to the tray in the
  lobby; two agents of the same office just cross it. A test checks that no
  route of any template crosses a wall, whatever the number of agents.
- The neutral character is `public/sprites/neutral.png`, drawn by
  `scripts/build-neutral-sprite.mjs`; it is tinted per agent from a fixed
  palette. A home gives an agent its own sheet with `agents[].sprite` (contract
  in `home-layout.md`, route in `api.md`).

**What the stream does** (durations are named constants of `room-model.ts`):

| Entity | Effect |
|---|---|
| `run` running | The agent is awake at its desk, seated; a new run clears a question mark. |
| `tool_call` | Types for 2.5 s. |
| `text` | Thought bubble with the first 64 characters, for 5 s (the stream does not keep `thinking` blocks). |
| `tool_call` `mcp__hq__hq_message` | Walks in a straight line to the table of `input.to` (the side of the desk that faces it), talks for 3 s, walks back. A recipient that is not in the room makes it an ordinary tool call. |
| `tool_call` `mcp__hq__hq_submit` | Walks to the desk of the user carrying a folder, stays 2.2 s, drops it in the tray, walks back. The tray counter rises at the drop, not when the `approval` event arrives. |
| run `failed`, `end` failed, or `hq_task_update` with `status: blocked` | A question mark, until the user decides an item of that agent or the next run starts. It overrides typing and thinking, not a walk, and it does not fall asleep. |
| no run for 60 s | Asleep. |
| `approval` | Moves the tray counter (pending items shown). |

Trips queue behind each other (three waiting at most). Every state has a text
label (types, thinks, "drops an item"...) in `strings.ts`.

**Accessibility.** The canvas complements the desk and is `aria-hidden`. Under
it a list gives, for each agent, its name, its state in text and a button that
opens its sheet. A single polite live region says the changes of a coarse state
(asleep, working, visiting, carrying an item, stuck): typing and thinking come
and go too often to be announced. The name of an agent is always written: on the plate of its office, and under
its character when it walks away from it. The tints are colour-blind safe: colour
never carries the identity alone.

**Performance and motion.** The canvas is drawn at the device pixel ratio
(`autoDensity`, redrawn at the new density when a zoom changes it). Sprite
sheets use nearest-neighbour scaling, except when a sheet is drawn well below
its size (a 128 px cell shown at 46 px), where smoothing avoids jagged edges.
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
line) and a "Voir la pièce" button that mounts it on demand.

**The sheet of an agent** (click on a character, or its list button): the team
card (role, model, tools, routines and their arming switch, last run, run
button: `AgentCard` of `team.tsx`) and its recent runs with their journal
(`FeedRow` of `feed.tsx`), rebuilt from the events the page holds since the
API has no list of old runs. A side panel on a wide screen, the whole screen on
a phone; Escape closes it and focus returns to what opened it.

**Without a real run.** `scripts/replay-fixture.ts` plays a fixture into a
throwaway demo home, one event per second, so that the real SSE stream animates
the room (README, "Trying the room without a real run").

**Choices and measures.**

- PixiJS rather than a hand-written 2D canvas: the plan decides it and richer
  animations can use it. Fifteen sprites would not need it. The cost is about
  168 kB gzipped (572 kB minified; esbuild estimate of the renderer chunk, under
  the 250 kB threshold), paid on `/room` only, since the module is a dynamic
  import. The renderer is behind an interface, so a canvas 2D one can replace it
  without touching the model.
- The tray counts the items of the shown room.
