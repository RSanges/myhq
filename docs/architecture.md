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
`HQ_AGENT_ID`, `HQ_ROOM`, and `HQ_WORK_DIR`, the working directory that
`hq_submit` reads attachments from); the app's own variables, Telegram token included,
are never passed on. The one exception is `HQ_CLAUDE_OAUTH_TOKEN`: when set,
it becomes the process's `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from
`claude setup-token`, to run unattended on a subscription). Tool search is
turned off (`ENABLE_TOOL_SEARCH=false`) so that the MCP tools are listed from
the start. MCP startup is made blocking (`MCP_CONNECTION_NONBLOCKING=0`,
`MCP_CONNECT_TIMEOUT_MS=30000`): by default CLI 2.1.183 connects the servers
in the background and sends the first request at once, so a server slower to
start than the CLI is still `pending` and the agent works without its tools
(it then writes tool calls as text and invents a result). The runner checks
the start event too: when a server listed there is not `connected`, the run
is stopped at once, before its first event is read, and fails with the end
reason `mcp_not_connected`; it is started again once, a few seconds later,
with the same task and the tasks it had claimed. Only a second failure (or a
retry that cannot start) is alerted, like any other failed run. The prompt of
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
room) and writes directly to SQLite. Nine tools, all validated with zod:

| Tool | Purpose |
|---|---|
| `hq_message(to, text, room?)` | Send a message to another agent: of the sender's room, or with `room` of a shared room or of a room that ordered from the sender's (see "Shared rooms"). |
| `hq_submit(type, title, body, payload, forRoom?)` | Submit an item to the approval queue (an informational type of `notifyTypes` is stored `unseen` and waits under « À regarder », see section 5). `forRoom`: a shared room's delivery to the room that ordered it. `attachments`: files to validate with the item (see "Files joined to an item"). |
| `hq_task_update(status, note)` | Report the state of the current task. |
| `hq_read_decisions()` | Read the user's decisions not yet seen by this agent. |
| `hq_memory_read(key)` | Read a value of the agent's role memory. |
| `hq_memory_write(key, value)` | Write a value of the agent's role memory. |
| `hq_pending()` | List the items waiting for the user's decision, in every room, oldest first: id, room, agent, `forRoom`, type, title, `submittedAt`, never the body. Read-only, for agents that write a brief or a recap. |
| `hq_rooms()` | List the shared rooms and their agents (id and name): the studios an agent may order from. Read-only. |
| `hq_suggest_agent(need)` | For an order nobody in the office can do: the need goes to the receptionist, which proposes a new agent to the user (see "Proposing a missing agent"). At most one per need text in 24 hours. |

Everything an agent wants to show or have approved goes through this server,
so everything is logged.

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

On the desk, the history items have « Demander une révision », which opens the
annotation list (the drafts kept for that item) and the general note.
Approving an item that still has draft remarks asks first (« Tu as N remarques
en attente. Approuver les ignore. »): « Passer en À retravailler » sends them
as a revise, « Approuver quand même » approves and drops them, Escape cancels.
The guard is a small state machine (`src/ui/approve-guard.ts`); it is desk
only, Telegram has no drafts.

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
changes nothing on Telegram.

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
annotations, the Approuver guard, « Demander une révision », every action); an
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
MyHQ never acts on the item itself. When the run fails, the item stays
`approved` and the task goes back to the mailbox for the agent's next run.

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
  full in a dialog, an audio player, and a download link for a 3D part or a
  PDF, with its preview when the agent joined an image of the same name
  (`piece.png` for `piece.3mf`; that image is then not shown on its own).
  Under a video or a sound, « Annoter à cet instant » pauses the player and
  opens the remark box of the annotations with the quote « <file> à <time> »
  (« clip-01.mp4 à 0:12 »). The remark joins the others (no `position`, so it
  comes after the remarks on the text) and a revision sends it to the agent
  in the numbered list, as any remark.
- **On Telegram**, see section 5.

### Messages between agents

A message addressed to an agent creates a task for it, handled at once (a run
woken as below) unless the recipient has `onMessage: "queue"`, in which case it
waits for its next run. There is no real-time dialogue between models:
mailboxes, readable and cheap.

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
| `revise` (a revise decision) | `revise` | unless `onRevise: "queue"` |
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
  task waits for the agent's next run.
- A run that fails gives its mailbox tasks back; they are older than that run,
  so the agent is not woken again in a loop: they wait for its next run.
- Two agents with the default `onMessage` writing to each other keep waking
  each other until the daily cap; `"queue"` on one of them breaks the loop.

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

### Why a run started

Each run stores a `reason` (`runs.reason`, null when started from the desk,
`/run` or a routine): the `reason` of `POST /api/runs` from a script of the
home (for example a mail listener calling with `reason: "mail"`), or MyHQ's
own `approval`, `message`, `revise`, `chat` and `agent_need`. It is in the Run shape (API, live stream, daily
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
  `npm run build` also freezes the HQ MCP server that every run starts (see
  "The HQ MCP server").
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
   name their tools. After a successful reply, the action files of
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
   holding its tools. The optional `afterReply` command runs after each
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
  it in full, an alert line then its body as is, cut in messages of 4000
  characters, with a single **Vu** button on the last message (polling mode
  only, like the decision buttons; callback `hq:w:<id>`) that does what the
  desk's « Vu » does and edits the alert to add « Vu ». It stays on the desk
  under « À regarder » until seen, is never in the pending list, `/pending` or
  `hq_pending`, and never triggers `onApproval` nor wakes an agent. For a mail
  alert: the user reads it, there is nothing to decide. The MCP server finds the home's
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
against the cap, cost, share of the weekly budget, routines armed, next fire
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
the rest is a drag away (the floor of one room then shows its offices). There
is no step under one: the old overview of the single floor went to half a
device pixel per art pixel, sampled smoothly, and blurred every piece of art.
The wheel zooms, one whole step per notch, around the pointer (a trackpad's
two finger scroll cannot be told apart from a wheel for sure, so it zooms
too, and its pinch arrives as the wheel with ctrl); a drag (a mouse, one
finger) pans; a pinch and the + and - buttons zoom. A click on a room flies to
it: centred, at the largest whole zoom that shows it whole (walls and
signboard included), the zoom passing through whole steps only so every frame
stays crisp, at once under `prefers-reduced-motion`. A click on the floor
outside the rooms, or the « Vue d'ensemble » button, flies back to the
overview. A click on an agent still opens its sheet, on a user's desk its
pile.

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
own colour. Each suite also has the user's own desk, empty, in its front row
by the opening, with a pile of folders on it: one per item of that room
waiting for a decision (ten drawn at most), the spines in the room colour, and
a count over it. The lobby (eight by eight) holds the reception counter, the
receptionist behind it, the coffee corner, a sofa by a rug and the user's desk
of the onboarding room `_hq`, where room proposals land.

The user's own office (`ownerOffice`, a block of OFFICE_LENGTH by six cells
beside the lobby, `layout.office`) is drawn in the look of the desk's scene,
as far as the floor set allows: a wooden floor, the desk against the back
wall with its chair, the hub's wall calendar and floor lamp (pieces of the
floor set), the filing cabinet of the tray with as many letters on it as the
desk's tray holds, a bookshelf, a rug and plants. Its desk holds the pile of
every item waiting for a decision, with its count. Nobody works there; a click
anywhere on it opens the desk, `/bureau`. On a floor of one room
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
A room whose `room.json` has a `logo` (`GET /api/rooms/<room>/logo`) shows it
on the left of the name, reduced to the height of the face without blending
any colour (`shrinkLogo`: each pixel takes the colour that covers most of its
block, or a detail in strong contrast with it), outlined in the ink when its
colours are too close to the board's. The names are on the canvas only; the
room buttons at the top and the list « À signer, par salle » under the floor
name every room for the keyboard and screen readers. A sign rises to
SIGN_TOP voxels (79, the wall 64): the hiding rules count it on the whole
length of the wall, so it never hides a room or a corridor.

The tests run every
rule above on generated homes of 1 to 8 rooms of 1 to 12 agents, check that
blocks stand apart with their walls, that the lobby is the front corner where
the corridors start, and that rooms and corridors take most of the floor's box
(the garden only the rest). The page shows every agent of the home in the
strip, the receptionist last; the buttons at the top fly the view to a room
(as a click on it does) and carry its count. A click on a user's desk (or the list « À
signer, par salle » under the floor, its equivalent for the keyboard and
screen readers) opens the page of the pile of decisions filtered to that room,
`/bureau/<id>?room=<room>` (section 8). An agent carries what it submits to the
user's desk of its own room, a delivery of a shared room (`forRoom`) to the
desk of the room that ordered it, and a message to an agent of another room
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
| `text` | Thought bubble with the first 64 characters, for 5 s (the stream does not keep `thinking` blocks). |
| `tool_call` `mcp__hq__hq_message` | Gets up and walks the aisles and the hall to the chair of `input.to`, faces it and talks for 3 s, walks back and sits. A recipient that is not in the room makes it an ordinary tool call. |
| `tool_call` `mcp__hq__hq_submit` | Walks to the tray of the lobby carrying a folder, stays 2.2 s, drops it in the tray, walks back. The tray counter rises at the drop, not when the `approval` event arrives. |
| run `failed`, `end` failed, or `hq_task_update` with `status: blocked` | A question mark, until the user decides an item of that agent or the next run starts. It overrides typing and thinking, not a walk, and it does not fall asleep. |
| no run for 60 s | Asleep. |
| `approval` | Moves the tray counter (pending items shown). |

Trips queue behind each other (three waiting at most). Every state has a text
label (types, thinks, "drops an item"...) in `strings.ts`.

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

**The sheet of an agent** (click on a character, or its list button): the team
card (role, model, tools, routines and their arming switch, last run, run
button: `AgentCard` of `team.tsx`) and its recent runs with their journal
(`FeedRow` of `feed.tsx`), rebuilt from the events the page holds since the
API has no list of old runs. A side panel on a wide screen, the whole screen on
a phone; Escape closes it and focus returns to what opened it.

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
  user's desk counts the items of its room (`pendingByRoom` of the view), an
  item delivered by a shared room counting for the room that ordered it.

## 8. The desk objects

The desk (`/bureau`, a click on the user's office of the floor) opens on a scene, the hub: the user's office in isometric
pixel art, where each object on the desk is a module (a pile of items to sign,
a mail tray, a newspaper, post-its, a wall calendar, a phone). It stands on
the model, the data, the API and one page per object.

- **The model** (`src/server/desk.ts`): `desk.objects` of `myhq.json` lists the
  objects, each `{ id, object, label, source }` (schema and defaults in
  `home-layout.md`). It is read apart from the rest of the file, so an invalid
  block falls back to the default desk without touching `notifyTypes` or the
  export. A source of the core is read from the database at each request
  (`approvals`, `watch:<type>`, `summaries`, `chat`); a command of the home
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
  (`Desk`: folded lines, annotations, the Approuver guard, every action, the
  history tab). A tray of `watch:` sources lists its unseen items with « Vu »
  and « Demander à » the assistant, oldest or newest first, then the ones
  already seen (`WatchDesk`). The newspaper is a reading view: a masthead with
  the day, the latest brief or recap as the lead story, the others in columns
  on a wide screen; an unseen brief can be marked read there. The calendar
  shows today in large and the next seven days beside it (under it on a phone),
  each with its events and its free slots, read-only. The post-its are notes,
  numbered as the list numbers them, the late ones marked. The phone is the
  conversation panel as the page itself. Any other pairing gets a plain list.
  Each page follows the live stream like the desk does (`useHq`), and reads
  `GET /api/desk` again on each `desk` message (`useDesk`).
- **Deep links** keep working: `/bureau#approval-<id>` opens the item on the
  desk (the floor sends an old `/#approval-<id>` there), and the items of a
  module link to `/bureau/<id>#approval-<id>`, which
  unfolds and rings the item on the page of the pile or the tray.
  `/bureau/<id>?room=<room>` (the user's desk of a room of the single floor)
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
  when it has something unread, and the wall calendar marks today (the
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
  phone's lamp blinks while it has something unread, unless
  `prefers-reduced-motion` asks otherwise. On a phone (under 40rem) the scene
  fits the width and a list of the modules follows it (label, count, link);
  should the assets fail to load, that list stands in for the scene.
  Under the scene, the desk keeps its folded items (« À regarder », then « À
  valider » and the history), so `/bureau#approval-<id>` works as before; the meter
  comes after them on a wide screen.
