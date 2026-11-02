# Architecture

MyHQ is a local app: a Next.js server, a SQLite file, a small MCP server, and
`claude -p` processes started on demand. This document describes how a run
works, what the app stores, and how the work is split into delivery slices.

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

The process starts in the agent's own working directory and receives the run
context through environment variables. The Claude Code binary is not modified
and runs on the user's own plan, which is the frame the subscription terms
allow. There is no Agent SDK.

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
room) and writes directly to SQLite. Six tools, all validated with zod:

| Tool | Purpose |
|---|---|
| `hq_message(to, text)` | Send a message to another agent. |
| `hq_submit(type, title, body, payload)` | Submit an item to the approval queue. |
| `hq_task_update(status, note)` | Report the state of the current task. |
| `hq_read_decisions()` | Read the user's decisions not yet seen by this agent. |
| `hq_memory_read(key)` | Read a value of the agent's role memory. |
| `hq_memory_write(key, value)` | Write a value of the agent's role memory. |

Everything an agent wants to show or have approved goes through this server,
so everything is logged.

### Routines

An internal cron (one schedule per agent, from `room.json`) starts runs at set
times, and a button starts one by hand. Two guards are checked before any
launch: one run at a time per agent (lock), and a daily cap on the total number
of runs, to stay within the limits of the plan (`HQ_MAX_RUNS_PER_DAY`, with a
conservative default). Start with a few scheduled agents and raise the cap
after a week of measurements.

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

### Messages between agents

A message addressed to an agent creates a task for it, handled at its next run
(or immediately if the sender asks for it and the lock is free). There is no
real-time dialogue between models: mailboxes, readable and cheap.

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
  `rooms`, `agents`, `runs`, `events`, `messages`, `tasks`, `approvals`,
  `memories`. Each run stores `input_tokens`, `output_tokens`, `cost_usd`,
  `started_at`, `ended_at`, `status` (`running`, `done`, `failed`,
  `cancelled`) and a `summary`.
- **Real time**: Server-Sent Events from the app to the browser.
- **The room view** (slice 2): a 2D canvas (PixiJS) with sprite sheets and a
  few animations per character (typing, walking, thinking, sleeping), driven by
  the real events of the stream-json output.
- **Rooms and roles**: `room.json` and `roles/*.md` in the home directory,
  loaded and validated at startup (see `home-layout.md`).
- **The assistant on Telegram**: the Bot API through `fetch`, with the token and
  chat id in `.env.local`. It sends a message when an item waits for approval or
  a run fails, and (slice 4) reads the user's messages, shows Approve and Reject
  buttons on items, answers in natural language, and loads extra commands from
  the home's `assistant/commands/` directory. Only one reader of the bot may
  run at a time: until a previous bot is switched off, MyHQ only sends. Without
  a token, nothing is sent and nothing crashes. A system toast is an option,
  never a requirement.
- **Portability**: relative paths, SQLite, no dependency on one OS apart from
  optional notifications.

## 3. Delivery slices

1. **The core.** The app, the database, the HQ MCP server, one agent running
   headless, the live event feed, and the approval queue with approve, reject
   and revise. Acceptance: a real run of the first agent submits an item, the
   user approves it, and the item moves to `approved` with the information
   needed to act on it. The run shows tokens and cost.
2. **The animated room.** The canvas, characters animated by the stream-json
   events, the team feed (messages between agents) and a whiteboard with the
   state of the routines and the user's key numbers. Acceptance: one can see an
   agent typing during its run, then walking to the user's desk to drop off a
   submission.
3. **The full team.** Any number of agents per room, cron, integrations through
   MCP servers, the per-agent lock and the daily cap, and an optional daily
   export of the agents' journal to a folder of the user's choice. Acceptance:
   three scheduled agents run for a week with no intervention other than
   approvals.
4. **The assistant on Telegram.** Notifications, approval from the phone,
   conversation in natural language, and commands loaded from the home
   directory. Acceptance: from the phone, the user gets an answer, runs a
   command defined in their home, and approves an item.
