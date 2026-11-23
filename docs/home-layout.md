# Home directory layout

MyHQ reads everything that is specific to one user from a *home* directory,
selected by `MYHQ_HOME` (absolute path, or relative to the root of the MyHQ
repository; default `./home`, ignored by Git). The home can be a separate
repository of its own.

```
<home>/
  rooms/
    <room>/
      room.json          the room definition (schema below)
      roles/
        <agent>.md       one system prompt per agent
  assistant.json         the Telegram assistant (optional, schema below)
  myhq.json              settings of the home, such as the daily export (optional)
  archives/
    rooms/<room>-<YYYY-MM-DD>/  the configuration folder of a room deleted from /reglages
  docs/roadmap.json      the live roadmap shown at /roadmap (optional, see api.md)
  folders/               the room folders, one folder per room (movable with `folders.dir`, see "Room folders")
    <room>/<drawer>/     what the room received and what MyHQ filed for it
  assistant/
    commands/            extensions for the Telegram assistant
  data/                  created at first launch, ignored by Git
    hq.db                SQLite database
    work/<room>/<agent>/ default working directory of each agent
    worktrees/<room>/<agent>/  Git worktrees (by convention, see `worktree`)
    runs/                raw output and MCP config of each run
    attachments/<id>/    copies of the files joined to item <id> (hq_submit attachments)
    scheduler.lock       the process that runs the routines of this home
    assistant/           offset.txt, bridge.lock, voice/ (temporary audio)
```

All paths written in `room.json` and `assistant.json` are relative to the home
directory (absolute paths are accepted in `assistant.json`).

`rooms/<room>/` is normally created by the onboarding agent when you approve
its room proposal (« Ajouter une salle », `/salle <path>`), and can also be
written by hand. `npm run init` creates an empty home (`rooms/`, `data/`, a
`.gitignore`).

## room.json

```json
{
  "name": "example",
  "targetRepo": "../example-project",
  "color": "#ff3d7f",
  "agents": [
    {
      "id": "scout",
      "name": "Scout",
      "role": "roles/scout.md",
      "model": "sonnet",
      "allowedTools": ["WebSearch", "WebFetch", "mcp__hq__*"],
      "mcpServers": {},
      "workingDirectory": "data/work/example/scout",
      "cron": "0 7 * * 1-5",
      "armed": true,
      "maxBudgetUsd": 2,
      "isoSprite": "rooms/example/sprites/iso-scout.png"
    },
    {
      "id": "analyst",
      "name": "Analyst",
      "role": "roles/analyst.md",
      "model": "sonnet",
      "allowedTools": ["Read", "Glob", "mcp__hq__*"],
      "cron": [
        { "cron": "0 17 * * 5", "task": "Weekly review of the numbers." },
        { "cron": "0 8 * * *", "task": "Morning alert on yesterday's sign-ups." }
      ]
    },
    {
      "id": "dev",
      "name": "Dev",
      "role": "roles/dev.md",
      "model": "opus",
      "allowedTools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git status)", "Bash(git add *)", "Bash(git commit *)", "Bash(git switch *)", "Bash(npm test)", "mcp__hq__*"],
      "worktree": "data/worktrees/example/dev",
      "workingDirectory": "data/worktrees/example/dev",
      "disallowedTools": ["Bash(git push *)", "Bash(gh pr merge *)", "Bash(npm run deploy *)"],
      "cron": "0 5 * * *",
      "maxBudgetUsd": 3
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Room name, unique in the home, equal to its folder name. It is the room's identifier everywhere (API, database, paths, commands). |
| `label` | no | The name shown to the owner, 1 to 60 characters (« Atelier client »): on the floor (signboards, room buttons, sheets), on the desk, in the surveillance room and on `/reglages`, where its panel edits it. Left out, the `name` is shown. |
| `targetRepo` | yes | Path of the repository the room works on, relative to the home. |
| `color` | no | The room's colour in the interface, a CSS hex colour (`#rgb` or `#rrggbb`). The chat chips of the room's agents, the agent strip under the floor and the room's button in the floor header take it as a soft tint (border and dot in the colour, text unchanged), and on the single floor its carpet, its name tags and its signboard take it. Without it the room stays neutral. The assistant's own chip keeps its blue. |
| `shared` | no | `true` makes the room a shared studio (a room of scripts, videos or visuals, say): every room of the home may order from it, and it delivers to the room that ordered (see "Shared rooms" below). Default `false`. |
| `orders` | no | `true` for a room that serves clients: its room folder holds one folder per order (`<YYYY>-<MM>-<client>-<subject>`), each with its own drawers, and its agents name the order of a delivery with `hq_submit` `order`, list them with `hq_orders` and open one with `hq_order_open` (see "Room folders" below). Default `false`. |
| `logo` | no | The logo of the room's project, a `.png`, `.webp` or `.svg` file relative to the room directory, inside it, at most 1 MiB (served by `GET /api/rooms/<room>/logo`). The single floor draws it on the left of the name on the room's signboard, reduced to the height of the board (about 14 pixels) in a pixel art way, so a small, bold logo reads best (an app icon rather than a wordmark; a thin line drawing turns to mush at that size, draw a bolder variant). The logo goes beside the name only when the room's wall is long enough for both: a short wall with a long name leaves room for a logo of about 12 pixels wide, a wider one is dropped. Without it, or when the file is missing, the board shows the name alone. |
| `decor` | no | How the room's suite of the single floor (`floor.layout: "room-per-project"` of `myhq.json`) is furnished. `"library"`: the same desks and aisles as an office of the same team, but a wooden floor, a tall shelf full of books on every cell of the back wall that no desk takes (a library ladder among them), two more on the side wall when no desk stands against it, a reading table in each spare place of the front row, a globe in the front corner, and beyond the aisle to the opening a reading wing of three cells (instead of a big team's coffee nook): an armchair, a floor lamp and a side table on a rug, piles of books, a plant. The armchair's cushion and the rug's border take the room's `color`. Left out, the suite is an office. A value MyHQ does not know makes the room invalid. The floor of one room (`floor-per-project`) ignores it. |
| `brief` | no | The room's brief, joined by MyHQ to a run of a shared room that works for this room (see "The room brief" below): `file`, a `.md` file relative to the room directory, inside it and present; `references`, at most 16 reference folders relative to the home, read-only for that run; `keeper`, the id of an agent of the room who keeps it, named in the prompt. |
| `agents[].id` | yes | Stable identifier, used in messages and in the database. |
| `agents[].name` | yes | Display name. |
| `agents[].role` | yes | Path of the role prompt, relative to the room directory. |
| `agents[].model` | yes | `opus`, `sonnet` or `haiku`. |
| `agents[].allowedTools` | yes | Whitelist passed to `--allowedTools`. A write rule may carry a path relative to the working directory: `Write`, `Write(**)`, `Write(./**)` or `Write(/**)` give the whole folder, `Write(models/**)` only `models/` (same for `Edit`, `MultiEdit`, `NotebookEdit`; the rules of all the write tools add up). The path is enforced by MyHQ's write guard, a hook installed in `<working directory>/.claude/settings.local.json`, and the CLI gets the bare name (`Write`); a write anywhere else is refused with a reason the agent sees (see "The write guard" in `architecture.md`). `Bash(...)` and MCP rules are passed as written. An explicit list of HQ tools (rather than `mcp__hq__*`) should name `mcp__hq__hq_status` too: it is how the agent says what it is doing, over its head on the floor (see "The activity bubble" in `architecture.md`). |
| `agents[].mcpServers` | no | Extra MCP servers, in the shape of Claude Code's MCP config. The `hq` server is always added by MyHQ. |
| `agents[].workingDirectory` | no | Defaults to the `worktree` when there is one, `data/work/<room>/<agent>` otherwise. Must stay inside the home. With a `worktree`, leave it out or give the same path. |
| `agents[].cron` | no | A cron expression (five fields, read in `HQ_TIMEZONE`), or a list of `{ "cron": "...", "task": "..." }` for several routines with a task each. Without it the agent only runs on demand. |
| `agents[].armed` | no | Initial armed state of the routines (default `false`: a declared cron does not fire). Once changed from the interface or with `/arm` and `/disarm`, the database value wins. Nothing fires anyway until `HQ_SCHEDULER=on`. |
| `agents[].worktree` | no | Path, relative to the home and inside it, of a Git worktree of the target repository: created with `git worktree add` on branch `hq/<agent>` when missing (on approval of an onboarding proposal, and before a run). The agent works in it. |
| `agents[].disallowedTools` | no | Denied to this agent on top of the global deny list (deploy and schema push commands), for example `Bash(git push *)`. A write rule with a path (`Write(supabase/**)`) is also enforced by the write guard. |
| `agents[].addDirs` | no | Directories the agent may read besides its working directory (`--add-dir`), relative to the home. Read-only: the write guard refuses any write there. When left out, an agent whose `allowedTools` include `Read`, `Glob` or `Grep` and that has no `worktree` gets the room's `targetRepo`; an agent with a worktree already runs inside the code. |
| `agents[].notebook` | no | The agent's notebook: one folder where it keeps what lasts (what was agreed with the owner, the owner's lasting preferences, the lessons of a piece of work), one Markdown note per topic, which the owner opens and corrects. Relative to the home or absolute, and it may be outside the home (a folder of the owner's notes vault). MyHQ creates it when missing. In a run it is readable (`--add-dir`) and writable (the write guard's one notebook, with `Write` and `Edit` added to the run's tools even when its rules have no write); in a question to the agent it is the only place a write may land (see "The notebook" in `architecture.md`). It holds Markdown notes only: a write there is refused when it is not `Write` or `Edit`, not a `.md` file, has a name starting with a dot (or holding a colon, or ending in a dot or a space), or would leave the note above 200000 bytes. It must not be, hold or sit inside a working directory of the room, overlap the home's `rooms/`, `data/` or `assistant/` folder, hold the home, overlap the MyHQ repository (unless it sits inside the home), or overlap another agent's notebook (in any room), each compared on its real path (a link or junction counts as where it leads): the room is invalid otherwise. Default: none. |
| `agents[].maxBudgetUsd` | no | Value passed to `--max-budget-usd` for each run. |
| `agents[].isoSprite` | no | Isometric character sheet of the floor (`/room`): a `.png` or `.webp` file, relative to the home, inside it (see "Character sheets" below). Without it, or when the file is missing or is not a sheet of the right size, the agent is drawn as one of the neutral people shipped with MyHQ, always the same one for the same agent. |
| `agents[].floor` | no | How the agent lives on the single floor (`floor.layout: "room-per-project"`): `{ "behaviour": "desk" }` (the default) sits at a desk of its room; `{ "behaviour": "roam" }` has no desk (see "Agents who roam the floor" below). |
| `agents[].sprite` | no | The old top-down sheet of the floor (4 by 4 square cells), relative to the home, inside it. Still accepted and served by `GET /api/sprites/<room>/<agent>`, but **no longer drawn**: the floor is isometric and only draws `isoSprite`. |
| `agents[].onApproval` | no | `"task"`: when an item this agent submitted is approved, MyHQ gives it the task « Exécute l'item approuvé n° <id> : <title> » and starts a run at once (reason `approval`). `"queue"`: the task is created but the agent is not woken, it finds it at its next run. The agent acts on the item with its own tools (for example an MCP server of the home that sends a mail once it finds the item approved). `"command"`: MyHQ runs the agent's `approvalCommand` itself the moment the item is approved, without a model turn, and falls back to `"task"` when the command fails (see "Executing an approved item without a model turn" below). Default: nothing happens on approval (no task: an approved item is usually the user's to post). An item submitted with `onApprove` (`hq_submit`) has its messages delivered by MyHQ instead, and its agent gets no task for it. |
| `agents[].approvalCommand` | with `onApproval: "command"` | The command MyHQ runs for an approved item of this agent: the program then its arguments, for example `["node", "tools/mail/send-approved.mjs"]`. It runs in the home (its cwd), a program given as a path is relative to the home, and there is no shell (a `.cmd` or `.ps1` is not run, give its interpreter). Never accepted in an agent proposal of the receptionist: what runs on an approval is the owner's to write. |
| `agents[].portier` | no | `false`: a message to this agent never goes through the portier and wakes it at once, as before it existed (for an agent whose every message matters). Default `true` (see "The portier" below). |
| `agents[].onMessage` | no | `"run"` (the default): an `hq_message` addressed to this agent starts a run at once (reason `message`) when its lock is free and the daily cap allows, otherwise as soon as its current run ends. `"queue"`: the message waits for the agent's next run, for an agent meant to batch its work. |
| `agents[].onRevise` | no | `"run"` (the default): a revise decision on one of its items (from the desk, including a revision asked after the item was approved or rejected, or from Telegram), or the answers of the owner to its questions (`hq_ask`), starts a run at once (reason `revise`) under the same conditions. `"queue"`: the revision waits for the agent's next run. |
| `agents[].notifyRuns` | no | `"summary"`: when a run of this agent ends `done`, its summary (the agent's final text, at most about 4000 characters) is sent to Telegram as plain text. This is how a brief or a recap agent delivers its text. Default: nothing is sent for a run that ends well. |
| `agents[].resources` | no | Shared resources the agent's runs hold, for example `["gpu"]` (lowercase letters, digits, `-` or `_`, each listed once). Two runs holding a common resource never run at once, in any room (see "Shared resources" below). Default: none. |
| `agents[].needs` | no | What one run of the agent takes from the machine, in GB: `{ "ramGb"?: number, "vramGb"?: number }`, at least one, each more than 0. A run starts only when the machine has it free on top of the home's margin (`machine` of `myhq.json`) and of what the runs in progress still have to take (see "What a run needs" below). Default: none, the machine is not looked at for this agent and its runs start as before. |
| `agents[].pieces` | no | What the agent works on, shown large on its tile of the surveillance room (`/surveillance`): 1 to 8 patterns relative to its working directory, written as the write rules take them (`renders/**/*.mp4`, `parts/*.3mf`, `drafts/*.md`; `**` any depth, `*` and `?` inside one name). MyHQ follows the matching files written during the run, newest first (see "The piece" below). Default: none, the tile shows the agent's words only. |
| `agents[].parallel` | no | `true`: the agent may run several runs at once, one per subject of its sheet (the general subject being one of them); the queue and the machine are the only limit. With a `worktree`, each subject other than the general one gets its own bench, a Git worktree beside the agent's (`<worktree>.subject-<id>`, branch `hq/<agent>.subject-<id>`) made from the agent's branch at the subject's first run, merged into it and removed once the subject is archived, what a run left in its ignored folders carried into the agent's worktree (never over a file already there); the run is told to commit there. MyHQ says on the Standard, in one entry per bench handed to the owner, what keeps a bench open. Its paths are recorded as absolute: let the benches close before moving the home, restoring its database or changing `worktree`. Without a `worktree`, the subjects share the agent's working directory: that is the home's choice. What to know before turning it on: see "Several benches" in `architecture.md`. Default: `false`, one run of the agent at a time. |
| `agents[].supervisor` | no | `true`: the supervisor of the Standard. It reads what is stuck (`hq_blocked`), writes to any agent of any room, reads the items of every room, relaunches a stuck entry once (`hq_relaunch`), leaves a note for the owner on it (`hq_blocked_note`) and closes, with its reason, what it settled (`hq_blocked_close`, the owner may reopen it), never a request of the owner nor an entry handed to the owner; it submits nothing to approve. MyHQ wakes it when something new is stuck, and every 30 minutes at most while entries remain open (see "The supervisor" in `architecture.md`). It also checks a run that reaches `HQ_RUN_TIMEOUT_MINUTES` (`hq_run_status`), and extends it (`hq_run_extend`) or stops it (`hq_run_stop`) instead of letting MyHQ interrupt it (see "Long runs"). Give it only the hq tools. MyHQ wakes the first one of the home. Default: `false`. |
| `agents[].skills` | no | Claude Code skills the agent follows: folders relative to the **room directory**, each holding a `SKILL.md` (see "Skills" below). Default: none. |
| `agents[].effort` | no | Reasoning effort of the agent's runs, passed as `--effort`: `low`, `medium`, `high`, `xhigh` or `max`. `low` suits an agent that formats more than it thinks (a brief, a recap, a watch). Default: the CLI's own (see "Run options" below). |
| `agents[].modelFor` | no | The model of a run by its motive, over `model`: `{ "message": "sonnet" }` coordinates on Sonnet and creates on the agent's `model`. Keys: the motives of "Run options" below. |
| `agents[].prepare` | no | `{ "command": [...], "timeoutSeconds": 60 }`: a command of the home MyHQ runs before each turn of the agent, which may skip the turn (no model call, cost 0) or add context to it (see "Run options" below). |
| `agents[].cacheTtl` | no | Prompt cache duration of the agent's runs: `"5m"` or `"1h"`. Default: the CLI's own, one hour on a subscription (see "Run options" below). |

Cron expressions accept `*`, numbers, ranges (`1-5`), steps (`*/15`,
`8-18/2`), lists (`1,15`) and names (`mon`, `jan`); 0 and 7 are Sunday. When
both the day of month and the day of week are restricted, a day matches if
either does (classic cron). A minute skipped by a daylight saving change does
not fire.

MyHQ validates the file with zod at startup and refuses to start a room whose
file is invalid, with an explicit error.

#### Waking an agent: `onApproval`, `onMessage` and `onRevise`

An agent that receives work does it: whenever a task is created for it (a
message, a revision, an approved item of an `onApproval: "task"` agent, a
request of the chat), MyHQ starts a run at once. `onMessage` and `onRevise`
wake by default; set them to `"queue"` for an agent meant to batch its work,
which then only finds the task at its next run (`onApproval` is the other way
round: it creates tasks only when set, and `"queue"` keeps them from waking).

The run goes through the same agent lock and daily cap as any other run
(`architecture.md`, "Wake-ups"). When the agent is busy, it is woken again as
soon as its run ends; when the cap is reached, the task waits in its mailbox
for its next run. Either way the task is listed in the prompt of the run that
takes it, under "Pending tasks from your mailbox". A run that fails gives its
mailbox tasks back, and they wait for the next run rather than waking the
agent in a loop. A message from one agent wakes its recipient at most once
every 10 minutes per pair of agents (`HQ_MESSAGE_WAKE_MINUTES`, 0 to wake at
each message): two agents that answer each other ("received", "still
waiting") no longer wake each other at each message, the next messages wait
in the mailbox for the recipient's next run (`architecture.md`, "Wake-ups").
Set `"queue"` on an agent that converses rather than answers.

#### The portier

A message from another agent (reason `message`) is read by **the portier**
before it wakes its recipient: a small model (Haiku unless `myhq.json` says
otherwise) reads the recipient's name, the first paragraph of its role and the
message, and answers whether the message is worth a wake now or can wait in the
mailbox for the recipient's next run. An acknowledgement, a thanks or a status
that asks nothing no longer costs a turn of the recipient; it is read by that
next run, whatever starts it (a routine, another message, a revision, the chat).

- The sender decides instead of the portier with `hq_message` `expects`:
  `"reply"` or `"action"` wake at once, `"none"` never wakes (the message
  waits for the next run). Without `expects`, a message whose text holds a
  question mark wakes at once. The messages MyHQ delivers for an approved item
  (`hq_submit` `onApprove`) are `"action"`.
- The portier is one `claude -p` call per batch of messages (every message of
  the agent it has not read yet): no tool, no MCP server, `--effort low`, a
  short system prompt, and a cap of 0.05 $. It costs a fraction of a cent.
  While it reads, the message waits; a wake verdict wakes the agent the moment
  it is stored.
- **It fails open.** A call that fails, times out (60 s) or answers something
  unreadable wakes the agent, with the error stored.
- A message the portier let wait (or that its sender sent with `"none"`) waits
  by design: the Standard does not list it as stuck.
- Every verdict is stored with its cost, and `/reglages` shows the latest ones.
- Turn it off for the home with `"portier": { "enabled": false }` in
  `myhq.json`, or for one agent with `"portier": false` in its `room.json`.
  The anti ping-pong window still applies before it.

#### Executing an approved item without a model turn

An agent whose items are executed by a script of the home (a mail sent, an
event put in the calendar) does not need a model turn for it. With
`"onApproval": "command"` and an `approvalCommand`, MyHQ runs the command the
moment the item is approved:

- **stdin**: one JSON object,
  `{ "item": { "id", "room", "agent", "kind", "title", "body", "payload", "note" } }`
  (`kind` is the item's type, `payload` its parsed payload, `note` the owner's
  note of the approval or `null`).
- **Environment**: the agents' own (none of the app's `HQ_*` or `MYHQ_*`
  variables, no secret added), plus `MYHQ_HOME`, the absolute path of the home.
- **Success**: exit code 0 and, on stdout, `{ "ok": true, "note"?: string }`.
  The item is executed: its task is written done with the note (« Exécuté par
  MyHQ (commande d'approbation). » without one), and the desk shows the note
  on the approved item. Nobody is woken.
- **Anything else** (another exit code, no such JSON, 120 s without an answer,
  a program that cannot start): MyHQ falls back to `"task"`. The agent gets the
  task « Exécute l'item approuvé n° <id> : <title> » with the error under it,
  and is woken (reason `approval`), so the item is still executed.

```json
{
  "id": "mail",
  "name": "Mail",
  "role": "roles/mail.md",
  "model": "sonnet",
  "allowedTools": ["mcp__hq__*"],
  "onApproval": "command",
  "approvalCommand": ["node", "tools/mail/send-approved.mjs"]
}
```

An agent that hands an approved item to another agent (a script to a studio)
says so when it submits it, with `hq_submit` `onApprove`: MyHQ delivers the
messages itself on approval, in the submitter's name, each with the item's
title, body and files appended, and does not wake the submitter to relay them.

An agent that sends approved mails could be declared like this (the
`courrier` server and its tools belong to the home):

```json
{
  "id": "mail",
  "name": "Mail",
  "role": "roles/mail.md",
  "model": "sonnet",
  "allowedTools": ["mcp__courrier__mail_list", "mcp__courrier__mail_send", "mcp__hq__*"],
  "mcpServers": {
    "courrier": {
      "command": "node",
      "args": ["../../../../mail-server/index.mjs"],
      "env": { "HQ_DB_PATH": "${HQ_DB_PATH}", "MAIL_PASSWORD": "${HQ_EXT_MAIL_PASSWORD}" }
    }
  },
  "onApproval": "task"
}
```

#### Shared rooms

A room with `"shared": true` is a studio that the other rooms order from. Its
agents, and the agents of every room, use the same two HQ tools as always:

- **Ordering.** `hq_message` takes an optional `room`. An agent may write to
  an agent of another room only when that room is shared, or when the
  recipient is an agent that ordered from its own room (a studio asking or
  answering its requester: any agent of the studio may answer the agent whose
  message became a task of the studio). Any other room is refused with an
  explicit error, and so is a room that is no longer in the home. The message
  becomes a task of the recipient that records the sender's room and agent,
  and wakes it per its `onMessage`, like any message. `hq_rooms` lists the
  shared rooms and their agents, and the prompt of each run names the shared
  rooms it may order from (and, for an agent of a shared room, how to deliver).
- **Delivering.** `hq_submit` takes an optional `forRoom`, for the agents of a
  shared room only, and only to a room of the home. The item belongs to that
  room's pile: it carries `forRoom` (`api.md`, Approval), the desk gives it
  that room's colour, so do the spines of `GET /api/desk`, a view that groups
  items by room reads `forRoom` before `room`, and the desk and Telegram say
  where it comes from and goes (« creation pour planygo »). Its decisions still
  go back to the producing agent: a revise wakes it as usual.
- The owner's own requests are unchanged: a task given to any agent from the
  desk, the chat or `/run` starts it whatever its room.

A studio declared like this, with a project room ordering from it:

```json
{ "name": "studio", "targetRepo": "../studio-assets", "color": "#f5a524", "shared": true, "agents": [ ... ] }
```

and in the role of a project agent: « Order a video from the room studio with
`hq_message` (`room: "studio"`, `to: "video"`); the deliverable comes back to
your room's pile. »

#### The room brief

A room may write down what any studio needs to know to work for it (its
colours, its tone, its logo rules) and say where its reference files live:

```json
{
  "name": "shop",
  "targetRepo": "../shop",
  "brief": { "file": "brief.md", "references": ["../example-project/design"], "keeper": "dev" },
  "agents": [ ... ]
}
```

- **When it is joined.** To a run of a shared room that works for this room,
  as "Room folders" below says (a message from one of its agents, the
  messages of an approved item, `hq_submit` `onApprove`, or a revise or
  approval task on an item delivered for it): the text of `brief.md` goes in
  the prompt, labelled with the room's name, cut at 12,000 characters with a
  note saying so, and its reference folders are read-only for that run only.
  A run that works for two rooms gets two labelled briefs. Never to a room
  that is not shared, and not when every task naming the room is a message
  from a supervisor. Nothing is stored in the database.
- **What the room checks when it loads.** The file must be a `.md` file inside
  the room directory (its real path too) and exist; `keeper` must be an agent
  of the room; a reference must not overlap, by real path, the home's
  `data/`, `assistant/` or `rooms/` folders, the root of the room folders, or
  the drop folder of `assistant.json` (`dropDir`). Any of these makes the room
  invalid, with the reason. A reference missing on disk is allowed: a run
  skips it, with a line in the log.
- **Asking the keeper.** A studio that works for the room (the room ordered
  from it) may ask the keeper a question about the brief: `hq_message` with
  `room`, `to` the keeper and `aboutBrief: true`. It becomes a task of the
  keeper, labelled as a question on the brief; the keeper answers the
  studio with an ordinary `hq_message`. A room without a brief or without a
  keeper, or another agent than the keeper, is refused with the reason. The
  keeper's role should say that it keeps the brief and answers such
  questions.
- **A draft when the room is created.** Approving a room proposal of the
  receptionist also writes a brief draft in the new room: headings to fill
  in (the project, its audience, its tone, its visual identity and where its
  reference files are, what is forbidden, who validates), with the room's
  name, repository and agents already there. It goes to the `brief.file` the
  proposal declares, else to `brief.md`, which `room.json` then does not
  declare: fill it in, then add `"brief": { "file": "brief.md" }`. It is
  shown in the proposal's body, and never written over an existing file.
- **A room without a brief shows.** A room that is not shared and has no
  `brief`, or whose brief file is empty, is listed in `roomsWithoutBrief` of
  the state and its card on the settings page says « Sans fiche ». It is an
  information, not an error: the room works, a studio just gets no brief
  from it. Shared rooms are never listed: they serve the others, and a brief
  is only given by the room a studio works for. (A declared file that is
  missing when the room loads still makes the room invalid, as above.)
- **The limit.** A reference reaches the studio as an `--add-dir`: the write
  guard refuses the editing tools there, but a studio agent that has `Bash`
  can still write in it, as in any `addDirs`.

#### Room folders

"One room, one folder": everything a room receives and produces lives under
`<root>/<room>/`, sorted into drawers. The root is `<home>/folders` by default,
or `folders.dir` of `myhq.json` (relative to the home, or absolute). `npm run
init` ignores only `data/` in the home's `.gitignore`: add the root there if
the home is a repository and the folders hold deliveries you do not version.

- **The rule.** MyHQ files an approved delivery itself, and the owner may drop
  what a client sent. Agents never write there. The workshops (working
  directories, worktrees, tools, target repositories) do not move: only what
  was approved, or dropped by the owner, lives in a room folder.
- **The drawers**, a closed list. Their names on disk follow the interface
  language (French for now) and are created when something is filed, `recu`
  excepted: it is created with the room folder and with each order.

  | Drawer | Holds |
  |---|---|
  | `recu` | What a client or a third party sent: the pieces of a request. |
  | `videos` | Delivered videos. |
  | `visuels` | Delivered images. |
  | `sons` | Delivered sounds, voices, music. |
  | `social` | A post: its text and media. |
  | `modeles-3d` | 3D models. |
  | `rendus` | Render images of a part. |
  | `impression` | Print-ready files. |
  | `devis` | Quotes. |
  | `documents` | Other PDFs and documents. |

- **How an approved item is filed.** When the item goes from pending to
  approved, after the decision is committed. Never filed: a question, a room
  proposal, an agent proposal, an informational item (`notifyTypes`), and an
  item with neither files of a known kind nor a named drawer.
  - *Where*: `<root>/<for_room, else the agent's room>/[<order>/]<drawer>/`.
    The drawer is the one `hq_submit` `drawer` names, else the default by what
    the files are: a 3D model, else a video, else a sound, else a PDF, else
    images (a preview image put first never decides).
  - *Under which name*: `<YYYY-MM-DD>-<slug of the title>`, the day of the
    approval in the home's time zone. Zero or one file: flat (`<name>.<ext>`,
    or `<name>.md` for an item without a file). Several files: a folder
    `<name>/` holding them. The body is kept as `<name>.md` (beside the file,
    or inside the folder) only when the item named its drawer. Nothing is ever
    overwritten: a taken name becomes `-2`, `-3`. Filing an item whose order
    folder was deleted recreates that folder, without saying so.
  - The frozen copies of `data/attachments` stay where they are. The place is
    recorded in the approval (`filedPath`, relative to the root), and the desk
    card says « Rangé dans ... » with a link to it. A failure to file never
    undoes the approval: what was written is removed, the error is logged and
    the item stays unfiled (see the catch-up below).
- **Orders.** With `"orders": true` in `room.json`, the room folder holds one
  folder per order, named `<YYYY>-<MM>-<client>-<subject>` (lowercase ASCII,
  for example `2026-11-acme-sign`), each with its own drawers and its own
  `recu`. The owner opens one with « Nouvelle commande » on the page
  `/dossiers`, an agent of the room with `hq_order_open` (arguments `client`
  and `subject`, the month taken in the home's time zone; an order of that
  name already there is given back with `created: false`). `hq_orders` lists
  the orders, newest first. An agent of a shared room may give `room`, but
  only a room that ordered from its own (a message of one of that room's
  agents became a task of the shared room, at any time); any other room gets
  one refusal, the same whether it exists or takes orders. `hq_submit` `order`
  names the order a delivery belongs to, checked against the destination room
  at submission; with `forRoom`, only for a room that ordered from the
  agent's: any other gets one refusal, whether the order exists or not.
  `hq_order_open` also takes `received`, the ids of items approved and filed
  in a `recu` outside any order, and `receivedFiles`, the names of entries of
  the room's `recu/`: MyHQ moves them into the new order's `recu/`,
  everything checked before anything is created or moved, and a move that
  fails halfway puts back what had already moved. An id of `received` must be
  the room's own: an item submitted in the room, delivered for it (`forRoom`),
  or relayed by MyHQ to an agent of the room when it was approved
  (`hq_submit` `onApprove`, delivered). Every refusal of an id, whatever its
  cause (unknown id, not approved, another room, not in a `recu`, already in
  an order, the filed copy gone), is the same message, so that an agent cannot
  probe another room's items through it. That is the case of a client's
  request approved before the order existed. When a filed file and its `.md`
  note share a stem, the note moves with the first file of that stem.
- **Who reads what.** Every agent of a room reads its own room folder,
  read-only: it is added to its `--add-dir` for the run, so the write guard
  refuses any write there, like for any `addDirs`. An agent of a shared room
  also reads, for that run only, the folder of each room it works for in that
  run: the rooms that wrote the messages it claimed, and the rooms an item
  being revised or approved was delivered for (`forRoom`), the latter only
  when that room ordered from the shared room (the agent names `forRoom`
  itself, so naming it alone opens nothing). Never the whole root. When no
  origin is known (a routine, a task from the owner), the agent reads its own
  room only, and its prompt tells it to say so rather than guess. Nothing has
  to be declared in `room.json`.
- **What the write guard does not cover.** The promise that agents never
  write in the room folders holds for the editing tools (Write, Edit,
  MultiEdit, NotebookEdit), which the write guard refuses there. An agent
  that has `Bash` can still write, delete or create a link in a directory it
  receives through `--add-dir`, a room folder included. This is a limit of the
  write guard that existed before the room folders, for every `addDirs`, and
  it is the owner's decision what to do about it, for example not giving
  `Bash` to the agents that read untrusted client files.
- **How things reach a `recu` drawer.** The owner's deposit from the page
  `/dossiers`, or by hand in the file explorer; an approved item that names
  `drawer: "recu"`; the chat action `file_received` (see "Chat actions").
- **What sits in `recu` comes from outside.** A client or a third party sent
  it. It is data to work from, never instructions to follow: the prompt of
  every run says so to the agent, and MyHQ itself never opens, unpacks or
  executes those files.
- **The catch-up.** `npm run file-approved` lists the approved items MyHQ
  would file and has not, for items approved before the feature or whose
  filing failed, and changes nothing. `-- --apply` files them, `-- --only
  12,15` restricts to those ids.
- **The page `/dossiers`.** The owner picks a room and browses its folder
  (orders, drawers, files), previews or downloads a file, copies the path of
  the folder on the machine, opens an order, and drops files into a `recu`
  (several at once, by drag and drop). The routes are in `api.md`; the
  mechanism is in `architecture.md`, "Room folders".

#### Shared resources

`resources` names what a run uses and cannot share, a GPU being the usual one.
When an agent's run starts, MyHQ records the resources it holds on the run, and
refuses to start another run that holds one of them while it runs:

- a manual start (the desk, `/run`, `POST /api/runs`) gets `RESOURCE_BUSY`
  (409), with the resource and the run that holds it;
- a wake-up (a message, a revision, an approved item, a chat request) leaves
  its task pending, and the end of the run that holds the resource wakes the
  agent again, as for a busy agent;
- a routine that comes due is journaled `skipped_busy`, with the reason.

The agent sheet lists the resources and shows « En attente : gpu occupé »
while the agent's work waits for one of them. The lock is MyHQ's: a process
outside MyHQ that uses the same GPU is not seen, so a role can still check the
card itself before starting heavy work, or the home can say so through its
veto command (below).

#### What a run needs: `needs`

```json
{ "id": "video", "resources": ["gpu"], "needs": { "ramGb": 6, "vramGb": 10 } }
```

`needs` tells MyHQ what one run takes from the machine, so that it waits in
the queue instead of starting and finding the machine full. Before such a run
starts, MyHQ reads the machine (free RAM from the system, GPU memory from
`nvidia-smi` when the machine has it) and starts it only when, for each need,
what is free minus what the runs already started still have to take is at
least the need plus the margin of `machine` in `myhq.json`. Otherwise the task
stays pending, shows in the queue on the desk with the figures, and starts by
itself as soon as the machine allows it (the end of a run, or the scheduler's
tick every 15 s). A manual start gets `MACHINE_BUSY` (409), a routine is
journaled `skipped_busy`.

- **A need the machine can never give** (with the margin, above its total
  RAM or GPU memory) never starts: its task says so in the queue and on the
  Standard, and holds no other task back. Lower the declaration, or close the
  task.
- **The need in force** is the declared one, raised to the second highest
  peak measured on the agent's last 5 runs that ran alone among the runs with
  needs, under the declaration in force, when that is higher: one outlier run
  (a game opened meanwhile) never raises it, a peak above what the machine can
  give is left out, and changing the declaration starts the learning over. It
  is never lowered below the declaration: the settings page shows the
  declared need and the measured median and max, and you change the
  declaration yourself.
- **A GPU need without a GPU reading** (no `nvidia-smi`, an AMD or Apple GPU,
  a failing driver) waits: MyHQ cannot tell whether the memory is there. Do
  not declare `vramGb` on such a machine; a `resources: ["gpu"]` lock and the
  veto command are the tools there.
- Only the first GPU `nvidia-smi` lists is read.
- A run MyHQ looked at the machine for (`needs` declared, or a veto command
  and `needs` or `resources`) is told in its run instructions that MyHQ
  checked the machine before starting it, and that it still checks it before
  a heavy step if its role says so. `resources` alone, without a veto
  command, adds no line.

#### The piece: `pieces`

The surveillance room (`/surveillance`, see "The surveillance room" in
`architecture.md`) shows each agent at work with the piece it works on. Never
everything in its working directory: the role declares its piece with
`pieces`, and MyHQ follows only the files that match one of the patterns and
were written during the run, newest first, at most 12; the latest is shown
large and the earlier ones form the strip of versions of the tile, marked
« Suivi auto ». A video plays muted in a loop, an image opens large on a
click, a sound gets a plain player, a 3D part (`.3mf`, `.stl`, `.glb`, as for
the attachments) is drawn by the desk's 3D viewer (in the detail panel, and
in at most two tiles at once; the others show a card), and a text file shows
its path and its first lines. Other kinds (a PDF, a STEP file) are never
followed.

```json
{ "id": "editor", "pieces": ["renders/*.mp4"] }
```

Name the files of a role with a version (`render-01.mp4`, `render-02.mp4`,
or a time): a file written again under the same name is one version, the
latest, and the strip has nothing to compare. A 3D part written again under
the same name is drawn again from its new version. A role that writes parts
and render boards next to them may follow both (`["parts/*.3mf",
"parts/*.png"]`): the newest file is the piece, whichever kind it is. Point the patterns at the
deliverable, not at its by-products (`renders/*.mp4`, not `**/*.png` when the
renders leave control frames next to them).

An agent may also choose its piece itself, with `hq_show(path, caption)`: the
file it shows wins over the patterns for the rest of the run, marked
« Montré par l'agent », with its caption (the latest showing of each file,
the 12 newest; a run may show 50 files at most). With no pattern and no file
shown, the tile shows the agent's words only.

What the room shows, the owner and anyone who reads the room sees: a text
piece shows its first lines (40 lines or 4 KB). A role must never declare in
`pieces`, nor show with `hq_show`, a file that holds a secret (a `.env`, a
token, a key, a configuration with a password).

#### Skills

The agents run `claude -p --setting-sources project,local` from their working
directory, so they never see the user's own skills (`~/.claude/skills`). Claude
Code does read project skills from `<working directory>/.claude/skills/<name>/SKILL.md`,
and `skills` is how a room hands some to an agent:

```json
{ "id": "scenariste", "skills": ["skills/scripter-video-courte"], "...": "..." }
```

Keep the skill folders in the home, next to the roles (`rooms/<room>/skills/<name>/`
with its `SKILL.md` and any `scripts/`), and list them relative to the room
directory. A path that leaves the room directory, is absolute, is not a folder,
has no `SKILL.md`, has a folder name with anything but letters, digits, `.`, `-`
or `_`, or repeats another skill's folder name makes the room invalid, with an
error naming the agent and the path.

Before each run MyHQ copies every listed folder to
`<working directory>/.claude/skills/<folder name>/`, replacing the previous copy
(an edit of the source is live from the next run), and adds `Skill` to the
agent's `--tools` (without it, the model cannot call a skill; nothing is needed
in `allowedTools`). Other folders of `.claude/skills` are never touched. A folder
of the same name that MyHQ did not create (a skill the repository versions) is
not overwritten: the run fails with `SKILL_CONFLICT`. MyHQ marks its copies with
a `.myhq-skill` file.

For an agent in a Git `worktree`, each copy also gets a `.gitignore` holding
`*`, so Git ignores the whole folder and the agent can never commit it. This was
preferred to `.git/info/exclude`, which Git shares between all the worktrees of
a repository: it would also hide the folder in the owner's own checkout, and
needs the worktree's common Git directory found first. The `.gitignore` lives
and dies with the copy.

Claude Code also lists its bundled skills (`loop`, `schedule`, `simplify`...)
next to the agent's own, and `Skill` is not limited to the listed ones. Deny one
in `disallowedTools` (for example `Skill(loop)`) if a role must not reach it.

#### Character sheets

The floor (`/`) is isometric pixel art and draws each agent as a
character of the same set. MyHQ ships four neutral people
(`public/sprites/iso-person-blue.png`, `-green`, `-mustard`, `-grey`, one
picked per agent from its key) and the receptionist
(`public/sprites/iso-receptionist.png`); a home can give an agent its own
with `isoSprite`, and seat someone of its own in the user's office with
`floor.owner` of `myhq.json` (see "The owner of the floor" below). The sheet is served by
`GET /api/sprites/<room>/<agent>?sheet=iso`, from the path in the validated
`room.json` only. The format is the one of `scripts/iso/README.md`
(section "Characters"), which also builds the shipped sheets and can draw a
home's own mascot with the same rig:

- A transparent PNG (or WebP) of **8 columns by 12 rows of 96 by 136 px
  frames** (768 by 1632 px). Any other size is ignored and the neutral person
  is drawn instead.
- **Anchor**: pixel (48, 120) of a frame is the point on the ground under the
  feet (for the seated frames: under the centre of the seat).
- **Rows**: direction times animation, `row = direction * 3 + animation`, the
  directions in the order `NE`, `SE`, `SW`, `NW` (`SE` walks towards the
  lower right of the screen, `NE` turns its back to the viewer), the
  animations `idle` (2 frames, standing), `walk` (8 frames) and `type`
  (4 frames, seated, hands on a keyboard at desk height). Unused cells stay
  empty. Directions are drawn, never mirrored.
- The floor picks the walk frame from the distance walked, so the feet do not
  slide: 3 voxels per frame by default (one floor cell is 16 voxels), or the
  `walk.voxelsPerFrame` (1 to 16) of an `iso.json` placed in the same folder as
  the sheet, in the format of `scripts/iso/README.md`. A mascot with a shorter
  stride (2 voxels, say) declares it there. Sitting, thinking
  and sleeping hold the first typing frame (a bubble over the head says the
  rest); talking to a colleague and dropping a folder stand (`idle`).
- The name over the head sits just above the highest opaque pixel of the
  frame, so a small mascot gets its name close to its head.
- The file must stay under 2 MiB. The art is drawn at a whole number of
  device pixels per pixel, without smoothing.

The old top-down `sprite` (a 4 by 4 grid of square cells: sit and type,
walk, think, sleep, facing right) is still accepted and served, but no longer
drawn.

#### Agents who roam the floor: `floor.behaviour: "roam"`

An agent with `"floor": { "behaviour": "roam" }` (the janitor of the floor,
say) has no desk in its room's suite: its suite is sized without it, and a
broom closet stands against the back wall of the lobby, the agent resting
beside it. During its runs it does its round: from the closet it walks into
every room of the floor in turn (the lobby, the user's office, every suite,
row after row), along the aisles and the corridors like everyone else, stops
in each room to sweep, and in the corridor before every other door; then
it starts again, for as long as the run lasts. When the run ends it walks back
to its closet and rests there, then falls asleep like the others. It runs no
errands on the floor: a message or an item it sends is not walked over. With
reduced motion there is no round: it stays by the closet, its status (in the
strip, as for any agent) says it is on its round.

Its sheet is `isoSprite` as usual; without one it is drawn as the janitor
shipped with MyHQ (`public/sprites/iso-janitor.png`: a broom and a bucket).
A roaming agent's sheet uses its `type` row for **sweeping**, standing, not
for typing (`scripts/iso/README.md`, "Characters"); a home that gives it its
own sheet draws that row so. The round only exists on the single floor: the
floor of one room (`floor-per-project`) has no closet, so a roaming agent is
listed in the strip without being drawn there.

With `"floor": { "behaviour": "roam", "always": true }` (`always` only goes with
`roam`) the round never stops: between its runs too the agent walks it, and
the place on it is a pure function of the clock, counted from a fixed origin
(the epoch), so every client and every reload draws it at the same spot, run
or not. A run changes its status, never where it is, and its end sends it
nowhere: there is no walk back to the closet. Between its runs its status
says « fait sa ronde, hors tour » and the strip lists it with the agents at
rest (no turn is in progress; it is drawn on its round all the same). With
reduced motion nothing changes from the plain `roam`: it stays by the closet,
then falls asleep.

#### Run options: `effort`, `modelFor`, `prepare` and `cacheTtl`

These fields change how a run of the agent is started, never what it may do.

**The motive of a run** is its `reason` (`runs.reason`, see "Why a run
started" in `architecture.md`: `message`, `approval`, `revise`, `chat`,
`desk`, `relaunch`, `standard`, `long_run`, or a reason of the home such as
`mail`), `routine` for a run started by a routine, and `manual` for a run
started by hand (the desk, `/run`, `POST /api/runs` without a reason).

**`effort`** is passed to `claude -p` as `--effort <level>`. Left out, the CLI
decides.

**`modelFor`** maps a motive to a model (`opus`, `sonnet` or `haiku`); a motive
it does not name runs on `model`:

```json
{ "model": "opus", "modelFor": { "message": "sonnet", "routine": "sonnet" } }
```

**`prepare`** runs a command before each turn: `command` is the program and its
arguments, relative to the home, and it runs with the home as working
directory, for at most `timeoutSeconds` (default 60, at most 600). Use an
absolute program or one on the `PATH` (`node`, `python`), not a shell built-in.
Its environment is the agent's (no secret of the app, see "A run" in
`architecture.md`) plus `MYHQ_HOME`, the absolute path of the home. It reads one
JSON object on stdin:

```json
{
  "room": "example",
  "agent": "analyst",
  "motive": "routine",
  "task": { "id": 812, "title": "Morning alert on yesterday's sign-ups.", "body": "Morning alert on yesterday's sign-ups." },
  "messages": [{ "from": "example/lead", "text": "Any news on the launch?", "expects": null }],
  "lastRunAt": "2026-11-05T07:00:02.114Z",
  "now": "2026-11-06T07:00:01.530Z"
}
```

- `task`: the run's own instruction (`title` is its first line), or `null`
  when the run was woken only to take its mailbox.
- `messages`: the mailbox tasks the run takes. `from` is `room/agent` for a
  message of an agent, otherwise where the task comes from (`approval`,
  `revise`, `chat`); `expects` is what the sender expects of a message
  (`reply`, `action` or `none`) when MyHQ knows it, else `null`.
- `lastRunAt`: the start of the agent's last run that ended well, a skipped
  one included (nothing was left to do then), or `null`.

It answers one JSON object on stdout, one of:

- `{ "run": false, "reason": "No sign-up yesterday." }`: no model turn. The run
  is still recorded, so the skip is visible in the list of runs and on the
  desk: status `done`, cost 0, no tokens, its summary « Skipped by its prepare
  command, no model turn: » followed by the reason (end reason
  `prepare_skipped`). Its tasks are closed `done` with the reason as their
  note. Nothing is delivered (`notifyRuns` sends nothing). A skipped run does
  not count in the daily cap (`maxRunsPerDay`) and never triggers its alert.
- `{ "run": true, "context": "...", "model": "sonnet", "effort": "low" }`: a
  normal turn. `context` (Markdown, optional) is added to the prompt under the
  heading `## Préparé par MyHQ`, before the date line; `model` and `effort`
  (optional) override `modelFor`, `model` and `effort` for this run only.

It fails open: a command that cannot start, exits with a non-zero code, runs
past its timeout (it is killed) or prints anything else than one of these two
objects leaves the turn to run as if there were no `prepare`; MyHQ logs the
error (`[runner] the prepare command of <room>/<agent> failed ...`). A command
meant to save turns must therefore be cheap and quick, and say `run: true`
whenever it is unsure.

**`cacheTtl`** sets the prompt cache duration of the agent's runs, through the
CLI's `CLAUDE_CODE_PROMPT_CACHE_TTL` variable. On a subscription the CLI keeps
the prompt for an hour, and a cache write costs twice the input price; for one
that lasts five minutes, it costs 1.25 times. An agent that runs less than once
an hour (a daily brief, a weekly review) rewrites its whole prompt prefix at
each run anyway: `"5m"` makes that write cheaper. Keep the default for an
agent woken several times an hour, which reads its prefix from the cache.

#### Environment placeholders in `mcpServers`

Any string value of an MCP server's `env`, and any entry of its `args`, may use
`${NAME}` placeholders. They are expanded from the app's own environment
(`.env.local`) when the per-run `--mcp-config` file is written, so a secret
lives in `.env.local` and never in `room.json`:

```json
"mcpServers": {
  "reddit": {
    "command": "npx",
    "args": ["-y", "some-reddit-mcp"],
    "env": {
      "REDDIT_CLIENT_ID": "${HQ_EXT_REDDIT_CLIENT_ID}",
      "REDDIT_CLIENT_SECRET": "${HQ_EXT_REDDIT_CLIENT_SECRET}"
    }
  }
}
```

- Only `env` values and `args` are expanded. `command`, `url`, `headers` and
  every other field are passed as written.
- The run's own variables are available too, and win over the app's
  environment: `${HQ_DB_PATH}` (absolute path of `data/hq.db`),
  `${HQ_RUN_ID}`, `${HQ_AGENT_ID}`, `${HQ_ROOM}` and `${HQ_WORK_DIR}`, the
  values MyHQ gives the `hq` server. A private server can then read the
  database (for example to check that an item is approved before acting on it)
  or tag its own journal with the run: `"env": { "HQ_DB_PATH": "${HQ_DB_PATH}", "HQ_RUN_ID": "${HQ_RUN_ID}" }`.
  `${HQ_WORK_DIR}` is the absolute working directory of the agent for the run
  (its worktree when it has one), the directory `hq_submit` attachments are
  relative to: a server can write a file there for the agent to attach.
- A variable that is not set, or is empty, fails the run before it launches,
  with an error naming the variable (`HQ_EXT_REDDIT_CLIENT_ID` here). It is
  never replaced by an empty string.
- Tools of an MCP server are named `mcp__<server>__<tool>` in `allowedTools`.
  List them by exact name: the run's `start` event (in the feed, or in
  `data/runs/<run>.jsonl`) shows every tool the server offers.
- Only the generated MCP config carries the expanded values. The agent's own
  process environment is unchanged: the `HQ_*` and `MYHQ_*` variables are still
  stripped from it. The config file is rewritten for each run, and the values
  are never logged.

#### Example: the official GitHub MCP server

GitHub's own server (`github/github-mcp-server`) runs over stdio, from its
Docker image or its released binary, and reads its token from the
environment variable `GITHUB_PERSONAL_ACCESS_TOKEN`. The token lives in
`.env.local` only (give it the smallest scope: one repository, contents,
issues and pull requests), and `room.json` names it with a placeholder:

```json
"allowedTools": [
  "mcp__github__get_file_contents",
  "mcp__github__list_issues",
  "mcp__github__create_issue",
  "mcp__hq__*"
],
"mcpServers": {
  "github": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${HQ_EXT_GITHUB_TOKEN}" }
  }
}
```

with `HQ_EXT_GITHUB_TOKEN=...` in `.env.local`. `docker run -e NAME` passes
the variable from the server's environment, which MyHQ fills from the
placeholder. With the binary instead of Docker: `"command":
"github-mcp-server", "args": ["stdio"]` and the same `env`. The server can be
narrowed further with its own options (toolsets, read-only mode, see its
README), which go in `args`.

List the tools by exact name, never `mcp__github__*`: the names change with
the server's version, so read them from the `start` event of a first run.
A token cannot tell "open a pull request" from "merge it": the barrier is the
whitelist, so never list merge tools, and remember that agents never push
(see `architecture.md`, approval cycle).

HTTP servers that sign in with OAuth (Metricool, for example) are covered in
`architecture.md`, section 6: declaring them works, signing in from a
headless run is the open question.

## roles/*.md

Plain Markdown, passed as is to `--append-system-prompt-file`. It describes who
the agent is, what it does, what it may and may not do, and what it submits to
the approval queue through `hq_submit`. Roles are meant to be read and edited by
hand and versioned with the rest of the home.

MyHQ ships generic templates in `templates/roles/` (community watch, SEO
content, videos and social networks, app stores and reviews, metrics analyst,
lifecycle email, directories and partners, competitor watch, developer). The
onboarding agent instantiates them for a project by filling `{{project}}`,
`{{targets}}`, `{{audience}}`, `{{features}}` (the closed list of what the
agent may claim), `{{autonomy}}` (A: inside the repository or the project's
accounts; B: prepared, then signed and posted by the user; C: the user alone,
the agent prepares notes) and `{{guardrails}}`. A role written by hand does not
have to follow them.

A role that delivers renders (video, image, sound, 3D part, PDF) should tell
the agent to join them to its item with `hq_submit` `attachments`, so that the
owner sees and plays them on the desk and on Telegram:

```json
{ "attachments": [
  { "path": "livraisons/planygo/teaser/clip-01.mp4", "caption": "Plan d'ouverture, 6 s" },
  { "path": "livraisons/planygo/teaser/piece.3mf" },
  { "path": "livraisons/planygo/teaser/piece.png", "caption": "Aperçu de la pièce" }
] }
```

Paths are relative to the agent's working directory (its worktree when it has
one) and may not leave it: a render written elsewhere (the output folder of
ComfyUI, an `addDirs` folder) is copied into the working directory first,
which needs a copy tool in the agent's whitelist (`Bash(cp *)`, or `Write`).
Accepted: mp4, webm, mov, png, jpg, jpeg, webp, gif, wav, mp3, ogg, flac, m4a,
3mf, stl, glb, pdf, and, for a client's piece or a data file (a logo, a
drawing, a build report), svg, ai, eps, psd, tif, tiff, heic, dxf, step, stp,
obj, docx, xlsx, txt, csv, md, json, zip, which MyHQ never opens and shows the
owner as downloads only (a file of these that starts like a program is
refused), each up to `HQ_ATTACHMENT_MAX_MB` (200 MB by default). An
image with the same name as a 3D part or a PDF is shown as its preview. MyHQ
keeps its own copy (`data/attachments/`), so the agent may go on working on
its file. See `architecture.md`, "Files joined to an item". The owner can pin
a remark on a point of an image, of a video's frame or of a part: the revision
then gives the point on a line under the remark (in percent from the left and
top edges of an image, with the time for a video, see `api.md`), which the role
can tell the agent how to read.

Once approved, MyHQ files the item in its room folder (see "Room folders"):
the agent never copies anything there and a role never names a path of the
room folders. `hq_submit` takes two more fields for that. `drawer` names the
drawer when the default one (by what the files are) is not right, and an item
without files is filed only when it names one. `order` names the order the
delivery belongs to, for an agent of a room with `"orders": true` (or of a
shared room delivering to one, with `forRoom`):

```json
{ "drawer": "devis", "order": "2026-11-acme-sign", "forRoom": "shop" }
```

An approved `agent_proposal` (`architecture.md`, "Proposing a missing agent")
is the other way MyHQ writes in a room: it adds `roles/<id>.md` (the role
prompt the receptionist wrote, in the language of the home) and appends the
agent to `room.json`, with `"role": "roles/<id>.md"` and `"armed": false`.
`room.json` is then rewritten as formatted JSON; nothing else of the room
changes.

## assistant.json

Configures the assistant on Telegram (see `architecture.md`). It is read when
the app starts, only when polling is on (`HQ_TELEGRAM_POLLING=true`); restart
the app after changing it. Without the file, the assistant has its core
commands and alerts only. An invalid file is reported in the log and the
assistant runs with its core commands only.

```json
{
  "chat": {
    "cwd": "assistant/chat",
    "systemPrompt": "assistant/chat/prompt.md",
    "model": "sonnet",
    "addDirs": ["../notes"],
    "writeDirs": ["../notes"],
    "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__mail__*"],
    "mcpServers": {
      "mail": {
        "command": "node",
        "args": ["mail-mcp/server.js"],
        "env": { "MAIL_PASSWORD": "${HQ_EXT_MAIL_PASSWORD}", "HQ_DB_PATH": "${HQ_DB_PATH}" }
      }
    },
    "requests": { "dir": "assistant/chat/requests" },
    "permissionMode": "acceptEdits",
    "timeoutMinutes": 10,
    "afterReply": "node assistant/after-reply.mjs"
  },
  "transcribe": "my-speech-to-text --language fr {file}",
  "dropDir": "../notes/inbox",
  "extensions": ["assistant/commands/hello.ts"],
  "door": {
    "dirs": ["../notes/Projects", "../notes/Knowledge"],
    "sensitive": ["../notes/Relations", "../notes/Money"],
    "model": "sonnet",
    "effort": "low"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `chat` | no | The conversation. Without it, text that no command claims gets a "not configured" answer. |
| `chat.cwd` | yes | Working directory of the `claude -p` chat. `--continue` resumes the latest conversation of this directory, so changing it starts a new one. |
| `chat.systemPrompt` | no | The conversation's system prompt: a Markdown file of the home, passed explicitly with `--system-prompt-file`, which replaces the CLI's default prompt (as a role file does for an agent, but whole). This is the lever on the assistant's behaviour, written for any engine. The CLI still reads the `CLAUDE.md` files of `chat.cwd` and of its parent directories as project memory, so keep them short, or say in the prompt that they do not apply. Without it, the CLI's default prompt and the `CLAUDE.md` of `chat.cwd` are what shape the chat, as before. |
| `chat.model` | no | `opus`, `sonnet` (default) or `haiku`. |
| `chat.addDirs` | no | Directories the chat may read (`--add-dir`). Read-only unless also listed in `chat.writeDirs`. Default: none. |
| `chat.writeDirs` | no | Directories outside `chat.cwd` the chat may write (a notes vault, a data folder), relative to the home; each is also passed as `--add-dir` unless `chat.cwd` or `chat.addDirs` covers it. Each turn installs the write guard in `chat.cwd` (its `.claude/settings.local.json`, kept out of Git by a `.claude/.gitignore` of MyHQ's): the chat writes only in `chat.cwd`, these folders and `chat.requests.dir`, whatever `chat.permissionMode` says. Default: none. |
| `chat.allowedTools` | no | Whitelist (`--allowedTools`). Only the built-in tools it names exist for the chat (`--tools`). Default: none, so the chat can only talk. May name MCP tools of `chat.mcpServers`: `mcp__<server>__*` or an exact `mcp__<server>__<tool>`. |
| `chat.mcpServers` | no | Extra MCP servers for the chat, same shape and same `${NAME}` placeholders as `agents[].mcpServers` of `room.json` (see "Environment placeholders" above). Each turn writes a `--mcp-config` file with them (deleted when the turn ends), still with `--strict-mcp-config`. The name `hq` is refused: the chat is not an agent and has no HQ tools. A server may add `"untrusted": false` (MyHQ's own flag, never written to the MCP config): every server is untrusted by default (see "Chat actions"). Default: none. |
| `chat.requests` | no | `{ "dir": "<path relative to the home>", "actions"?: [...] }`: where the chat leaves requests for the agents and actions for the core (below). `actions` is the whitelist of chat actions (`approve`, `reject`, `revise`, `run`, `arm`, `disarm`, `propose_agent`, `file_received`, `queue`, `queue_first`); default none. The directory must be inside `chat.cwd`, `chat.addDirs` or `chat.writeDirs`; the write guard lets the chat write there. |
| `chat.untrustedTools` | no | More tools whose results count as untrusted for chat actions, by exact name or with a final `*` (`mcp__mail__*`). The web tools and the tools of untrusted servers always count. Default: none. |
| `chat.permissionMode` | no | `default` (default), `acceptEdits`, `plan`, `dontAsk` or `auto`. `bypassPermissions` is refused. |
| `chat.timeoutMinutes` | no | A turn still going after this is killed. Default: 10. |
| `chat.afterReply` | no | Shell command run in `chat.cwd` after each reply. Its output goes to the log, never to Telegram. |
| `chat.historyTurns` | no | Exchanges of the conversation MyHQ gives back to the chat at the start of a turn (below). Default: 12; 0 gives none. |
| `chat.historyMaxChars` | no | Characters of that transcript at most, its marks included (200 to 100,000). Default: 8,000. |
| `chat.resume` | no | `cli` (default): resume the CLI's conversation with `--continue`, an optimization while the engine is Claude. `history`: never `--continue`, every turn is fresh and gets MyHQ's transcript (what any other engine would do). |
| `chat.freshAfterMinutes` | no | Pause, in minutes since the previous turn, after which a `cli` chat stops resuming the CLI's conversation and starts a new one with MyHQ's transcript (the `historyTurns` last exchanges). The CLI keeps a conversation cached for an hour: resuming later writes all of it again at twice the price of an input token (74,000 tokens after eighteen turns), while a new conversation only writes the fixed prefix and the transcript. Default: 60. |
| `chat.preamble` | no | The facts of the moment given before each message (below): `{ "fields"?, "command"?, "file"?, "maxChars"?, "timeoutSeconds"? }`. Without it, no preamble. |
| `transcribe` | no | Shell command that turns a voice note into text: `{file}` is replaced by the quoted path of the audio file (do not quote it yourself), and the command prints the text on stdout. Without it, voice notes get a "not configured" answer. |
| `dropDir` | no | Folder where photos and documents sent to the bot are saved, with a free name (never overwritten) and, when the message has a caption, a companion `.md` note. Without it, files get a "not configured" answer. |
| `extensions` | no | Extension modules, asked in this order (below). |
| `door` | no | The door agents ask the assistant through (`hq_ask_assistant`, see "The door to the assistant" in `architecture.md`). Without it the door is closed: the tool answers so, and no model is called. It is read at each request, no restart needed, by the app whether polling is on or not. A `door` of the wrong shape makes the whole file invalid, like any other key. |
| `door.dirs` | yes | The folders the door's call may read (`--add-dir`, read-only), relative to the home or absolute: 1 to 32. |
| `door.sensitive` | no | Folders that open only for a question the owner approved on the desk: never mounted otherwise. A sensitive folder may not overlap a folder of `door.dirs` (mounting that one would open it): the door is then invalid, and stays closed. Default: none. |
| `door.model` | no | `opus`, `sonnet` (default) or `haiku`. |
| `door.effort` | no | `--effort` of the call: `low` (default) to `max`. |

### The preamble

With `chat.preamble`, each message given to the chat is preceded by a
delimited block of the facts of that instant, so that the chat answers « what
do I have today? » or « approve the one for the town hall » without a tool
call:

```
[Contexte à cet instant, le plus récent fait foi]
Nous sommes le mardi 3 novembre 2026 à 14:05 (Europe/Paris).
Dernier échange : il y a 12 min.
À valider (7) :
- n° 14, Mail, mail_reply : Réponse à la mairie
- ... (five at most)
- et 2 autres
Tours d'agents aujourd'hui : 3 sur 12.
<the stdout of the home's command>
[Fin du contexte]

<the user's message>
```

| Field | Default | Meaning |
|---|---|---|
| `fields` | `["datetime", "lastExchange", "pending", "runs"]` | The core's facts, in this order: the date and time in `HQ_TIMEZONE`; `lastExchange`, the time since the user last wrote to the chat (below); the pending items (number, agent, type and a title cut at 50 characters, five at most, then how many others); the runs started today against the daily cap. |
| `command` | none | Shell command run in the home (same shell and environment as `transcribe`); its trimmed stdout ends the block (for example the day's appointments from a cache of the home). |
| `file` | none | Instead of `command`: a text file of the home whose content ends the block. |
| `maxChars` | 600 | Characters of the block at most, marks included (100 to 4000). The home's text is cut first; the core's lines only when they alone do not fit. |
| `timeoutSeconds` | 3 | A command still running after this is killed and left out. |

`lastExchange` lets the chat decide whether to greet. It is worded from the last
message the user sent to the chat (a task given to an agent from the desk does
not count; the turn in progress is not recorded yet), in `HQ_TIMEZONE`:
« Dernier échange : à l'instant » (under a minute), « il y a 12 min », « il y a
3 h 05 » (same day), « hier à 22 h 40 », « vendredi 30 octobre à 22 h 40 »
(older), or « premier échange aujourd'hui » when the conversation holds no
message of the user (new, or after `/new`). Leave it out of `fields` to turn it
off.

The home's part is computed at most once a minute (cached 60 seconds); the
core's facts are read at each message. A command that fails, prints nothing
or runs past its timeout leaves the core's facts alone (and a line in the
log): the chat never waits longer than `timeoutSeconds`. The conversation MyHQ
keeps (below) stores the user's own words, never the preamble.

### The conversation MyHQ keeps

MyHQ, not the CLI, holds the continuity of the conversation, so that it
survives a change of `chat.cwd` or of engine. The table `chat_messages` keeps
the user's messages that went to the chat, the chat's replies, and what the
bot sent on its own: approval alerts, informational items (`notifyTypes`),
failure alerts and run summaries (`notifyRuns`, a brief or a recap), each
flagged as such, only once Telegram accepted it. The 500 most recent are kept;
`/new` empties the table (and the next turn starts without `--continue`).
Each message also says its channel (`telegram`, or `desk` for the conversation
panel of the web interface, which talks to the same chat: `POST /api/chat`) and,
for a task the user gave an agent from the desk, the agent it went to.
`GET /api/chat/history` returns them (`api.md`).

At the start of a turn the user's message is preceded by a transcript in a
delimited block (« [Conversation récente, du plus ancien au plus récent] »
... « [Fin de la conversation récente] »), at most `chat.historyTurns`
exchanges (a user message and the replies that follow it; each message of the
bot counts as one) and `chat.historyMaxChars` characters, the oldest dropped
first:

- a turn that does not resume (`chat.resume: "history"`, the first turn after
  `/new`, or the retry when the CLI has no conversation to continue) gets the
  whole transcript;
- a turn that resumes with `--continue` already has the exchanges, so it only
  gets the messages the bot sent since the last one (« [Messages envoyés de ta
  part depuis notre dernier échange] »): a « oui » then answers what the bot
  just sent.

### Chat MCP servers

`chat.mcpServers` expands its placeholders from the app's environment
(`.env.local`) plus the variables of the chat turn, which win: `${HQ_DB_PATH}`
(absolute path of `data/hq.db`), `${HQ_ROOM}` (`_chat`), `${HQ_AGENT_ID}`
(`chat`) and `${HQ_RUN_ID}` (an id of the turn, `chat-<ms>-<n>`). A variable
that is not set fails the turn: the user gets the error naming it, and
`claude` is not started.

### Chat requests

The chat has no agent tools, but it can hand an action to an agent (for
example a mail reply to prepare) by writing a JSON file in `chat.requests.dir`:

```json
{ "room": "demo", "agent": "mailer", "task": "Prepare a reply to the landlord's mail about the lease.", "reason": "mail_followup" }
```

`room`, `agent` and `task` (20,000 characters at most) are required; `reason`
is optional (lowercase letters and underscores, 40 at most; default `chat`).
After each chat reply that succeeds, MyHQ reads the `*.json` files of the
directory, in name order. For each valid one it creates a pending task (source
`chat`) for that agent with the given text, starts a run at once if the agent
is free and the daily cap allows (the run takes the task from its mailbox,
reason `chat` or the given one), then deletes the file. A busy agent, a busy
shared resource or the cap leave the task waiting for the agent's next run, and
MyHQ adds a line to the chat's reply to say so (the chat wrote its answer before
knowing); a task that waited for the cap starts by itself after the daily reset. A file that is not valid JSON,
does not match the shape or names an unknown room or agent is logged and moved
to `<dir>/rejected/`. Other files are left alone. The agent keeps its own tools
and the approval queue: the request only gives it work.

### Chat actions

The chat can also ask the core itself to act on the HQ, as the user would
with a button or a command, by writing a JSON file in the same
`chat.requests.dir` with an `action` key:

```json
{ "action": "approve", "id": 14 }
{ "action": "reject", "id": 15, "note": "Pas ce mois-ci." }
{ "action": "revise", "id": 16, "note": "Plus court." }
{ "action": "run", "agent": "watch", "task": "Optional task." }
{ "action": "arm", "room": "demo", "agent": "watch" }
{ "action": "disarm", "agent": "watch" }
{ "action": "propose_agent", "need": "Draw the illustrations of the site.", "room": "demo" }
{ "action": "file_received", "file": "contract.pdf", "room": "shop", "order": "2026-11-acme-sign" }
{ "action": "queue" }
{ "action": "queue_first", "taskId": 41 }
```

- Only the actions listed in `chat.requests.actions` are taken; an action
  outside it, or a file that does not match (an unknown action, `reject` or
  `revise` without a `note`, a decision without `id`, which `approvalId` may
  replace, a `run`, `arm` or `disarm` without `agent`, a `propose_agent`
  without `need`, a `file_received` without `file` or `room`, a `queue_first`
  without `taskId`), is moved to
  `<dir>/rejected/`, logged, and a line of the reply says so.
- `room` may be left out when exactly one room has an agent of that id.
- After a reply that succeeds, the action files are taken in name order (before
  the requests to the agents) and executed with the code of the buttons and of
  the commands: `decideApproval` for `approve`, `reject` and `revise` (an item
  already decided or unknown is refused with the usual error, an approved item
  is handed over like an Approuver button does), `startRun` for `run` (agent
  lock, daily cap, reason `chat`), the armed state for `arm` and `disarm`,
  and `proposeAgent` for `propose_agent`: the need goes to the receptionist,
  which proposes a missing agent (`architecture.md`, "Proposing a missing
  agent"; `room`, optional, is the room the need comes from; a busy
  receptionist or the cap leave the need waiting for its next run), and
  `file_received`, below. The
  core appends one French line per action to the chat's reply (« Item #14 :
  Approuvé. », « Tour #7 lancé pour demo / watch. », or the refusal). The
  chat's own text never decides anything.
- **`queue`** lists the queue (`architecture.md`, "The queue and the
  machine"): a line per waiting task, in order, with its number, room and
  agent, its text and why it waits. **`queue_first`** `{ "action":
  "queue_first", "taskId" }` puts a pending task at the head of the queue, as
  « En tête » on the desk does, then wakes the agents in the new order; the
  line says so, or why not (a task no longer pending). Both go through the
  same confirmation guard as every action.
- **`file_received`** `{ "action": "file_received", "file", "room", "order"? }`
  files a file the owner sent to the bot. It moves `file`, a plain file name
  (no separator, no drive prefix) of the `dropDir` of `assistant.json`, with
  its companion note (`<name without extension>.md`) when there is one, into
  the `recu/` of `room`, or of its `order` (the room must take orders and the
  order exist), under a free name: it never overwrites, and refuses a link or
  a file that is not directly in the drop folder. The line of the reply says
  where it went (« Rangé dans ... ») or why not. It goes through the same
  confirmation guard as every action. No agent ever reads the drop folder:
  only MyHQ moves a file out of it, on an act of the owner (see "Room
  folders").
- **Confirmation guard.** When the turn called an untrusted tool, the actions
  are not executed: the reply ends with a line naming them and asking for
  « oui ». A mail or a web page read in that turn could have asked for them.
  Untrusted tools are `WebFetch`, `WebSearch`, the tools matching
  `chat.untrustedTools`, and every tool of a chat MCP server that is not marked
  `"untrusted": false` (so a home marks only its own action server as trusted,
  never a mail or calendar server). A turn whose tools are unknown counts as
  untrusted. The held actions are a pending question, like the reason a
  Refuser button asks for: the next text message that is not a command
  answers it. « oui », « ok », « vas-y » (case and final punctuation ignored)
  executes them and the results are the reply, with no chat turn; « non »
  drops them; any other message drops them with a short notice and goes on as
  usual. After one hour they expire. A new question (a button pressed)
  replaces them.
- The actions of a turn that fails are dropped, never executed.

### Shell commands and isolation

The shell commands (`transcribe`, `afterReply`) run through the system shell
(`cmd.exe` on Windows, `sh` elsewhere) with the app's environment minus the
`HQ_TELEGRAM_*` variables and `HQ_CLAUDE_OAUTH_TOKEN`. Each chat turn runs with
the same isolation as an agent run: the app's variables removed,
`--setting-sources project,local`, `--strict-mcp-config` (only the servers of
`chat.mcpServers`), tool search off,
deploy commands denied, and `--max-budget-usd` from `HQ_CHAT_MAX_BUDGET_USD`.

## assistant/commands/

The assistant's extensions: commands specific to one user that do not belong in
the core. Each entry of `extensions` in `assistant.json` is a TypeScript (or
JavaScript) module of the home, loaded once at startup with tsx's `tsImport`.
Its default export follows this contract (exported by MyHQ from
`src/assistant/extension.ts`):

```ts
export interface AssistantCommand { command: string; description: string }
export interface AssistantContext {
  chatId: string; home: string; env: NodeJS.ProcessEnv;
  reply(text: string): Promise<void>; log(message: string): void;
}
export interface AssistantExtension {
  name: string;
  commands: AssistantCommand[];
  handle(text: string, ctx: AssistantContext): Promise<string | null>;
}
```

- `commands` are added to the bot's command menu after the core commands
  (`command`: 1 to 32 lowercase letters, digits or underscores). A name already
  taken by the core is left out of the menu, and the core command wins.
- For every text message (typed, or transcribed from a voice note) that is not
  a core command, the extensions are asked in order. The first one to return a
  string has it sent as the reply, and nothing else runs; `null` passes the
  message on. When none claims it, the message goes to the chat. An extension
  may therefore keep a question of its own and claim the next message.
- An exception thrown by `handle` is caught and logged, and the user gets a
  short error message; the assistant keeps running.
- `ctx.env` is the app's environment (`.env.local`) without the
  `HQ_TELEGRAM_*` variables and without `HQ_CLAUDE_OAUTH_TOKEN`: an extension
  reads its own secrets there, MyHQ never looks at them. `ctx.reply` sends a
  message at once (for progress on long work), `ctx.log` writes to the app's
  log.
- A module that is missing, outside the home, fails to load or does not match
  the contract is reported in the log and skipped.

A minimal extension, `assistant/commands/hello.ts`:

```ts
import type { AssistantExtension } from "../../../myhq/src/assistant/extension";

const hello: AssistantExtension = {
  name: "hello",
  commands: [{ command: "hello", description: "Says hello" }],
  async handle(text, ctx) {
    if (!text.startsWith("/hello")) return null;
    ctx.log("hello called");
    return `Hello ${text.slice("/hello".length).trim() || "you"}.`;
  },
};

export default hello;
```

The type import is erased at load time; its path only matters to your editor
(here, a home cloned next to the MyHQ repository).

## myhq.json

Settings of the home that are not secrets. Optional: without the file, or
without a section, the feature is off. Other keys are ignored (and kept as they are when MyHQ rewrites the file from the settings page, see below).

```json
{
  "language": "fr",
  "export": { "dir": "../notes/agents-journal", "hour": 6 },
  "folders": { "dir": "../deliveries" },
  "reception": { "room": "assistant" },
  "floor": { "layout": "room-per-project", "owner": { "name": "Ada", "isoSprite": "sprites/iso-ada.png" } },
  "scheduler": true,
  "timeZone": "Europe/Paris",
  "maxRunsPerDay": 12,
  "defaultMaxBudgetUsd": 1,
  "runTimeoutMinutes": 30,
  "runSummaries": { "enabled": true },
  "archivedRooms": [{ "name": "old-project", "at": "2026-10-28" }],
  "catalog": { "dirs": ["../notes/projects"] },
  "projectsRoot": "..",
  "onboarding": { "sprite": "sprites/reception.png" },
  "notifyTypes": ["brief", "mail_alert"],
  "quietHours": { "start": "21:00", "end": "08:00" },
  "privateDirs": ["../notes"],
  "desk": {
    "objects": [
      { "id": "signer", "object": "pile", "label": "À signer", "source": "approvals" },
      { "id": "agenda", "object": "calendar", "label": "Agenda", "source": { "command": "node tools/agenda.mjs", "cacheSeconds": 300 } }
    ]
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `language` | no | Language of the texts the agents write for this home, as a BCP 47 tag (`fr`, `en`, `pt-BR`). Default: `en`. The onboarding run tells its agent to write the proposal, the role prompts and the "HQ agents" block in it (the English templates stay the structural source, the agent translates them), and, for a French home, to title the proposal « Proposition de salle : <name> ». Roles you write by hand are yours to write in any language. |
| `export.dir` | yes (with `export`) | Folder of the daily export, relative to the home or absolute. One file per day, `<YYYY-MM-DD>.json`: the runs, messages and approvals of that day (see `architecture.md`, section 6). |
| `export.hour` | no | Local hour (`HQ_TIMEZONE`, 0 to 23) from which the previous day is written. Default: 1. |
| `reception.room` | no | The floor (`/`) that draws the reception desk and the receptionist, the onboarding agent (see `architecture.md`, section 7). Only that floor has the counter in its lobby, the receptionist's chip in the strip under the floor and its sheet (with the « Ajouter une salle » form and the recent onboarding runs); the others keep a plain lobby. Default: the room called `assistant` when the home has one, otherwise the first room. A name that is not a room of the home falls back to the default. |
| `folders.dir` | no | The root of the room folders (see "Room folders" below), relative to the home or absolute, like `export.dir`. Default: `<home>/folders`. |
| `floor.layout` | no | How the floor, the home page `/`, draws the home (see `architecture.md`, section 7). `"floor-per-project"` (the default): a floor per room of the home, chosen with the buttons at the top, each a template of offices, a lobby with your desk and the tray, a meeting room and a kitchen. `"room-per-project"`: one floor for the whole home, where each room is a suite of its own (its walls, its workstations sized from its number of agents, a coffee nook for a big team, a counter beside its name of what that room waits for: a click opens « À signer » filtered to the room), around corridors that start at the lobby, the entrance at the front (a main corridor, a spine, ribs branching off it), your own office beside the lobby, the desk's scene itself (a click opens the desk, `/bureau`), a signboard with its name (and its `logo`) on each room, a garden between the rooms; the floor pans and zooms by whole steps, and a click on a room or its button at the top flies the view to it. Read apart from the rest of the file: a missing or invalid `floor` (an unknown layout) falls back to the default, with the reason in the log, and leaves every other setting as it is. |
| `floor.owner` | no | Someone seated in the user's own office of the single floor: `{ "name", "isoSprite" }` (see "The owner of the floor" below). Read apart from the rest of the file and from `floor.layout`: an invalid owner leaves the office empty, with the reason in the log. Default: none, the office stays empty. |
| `catalog.dirs` | no | Extra read-only folders of the technology catalogue the receptionist bases an agent proposal on (`architecture.md`, "Proposing a missing agent"), relative to the home or absolute, 20 at most. Besides the target repositories of the rooms, which are always in it, each folder is summarized in the run prompt (its own `package.json`, `pyproject.toml` and README, then each top-level Markdown note with its YAML frontmatter, for example notes whose `stack:` lists the technologies you use) and given to the run as `--add-dir`, read-only. A folder that does not exist is named as missing. Read apart from the rest of the file: an invalid `catalog` gives no extra folder, with the reason in the log, and leaves every other setting as it is. Default: none. |
| `projectsRoot` | no | The folder the explorer behind « Parcourir » of the « Ajouter une salle » form is limited to (`GET /api/fs/dirs`, see `api.md`), relative to the home or absolute. Nothing outside it can be listed (`..`, an absolute path or a link that leaves it is refused), and it only shows folders. Default: the parent folder of the home, where the repositories are usually kept next to it. Read apart from the rest of the file: an invalid value (not a non-empty string) falls back to the default, with the reason in the log, and leaves every other setting as it is; a folder that does not exist makes the explorer answer `ROOT_NOT_FOUND`, and the form still takes a typed path. |
| `scheduler` | no | `true` or `false`: whether the routines of `room.json` start runs on their own. When the key is set it wins over `HQ_SCHEDULER`; without it the variable applies (default off). See "Settings that also exist as environment variables" below. |
| `timeZone` | no | IANA time zone of the routines and of the daily export (`Europe/Paris`). Wins over `HQ_TIMEZONE`; without it the variable applies, then the time zone of the machine. |
| `maxRunsPerDay` | no | Daily cap of runs, all agents together (an integer, 0 or more; 0 stops every run). Wins over `HQ_MAX_RUNS_PER_DAY`; without it the variable applies (default 12). |
| `defaultMaxBudgetUsd` | no | `--max-budget-usd` of an agent whose `room.json` sets no `maxBudgetUsd`, in dollars (more than 0). Wins over `HQ_DEFAULT_MAX_BUDGET_USD` (default 1). |
| `weeklyBudgetUsd` | no | The weekly budget, in dollars, against which the meter and `/status` show the share spent; nothing stops when it is reached. Wins over `HQ_WEEKLY_BUDGET_USD` (default: none). |
| `runTimeoutMinutes` | no | The soft deadline of a run, in minutes, 1 at least (see "Long runs" in `architecture.md`). Wins over `HQ_RUN_TIMEOUT_MINUTES` (default 30). |
| `runHardLimitMinutes` | no | The hard limit of a run, in minutes, 1 at least. Wins over `HQ_RUN_HARD_LIMIT_MINUTES` (default 180). The two durations are read as a pair: when the timeout in force (file over environment) is not strictly shorter than the hard limit, the pair is invalid, logged and reported on `/reglages`, and the environment's pair applies (the defaults when it is no better). The settings page checks the pair only when one of the two changes. |
| `runSummaries` | no | `{ "enabled": false }` stops the run summaries: the one-line headline of a run's task that a small model writes once at the start of a run whose task is long or that takes mailbox tasks, shown in the surveillance room (`architecture.md`, "The surveillance room"). Default: on. Read apart, like `portier`: an invalid block keeps them on, with the reason on `/reglages`. |
| `archivedRooms` | no | The rooms archived from `/reglages`, each `{ "name", "at" }` (`at` the day it was archived, `YYYY-MM-DD`). An archived room keeps its folder `rooms/<name>/` and its whole history, but MyHQ leaves it out of the rooms it loads: it is not on the floor, nor in the desk's lists, nor in the scheduler, nothing of it starts and no agent can write to it. Its items waiting for a decision or a look are set aside (out of the desk, refused if decided) and come back when it is restored. Restoring it (`/reglages`) removes it from the list, and it comes back paused. The list is read entry by entry: an invalid entry is reported on `/reglages`, archives nothing and is kept as it is when MyHQ rewrites the list; an entry whose folder is gone is dropped at the next write. |
| `onboarding.sprite` | no | Old top-down sheet of the receptionist, a path relative to the home (same contract as `agents[].sprite`). Still accepted and served, but **no longer drawn**: the isometric floor always draws the receptionist shipped with MyHQ, `public/sprites/iso-receptionist.png` (headset). |
| `notifyTypes` | no | Informational approval types (snake_case). An item of one of them is stored `unseen` the moment the agent submits it: it is sent to Telegram as one message (an alert line, then its body as is; past 1500 characters the body is cut cleanly, ends with « … » and « Lire la suite : <url> », or « (suite dans MyHQ, item #<id>) » without `HQ_PUBLIC_URL`) with a single « Vu » button, and it stays on the desk in the « À regarder » section until the user marks it seen (« Vu », or « Demander à Rom2 » which sends it to the assistant first); it is then `seen` and stays in the history. It is not in the pending list nor in the `À valider` count of the tab title (counted apart), not in `/pending` nor in `hq_pending`, and it never triggers `onApproval` nor wakes an agent. `hq_submit` answers `"status": "unseen"`. Every other type (`mail_reply`, `room_proposal`...) keeps the pending flow with buttons. Default: none. |
| `privateDirs` | no | Folders no agent reads directly (32 at most), relative to the home or absolute, typically the owner's notes vault: for a fact from there an agent asks the assistant (`hq_ask_assistant`). When set, every run and every question to an agent installs the read guard (see "The read guard" in `architecture.md`): `Read`, `Glob` and `Grep` on a path inside one of these folders (links resolved), or a `Glob` or `Grep` of a folder that holds one, are refused, except inside the agent's own `notebook` and inside an entry of its own `addDirs` (or a room folder MyHQ gives the run) that lies inside the private folder: an explicit grant by the home's owner. An `addDirs` entry that holds a private folder opens nothing of it. For an agent that has a shell (`Bash`) this is a guard against mistakes and simple injections, not a sandbox: a command can still read the files. For a question (no shell) it is a real barrier. A `myhq.json` that cannot be read while it is set fails the run or the question rather than open the folders. Default: none, nothing is installed and the runs are exactly as without the key. |
| `quietHours` | no | A daily range, `start` and `end` as `HH:MM` on the wall clock of the home's time zone (`timeZone`, then `HQ_TIMEZONE`, then the machine's), during which the Telegram alerts of the informational items (`notifyTypes`) are held. An `end` earlier than `start` crosses midnight (`21:00` to `08:00`); `start` is inside the range, `end` is not. An item held stays on the desk under « À regarder » as usual, only its message waits: the first sweep after the end of the range (the app checks every minute) sends all the items held as one text, a heading « MyHQ : N alertes arrivées pendant les heures calmes (de 21:00 à 08:00) » then each item with its link, cut like a single one is, without « Vu » buttons (the whole is one message when it can be, several only past 4000 characters); a single item held is sent the usual way, with its button. An item whose agent puts `"urgent": true` in its `payload` (`hq_submit`) is sent at once, quiet hours or not. Pending approvals, failure alerts and run summaries are never held. Read apart from the rest of the file: an invalid value (`"8:00"`, the same start and end) holds nothing, with the reason in the log and on `/reglages`. Default: none, every alert goes at once. |

| `desk` | no | The objects of the desk and where their data comes from (below). Default: a pile, a tray, a newspaper and a phone (the Standard). |
| `machine` | no | `{ "keepFreeRamGb"?: number, "keepFreeVramGb"?: number, "veto"?: { "command": [...], "timeoutSeconds"?: number } }`: what the gate of the machine keeps free for you on top of what the runs need (defaults: 2 GB of RAM, 1 GB of GPU memory), and the home's veto command (see "The veto command" below). Only agents with `needs` (and, for the veto command, `resources`) are concerned. Read at each start, apart from the rest of the file: an invalid block keeps the defaults and no veto command, with the reason in the errors of `/reglages`. |
| `portier` | no | `{ "enabled": true, "model": "haiku" }` (the default): the portier reads a message from another agent before MyHQ wakes its recipient for it, and lets an acknowledgement wait for the recipient's next run (see "The portier" above). `enabled: false` wakes the recipient at each message, as before; `model` is the alias given to `claude -p --model`. Read at each wake-up, apart from the rest of the file: an invalid block keeps the default, with the reason on `/reglages`. |

The file is read when the export is checked (every ten minutes) and at each
`hq_submit`, so a change needs no restart. An invalid file is reported in the
log (and every item keeps the pending flow).

### The veto command (`machine.veto`)

```json
{ "machine": { "keepFreeVramGb": 2, "veto": { "command": ["node", "tools/machine-veto.mjs"], "timeoutSeconds": 10 } } }
```

A command of the home that MyHQ asks before a run of an agent that declares
`needs` or `resources` starts, once the agent lock, the resources, the daily
cap and the memory allow it: for what MyHQ cannot see (a game is running,
another tool's own queue is busy). It runs like the other home commands
(`prepare`, `approvalCommand`): the program and its arguments, started
without a shell, a program given as a path relative to the home, cwd the
home, the agents' safe environment plus `MYHQ_HOME`, at most `timeoutSeconds`
(10 by default, 60 at most). On Windows a `.cmd`, `.bat` or `.ps1` script does
not start by itself: give its interpreter as the program (`["powershell",
"-File", "veto.ps1"]`, `["node", "veto.mjs"]`). It reads one JSON object on
stdin:

```json
{
  "reading": { "at": "...", "ramFreeGb": 18.4, "ramTotalGb": 31.9, "vramUsedGb": 16, "vramTotalGb": 24 },
  "run": { "room": "studio", "agent": "video", "needs": { "ramGb": 6, "vramGb": 10 }, "declaredNeeds": { "ramGb": 6, "vramGb": 8 }, "resources": ["gpu"] },
  "now": "..."
}
```

`needs` is the need in force, `declaredNeeds` the one of `room.json`
(`null` for a kind not declared). It answers on stdout, exit code 0:
`{ "wait": false }` to let the run start, `{ "wait": true, "reason": "Un jeu
tourne" }` to make it wait; the reason (500 characters at most) is shown in
the queue. The run waits while the command is asked, and its answer wakes the
agents again: a waiting task starts then, and a start with no task (a routine,
a run by hand, a relaunch) is tried again once, so it is not lost; a routine's
journal line says `started` once it did. A `wait` holds for a minute, then the
command is asked again at the next wake-up or tick; an `ok` is used by the
start it was asked for. **It fails open**: a command that cannot start, exits
with another code, takes longer than its timeout or prints something else lets
the run start, with the error in the log, on `/reglages` and on the Standard
(MyHQ's note on the agent, closed once the command answers again). Without
`veto`, nothing is asked.

### The owner of the floor (`floor.owner`)

```json
{ "floor": { "layout": "room-per-project", "owner": { "name": "Ada", "isoSprite": "sprites/iso-ada.png" } } }
```

The single floor (`room-per-project`) draws the user's own office, the hub's
scene, empty by default. With `floor.owner` a character sits in its chair,
facing the desk, its `name` (1 to 40 characters) over its head like the
agents'. `isoSprite` is an iso character sheet in the format of "Character
sheets" above, relative to the home (`.png` or `.webp`); left out, or a file
that does not exist, a neutral person is drawn. It is served by
`GET /api/sprites/_hq/owner?sheet=iso`, from this setting only, with the
guards of the agents' sheets (inside the home once links are resolved, 2 MiB at
most, really a PNG or a WebP; a sheet of the wrong size is drawn as a neutral
person).

The owner is no agent: no runs, no strip entry, no sheet of its own. It types
on the keyboard (the `type` row) while a turn of the chat (the assistant's
conversation, `assistant.json`) is in progress, from any channel, and sits
quietly otherwise, held on the first typing frame like an agent seated between
two tool calls; it never falls asleep. A click on it opens the « Discuter »
panel. The floor of one room (`floor-per-project`) has no such office: its
desk in the lobby stays empty.

### Settings that also exist as environment variables

Seven settings that are not secrets can live in `myhq.json` as well as in
`.env.local`: `scheduler` (`HQ_SCHEDULER`), `timeZone` (`HQ_TIMEZONE`),
`maxRunsPerDay` (`HQ_MAX_RUNS_PER_DAY`), `defaultMaxBudgetUsd`
(`HQ_DEFAULT_MAX_BUDGET_USD`), `weeklyBudgetUsd` (`HQ_WEEKLY_BUDGET_USD`),
`runTimeoutMinutes` (`HQ_RUN_TIMEOUT_MINUTES`) and `runHardLimitMinutes`
(`HQ_RUN_HARD_LIMIT_MINUTES`). The order is always the same:

1. the key of `myhq.json`, when it is set and valid;
2. the environment variable, when it is set;
3. the default (scheduler off, time zone of the machine, 12 runs a day, 1 $ a
   run, no weekly budget, 30 and 180 minutes).

Each of these keys is parsed apart from the others and from the rest of the
file: an invalid value (a time zone that does not exist, `"scheduler": "yes"`, a
negative cap) is logged once and ignored, so the variable applies for that key
only, and every other key of the file keeps working. A `myhq.json` that is not a
JSON object is ignored as a whole for these keys.

They are read again when they are needed, so a change needs **no restart**: a
run checks the cap and takes its budget and its deadlines when it starts, the scheduler is started or stopped at its
next tick (every 15 seconds, or at once when the change comes from the settings
page), the daily export and the Telegram assistant use the new time zone and cap
the next time they look. Secrets and tokens (`HQ_TELEGRAM_BOT_TOKEN`,
`HQ_CLAUDE_OAUTH_TOKEN`, `HQ_TRIGGER_TOKEN`) and every other `HQ_*` variable stay
in `.env.local`, and changing those needs a restart.

### The settings page (`/reglages`)

`/reglages` edits the home in five tabs, each addressed by the query
(`?onglet=general`, `salles`, `limites`, `notifications`, `securite`; a room's
panel is `?onglet=salles&salle=<room>`, its deletion `&supprimer=<room>`). Each
tab saves on its own: its « Enregistrer » button is active only once a value
differs from what is saved, and « Annuler les changements » puts the saved
values back.

| Tab | What it writes |
|---|---|
| Général | `floor.layout`, `language` (French or English, plus the current tag when it is another one) and `timeZone` of `myhq.json`. An empty time zone removes the key (the variable applies again). |
| Salles | One card per room, and the panel of a room: its `label` and `color` in its `room.json`, then `model` and `maxBudgetUsd` of each agent, and the armed state of the routines through the existing mechanism (the database wins over `armed` of `room.json`, see `api.md`). The gestures on a room (pause, archive, remove an agent, delete) act at once, see `architecture.md`, "Managing rooms". |
| Limites et coûts | `scheduler`, `maxRunsPerDay`, `defaultMaxBudgetUsd`, `weeklyBudgetUsd`, `runTimeoutMinutes` and `runHardLimitMinutes` of `myhq.json` (« Selon l'environnement » or an empty field removes the key), and the switches `portier.enabled` and `runSummaries.enabled` (the portier's `model` is kept). The scheduler starts or stops at once. |
| Notifications | `notifyTypes` and `quietHours` of `myhq.json` (the types seen in the database and in the « What you submit » lists of the roles, plus any type typed in; the quiet hours as a switch and two times, off removes the key) and `notifyRuns: "summary"` of each agent in its `room.json`. |
| Sécurité | Nothing: it says which secrets of `.env.local` are set (never their value) and the guard rails always in force. |

The files stay the source of truth, so editing them by hand keeps working. Every
write is checked with zod first (the whole tab, then each file, before anything
is written), goes through a temporary file in the same folder and a rename,
keeps the keys it does not know (and their order) and writes 2-space JSON with
a final newline. A `myhq.json` that cannot be read back is never overwritten:
the save fails with `SETTINGS_FILE_INVALID` and the file is left for you to fix.
A file that already holds the values sent is not rewritten. Comments cannot
exist in JSON, so none is lost; the one cosmetic change is that short arrays are
written one item per line.

« Limites et coûts » also shows what the runs cost since Monday, room by room
against the weekly budget, and the two small model calls outside runs: the
portier (its verdicts over 7 days, wakes avoided, total cost, and its latest 20
verdicts) and the run summaries (their calls and cost over 7 days).

### The desk objects (`desk`)

The desk is drawn as an office, and each object on it is a module with a count,
items and a page of its own, `/bureau/<id>` (see `architecture.md`, section 8).
`desk.objects` lists them, at most one of each kind:

| Field | Meaning |
|---|---|
| `id` | The address of its page, `/bureau/<id>`: lowercase letters, digits and hyphens, starting with a letter, unique. |
| `object` | What the scene draws: `pile`, `tray`, `newspaper`, `postits`, `calendar` or `phone`. |
| `label` | Its name in the interface (1 to 40 characters). |
| `source` | Where its count and items come from: a source of the core, a list of them, or a command of the home. |

Sources of the core:

| Source | Count | Items |
|---|---|---|
| `approvals` | Pending items. | Every pending item, oldest first (the object also gets the room colour of each one, the spines of the pile). |
| `watch:<type>`, `watch:*` | Unseen informational items of that type (of any type for `*`). | The unseen ones, oldest first, then the 20 last seen ones (`tone: "muted"`). |
| `summaries` | Summaries not seen yet: the ones that ended since the object's page was last opened (the ones of the day while it was never opened). | The 20 last run summaries (runs ended `done`) of the agents with `notifyRuns: "summary"`, the briefs and recaps they send, newest first. |
| `chat` | Replies and messages of the bot since the user last wrote and since the object's page was last opened. | The 10 last messages of the conversation. |
| `blocked` | The agents that have something stuck (one per agent, however many entries). | What is stuck at the agents of every room, newest first: the blocked tasks, the pending tasks that nothing will take on its own, the failed or interrupted runs of the last 24 hours whose tasks were not taken again (`architecture.md`, "The Standard"). |

A list (`["watch:brief", "summaries"]`) adds up the counts and merges the
items, newest first. Without a `desk` block the desk is: `signer` (pile,
`approvals`), `courrier` (tray, `watch:mail_alert`), `journal` (newspaper,
`["watch:brief", "summaries"]`) and `telephone` (phone, `blocked`, « Standard »);
post-its and a calendar exist only when configured, since only a home knows
where they live. A phone on `chat` is still possible: its page is then the
conversation panel.

**Seen.** Opening the page of an object (`/bureau/<id>`) marks it seen on the
server (`POST /api/desk/<id>/seen`, one row per object id in the `desk_seen`
table of the database). Its `summaries` and `chat` sources then count only what
came after that instant: what existed when the page was opened is read, what
arrives later counts again. The sources that wait for a decision (`approvals`)
or a gesture (`watch:*` and its « Vu », what is stuck for `blocked`) keep their
own count whatever the mark. The mark belongs to the object id: renaming an
object starts it over.
An invalid block is reported (`configError` of `GET /api/desk`, and a line on
the pages) and the default desk is shown; the rest of `myhq.json` is not affected.

A command of the home: `{ "command", "cwd"?, "timeoutSeconds"?, "cacheSeconds"? }`.
It runs through the system shell, in `cwd` (relative to the home, the home by
default, never outside it), with the same environment as the other commands of
the home (the app's, without `HQ_TELEGRAM_*` nor `HQ_CLAUDE_OAUTH_TOKEN`). It is
killed after `timeoutSeconds` (1 to 60, default 10) and its result is kept
`cacheSeconds` (0 to 3600, default 60), a failure too; two requests at once share
one run. It prints one JSON document on stdout (unknown fields are dropped):

```json
{
  "count": 2,
  "items": [
    { "id": "a1", "title": "Dentiste", "body": "Paris 11e", "at": "2026-11-05T13:30:00.000Z", "end": "2026-11-05T14:15:00.000Z", "href": "https://example.com/event", "tone": "warn" },
    { "title": "Anniversaire", "at": "2026-11-07", "end": "2026-11-07", "allDay": true }
  ],
  "slots": [{ "start": "2026-11-05T08:00:00.000Z", "end": "2026-11-05T13:30:00.000Z" }],
  "note": "Lu du cache."
}
```

| Field | Meaning |
|---|---|
| `count` | The number the scene shows on the object (an integer, 0 or more). |
| `items[]` | At most 200. `title` (required, 1 to 300 characters), `id` (else `item-<n>`), `body` (Markdown), `at` and `end` (an instant with its offset, or a date `YYYY-MM-DD`), `allDay`, `href` (an http(s) URL or a path of the app starting with `/`; anything else makes the output invalid), `tone` (`neutral`, `info`, `warn`, `alert`, `muted`). |
| `slots` | Free stretches of a calendar, `{ start, end, label? }` (instants). Optional. |
| `note` | A short line about the data, shown on the page. Optional. |

A command that runs past its timeout, exits with another code than 0 or prints
something else than this contract puts its object in an error state
(`COMMAND_TIMEOUT`, `COMMAND_FAILED`, `COMMAND_INVALID_OUTPUT`): the page says it
and offers to try again, the desk goes on, and stderr goes to the server's log
only. A command meant for the desk must be read-only and print no secret.

#### Actions

A command source may declare what the owner can do from the page of its object,
each as another command of the home:

```json
{
  "id": "postits",
  "object": "postits",
  "label": "Post-it",
  "source": {
    "command": "node tools/desk/afaire.mjs",
    "cacheSeconds": 30,
    "actions": {
      "add": { "command": "node tools/desk/afaire.mjs add" },
      "done": { "command": "node tools/desk/afaire.mjs done", "timeoutSeconds": 10 }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `actions.add` | Adds an item. The page of a `postits` object then shows a « Nouveau post-it » field. |
| `actions.done` | Marks an item done. The page then shows a « Fait » box on each post-it, which hides the note and leaves a few seconds to take it back before the command runs. |
| `command` | Required. Run like the source's command (system shell, the home's environment, same `cwd` rules). |
| `cwd`, `timeoutSeconds` | As for a source (the home by default; 1 to 60 seconds, default 10). There is no cache. |

`POST /api/desk/<id>/actions/<action>` (`api.md`) validates the body and runs the
command with the values as **one JSON document on standard input**, never in the
command line, so that no text can be read as shell syntax: `{ "text": "..." }`
for `add` (one line, 1 to 300 characters, trimmed), `{ "id": "..." }` for `done`
(an `id` from the source's own `items`). The command prints one JSON document on
stdout:

```json
{ "ok": true, "message": "Ajouté." }
{ "ok": false, "message": "Ce post-it n'existe plus." }
```

`message` is one line in the language of the home (up to 300 characters), required
when `ok` is false: the page shows it as is. A refusal may also exit with an error
code. Any other failure (exit code without that JSON, other output, timeout) is
reported by its code (`ACTION_INVALID_OUTPUT`, `ACTION_TIMEOUT`) and stderr goes to the
log. Afterwards the server drops the cached output of the source's command (the
next read runs it again) and the `desk` event carries the new count at once, so
the scene follows. Actions run one at a time, so two of them never write the same file together
(a command should still write atomically, in case something else reads it).
Only command sources have actions.

