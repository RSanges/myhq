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
      "sprite": "rooms/example/sprites/scout.png"
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
| `agents[].sprite` | no | Character sheet of the room view (`/room`): a `.png` or `.webp` file, relative to the home, inside it (see "Character sheets" below). Without it, or when the file is missing, the neutral character shipped with MyHQ is drawn, tinted per agent. |
| `agents[].onApproval` | no | `"task"`: when an item this agent submitted is approved, MyHQ gives it the task « Exécute l'item approuvé n° <id> : <title> » and starts a run at once (reason `approval`). `"queue"`: the task is created but the agent is not woken, it finds it at its next run. The agent acts on the item with its own tools (for example an MCP server of the home that sends a mail once it finds the item approved); MyHQ itself never does. Default: nothing happens on approval (no task: an approved item is usually the user's to post). |
| `agents[].onMessage` | no | `"run"` (the default): an `hq_message` addressed to this agent starts a run at once (reason `message`) when its lock is free and the daily cap allows, otherwise as soon as its current run ends. `"queue"`: the message waits for the agent's next run, for an agent meant to batch its work. |
| `agents[].onRevise` | no | `"run"` (the default): a revise decision on one of its items (from the desk, including a revision asked after the item was approved or rejected, or from Telegram) starts a run at once (reason `revise`) under the same conditions. `"queue"`: the revision waits for the agent's next run. |
| `agents[].notifyRuns` | no | `"summary"`: when a run of this agent ends `done`, its summary (the agent's final text, at most about 4000 characters) is sent to Telegram as plain text. This is how a brief or a recap agent delivers its text. Default: nothing is sent for a run that ends well. |

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

#### Character sheets

The room view draws each agent as a small character. MyHQ ships one neutral
silhouette (`public/sprites/neutral.png`, tinted per agent from a fixed
palette); a home can give an agent its own with `sprite`. The sheet is served
by `GET /api/sprites/<room>/<agent>`, from the path in the validated
`room.json` only.

- A transparent PNG (or WebP) of **4 columns by 4 rows of square cells**. The
  cell size is the width divided by 4, for example 128 px cells (512 by 512
  image) displayed at 64 px, which stays sharp on dense screens. The height
  must equal the width.
- Rows, top to bottom: **sit and type** (2 frames), **walk** (4 frames),
  **think** (2 frames), **sleep** (2 frames). Unused cells stay empty.
- The character **faces right** (walking left is drawn by mirroring). The feet
  are at the **horizontal center of the bottom of the cell**; a seated
  character is drawn as if the desk hid its legs.
- Row 1, first frame, doubles as the standing pose (talking to a colleague,
  dropping a folder).
- A custom sheet is drawn as is. Only the neutral sheet is tinted.
- The file must stay under 2 MiB. Textures are drawn without smoothing.

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
| `chat.requests` | no | `{ "dir": "<path relative to the home>", "actions"?: [...] }`: where the chat leaves requests for the agents and actions for the core (below). `actions` is the whitelist of chat actions (`approve`, `reject`, `revise`, `run`, `arm`, `disarm`); default none. The chat needs write access to that directory (`chat.cwd` or `chat.addDirs`). |
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
```

- Only the actions listed in `chat.requests.actions` are taken; an action
  outside it, or a file that does not match (an unknown action, `reject` or
  `revise` without a `note`, a decision without `id`, which `approvalId` may
  replace, a `run`, `arm` or `disarm` without `agent`), is moved to
  `<dir>/rejected/`, logged, and a line of the reply says so.
- `room` may be left out when exactly one room has an agent of that id.
- After a reply that succeeds, the action files are taken in name order (before
  the requests to the agents) and executed with the code of the buttons and of
  the commands: `decideApproval` for `approve`, `reject` and `revise` (an item
  already decided or unknown is refused with the usual error, an approved item
  is handed over like an Approuver button does), `startRun` for `run` (agent
  lock, daily cap, reason `chat`), the armed state for `arm` and `disarm`. The
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
without a section, the feature is off. Other keys are ignored.

```json
{
  "language": "fr",
  "export": { "dir": "../notes/agents-journal", "hour": 6 },
  "notifyTypes": ["brief", "mail_alert"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `language` | no | Language of the texts the agents write for this home, as a BCP 47 tag (`fr`, `en`, `pt-BR`). Default: `en`. The onboarding run tells its agent to write the proposal, the role prompts and the "HQ agents" block in it (the English templates stay the structural source, the agent translates them), and, for a French home, to title the proposal « Proposition de salle : <name> ». Roles you write by hand are yours to write in any language. |
| `export.dir` | yes (with `export`) | Folder of the daily export, relative to the home or absolute. One file per day, `<YYYY-MM-DD>.json`: the runs, messages and approvals of that day (see `architecture.md`, section 6). |
| `export.hour` | no | Local hour (`HQ_TIMEZONE`, 0 to 23) from which the previous day is written. Default: 1. |
| `notifyTypes` | no | Informational approval types (snake_case). An item of one of them is stored already `approved`, with the note « notification », the moment the agent submits it: it is sent to Telegram in full (an alert line, then its body as is, cut in messages of 4000 characters) with no buttons, it shows on the desk in the history only (not in the pending list nor in the count of the tab title, not in `/pending` nor in `hq_pending`), and it never triggers `onApproval`. `hq_submit` answers `"status": "approved"`. Every other type (`mail_reply`, `room_proposal`...) keeps the pending flow with buttons. Default: none. |

The file is read when the export is checked (every ten minutes) and at each
`hq_submit`, so a change needs no restart. An invalid file is reported in the
log (and every item keeps the pending flow).

