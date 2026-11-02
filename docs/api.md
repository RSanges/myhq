# HTTP API

The app listens on `http://127.0.0.1:4242` (localhost only). Every route
returns JSON except `GET /api/events`, which is a Server-Sent Events stream.
Inputs are validated with zod; unknown fields in a body are refused.

## Errors

Every error has the same shape and an HTTP status:

```json
{ "error": { "code": "AGENT_BUSY", "message": "Agent \"scout\" of room \"demo\" already has a run in progress (#12)." } }
```

| Code | Status | When |
|---|---|---|
| `INVALID_JSON` | 400 | The body is not JSON. |
| `INVALID_INPUT` | 400 | A field is missing or invalid. The message lists each problem as `path: message`. |
| `ROOM_NOT_FOUND` | 404 | No `rooms/<room>/` in the home. |
| `AGENT_NOT_FOUND` | 404 | The room has no such agent. |
| `APPROVAL_NOT_FOUND` | 404 | No approval with this id. |
| `ROOM_INVALID` | 422 | The room's `room.json` failed validation. The message carries the validation error. |
| `AGENT_BUSY` | 409 | The agent already has a run in progress (one run at a time per agent). |
| `APPROVAL_ALREADY_DECIDED` | 409 | The approval is no longer `pending`. |
| `DAILY_CAP_REACHED` | 429 | `HQ_MAX_RUNS_PER_DAY` runs were already started today (local day, all agents). |
| `ROADMAP_NOT_FOUND` | 404 | `docs/roadmap.json` is missing from the home, or fails validation. The message says which. |
| `INTERNAL` | 500 | Unexpected error. |

The `message` is in English and meant for logs; the interface shows its own
French text per `code`.

## Status values

| Entity | Values |
|---|---|
| Run `status` | `running`, `done`, `failed`, `cancelled` |
| Approval `status` | `pending`, `approved`, `rejected`, `revise` |
| Event `type` | `start`, `text`, `tool_call`, `tool_result`, `end` |
| Agent `state` (in `/api/state`) | `working` (a run is in progress), `failed` (its last run failed), `idle` |

A run is `cancelled` when the app stops during the run, and `failed` when the
engine reports an error, the budget (`--max-budget-usd`) is exceeded, the run
times out (`HQ_RUN_TIMEOUT_MINUTES`) or the app crashed during it.

All timestamps are ISO 8601 strings in UTC (`2026-11-02T16:18:11.256Z`). Ids
are integers.

## Shapes

### Run

```json
{
  "id": 3,
  "room": "demo",
  "agentId": "scout",
  "engine": "claude",
  "task": "Do the routine work described in your role.",
  "status": "done",
  "inputTokens": 20,
  "outputTokens": 812,
  "cacheCreationInputTokens": 15890,
  "cacheReadInputTokens": 61234,
  "costUsd": 0.0841,
  "startedAt": "2026-11-02T16:18:11.256Z",
  "endedAt": "2026-11-02T16:19:40.002Z",
  "summary": "Three replies submitted."
}
```

`summary` is the final text of the agent (or the error), at most about 4000
characters. `inputTokens` excludes the cache: the total input of a run is
`inputTokens + cacheCreationInputTokens + cacheReadInputTokens`. `costUsd` is
the `total_cost_usd` reported by Claude Code (an estimate on a subscription).
Tokens and cost are written when the run ends; they are 0 while it runs.

### Event

```json
{ "id": 9, "runId": 3, "room": "demo", "agentId": "scout", "type": "tool_call", "data": { }, "createdAt": "..." }
```

`data` depends on `type`:

| `type` | `data` |
|---|---|
| `start` | `{ "sessionId": string \| null, "model": string \| null, "tools": string[], "mcpServers": [{ "name": string, "status": string }] }` |
| `text` | `{ "text": string }` (truncated to about 4000 characters) |
| `tool_call` | `{ "id": string, "name": string, "input": object }` (name like `WebSearch` or `mcp__hq__hq_submit`) |
| `tool_result` | `{ "toolUseId": string, "isError": boolean, "content": string }` (truncated to about 2000 characters; `toolUseId` matches a `tool_call` `id`) |
| `end` | `{ "status": "done" \| "failed", "reason": string, "summary": string, "usage": { "inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens" }, "costUsd": number }` |

`reason` is the engine's own detail (for Claude Code: the `subtype` of its
result message, such as `success` or `error_max_budget_usd`, or `spawn_error`,
`no_result`, `aborted`, `engine_error`). Use the run's `status`, not
`reason`, to decide what to show. The complete raw output of each run is kept
in `<home>/data/runs/<runId>.jsonl`.

### Message

```json
{ "id": 4, "room": "demo", "from": "scout", "to": "writer", "text": "...", "runId": 3, "createdAt": "..." }
```

Messages are written by agents with `hq_message`. Each one also becomes a task
for the recipient, handed over at its next run.

### Approval

```json
{
  "id": 1,
  "room": "demo",
  "agentId": "scout",
  "runId": 3,
  "type": "community_reply",
  "title": "Reply to a thread about group trips",
  "body": "Markdown text to approve.",
  "payload": { "url": "https://example.com/thread/1", "forum": "example", "src": "example-1" },
  "status": "pending",
  "decisionNote": null,
  "decidedAt": null,
  "createdAt": "2026-11-02T16:18:11.483Z"
}
```

`type`, `body` (Markdown) and `payload` come from the agent's `hq_submit`. The
payload is free-form per type; it holds what is needed to act on the item once
approved (for example the thread URL). `decisionNote` is the user's reason or
comment.

## Routes

### `GET /api/state`

Snapshot for the interface. Load it first, then follow `GET /api/events` from
`cursor`. It re-reads the home, so a room edited by hand shows up without a
restart.

```json
{
  "cursor": 42,
  "rooms": [
    {
      "name": "demo",
      "targetRepo": "../demo-project",
      "agents": [
        {
          "id": "scout",
          "name": "Scout",
          "model": "sonnet",
          "role": "rooms/demo/roles/scout.md",
          "allowedTools": ["WebSearch", "WebFetch", "mcp__hq__*"],
          "cron": null,
          "state": "idle",
          "lastRun": null
        }
      ]
    }
  ],
  "invalidRooms": [{ "room": "broken", "error": "..." }],
  "approvals": { "pending": [], "history": [] },
  "recent": { "events": [], "messages": [] },
  "assistant": { "polling": false }
}
```

- `role` and `targetRepo` are relative to the home.
- `lastRun` is a Run or `null`.
- `approvals.pending`: every pending item, oldest first. `approvals.history`:
  the 100 most recently decided items, newest first.
- `recent.events` (last 200) and `recent.messages` (last 100), oldest first.
- `assistant.polling`: true while this process reads the Telegram bot's updates
  (`HQ_TELEGRAM_POLLING=true`, lock taken, polling loop running).

### `POST /api/runs`

Starts a run of one agent and returns at once; the run continues in the
background.

Body:

```json
{ "room": "demo", "agent": "scout", "task": "Optional instruction for this run." }
```

`task` is optional (at most 20000 characters). Without it, the agent gets
"Do the routine work described in your role." Pending tasks of the agent
(messages from other agents, revisions asked by the user) are appended to the
prompt.

Response `202`:

```json
{ "run": { "id": 3, "status": "running", "...": "Run shape" } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT`, `ROOM_NOT_FOUND`, `ROOM_INVALID`,
`AGENT_NOT_FOUND`, `AGENT_BUSY` (409), `DAILY_CAP_REACHED` (429). The lock
and the cap are checked before anything is started.

### `GET /api/events`

Server-Sent Events stream (`Content-Type: text/event-stream`). The server polls
the database every second, so changes made by the HQ MCP server (another
process) are streamed too. A comment line `: keepalive` is sent every 15
seconds.

Where to start:

- `?since=<cursor>` (the `cursor` of `/api/state`, or the last `id` received),
- or the `Last-Event-ID` header (sent automatically by `EventSource` when it
  reconnects),
- or neither: only changes made after the connection.

`since` must be a non-negative integer (`INVALID_INPUT` otherwise).

The first message is always:

```
retry: 3000
event: ready
data: {"cursor":42}
```

Then one message per change:

```
id: 43
event: run
data: {Run}
```

| `event` | `data` | Sent when |
|---|---|---|
| `run` | Run | a run starts, and when its status changes (end) |
| `event` | Event | the runner stores an event of a run |
| `message` | Message | an agent sends a message |
| `approval` | Approval | an agent submits an item, and when the item is decided |
| `roadmap` | `{ "at": string }` | `docs/roadmap.json` of the home was created, edited, replaced or removed (see `GET /api/roadmap`) |

`data` is the entity as it is when the message is sent, so an older change may
already carry a later state (for example an approval created then approved
within the same second arrives twice as `approved`). Treat every message as
"upsert this entity by id". The `id` of a message is the stream cursor, not
the entity id.

The `roadmap` message is not a stored change: it carries no `id` (the cursor does
not move, and it is never replayed on reconnect), and it only goes to the
connections open when the file changes. `at` is the time the server noticed
(ISO 8601, UTC). Consumers should simply fetch `GET /api/roadmap` again; an
older client that does not listen to `roadmap` is not affected.

Browser usage:

```js
const source = new EventSource(`/api/events?since=${state.cursor}`);
source.addEventListener("approval", (e) => upsertApproval(JSON.parse(e.data)));
```

### `GET /api/roadmap`

The roadmap of the home: `<home>/docs/roadmap.json`, validated (the path is a
constant for now). Unknown extra fields are dropped, and text fields left out
are returned as empty strings.

```json
{
  "updatedAt": "2026-11-02T18:46:00+01:00",
  "slices": [
    { "id": 1, "name": "Slice", "status": "en cours", "progress": 60, "criterion": "What proves it", "proved": "", "note": "" }
  ],
  "items": [
    { "slice": 1, "name": "Item", "status": "fait", "owner": "Someone", "date": "2026-11-02", "note": "" }
  ],
  "openPoints": [{ "name": "Question", "status": "ouvert", "note": "" }],
  "events": [{ "at": "2026-11-02T14:27", "text": "What happened" }]
}
```

- `status` of a slice or an item: `fait`, `en cours`, `à faire` or `bloqué`.
- `status` of an open point: `ouvert` or `tranché`.
- `slices[].progress` is a percentage (0 to 100); `items[].slice` is the `id`
  of a slice; `proved` and `items[].date` are dates (`YYYY-MM-DD`) or empty;
  `events[].at` is a local date and time (`2026-11-02T14:27`), not
  necessarily ordered (the interface shows the newest first).

Errors: `ROADMAP_NOT_FOUND` (404) when the file is missing, is not JSON or
fails validation (the reason is also logged by the server). The file is watched,
and every change is announced as a `roadmap` event on `GET /api/events`.

### `PATCH /api/approvals/[id]`

Decides a pending approval.

Body:

```json
{ "decision": "approved" }
{ "decision": "rejected", "note": "Too promotional." }
{ "decision": "revise", "note": "Shorter, and answer the budget question first." }
```

`note` is optional for `approved` and required (non-blank, at most 5000
characters) for `rejected` and `revise`. `revise` sends the item back to its
agent as a new task carrying the note; the agent sees it at its next run, and
reads every decision through `hq_read_decisions`.

Response `200`:

```json
{ "approval": { "id": 1, "status": "approved", "decidedAt": "...", "...": "Approval shape" } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT` (also for an id that is not a positive
integer), `APPROVAL_NOT_FOUND` (404), `APPROVAL_ALREADY_DECIDED` (409).

Approving records the decision and keeps the payload; acting on an approved
item (publishing, merging) is not done by the app in this slice.

### `GET /api/usage`

Tokens and cost of the runs, by local calendar day of the server, and the
daily cap.

```json
{
  "today": { "date": "2026-11-02", "runs": 3, "inputTokens": 40, "outputTokens": 1600, "cacheCreationInputTokens": 31000, "cacheReadInputTokens": 120000, "costUsd": 0.17 },
  "week": { "start": "2026-11-02", "runs": 3, "...": "same totals" },
  "days": [{ "date": "2026-10-27", "runs": 0, "...": "same totals" }],
  "cap": { "maxRunsPerDay": 12, "runsToday": 3, "remaining": 9 }
}
```

- `days`: the last 7 days, oldest first, today last, days without runs at 0.
- `week`: from Monday of the current week to today.
- Every run started counts towards the cap, whatever its status.

## Not in the API

The HQ MCP server is not reached over HTTP: `claude -p` starts it over stdio
for each run (see `architecture.md`). Its six tools write to the same
database, and their effects reach the interface through `/api/events`.
