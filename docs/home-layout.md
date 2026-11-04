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
  docs/roadmap.json      the live roadmap shown at /roadmap (optional, see api.md)
  assistant/
    commands/            extensions for the Telegram assistant
  data/                  created at first launch, ignored by Git
    hq.db                SQLite database
    work/<room>/<agent>/ default working directory of each agent
    worktrees/<room>/<agent>/  Git worktrees (by convention, see `worktree`)
    runs/                raw output and MCP config of each run
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
| `name` | yes | Room name, unique in the home. |
| `targetRepo` | yes | Path of the repository the room works on, relative to the home. |
| `color` | no | The room's colour in the interface, a CSS hex colour (`#rgb` or `#rrggbb`). The chat chips of the room's agents, the agent strip under the floor and the room's button in the floor header take it as a soft tint (border and dot in the colour, text unchanged), and the name plates on the floor get a thin line in it. Without it the room stays neutral. The assistant's own chip keeps its blue. |
| `shared` | no | `true` makes the room a shared studio (a room of scripts, videos or visuals, say): every room of the home may order from it, and it delivers to the room that ordered (see "Shared rooms" below). Default `false`. |
| `agents[].id` | yes | Stable identifier, used in messages and in the database. |
| `agents[].name` | yes | Display name. |
| `agents[].role` | yes | Path of the role prompt, relative to the room directory. |
| `agents[].model` | yes | `opus`, `sonnet` or `haiku`. |
| `agents[].allowedTools` | yes | Whitelist passed to `--allowedTools`. |
| `agents[].mcpServers` | no | Extra MCP servers, in the shape of Claude Code's MCP config. The `hq` server is always added by MyHQ. |
| `agents[].workingDirectory` | no | Defaults to the `worktree` when there is one, `data/work/<room>/<agent>` otherwise. Must stay inside the home. With a `worktree`, leave it out or give the same path. |
| `agents[].cron` | no | A cron expression (five fields, read in `HQ_TIMEZONE`), or a list of `{ "cron": "...", "task": "..." }` for several routines with a task each. Without it the agent only runs on demand. |
| `agents[].armed` | no | Initial armed state of the routines (default `false`: a declared cron does not fire). Once changed from the interface or with `/arm` and `/disarm`, the database value wins. Nothing fires anyway until `HQ_SCHEDULER=on`. |
| `agents[].worktree` | no | Path, relative to the home and inside it, of a Git worktree of the target repository: created with `git worktree add` on branch `hq/<agent>` when missing (on approval of an onboarding proposal, and before a run). The agent works in it. |
| `agents[].disallowedTools` | no | Denied to this agent on top of the global deny list (deploy and schema push commands), for example `Bash(git push *)`. |
| `agents[].addDirs` | no | Directories the agent may read besides its working directory (`--add-dir`), relative to the home. When left out, an agent whose `allowedTools` include `Read`, `Glob` or `Grep` and that has no `worktree` gets the room's `targetRepo`; an agent with a worktree already runs inside the code. |
| `agents[].maxBudgetUsd` | no | Value passed to `--max-budget-usd` for each run. |
| `agents[].isoSprite` | no | Isometric character sheet of the floor (`/room`): a `.png` or `.webp` file, relative to the home, inside it (see "Character sheets" below). Without it, or when the file is missing or is not a sheet of the right size, the agent is drawn as one of the neutral people shipped with MyHQ, always the same one for the same agent. |
| `agents[].sprite` | no | The old top-down sheet of the floor (4 by 4 square cells), relative to the home, inside it. Still accepted and served by `GET /api/sprites/<room>/<agent>`, but **no longer drawn**: the floor is isometric and only draws `isoSprite`. |
| `agents[].onApproval` | no | `"task"`: when an item this agent submitted is approved, MyHQ gives it the task « Exécute l'item approuvé n° <id> : <title> » and starts a run at once (reason `approval`). `"queue"`: the task is created but the agent is not woken, it finds it at its next run. The agent acts on the item with its own tools (for example an MCP server of the home that sends a mail once it finds the item approved); MyHQ itself never does. Default: nothing happens on approval (no task: an approved item is usually the user's to post). |
| `agents[].onMessage` | no | `"run"` (the default): an `hq_message` addressed to this agent starts a run at once (reason `message`) when its lock is free and the daily cap allows, otherwise as soon as its current run ends. `"queue"`: the message waits for the agent's next run, for an agent meant to batch its work. |
| `agents[].onRevise` | no | `"run"` (the default): a revise decision on one of its items (from the desk, including a revision asked after the item was approved or rejected, or from Telegram) starts a run at once (reason `revise`) under the same conditions. `"queue"`: the revision waits for the agent's next run. |
| `agents[].notifyRuns` | no | `"summary"`: when a run of this agent ends `done`, its summary (the agent's final text, at most about 4000 characters) is sent to Telegram as plain text. This is how a brief or a recap agent delivers its text. Default: nothing is sent for a run that ends well. |
| `agents[].resources` | no | Shared resources the agent's runs hold, for example `["gpu"]` (lowercase letters, digits, `-` or `_`, each listed once). Two runs holding a common resource never run at once, in any room (see "Shared resources" below). Default: none. |

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
agent in a loop. Two agents that write to each other with the default
`onMessage` keep waking each other: only the daily cap stops them, so set
`"queue"` on an agent that converses rather than answers.

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
card itself before starting heavy work.

#### Character sheets

The floor (`/room`) is isometric pixel art and draws each agent as a
character of the same set. MyHQ ships four neutral people
(`public/sprites/iso-person-blue.png`, `-green`, `-mustard`, `-grey`, one
picked per agent from its key) and the receptionist
(`public/sprites/iso-receptionist.png`); a home can give an agent its own
with `isoSprite`. The sheet is served by
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
  `${HQ_RUN_ID}`, `${HQ_AGENT_ID}` and `${HQ_ROOM}`, the values MyHQ gives the
  `hq` server. A private server can then read the database (for example to
  check that an item is approved before acting on it) or tag its own journal
  with the run: `"env": { "HQ_DB_PATH": "${HQ_DB_PATH}", "HQ_RUN_ID": "${HQ_RUN_ID}" }`.
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
  "extensions": ["assistant/commands/hello.ts"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `chat` | no | The conversation. Without it, text that no command claims gets a "not configured" answer. |
| `chat.cwd` | yes | Working directory of the `claude -p` chat. `--continue` resumes the latest conversation of this directory, so changing it starts a new one. |
| `chat.systemPrompt` | no | The conversation's system prompt: a Markdown file of the home, passed explicitly with `--system-prompt-file`, which replaces the CLI's default prompt (as a role file does for an agent, but whole). This is the lever on the assistant's behaviour, written for any engine. The CLI still reads the `CLAUDE.md` files of `chat.cwd` and of its parent directories as project memory, so keep them short, or say in the prompt that they do not apply. Without it, the CLI's default prompt and the `CLAUDE.md` of `chat.cwd` are what shape the chat, as before. |
| `chat.model` | no | `opus`, `sonnet` (default) or `haiku`. |
| `chat.addDirs` | no | Directories the chat may read and write (`--add-dir`). Default: none. |
| `chat.allowedTools` | no | Whitelist (`--allowedTools`). Only the built-in tools it names exist for the chat (`--tools`). Default: none, so the chat can only talk. May name MCP tools of `chat.mcpServers`: `mcp__<server>__*` or an exact `mcp__<server>__<tool>`. |
| `chat.mcpServers` | no | Extra MCP servers for the chat, same shape and same `${NAME}` placeholders as `agents[].mcpServers` of `room.json` (see "Environment placeholders" above). Each turn writes a `--mcp-config` file with them (deleted when the turn ends), still with `--strict-mcp-config`. The name `hq` is refused: the chat is not an agent and has no HQ tools. A server may add `"untrusted": false` (MyHQ's own flag, never written to the MCP config): every server is untrusted by default (see "Chat actions"). Default: none. |
| `chat.requests` | no | `{ "dir": "<path relative to the home>", "actions"?: [...] }`: where the chat leaves requests for the agents and actions for the core (below). `actions` is the whitelist of chat actions (`approve`, `reject`, `revise`, `run`, `arm`, `disarm`, `propose_agent`); default none. The chat needs write access to that directory (`chat.cwd` or `chat.addDirs`). |
| `chat.untrustedTools` | no | More tools whose results count as untrusted for chat actions, by exact name or with a final `*` (`mcp__mail__*`). The web tools and the tools of untrusted servers always count. Default: none. |
| `chat.permissionMode` | no | `default` (default), `acceptEdits`, `plan`, `dontAsk` or `auto`. `bypassPermissions` is refused. |
| `chat.timeoutMinutes` | no | A turn still going after this is killed. Default: 10. |
| `chat.afterReply` | no | Shell command run in `chat.cwd` after each reply. Its output goes to the log, never to Telegram. |
| `chat.historyTurns` | no | Exchanges of the conversation MyHQ gives back to the chat at the start of a turn (below). Default: 12; 0 gives none. |
| `chat.historyMaxChars` | no | Characters of that transcript at most, its marks included (200 to 100,000). Default: 8,000. |
| `chat.resume` | no | `cli` (default): resume the CLI's conversation with `--continue`, an optimization while the engine is Claude. `history`: never `--continue`, every turn is fresh and gets MyHQ's transcript (what any other engine would do). |
| `chat.preamble` | no | The facts of the moment given before each message (below): `{ "fields"?, "command"?, "file"?, "maxChars"?, "timeoutSeconds"? }`. Without it, no preamble. |
| `transcribe` | no | Shell command that turns a voice note into text: `{file}` is replaced by the quoted path of the audio file (do not quote it yourself), and the command prints the text on stdout. Without it, voice notes get a "not configured" answer. |
| `dropDir` | no | Folder where photos and documents sent to the bot are saved, with a free name (never overwritten) and, when the message has a caption, a companion `.md` note. Without it, files get a "not configured" answer. |
| `extensions` | no | Extension modules, asked in this order (below). |

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
reason `chat` or the given one), then deletes the file. A busy agent or the cap
leave the task waiting for the agent's next run. A file that is not valid JSON,
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
```

- Only the actions listed in `chat.requests.actions` are taken; an action
  outside it, or a file that does not match (an unknown action, `reject` or
  `revise` without a `note`, a decision without `id`, which `approvalId` may
  replace, a `run`, `arm` or `disarm` without `agent`, a `propose_agent`
  without `need`), is moved to
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
  receptionist or the cap leave the need waiting for its next run). The
  core appends one French line per action to the chat's reply (« Item #14 :
  Approuvé. », « Tour #7 lancé pour demo / watch. », or the refusal). The
  chat's own text never decides anything.
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
  "reception": { "room": "assistant" },
  "floor": { "layout": "room-per-project" },
  "scheduler": true,
  "timeZone": "Europe/Paris",
  "maxRunsPerDay": 12,
  "catalog": { "dirs": ["../notes/projects"] },
  "onboarding": { "sprite": "sprites/reception.png" },
  "notifyTypes": ["brief", "mail_alert"],
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
| `reception.room` | no | The floor (`/room`) that draws the reception desk and the receptionist, the onboarding agent (see `architecture.md`, section 7). Only that floor has the counter in its lobby, the receptionist's chip in the strip under the floor and its sheet (with the « Ajouter une salle » form and the recent onboarding runs); the others keep a plain lobby. Default: the room called `assistant` when the home has one, otherwise the first room. A name that is not a room of the home falls back to the default. |
| `floor.layout` | no | How `/room` draws the home (see `architecture.md`, section 7). `"floor-per-project"` (the default): a floor per room of the home, chosen with the buttons at the top, each a template of offices, a lobby with your desk and the tray, a meeting room and a kitchen. `"room-per-project"`: one floor for the whole home, where each room is a suite of its own (its walls, its workstations sized from its number of agents, a coffee nook for a big team, your own empty desk with a pile of what that room waits for: a click opens « À signer » filtered to the room), around corridors that start at the lobby, the entrance at the front (a main corridor, a spine, ribs branching off it), a garden between the rooms; the floor pans, the overview fits it whole and the buttons at the top centre the view on a room. Read apart from the rest of the file: a missing or invalid `floor` (an unknown layout) falls back to the default, with the reason in the log, and leaves every other setting as it is. |
| `catalog.dirs` | no | Extra read-only folders of the technology catalogue the receptionist bases an agent proposal on (`architecture.md`, "Proposing a missing agent"), relative to the home or absolute, 20 at most. Besides the target repositories of the rooms, which are always in it, each folder is summarized in the run prompt (its own `package.json`, `pyproject.toml` and README, then each top-level Markdown note with its YAML frontmatter, for example notes whose `stack:` lists the technologies you use) and given to the run as `--add-dir`, read-only. A folder that does not exist is named as missing. Read apart from the rest of the file: an invalid `catalog` gives no extra folder, with the reason in the log, and leaves every other setting as it is. Default: none. |
| `scheduler` | no | `true` or `false`: whether the routines of `room.json` start runs on their own. When the key is set it wins over `HQ_SCHEDULER`; without it the variable applies (default off). See "Settings that also exist as environment variables" below. |
| `timeZone` | no | IANA time zone of the routines and of the daily export (`Europe/Paris`). Wins over `HQ_TIMEZONE`; without it the variable applies, then the time zone of the machine. |
| `maxRunsPerDay` | no | Daily cap of runs, all agents together (an integer, 0 or more; 0 stops every run). Wins over `HQ_MAX_RUNS_PER_DAY`; without it the variable applies (default 12). |
| `onboarding.sprite` | no | Old top-down sheet of the receptionist, a path relative to the home (same contract as `agents[].sprite`). Still accepted and served, but **no longer drawn**: the isometric floor always draws the receptionist shipped with MyHQ, `public/sprites/iso-receptionist.png` (headset). |
| `notifyTypes` | no | Informational approval types (snake_case). An item of one of them is stored `unseen` the moment the agent submits it: it is sent to Telegram in full (an alert line, then its body as is, cut in messages of 4000 characters) with a single « Vu » button, and it stays on the desk in the « À regarder » section until the user marks it seen (« Vu », or « Demander à Rom2 » which sends it to the assistant first); it is then `seen` and stays in the history. It is not in the pending list nor in the `À valider` count of the tab title (counted apart), not in `/pending` nor in `hq_pending`, and it never triggers `onApproval` nor wakes an agent. `hq_submit` answers `"status": "unseen"`. Every other type (`mail_reply`, `room_proposal`...) keeps the pending flow with buttons. Default: none. |

| `desk` | no | The objects of the desk and where their data comes from (below). Default: a pile, a tray, a newspaper and a phone. |

The file is read when the export is checked (every ten minutes) and at each
`hq_submit`, so a change needs no restart. An invalid file is reported in the
log (and every item keeps the pending flow).

### Settings that also exist as environment variables

Three settings that are not secrets can live in `myhq.json` as well as in
`.env.local`: `scheduler` (`HQ_SCHEDULER`), `timeZone` (`HQ_TIMEZONE`) and
`maxRunsPerDay` (`HQ_MAX_RUNS_PER_DAY`). The order is always the same:

1. the key of `myhq.json`, when it is set and valid;
2. the environment variable, when it is set;
3. the default (scheduler off, time zone of the machine, 12 runs a day).

Each of these keys is parsed apart from the others and from the rest of the
file: an invalid value (a time zone that does not exist, `"scheduler": "yes"`, a
negative cap) is logged once and ignored, so the variable applies for that key
only, and every other key of the file keeps working. A `myhq.json` that is not a
JSON object is ignored as a whole for these three keys.

They are read again when they are needed, so a change needs **no restart**: a
run checks the cap when it starts, the scheduler is started or stopped at its
next tick (every 15 seconds, or at once when the change comes from the settings
page), the daily export and the Telegram assistant use the new time zone and cap
the next time they look. Secrets and tokens (`HQ_TELEGRAM_BOT_TOKEN`,
`HQ_CLAUDE_OAUTH_TOKEN`, `HQ_TRIGGER_TOKEN`) and every other `HQ_*` variable stay
in `.env.local`, and changing those needs a restart.

### The settings page (`/reglages`)

`/reglages`, linked from the header of the desk, edits the home in four groups,
each with its own « Enregistrer » button and its own confirmation or error:

| Group | What it writes |
|---|---|
| Disposition et langue | `floor.layout`, `language` (French or English, plus the current tag when it is another one) and `timeZone` of `myhq.json`. An empty time zone removes the key (the variable applies again). |
| Planificateur et plafonds | `scheduler` and `maxRunsPerDay` of `myhq.json`. « Selon l'environnement » or an empty cap removes the key. The scheduler starts or stops at once. |
| Notifications | `notifyTypes` of `myhq.json` (the types seen in the database and in the « What you submit » lists of the roles, plus any type typed in) and `notifyRuns: "summary"` of each agent in its `room.json`. |
| Salles et agents | `color` of each `room.json`, then `model` and `maxBudgetUsd` of each agent. The armed state of the routines goes through the existing mechanism (the database wins over `armed` of `room.json`, see `api.md`). |

The files stay the source of truth, so editing them by hand keeps working. Every
write is checked with zod first (the whole group, then each file of the group,
before anything is written), goes through a temporary file in the same folder
and a rename, keeps the keys it does not know (and their order) and writes
2-space JSON with a final newline. A `myhq.json` that cannot be read back is
never overwritten: the save fails with `SETTINGS_FILE_INVALID` and the file is
left for you to fix. A file that already holds the values sent is not rewritten.
Comments cannot exist in JSON, so none is lost; the one cosmetic change is that
short arrays are written one item per line.

Secrets are neither shown nor editable on the page, which only says that they
live in `.env.local`.

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
| `summaries` | Summaries of the day. | The 20 last run summaries (runs ended `done`) of the agents with `notifyRuns: "summary"`, the briefs and recaps they send, newest first. |
| `chat` | Replies and messages of the bot since the user last wrote. | The 10 last messages of the conversation. |

A list (`["watch:brief", "summaries"]`) adds up the counts and merges the
items, newest first. Without a `desk` block the desk is: `signer` (pile,
`approvals`), `courrier` (tray, `watch:mail_alert`), `journal` (newspaper,
`["watch:brief", "summaries"]`) and `telephone` (phone, `chat`); post-its and a
calendar exist only when configured, since only a home knows where they live.
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

