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
  docs/roadmap.json      the live roadmap shown at /roadmap (optional, see api.md)
  assistant/
    commands/            extensions for the Telegram assistant
  data/                  created at first launch, ignored by Git
    hq.db                SQLite database
    work/<room>/<agent>/ default working directory of each agent
    runs/                raw output and MCP config of each run
    assistant/           offset.txt, bridge.lock, voice/ (temporary audio)
```

All paths written in `room.json` and `assistant.json` are relative to the home
directory (absolute paths are accepted in `assistant.json`).

`rooms/<room>/` is normally created by the onboarding agent when you approve
its room proposal, and can also be written by hand.

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
      "cron": "0 7 * * *",
      "maxBudgetUsd": 2
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
| `agents[].workingDirectory` | no | Defaults to `data/work/<room>/<agent>`. Must stay inside the home. |
| `agents[].cron` | no | Cron expression. Without it the agent only runs on demand. |
| `agents[].maxBudgetUsd` | no | Value passed to `--max-budget-usd` for each run. |

MyHQ validates the file with zod at startup and refuses to start a room whose
file is invalid, with an explicit error.

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
- Only the generated MCP config carries the expanded values. The agent's own
  process environment is unchanged: the `HQ_*` and `MYHQ_*` variables are still
  stripped from it. The config file is rewritten for each run, and the values
  are never logged.

## roles/*.md

Plain Markdown, passed as is to `--append-system-prompt-file`. It describes who
the agent is, what it does, what it may and may not do, and what it submits to
the approval queue through `hq_submit`. Roles are meant to be read and edited by
hand and versioned with the rest of the home.

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
