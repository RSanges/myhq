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

Cron expressions accept `*`, numbers, ranges (`1-5`), steps (`*/15`,
`8-18/2`), lists (`1,15`) and names (`mon`, `jan`); 0 and 7 are Sunday. When
both the day of month and the day of week are restricted, a day matches if
either does (classic cron). A minute skipped by a daylight saving change does
not fire.

MyHQ validates the file with zod at startup and refuses to start a room whose
file is invalid, with an explicit error.

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
    "model": "sonnet",
    "addDirs": ["../notes"],
    "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
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
| `chat.cwd` | yes | Working directory of the `claude -p` chat. Its `CLAUDE.md` is the lever on the assistant's behaviour, and `--continue` resumes the latest conversation of this directory. |
| `chat.model` | no | `opus`, `sonnet` (default) or `haiku`. |
| `chat.addDirs` | no | Directories the chat may read and write (`--add-dir`). Default: none. |
| `chat.allowedTools` | no | Whitelist (`--allowedTools`). Only the built-in tools it names exist for the chat (`--tools`). Default: none, so the chat can only talk. No MCP server is loaded. |
| `chat.permissionMode` | no | `default` (default), `acceptEdits`, `plan`, `dontAsk` or `auto`. `bypassPermissions` is refused. |
| `chat.timeoutMinutes` | no | A turn still going after this is killed. Default: 10. |
| `chat.afterReply` | no | Shell command run in `chat.cwd` after each reply. Its output goes to the log, never to Telegram. |
| `transcribe` | no | Shell command that turns a voice note into text: `{file}` is replaced by the quoted path of the audio file (do not quote it yourself), and the command prints the text on stdout. Without it, voice notes get a "not configured" answer. |
| `dropDir` | no | Folder where photos and documents sent to the bot are saved, with a free name (never overwritten) and, when the message has a caption, a companion `.md` note. Without it, files get a "not configured" answer. |
| `extensions` | no | Extension modules, asked in this order (below). |

The shell commands (`transcribe`, `afterReply`) run through the system shell
(`cmd.exe` on Windows, `sh` elsewhere) with the app's environment minus the
`HQ_TELEGRAM_*` variables and `HQ_CLAUDE_OAUTH_TOKEN`. Each chat turn runs with
the same isolation as an agent run: the app's variables removed,
`--setting-sources project,local`, `--strict-mcp-config`, tool search off,
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
  "export": { "dir": "../notes/agents-journal", "hour": 6 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `export.dir` | yes | Folder of the daily export, relative to the home or absolute. One file per day, `<YYYY-MM-DD>.json`: the runs, messages and approvals of that day (see `architecture.md`, section 6). |
| `export.hour` | no | Local hour (`HQ_TIMEZONE`, 0 to 23) from which the previous day is written. Default: 1. |

The file is read when the export is checked (every ten minutes), so a change
needs no restart. An invalid file is reported in the log.

