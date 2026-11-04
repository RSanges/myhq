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
| `UNAUTHORIZED` | 401 | `POST /api/runs` with a `reason` while `HQ_TRIGGER_TOKEN` is set, without `Authorization: Bearer <token>` or with another token. |
| `ROOM_NOT_FOUND` | 404 | No `rooms/<room>/` in the home. |
| `AGENT_NOT_FOUND` | 404 | The room has no such agent. |
| `APPROVAL_NOT_FOUND` | 404 | No approval with this id. |
| `ROOM_INVALID` | 422 | The room's `room.json` failed validation. The message carries the validation error. |
| `CHAT_NOT_CONFIGURED` | 404 | `POST /api/chat` (without `to`) while the home has no `chat` section in `assistant.json`. |
| `AGENT_BUSY` | 409 | The agent already has a run in progress (one run at a time per agent). |
| `RESOURCE_BUSY` | 409 | The agent holds a shared resource (`resources` in `room.json`, for example `gpu`) that a run of another agent holds now. The message names the resource and that run. |
| `APPROVAL_ALREADY_DECIDED` | 409 | The approval is no longer `pending`, and the decision is not a `revise` (an approved or rejected item can be sent back; an item already in `revise` only with a new note or new remarks). |
| `DAILY_CAP_REACHED` | 429 | `HQ_MAX_RUNS_PER_DAY` runs were already started today (local day, all agents). |
| `ROADMAP_NOT_FOUND` | 404 | `docs/roadmap.json` is missing from the home, or fails validation. The message says which. |
| `TARGET_NOT_FOUND` | 404 | The path given to onboarding is not a directory. |
| `ROOM_EXISTS` | 409 | Approving a room proposal whose room already exists in the home. Nothing is written; the item stays pending. |
| `PROPOSAL_INVALID` | 422 | Approving a room proposal that fails validation (payload, paths, target repository). Nothing is written; the item stays pending. |
| `WORKTREE_FAILED` | 422 | Approving a room proposal whose agent worktree cannot be created. Nothing is written; the item stays pending. |
| `SPRITE_NOT_FOUND` | 404 | `GET /api/sprites/<room>/<agent>` (or `?sheet=iso`) for an agent that declares no such sheet, or whose file is missing, too large, or not a PNG or WebP. |
| `EXPORT_NOT_CONFIGURED` | 404 | `POST /api/export` while the home has no `export.dir` in `myhq.json`. |
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
| Firing `outcome` | `started`, `skipped_busy` (agent lock, or a shared resource held by another run), `skipped_cap` (daily cap), `skipped_unarmed`, `error` |

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
  "summary": "Three replies submitted.",
  "reason": null
}
```

`summary` is the final text of the agent (or the error), at most about 4000
characters. `reason` says why the run was started: the `reason` given to
`POST /api/runs` (for example `mail`), `approval`, `message`, `revise` or `chat`
for a run MyHQ started to wake an agent (`onApproval`, `onMessage`,
`onRevise`, see `home-layout.md`),
`desk` for a task typed in the conversation panel and addressed to an agent
(`POST /api/chat` with `to`), `null` for a run started from the desk's button,
`/run` or a routine. `inputTokens` excludes the cache: the total input of a run is
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
| `start` | `{ "sessionId": string \| null, "model": string \| null, "tools": string[], "mcpServers": [{ "name": string, "status": string }], "reason"?: string }` (`reason`: the run's, when it has one) |
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
{ "id": 4, "room": "demo", "from": "scout", "to": "writer", "toRoom": null, "text": "...", "runId": 3, "createdAt": "..." }
```

Messages are written by agents with `hq_message`. Each one also becomes a task
for the recipient, handed over at its next run, which starts at once when the
recipient has not set `onMessage: "queue"` (a run with `reason` `message`).
`room` is the sender's room; `toRoom` is the recipient's when it is another one
(an order to a shared room, or a studio's answer to the agent that ordered,
see `architecture.md`, "Shared rooms"), `null` otherwise.

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
  "annotations": [],
  "decisionHistory": [],
  "actionDone": false,
  "informational": false,
  "forRoom": null,
  "decidedAt": null,
  "createdAt": "2026-11-02T16:18:11.483Z"
}
```

`type`, `body` (Markdown) and `payload` come from the agent's `hq_submit`. The
payload is free-form per type; it holds what is needed to act on the item once
approved (for example the thread URL). `decisionNote` is the user's reason or
general comment. `annotations` are the remarks on passages of the body that came
with a `revise` or `rejected` decision, in document order, each
`{ "quote": "...", "comment": "...", "position": 552 }` (`position` is optional:
the offset of the quote in the rendered text of the body, which tells apart two
passages that read the same); empty for every other item. They are part of the
history in `GET /api/state`.

`decisionHistory` lists the decisions the item had before its last one, oldest
first, each `{ "decision": "approved" | "rejected" | "revise", "note": string |
null, "annotations": [...], "decidedAt": string | null }`: empty until an
item is sent back for a revision after it was decided (see `PATCH
/api/approvals/[id]`). `actionDone` is `true` when the item's agent has
`onApproval: "task"` and the task that executes the approved item is done (the
action, for example a sent mail, already happened). `informational` is `true`
for an item of `notifyTypes`, which is not decided nor sent back. `status` is then
`unseen` (it waits under « À regarder ») or `seen` (it was marked, see `POST
/api/approvals/[id]/seen`); the items stored before these statuses existed are
`approved` with the note `notification`, still `informational`.

`forRoom` is the room that ordered the item from a shared room (`hq_submit`
with `forRoom`), `null` for an item of the agent's own room. Such an item
belongs to that room's pile: the desk shows it with that room's colour and as
« <room> pour <forRoom> » (« creation pour planygo »), the spines of
`GET /api/desk` take that colour, and a view that groups items by room uses
`forRoom ?? room`. `room` and `agentId` stay the producing agent's: its
decisions, a revise included, go back to that agent.

Payloads the interface and the assistant act on:

| `type` | `payload` | Once approved |
|---|---|---|
| any | `{ "url": "https://..." }` | The body and the link are handed to the user (copy, open). |
| `pull_request`, `blog_post` | `{ "branch": "hq/<agent>-<slug>", "sha": "...", "title": "...", "summary": "..." }` | The branch, the commit, and the `git push` and `gh pr create` commands are handed to the user. Nothing is pushed or merged. |
| `room_proposal` | `{ "room": {room.json}, "roles": { "<agent>": { "template": "...", "content": "..." } }, "claudeMd": "..." }` (completed by `hq_submit`, see `architecture.md` section 3) | The room is written in the home (otherwise the approval fails with `ROOM_EXISTS`, `PROPOSAL_INVALID` or `WORKTREE_FAILED`), then the `CLAUDE.md` block is handed to the user. |

### Firing

```json
{
  "id": 7,
  "room": "demo",
  "agentId": "scout",
  "cron": "0 7 * * 1-5",
  "task": null,
  "scheduledAt": "2026-11-03T06:00:00.000Z",
  "outcome": "started",
  "runId": 12,
  "detail": null,
  "createdAt": "2026-11-03T06:00:04.512Z"
}
```

One routine that came due. `task` is the routine's own task, `null` for the
routine work of the role. `runId` is set when `outcome` is `started`;
`detail` explains `skipped_busy`, `skipped_cap` and `error`.

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
      "color": null,
      "agents": [
        {
          "id": "scout",
          "name": "Scout",
          "model": "sonnet",
          "role": "rooms/demo/roles/scout.md",
          "allowedTools": ["WebSearch", "WebFetch", "mcp__hq__*"],
          "sprite": null,
          "isoSprite": "/api/sprites/demo/scout?sheet=iso",
          "isoStride": null,
          "armed": false,
          "routines": [{ "cron": "0 7 * * 1-5", "task": null, "nextAt": "2026-11-03T06:00:00.000Z" }],
          "state": "idle",
          "resources": [],
          "waitingFor": [],
          "lastRun": null
        }
      ]
    }
  ],
  "invalidRooms": [{ "room": "broken", "error": "..." }],
  "reception": { "room": "demo", "sprite": null, "runs": [] },
  "floor": { "layout": "floor-per-project" },
  "scheduler": { "enabled": false, "running": false, "timeZone": "Europe/Paris" },
  "firings": [],
  "approvals": { "pending": [], "unseen": [], "history": [] },
  "recent": { "events": [], "messages": [] },
  "assistant": { "polling": false }
}
```

- `role` and `targetRepo` are relative to the home.
- `color`: the room's hex colour from `room.json`, or `null` (a neutral room).
- `isoSprite`: `/api/sprites/<room>/<agent>?sheet=iso` when the agent declares
  an isometric character sheet (`isoSprite` in `room.json`) and the file
  exists, `null` otherwise (the floor then draws one of the neutral people
  shipped with the app).
- `isoStride`: voxels per walk frame of that sheet, read from `walk.voxelsPerFrame`
  of the `iso.json` next to it; `null` when there is no such file or value (the
  floor then walks at 3 voxels per frame).
- `sprite`: `/api/sprites/<room>/<agent>` when the agent declares an old
  top-down sheet (`sprite`) and the file exists, `null` otherwise. The floor
  no longer draws it.
- `lastRun` is a Run or `null`.
- `resources`: the shared resources the agent's runs hold (`resources` in
  `room.json`, for example `["gpu"]`), empty for most agents. `waitingFor`:
  those of them that a run of another agent holds while a task waits in this
  agent's mailbox (the agent sheet then says « En attente : gpu occupé »); empty
  otherwise, and always while the agent works. The interface drops an entry as
  soon as no working agent holds that resource any more.
- `reception`: the onboarding agent seen from the floors. `room` is the one
  floor that draws it as a receptionist (`reception.room` of `myhq.json` when
  that room exists, else the room `assistant`, else the first room, `null`
  when the home has no room); `sprite` is `/api/sprites/_hq/onboarding` when
  the home sets `onboarding.sprite` (an old top-down sheet, no longer drawn:
  the floor draws the shipped iso receptionist), `null` otherwise; `runs` are
  its latest eight runs (room `_hq`, agent `onboarding`, task « Propose a room
  for the repository <path>. »), newest first. The reserved room `_hq` is not
  in `rooms`; its runs, events and approvals still arrive on the stream like
  any other.
- `floor.layout`: how `/room` draws the home, `floor.layout` of `myhq.json`:
  `"floor-per-project"` (the default, also when the block is missing or
  invalid) or `"room-per-project"` (one floor for the whole home). An
  interface that does not know a value takes the default.
- `armed`: whether the agent's routines may start runs (the database value
  once changed, the `armed` of `room.json` until then). `routines`: one entry
  per cron of the agent, `task` `null` for the routine work of the role,
  `nextAt` its next fire in UTC (`null` for an expression that never fires).
- `scheduler.enabled`: `HQ_SCHEDULER=on`; `running`: this process runs the
  routines (another MyHQ process on the same home may hold them);
  `timeZone`: `HQ_TIMEZONE` or the machine's zone.
- `firings`: the 50 most recent routine firings (Firing shape), newest first.
- `approvals.pending`: every pending item, oldest first. `approvals.unseen`:
  every informational item not yet seen (« À regarder »), oldest first.
  `approvals.history`: the 100 most recently handled items (decided, or seen),
  newest first.
- `recent.events` (last 200) and `recent.messages` (last 100), oldest first.
- `assistant.polling`: true while this process reads the Telegram bot's updates
  (`HQ_TELEGRAM_POLLING=true`, lock taken, polling loop running).

### `POST /api/runs`

Starts a run of one agent and returns at once; the run continues in the
background.

Body:

```json
{ "room": "demo", "agent": "scout", "task": "Optional instruction for this run.", "reason": "mail" }
```

`task` is optional (at most 20000 characters). Without it, the agent gets
"Do the routine work described in your role." Pending tasks of the agent
(messages from other agents, revisions asked by the user, approved items to
execute) are appended to the prompt.

`reason` is optional: why the run is started, 1 to 40 lowercase letters or
underscores (`mail`, `rom2`). It is stored on the run (the `reason` of the Run
shape: API, live stream, daily export) and shown in the feed at the start of
the run. The desk sends none.

**Trigger token.** When `HQ_TRIGGER_TOKEN` is set (`.env.local`), a request
that carries a `reason` must send `Authorization: Bearer <HQ_TRIGGER_TOKEN>`,
compared in constant time; otherwise the answer is `401 UNAUTHORIZED` and
nothing starts. A request without `reason` (the desk) is not affected, and
without the variable nothing changes. It is meant for a local script of the
home (a mail listener, a hook of the assistant):

```sh
curl -X POST http://127.0.0.1:4242/api/runs \
  -H "Authorization: Bearer $HQ_TRIGGER_TOKEN" -H "Content-Type: application/json" \
  -d '{"room":"assistant","agent":"mail","reason":"mail"}'
```

Response `202`:

```json
{ "run": { "id": 3, "status": "running", "...": "Run shape" } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT`, `UNAUTHORIZED` (401),
`ROOM_NOT_FOUND`, `ROOM_INVALID`, `AGENT_NOT_FOUND`, `AGENT_BUSY` (409),
`RESOURCE_BUSY` (409), `DAILY_CAP_REACHED` (429). The token, the lock, the
shared resources and the cap are checked before anything is started.

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
| `chat` | `{ "type": "message", "message": ChatMessage }`, `{ "type": "cleared" }` or `{ "type": "turn", "turn": TurnState }` | a message is added to the conversation (from any channel: Telegram, the desk's panel, an alert of the bot), the conversation is emptied (`/new`), or a turn starts, queues or ends (see `GET /api/chat/history`) |
| `roadmap` | `{ "at": string }` | `docs/roadmap.json` of the home was created, edited, replaced or removed (see `GET /api/roadmap`) |
| `desk` | `{ "objects": [{ "id", "count", "status" }], "at": string }` | the count or the state (`ok`, `error`) of an object of the desk changed (see `GET /api/desk`) |

`data` is the entity as it is when the message is sent, so an older change may
already carry a later state (for example an approval created then approved
within the same second arrives twice as `approved`). Treat every message as
"upsert this entity by id". The `id` of a message is the stream cursor, not
the entity id.

The `chat` message is not a stored change either: no `id`, never replayed on
reconnect. A client that shows the conversation loads `GET /api/chat/history` when
the stream opens (the `ready` message, again after each reconnection) and then
applies the `chat` messages: upsert a `message` by its `id`, empty the list on
`cleared`, replace the turn state on `turn`.

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

The `desk` message is not a stored change either (no `id`, never replayed).
The counts are read every three seconds while a stream is open, and only a
change is sent (the first reading is not). Consumers fetch `GET /api/desk`
again, and do so as well when the stream opens.

### `GET /api/desk`

The objects of the desk (`desk` of `myhq.json`, or the default desk, see
`home-layout.md`), each with its count and items. The core's sources are read
at each request; a command of the home is served from its cache while fresh.
A failing command never fails the route: its object has `status: "error"`.

```json
{
  "objects": [
    {
      "id": "signer",
      "object": "pile",
      "label": "À signer",
      "source": "approvals",
      "status": "ok",
      "error": null,
      "count": 1,
      "items": [
        {
          "id": "approval-12",
          "title": "Reply to a thread about group trips",
          "body": "Markdown text to approve.",
          "at": "2026-11-04T08:00:00.000Z",
          "end": null,
          "allDay": false,
          "href": "/bureau/signer#approval-12",
          "tone": null,
          "color": "#ff3d7f",
          "ref": { "kind": "approval", "id": 12, "room": "demo", "agentId": "scout", "type": "community_reply", "status": "pending", "forRoom": null }
        }
      ],
      "slots": null,
      "note": null,
      "spines": [{ "approvalId": 12, "room": "demo", "color": "#ff3d7f" }],
      "updatedAt": "2026-11-04T09:00:00.000Z"
    },
    {
      "id": "agenda",
      "object": "calendar",
      "label": "Agenda",
      "source": "command",
      "status": "error",
      "error": { "code": "COMMAND_TIMEOUT", "message": "timed out after 10000 ms" },
      "count": 0,
      "items": [],
      "slots": null,
      "note": null,
      "spines": null,
      "updatedAt": "2026-11-04T09:00:00.000Z"
    }
  ],
  "configError": null
}
```

- `source`: the core's source (`approvals`, `watch:mail_alert`, `summaries`,
  `chat`), several joined by `+` (`watch:brief+summaries`), or `command`.
- `items[].ref`: what an item of the core is (`approval`, `run` for a run
  summary, `chat` for a message), `null` for an item of a command. `color` is
  the colour of its room, `null` for a neutral room or a command. An approval
  a shared room delivered has `ref.forRoom`, the room that ordered it, and
  takes that room's colour (`ref.room` and `ref.agentId` stay the producing
  agent's). `href` opens
  it on the page of the object, `/bureau/<id>`.
- `slots` and `note`: from a command (a calendar's free stretches, a line about
  its data), `null` otherwise.
- `spines`: for a source with `approvals`, the room colour of each pending item,
  oldest first (the pile of the scene); `null` otherwise. For a delivery of a
  shared room, `room` and `color` are the ones of the room that ordered it.
- `error.code`: `COMMAND_TIMEOUT`, `COMMAND_FAILED` (exit code, or a `cwd`
  outside the home) or `COMMAND_INVALID_OUTPUT` (not JSON, or not the
  contract). The command's stderr is in the server's log, never here.
- `configError`: why the `desk` block was not used (the default desk is then
  returned), `null` otherwise.

### `GET /api/sprites/[room]/[agent]`

The character sheet of an agent for the floor (`/room`): a PNG or WebP image
(see `home-layout.md` for the format). With `?sheet=iso` the file is the one
declared in the agent's `isoSprite` field of the validated `room.json` (the
isometric sheet the floor draws); without it, its `sprite` field (the old
top-down sheet, still served, no longer drawn; for the receptionist,
`/api/sprites/_hq/onboarding`: the `onboarding.sprite` of `myhq.json`). The
path is never read from the URL, must stay inside the home (symbolic links are resolved), must end
in `.png` or `.webp`, must not exceed 2 MiB and must really start like a PNG
or a WebP. `ETag` follows the modification time and `Cache-Control: no-cache`
makes the browser revalidate, so a redrawn sheet shows up at the next load
(`304` when it did not change).

Errors: `ROOM_NOT_FOUND`, `ROOM_INVALID`, `AGENT_NOT_FOUND`, `SPRITE_NOT_FOUND`
(no sheet declared, file missing, too large or not an image). The floor
treats any error, and a sheet of the wrong size, as "draw a neutral person".

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

Decides a pending approval, or sends a decided one back for a revision.

Body:

```json
{ "decision": "approved" }
{ "decision": "rejected", "note": "Too promotional." }
{ "decision": "revise", "note": "Shorter, and answer the budget question first." }
{
  "decision": "revise",
  "note": "Overall, a more direct tone.",
  "annotations": [
    { "quote": "Most organizers underestimate the cost of coordination", "comment": "Too vague: give a figure.", "position": 552 }
  ]
}
```

`note` is optional for `approved` and required (non-blank, at most 5000
characters) for `rejected` and `revise`. `revise` sends the item back to its
agent as a new task carrying the note; the agent sees it at its next run, and
reads every decision through `hq_read_decisions`. The agent is woken at once
(run `reason` `revise`) unless it has `onRevise: "queue"`.

`revise` is also accepted on an item that was already decided: an `approved` or
`rejected` item becomes `revise`, its previous decision is appended to
`decisionHistory`, the usual revision task is created and `hq_read_decisions`
returns the new decision. On an item already in `revise` it is accepted only
when the note or the annotations differ from the current ones
(`APPROVAL_ALREADY_DECIDED` otherwise). `approved` and `rejected` on a decided item
stay `APPROVAL_ALREADY_DECIDED`. The revision does not undo what the approval
triggered: check `actionDone` before asking for one.

`annotations` (optional, at most 30) attach remarks to passages of the body:
each has a `quote` (1 to 2000 characters, the passage as rendered), a `comment`
(1 to 2000 characters) and an optional `position` (integer, 0 or more). They go
with `revise` and `rejected` only (`approved` with annotations is
`INVALID_INPUT`). A `revise` with at least one annotation needs no `note`; a
`rejected` always needs its reason. They are stored with the decision, and the
agent reads them in the text of the decision, both in the revision task and in
the `note` of `hq_read_decisions`, as a numbered list followed by the general
note:

```
1. À propos de « <quote, cut at 200 characters> » : <comment>
2. ...

Remarque générale : <note>
```

Without annotations the text is the note alone, as before. The desk's controls
send them; Telegram does not (see `architecture.md`).

Response `200`:

```json
{ "approval": { "id": 1, "status": "approved", "decidedAt": "...", "...": "Approval shape" } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT` (also for an id that is not a positive
integer), `APPROVAL_NOT_FOUND` (404), `APPROVAL_ALREADY_DECIDED` (409), and for
a `room_proposal`: `ROOM_EXISTS` (409), `PROPOSAL_INVALID` (422) and
`WORKTREE_FAILED` (422), in which case the item stays pending.

Approving records the decision and keeps the payload. The only item the app
acts on is a `room_proposal` (it writes the room); publishing, pushing and
merging stay the user's. When the item's agent has `onApproval: "task"`,
approving also gives it the task « Exécute l'item approuvé n° <id> : <title> »
and starts its run at once (`reason` `approval`) when its lock is free and the
cap allows; otherwise the task waits. The decision never fails because of it.

### `POST /api/approvals/[id]/seen`

« Vu »: an informational item (`unseen`) becomes `seen`, leaves the desk's
« À regarder » section and stays in the history. No body. Idempotent (a `seen`
item is returned as is). Nothing wakes and no task is created.

Response `200`: `{ "approval": { ...Approval shape, "status": "seen" } }`.

Errors: `INVALID_INPUT` (id not a positive integer), `APPROVAL_NOT_FOUND` (404),
`APPROVAL_NOT_WATCHABLE` (409) for an item that is pending or was decided.
`PATCH /api/approvals/[id]` on an `unseen` or `seen` item is
`APPROVAL_NOT_DECIDABLE` (409).

### `POST /api/approvals/[id]/ask`

« Demander à Rom2 » about an `unseen` item. The text goes through the same
service as `POST /api/chat` (one turn at a time, channel `desk`, recorded in the
conversation and published as `chat` events), preceded by nothing and followed by
the item as context. When the chat answers, the item is marked seen.

Body: `{ "text": "Prépare une réponse à ce mail" }` (trimmed, 1 to 2000
characters). The message the chat receives is the text, then
`Contexte : item #<id> (<type>) « <title> », apporté par <agent> (<room>).`, then
the item's body (cut at 8000 characters).

Response `200`: `{ "ok": true, "reply": "...", "approval": {...}, "messages": [...] }`
(`messages`: the user's message and the reply, as in `POST /api/chat`). When the
chat did not answer (budget, timeout, error), `ok` is `false`, `reply` says why and
`approval` is still `unseen`.

Errors: `INVALID_JSON`, `INVALID_INPUT`, `APPROVAL_NOT_FOUND` (404),
`APPROVAL_NOT_WATCHABLE` (409, the item is not `unseen`), `CHAT_NOT_CONFIGURED` (404).

### `GET /api/usage`

Tokens and cost of the runs, by local calendar day of the server, per agent,
of the assistant's chat turns, and the daily cap.

```json
{
  "today": { "date": "2026-11-02", "runs": 3, "inputTokens": 40, "outputTokens": 1600, "cacheCreationInputTokens": 31000, "cacheReadInputTokens": 120000, "costUsd": 0.17 },
  "week": { "start": "2026-11-02", "runs": 3, "...": "same totals" },
  "days": [{ "date": "2026-10-27", "runs": 0, "...": "same totals" }],
  "cap": { "maxRunsPerDay": 12, "runsToday": 3, "remaining": 9 },
  "budget": { "weeklyUsd": 10, "spentUsd": 0.17, "share": 0.017 },
  "agents": {
    "today": [{ "room": "demo", "agentId": "scout", "runs": 3, "...": "same totals" }],
    "week": [{ "room": "demo", "agentId": "scout", "runs": 3, "...": "same totals" }]
  },
  "chat": {
    "today": { "turns": 5, "inputTokens": 30, "outputTokens": 900, "cacheCreationInputTokens": 9000, "cacheReadInputTokens": 60000, "costUsd": 0.12, "toolCalls": 4 },
    "week": { "turns": 21, "...": "same totals" }
  }
}
```

- `days`: the last 7 days, oldest first, today last, days without runs at 0.
- `week`: from Monday of the current week to today.
- Every run started counts towards the cap, whatever its status.
- `budget` is `null` unless `HQ_WEEKLY_BUDGET_USD` is set; `share` is
  `week.costUsd / weeklyUsd` (above 1 when the budget is exceeded).
- `agents`: the totals of each agent that has runs in the period (today, or
  Monday to today), most expensive first. The desk's meter lists the week's.
- `chat`: the turns of the assistant's chat (`chat_turns`), answered or not,
  with the tool calls they made. The chat is not a run: its turns are not in
  `today`, `week`, `days`, the cap nor `budget`.

### Conversation shapes

```json
{
  "id": 43,
  "role": "assistant",
  "kind": null,
  "channel": "desk",
  "to": null,
  "text": "...",
  "choices": null,
  "createdAt": "..."
}
```

A ChatMessage. `role` is `user`, `assistant` (the chat's reply) or `bot` (a
message the bot sent on its own); `kind` says which for a bot message (`alert`,
`notification`, `summary`, `dispatch`: the confirmation of a task sent to an agent)
and is `null` otherwise. `channel` is where it was exchanged: `telegram` or
`desk` (the panel of `/` and `/room`); bot messages are the ones Telegram
accepted. `to` is `{ "room", "agent" }` for a message the user addressed to an
agent from the desk, `null` otherwise. `choices` is `[{ "id": string | null, "label": string }]`
for a reply of the chat that holds a selection list (see `POST /api/chat`), `null`
otherwise; it is computed from the stored text, so every message of the history
and every `chat` event carries it.

```json
{ "running": true, "queued": 1, "pendingConfirmation": { "summary": "approuver l'item #14" } }
```

The TurnState. The chat answers one message at a time, whatever the channel:
`running` is true while a turn is in progress, `queued` counts the messages
waiting behind it (their reply comes in order). `pendingConfirmation` is set
while actions the chat asked for wait for a yes (after a turn that read a mail
or a web page, see `architecture.md` section 5), `null` otherwise.

### `POST /api/chat`

Says something to the assistant's chat, the same conversation as Telegram's, or
gives a task to an agent. The body is `{ "text": string, "to"?: { "room", "agent" } }`
(`text` 1 to 20000 characters, unknown fields refused).

**Without `to`**: the message goes through the pipeline Telegram uses (the
transcript and the preamble of the home, the model, the actions and requests
the turn asked for, the guard that holds them for a yes after an untrusted
read, the history), and the request returns when the reply is known. If
another turn is in progress, the message waits for it (see TurnState).

```json
{
  "ok": true,
  "reply": "Réponse...",
  "pendingConfirmation": { "summary": "approuver l'item #14" },
  "choices": [{ "id": "1", "label": "1. Mairie de Paris : recours FPS" }],
  "messages": [{ "...": "ChatMessage of the user" }, { "...": "ChatMessage of the reply" }]
}
```

- `pendingConfirmation` is only present when the turn holds actions for a yes. The
  answer goes through this same route: the text « oui » (or ok, vas-y, go,
  confirme) executes them, « non » (annule, stop) drops them, anything else drops
  them with a note and goes on as a message. The reply of a « oui » is the result
  line of each action.
- `choices` is only present when the reply holds a selection list: a GFM task
  list, lines `- [ ] label` (also `*` or `+`), twelve items at most (a longer list
  stays plain text and has no `choices`). Each item is `{ "id", "label" }`: `label`
  is the text after the box, and `id` the short id it starts with (digits, or one
  letter then digits, followed by `.` or `)` and a space: `1. `, `A3) `), `null`
  when it has none. The text of `reply` still holds the list. A client turns the
  items into checkboxes and answers by posting a normal message to this same
  route, « Sélection : 1, 3, 5 » (the ids of the ticked items in the order of the
  list, or their full labels joined by commas when they have no id), which the
  assistant reads as the answer. The desk's panel and the Telegram bridge do
  exactly this.
- `ok` is false when the turn gave no answer (budget, timeout, error): `reply`
  then says why, `messages` is empty, nothing is added to the conversation. The
  status is still 200.
- `messages` are what the request added to the conversation, so that a client
  can show them without waiting for the `chat` events (which carry the same
  messages, with the same ids).

**With `to`**: the text becomes the task of that agent and a run starts at once
(reason `desk`), like `POST /api/runs` with a `task`: same agent lock and daily
cap. The chat is not asked, so the request does not wait for its turn.

```json
{
  "ok": true,
  "reply": "Tâche transmise à Scout, tour n° 12 lancé",
  "dispatch": { "run": { "...": "Run shape" } },
  "messages": [{ "...": "the task, role user, with to" }, { "...": "kind dispatch" }]
}
```

Status `202`. Both messages are added to the conversation, so the next chat turn
knows what was sent to whom. Without `to`, the chat may itself hand work to an
agent through its request files, as it does on Telegram.

Errors: `INVALID_JSON`, `INVALID_INPUT`, `CHAT_NOT_CONFIGURED` (404, without `to`),
and with `to`: `ROOM_NOT_FOUND`, `ROOM_INVALID`, `AGENT_NOT_FOUND`, `AGENT_BUSY` (409),
`DAILY_CAP_REACHED` (429), in which case nothing is added to the conversation.

### `GET /api/chat/history`

The latest messages of the assistant's conversation as MyHQ keeps it (see
`home-layout.md`, "The conversation MyHQ keeps"), oldest first, from every channel,
and the state of the turns. `?limit=` from 1 to 200 (default 50). Only the texts
exchanged: no token, no configuration.

```json
{
  "messages": [
    { "id": 41, "role": "bot", "kind": "alert", "channel": "telegram", "to": null, "text": "MyHQ : un item attend ta validation (#14) ...", "choices": null, "createdAt": "..." },
    { "id": 42, "role": "user", "kind": null, "channel": "telegram", "to": null, "text": "oui", "choices": null, "createdAt": "..." },
    { "id": 43, "role": "assistant", "kind": null, "channel": "telegram", "to": null, "text": "...", "choices": null, "createdAt": "..." }
  ],
  "turn": { "running": false, "queued": 0, "pendingConfirmation": null }
}
```

Errors: `INVALID_INPUT` for a bad `limit`.

### `DELETE /api/chat/history`

`/new`: the conversation starts over. The next turn does not resume the CLI's
conversation, and held actions are dropped. It waits for the turn in progress, if
any. Response `200`: `{ "cleared": true }`; the streams get a `chat` message
`{ "type": "cleared" }`.

### `PATCH /api/rooms/[room]/agents/[agent]`

Arms or disarms the routines of an agent. The value is stored in the database
and wins over `room.json` from then on.

Body: `{ "armed": true }`. Response `200`:

```json
{ "agent": { "room": "demo", "id": "scout", "armed": true } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT`, `ROOM_NOT_FOUND`, `ROOM_INVALID`,
`AGENT_NOT_FOUND`.

### `GET /api/routines`

The scheduler's state and the journal of routine firings, newest first.
`?limit=` from 1 to 500 (default 50).

```json
{ "scheduler": { "enabled": true, "running": true, "timeZone": "Europe/Paris" }, "firings": [{ "...": "Firing shape" }] }
```

Errors: `INVALID_INPUT` for a bad `limit`.

### `POST /api/onboarding`

Starts a run of the onboarding agent on a repository and returns at once; its
room proposal arrives on the desk as a `room_proposal` approval. Same lock
(one onboarding run at a time) and daily cap as any run.

Body: `{ "path": "../my-project" }` (relative to the home, or absolute).
Response `202`: `{ "run": { "room": "_hq", "agentId": "onboarding", "...": "Run shape" } }`.

Errors: `INVALID_JSON`, `INVALID_INPUT`, `TARGET_NOT_FOUND` (404),
`AGENT_BUSY` (409), `DAILY_CAP_REACHED` (429).

### `POST /api/export`

Writes the daily export of one day now (and replaces its file). The body is
optional: `{ "date": "2026-11-02" }`, yesterday in `HQ_TIMEZONE` by default.

```json
{ "export": { "date": "2026-11-02", "file": "/abs/path/2026-11-02.json", "runs": 4, "messages": 1, "approvals": 3 } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT`, `EXPORT_NOT_CONFIGURED` (404).

## Not in the API

The HQ MCP server is not reached over HTTP: `claude -p` starts it over stdio
for each run (see `architecture.md`). Its seven tools write to the same
database, and their effects reach the interface through `/api/events`.
