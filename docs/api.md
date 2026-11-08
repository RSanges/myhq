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
| `FILE_NOT_FOUND` | 404 | `GET /api/approvals/<id>/files/<fileId>`: the item has no such file, or its copy is gone. |
| `ROOM_INVALID` | 422 | The room's `room.json` failed validation. The message carries the validation error. |
| `CHAT_NOT_CONFIGURED` | 404 | `POST /api/chat` (without `to`) while the home has no `chat` section in `assistant.json`. |
| `AGENT_BUSY` | 409 | The agent already has a run in progress (one run at a time per agent). |
| `QUESTION_BUSY` | 409 | A question to an agent while it answers another one (one at a time per agent), or a reset of its discussion meanwhile. |
| `QUESTION_NOT_FOUND` | 404 | A decision on a proposed run for a question that is not one of this agent's. |
| `PROPOSAL_NOT_FOUND` | 404 | A decision on a proposed run for a question whose answer proposes none. |
| `PROPOSAL_DECIDED` | 409 | A decision on a proposed run already launched or set aside: each proposal is decided once. |
| `RESOURCE_BUSY` | 409 | The agent holds a shared resource (`resources` in `room.json`, for example `gpu`) that a run of another agent holds now. The message names the resource and that run. |
| `APPROVAL_ALREADY_DECIDED` | 409 | The approval is no longer `pending`, and the decision is not a `revise` (an approved or rejected item can be sent back; an item already in `revise` only with a new note or new remarks). |
| `ANSWERS_REQUIRED` | 422 | Approving an item of questions (`type: "question"`, from `hq_ask`) without `answers`. |
| `INVALID_ANSWERS` | 422 | The `answers` do not fit the questions: not one per question, an option that does not exist or is picked twice, nothing answered, or several answers to a single-select question. Nothing is decided. |
| `ANSWERS_NOT_EXPECTED` | 400 | `answers` on an item that is not an item of questions. |
| `QUESTION_NOT_REVISABLE` | 409 | `revise` on an item of questions: answer it or reject it. |
| `DAILY_CAP_REACHED` | 429 | `HQ_MAX_RUNS_PER_DAY` runs (or `maxRunsPerDay` of `myhq.json`, which wins) were already started today (local day, all agents). |
| `SHUTTING_DOWN` | 503 | The app is stopping (`architecture.md`, "Stopping and restarting"): no run starts, and no agent takes a question, until it is back. |
| `ROADMAP_NOT_FOUND` | 404 | `docs/roadmap.json` is missing from the home, or fails validation. The message says which. |
| `TARGET_NOT_FOUND` | 404 | The path given to onboarding is not a directory. |
| `PATH_OUTSIDE_ROOT` | 400 | `GET /api/fs/dirs`: the `path` is absolute (`/x`, `C:/x`), climbs (`..`), uses a backslash or a `:`, or leads out of the projects root through a link. |
| `DIR_NOT_FOUND` | 404 | `GET /api/fs/dirs`: the `path` is not a folder of the projects root, or is a hidden or heavy one (a name starting with `.`, `node_modules`, `data`, `build`). |
| `ROOT_NOT_FOUND` | 404 | `GET /api/fs/dirs`: the projects root (`projectsRoot` of `myhq.json`, else the parent folder of the home) is not a folder. |
| `ROOM_EXISTS` | 409 | Approving a room proposal whose room already exists in the home. Nothing is written; the item stays pending. |
| `PROPOSAL_INVALID` | 422 | Approving a room proposal that fails validation (payload, paths, target repository). Nothing is written; the item stays pending. |
| `WORKTREE_FAILED` | 422 | Approving a room proposal, or an agent proposal, whose agent worktree cannot be created. Nothing is written; the item stays pending. |
| `AGENT_EXISTS` | 409 | Approving an agent proposal whose room already has an agent of that id, or a role file of that name. Nothing is written; the item stays pending. |
| `AGENT_PROPOSAL_INVALID` | 422 | Approving an agent proposal that fails validation, or that would make its room invalid (for example a working directory outside the home). Nothing is written; the item stays pending. An agent proposal for a room the home no longer has is `ROOM_NOT_FOUND` (422). |
| `SPRITE_NOT_FOUND` | 404 | `GET /api/sprites/<room>/<agent>` (or `?sheet=iso`) for an agent that declares no such sheet, or whose file is missing, too large, or not a PNG or WebP. |
| `EXPORT_NOT_CONFIGURED` | 404 | `POST /api/export` while the home has no `export.dir` in `myhq.json`. |
| `SETTINGS_FILE_INVALID` | 409 | A save of the settings page that writes `myhq.json` while the file is not valid JSON or not a JSON object. Nothing is written; the file is left for the user to fix. |
| `TASK_NOT_FOUND` | 404 | `POST /api/blocked/relaunch` or `/close` with a task id that does not exist. |
| `RUN_NOT_FOUND` | 404 | `POST /api/blocked/relaunch` or `/close` with a run id that does not exist. |
| `NOT_BLOCKED` | 409 | `POST /api/blocked/relaunch` or `/close` on a task that is neither `blocked` nor `pending`, or on a run that is not failed or interrupted, or has no task left blocked or given back. Nothing is changed. |
| `DESK_OBJECT_NOT_FOUND` | 404 | `POST /api/desk/<id>/seen` or `/actions/<action>` with an id that is not an object of the desk. |
| `DESK_ACTION_NOT_FOUND` | 404 | `POST /api/desk/<id>/actions/<action>` for an action the object does not declare (a core source declares none; a command source declares `add` and `done` in its `actions`). |
| `ACTION_FAILED` | 422 | An action command refused (`{ "ok": false, "message" }`). The `message` is the command's own, in the language of the home, and meant to be shown. |
| `ACTION_TIMEOUT` | 504 | An action command ran past its `timeoutSeconds`. |
| `ACTION_INVALID_OUTPUT` | 502 | An action command exited with an error code, or printed something that is not `{ "ok", "message"? }`. Its stderr is in the server's log only. |
| `SETTINGS_GROUP_NOT_FOUND` | 404 | `PUT /api/settings/<group>` with a group that is not `layout`, `limits`, `notifications` or `rooms`. |
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

A run is `cancelled` when it was interrupted because the app stopped during it
(the grace of a stop was over, or the app crashed or was killed: summary
« Interrupted: MyHQ stopped during the run. »), and `failed` when the engine
reports an error, the budget (`--max-budget-usd`) is exceeded, the run times
out (`HQ_RUN_TIMEOUT_MINUTES`, in a home without a supervisor), reaches its
hard limit (`HQ_RUN_HARD_LIMIT_MINUTES`) or is stopped by the supervisor
(`hq_run_stop`): see "Long runs" in `architecture.md`.

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
`agent_need` for a run of the receptionist proposing a missing agent
(`POST /api/agents/propose`, the chat's `propose_agent`, `hq_suggest_agent`),
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
  "files": [],
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
passages that read the same); a remark on a point of a joined file (a 3D
part, an image, a video's frame) has a `point` instead (see `PATCH
/api/approvals/[id]`); empty for every other item. They are part of the
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

`files` are the files the agent joined with `hq_submit` `attachments`, in its
order (empty for an item without any), each:

```json
{ "id": 4, "name": "clip-01.mp4", "mime": "video/mp4", "kind": "video", "size": 625593,
  "sha256": "9f2c...", "caption": "Plan d'ouverture", "url": "/api/approvals/1/files/4" }
```

`kind` is `video`, `image`, `audio`, `model` (3mf, stl, glb) or `pdf`. `size`
and `sha256` are those of the copy MyHQ made at submission, which `url` serves
(see `GET /api/approvals/[id]/files/[fileId]`).

Payloads the interface and the assistant act on:

| `type` | `payload` | Once approved |
|---|---|---|
| any | `{ "url": "https://..." }` | The body and the link are handed to the user (copy, open). |
| `pull_request`, `blog_post` | `{ "branch": "hq/<agent>-<slug>", "sha": "...", "title": "...", "summary": "..." }` | The branch, the commit, and the `git push` and `gh pr create` commands are handed to the user. Nothing is pushed or merged. |
| `question` | `{ "context"?: "...", "questions": [{ "question": "...", "header"?: "...", "options": [{ "label": "...", "description"?: "..." }], "multiSelect"?: true }], "answers"?: [{ "options": [1], "other"?: "..." }] }` (from `hq_ask`; `answers` once answered, one per question) | Answering it (`approved` with `answers`) wakes the agent with its questions and the answers; see `PATCH /api/approvals/[id]`. |
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
      "logo": null,
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
          "roam": false,
          "roamAlways": false,
          "armed": false,
          "routines": [
            {
              "cron": "0 7 * * 1-5",
              "task": null,
              "nextAt": "2026-11-03T06:00:00.000Z",
              "schedule": { "times": ["07:00"], "weekdays": [1, 2, 3, 4, 5], "monthDays": null, "months": null, "dayRule": "and" }
            }
          ],
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
  "floor": { "layout": "floor-per-project", "owner": null },
  "scheduler": { "enabled": false, "running": false, "timeZone": "Europe/Paris" },
  "firings": [],
  "approvals": { "pending": [], "unseen": [], "history": [] },
  "recent": { "events": [], "messages": [] },
  "assistant": { "polling": false }
}
```

- `role` and `targetRepo` are relative to the home.
- `logo`: the URL of the logo of the room's project (`GET /api/rooms/[room]/logo`), or `null`.
- `color`: the room's hex colour from `room.json`, or `null` (a neutral room).
- `isoSprite`: `/api/sprites/<room>/<agent>?sheet=iso` when the agent declares
  an isometric character sheet (`isoSprite` in `room.json`) and the file
  exists, `null` otherwise (the floor then draws one of the neutral people
  shipped with the app).
- `isoStride`: voxels per walk frame of that sheet, read from `walk.voxelsPerFrame`
  of the `iso.json` next to it; `null` when there is no such file or value (the
  floor then walks at 3 voxels per frame).
- `roam`: `true` for an agent with `floor.behaviour: "roam"` in `room.json` (no
  desk: it does its round of the floor during its runs and rests by the broom
  closet of the lobby, see `home-layout.md`), `false` otherwise. `roamAlways`:
  `true` when it also has `floor.always: true` (its round goes on between its
  runs, on a clock anchored at a fixed origin), `false` otherwise.
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
- `floor.owner`: the person seated in the user's own office of the single
  floor, `floor.owner` of `myhq.json` (see `home-layout.md`): `{ "name",
  "isoSprite" }`, `isoSprite` being `/api/sprites/_hq/owner?sheet=iso` when the
  setting names a sheet and the file exists, `null` otherwise (a neutral
  person). `null` without the setting, or with an invalid one (the office stays
  empty, the reason is in the log).
- `floor.layout`: how the floor (`/`) draws the home, `floor.layout` of `myhq.json`:
  `"floor-per-project"` (the default, also when the block is missing or
  invalid) or `"room-per-project"` (one floor for the whole home). An
  interface that does not know a value takes the default.
- `armed`: whether the agent's routines may start runs (the database value
  once changed, the `armed` of `room.json` until then). `routines`: one entry
  per cron of the agent, `task` `null` for the routine work of the role,
  `nextAt` its next fire in UTC (`null` for an expression that never fires),
  `schedule` what the expression says, without any wording, for an interface
  to phrase it (« Du lundi au vendredi à 7 h »): `times` the times of day it
  fires, `"HH:MM"` on the wall clock of `scheduler.timeZone`, in order (`null`
  past six a day); `weekdays` the days of the week it is limited to, 0 Sunday
  to 6 Saturday (`null`: every day of the week); `monthDays` the days of the
  month (`null`: every day); `months` 1 to 12 (`null`: every month); `dayRule`
  how `weekdays` and `monthDays` combine when both are set, `"or"` (classic
  cron, both fields restricted) or `"and"` (one of them starts with `*`).
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
`RESOURCE_BUSY` (409), `DAILY_CAP_REACHED` (429), `SHUTTING_DOWN` (503). The
token, the lock, the shared resources and the cap are checked before anything
is started.

### `GET /api/runs/active`

The runs in progress, oldest first (whatever process started them), and
whether the app is stopping. Read-only; a deployment waits on it
(`npm run wait-idle`).

```json
{ "running": 1, "stopping": false, "runs": [{ "id": 12, "status": "running", "...": "Run shape" }] }
```

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
change is sent (the first reading is not). An action of an object
(`POST /api/desk/<id>/actions/<action>`) makes the read happen at once. Consumers fetch `GET /api/desk`
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
      "actions": [],
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
      "actions": [],
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
  `chat`, `blocked`), several joined by `+` (`watch:brief+summaries`), or `command`.
- `count`: for `summaries` and `chat`, only what came after the object's page
  was last opened (`POST /api/desk/<id>/seen`); for `blocked`, the number of
  agents that have something stuck.
- `items[].ref`: what an item of the core is (`approval`, `run` for a run
  summary, `chat` for a message, `blocked` for an entry of the Standard),
  `null` for an item of a command. `color` is
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
- `actions`: what the page can ask of the object, `add` and/or `done`
  (`POST /api/desk/<id>/actions/<action>`): those a command source declares in
  its `actions` while its data is readable, `[]` for a core source or a failing
  command.
- `configError`: why the `desk` block was not used (the default desk is then
  returned), `null` otherwise.

An entry of the Standard (source `blocked`, `architecture.md`, "The Standard"):

```json
{
  "id": "blocked-run-41",
  "title": "Scout",
  "body": "Handle the pending tasks of your mailbox, listed below.

- Sum up this week's announcements.",
  "at": "2026-11-04T08:00:00.000Z",
  "end": null,
  "allDay": false,
  "href": "/bureau/telephone#blocked-run-41",
  "tone": "alert",
  "color": "#ff3d7f",
  "ref": { "kind": "blocked", "entry": "run", "id": 41, "room": "demo", "agentId": "scout", "state": "failed", "reason": "Le tour #41 a échoué : Budget exceeded.", "tasks": 2, "note": null, "handedOff": false }
}
```

`ref.entry` is `task` (a blocked task), `pending` (a pending task nothing
takes) or `run` (a failed or interrupted run, `ref.id` is the run); `state` is
`blocked`, `pending`, `failed` or `cancelled`; `tasks` is how many tasks the
actions act on. `title` is the agent's name, `body` the text of the task (for a run,
its instruction, then the tasks it gave back as a Markdown list), `at` since
when it is stuck, `reason` one sentence in
the language of the interface. `note` is the latest note of the supervisor of
the Standard on the entry (`{ text, by, at }`, `by` its name; null when there is
none), and `handedOff` says that it handed the entry to the owner: those
entries come first (see "The supervisor" in `architecture.md`).

### `POST /api/desk/[id]/seen`

The owner opened the page of a desk object. The `summaries` and `chat` sources
of that object stop counting what exists now, and count what comes after (the
other sources are not affected). No body. Idempotent: it moves the mark to now.

Response `200`: `{ "id": "journal", "seenAt": "2026-11-04T09:00:00.000Z" }`.

Errors: `INVALID_INPUT` (not an object id), `DESK_OBJECT_NOT_FOUND` (404).

### `POST /api/desk/[id]/actions/[action]`

An action of a desk object whose source is a command of the home (see
`home-layout.md`, "Actions"): `add` a new item, or mark one `done`. The server
checks the body, then runs the action's command of the home with the values as
one JSON document on its **standard input** (never in the command line), waits
for it up to its `timeoutSeconds`, reads `{ "ok": true, "message"?: string }`
on its stdout, drops the cached data of the object and sends the `desk` event
at once. Actions run one at a time.

| Action | Body | Meaning |
|---|---|---|
| `add` | `{ "text": string }` | A new item: 1 to 300 characters after trimming, on one line (no control character). |
| `done` | `{ "id": string }` | The item with that `id`, as `GET /api/desk` gave it (1 to 200 characters). |

Unknown fields are refused. Response `200`: `{ "ok": true }`, with the command's
`"message"` when it gave one.

Errors: `INVALID_JSON`, `INVALID_INPUT` (400), `DESK_OBJECT_NOT_FOUND`,
`DESK_ACTION_NOT_FOUND` (404), `ACTION_FAILED` (422), `ACTION_INVALID_OUTPUT` (502),
`ACTION_TIMEOUT` (504). The data of the object is dropped from the cache whatever
the outcome, since a command that failed may have written.

### `POST /api/blocked/relaunch`

« Relancer » on the Standard. Body: `{ "kind": "task" | "run", "id": 12 }` (a
`pending` entry is a `task`). The tasks of the target (the task; for a run,
its instruction left blocked and the tasks it gave back) go back to `pending`,
then a run of their agent starts at once with reason `relaunch`, taking its
mailbox, under the agent lock, the shared resources and the daily cap.

Response `200`:

```json
{ "tasks": [12], "run": { "...Run shape": "..." }, "waiting": null }
```

When the run cannot start, `run` is `null`, the tasks stay pending, and
`waiting` says why: `{ "code": "RESOURCE_BUSY", "message": "..." }` (also
`AGENT_BUSY`, `DAILY_CAP_REACHED`, `SHUTTING_DOWN`, or `ROOM_NOT_FOUND`,
`AGENT_NOT_FOUND`, `ROOM_INVALID` when the agent is no longer in the home).

Errors: `INVALID_INPUT`, `TASK_NOT_FOUND` or `RUN_NOT_FOUND` (404), `NOT_BLOCKED` (409).

### `POST /api/blocked/close`

« Clore » on the Standard. Same body. The tasks of the target are `done`, with
the note « Close par le propriétaire. ». Nothing wakes.

Response `200`: `{ "tasks": [12] }`. Errors: as for the relaunch.

### `GET /api/sprites/[room]/[agent]`

The character sheet of an agent for the floor (`/`): a PNG or WebP image
(see `home-layout.md` for the format). With `?sheet=iso` the file is the one
declared in the agent's `isoSprite` field of the validated `room.json` (the
isometric sheet the floor draws); without it, its `sprite` field (the old
top-down sheet, still served, no longer drawn; for the receptionist,
`/api/sprites/_hq/onboarding`: the `onboarding.sprite` of `myhq.json`). The
owner of the floor belongs to no room either: `/api/sprites/_hq/owner?sheet=iso`
serves `floor.owner.isoSprite` of `myhq.json`. The
path is never read from the URL, must stay inside the home (symbolic links are resolved), must end
in `.png` or `.webp`, must not exceed 2 MiB and must really start like a PNG
or a WebP. `ETag` follows the modification time and `Cache-Control: no-cache`
makes the browser revalidate, so a redrawn sheet shows up at the next load
(`304` when it did not change).

Errors: `ROOM_NOT_FOUND`, `ROOM_INVALID`, `AGENT_NOT_FOUND`, `SPRITE_NOT_FOUND`
(no sheet declared, file missing, too large or not an image). The floor
treats any error, and a sheet of the wrong size, as "draw a neutral person".

### `GET /api/rooms/[room]/logo`

The logo of a room's project, drawn on the room's signboard on the floor: the
file of the `logo` field of the validated `room.json` (never a path of the
URL), inside the room's directory once symbolic links are resolved, at most
1 MiB, really a PNG, a WebP or an SVG (`Content-Type` from its first bytes).
An SVG is served with `Content-Security-Policy: default-src 'none';
style-src 'unsafe-inline'; sandbox`, so nothing in it runs should it be opened
alone. `ETag` and `Cache-Control: no-cache` as for the sheets; the state's
`rooms[].logo` is this URL with `?v=` the modification time, or `null` without
a logo (or when its file is missing).

Errors: `ROOM_NOT_FOUND`, `LOGO_NOT_FOUND` (no logo declared, file missing,
outside the room, too large or not an image). The floor then draws the name
alone.

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

An item of questions (`type: "question"`, created by the agent's `hq_ask`) is not approved but answered: `approved` takes `answers`, one per question in the order asked, each `{ "options": [index, ...], "other"?: "free text" }` (`options` are indexes in the question's `options`; `other` is the « Autre » answer MyHQ always offers). A single-select question takes exactly one of an option or `other`; a multi-select one (`multiSelect`) takes any mix, at least one answer. `answers` without `approved`, or on another type, and `approved` without `answers` on a question, are refused (`INVALID_INPUT`, `ANSWERS_NOT_EXPECTED`, `ANSWERS_REQUIRED`, `INVALID_ANSWERS`).

```json
{ "decision": "approved", "answers": [{ "options": [1] }, { "options": [0, 2], "other": "Podcast" }] }
```

The answers are kept in the item's `payload.answers` and, as `Q : ... / R : ...` lines, in its `decisionNote`. The agent is woken like for a revision (run `reason` `revise`, so `onRevise: "queue"` makes it wait for its next run) with a task that holds its questions and the answers; it also reads the decision with `hq_read_decisions`. `rejected` (with a reason) is how the owner says the question has no place; nothing wakes. `revise` is refused.

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
(1 to 2000 characters) and an optional `position` (integer, 0 or more). A
remark on a point of a file joined to the item (a 3D part, an image, a video's
frame) has, instead of a `position`, a `point`, whose `kind` says which:

```json
{
  "quote": "piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z",
  "comment": "Paroi trop fine ici.",
  "point": { "fileId": 4, "kind": "model", "x": 12.4, "y": -3, "z": 8.5, "normal": [0, 0, 1] }
}
{
  "quote": "cover.png, point à 62 % de la largeur et 18 % de la hauteur",
  "comment": "Logo trop près du bord.",
  "point": { "fileId": 5, "kind": "image", "x": 0.62, "y": 0.18 }
}
{
  "quote": "clip-01.mp4 à 0:12, point à 40 % ; 70 %",
  "comment": "Le texte passe sous le visage.",
  "point": { "fileId": 6, "kind": "video", "x": 0.4, "y": 0.7, "t": 12.4 }
}
```

`fileId` is the id of the file in `files` (a positive integer).

- `kind: "model"`, a 3D part: `x`, `y`, `z` the point in millimetres in the
  part's own frame (Z up; the desk rounds them to the tenth; each between
  -1000000 and 1000000); `normal` the outward unit normal of the face hit
  (three numbers between -1 and 1, rounded to the hundredth by the desk).
  `kind` may be left out: the 3D points stored before images and videos had
  theirs have none, and read as they did.
- `kind: "image"`, an image: `x` from the left edge and `y` from the top edge,
  as shares of the image's own width and height (0 to 1, the desk keeps the
  thousandth), so the same spot gives the same point at any size it was shown.
- `kind: "video"`, a video's frame: `x` and `y` as on an image, and `t` the
  time in seconds (0 or more, the desk keeps the millisecond).

Any other key, or a key of another kind (a `t` on an image, an image point
without `y`), is `INVALID_INPUT`. They go
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

A remark with a `point` is followed by a line with the exact point. On a 3D
part, numbers with a dot (one decimal for the coordinates, two for the
normal); on an image, whole percentages from the left and top edges; on a
video, the same with the time, as shown and in seconds (two decimals, to
extract the frame):

```
2. À propos de « piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z » : Paroi trop fine ici.
   Point dans le repère de la pièce (mm) : x=12.4 y=-3.0 z=8.5 ; normale sortante de la face : (0.00, 0.00, 1.00)
3. À propos de « cover.png, point à 62 % de la largeur et 18 % de la hauteur » : Logo trop près du bord.
   Point sur l'image : 62 % depuis la gauche, 18 % depuis le haut
4. À propos de « clip-01.mp4 à 0:12, point à 40 % ; 70 % » : Le texte passe sous le visage.
   Point sur l'image de la vidéo à 0:12 (12.40 s) : 40 % depuis la gauche, 70 % depuis le haut
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

### `GET /api/approvals/[id]/files/[fileId]`

A file joined to an item, served from the copy MyHQ made when the item was
submitted (`<home>/data/attachments/<id>/`). The file is looked up by both ids
in the database; nothing of the request is used as a path. `HEAD` works the
same, without the body.

- `Content-Type`: the MIME type of the file (from its extension, checked at
  submission), `X-Content-Type-Options: nosniff`.
- `Content-Disposition`: `inline` with the original name, `attachment` with
  `?download=1` (the desk uses it for 3D parts).
- `Accept-Ranges: bytes`. A `Range: bytes=<start>-<end>` (or `<start>-`, or a
  suffix `-<n>`) gets `206 Partial Content` with `Content-Range`; only the first
  range of a list is served. A range that starts past the end gets `416` with
  `Content-Range: bytes */<size>`. A malformed `Range` gets the whole file
  (`200`). Players need this, Safari on iOS first of all, to play and seek.
- `ETag`: the sha256 of the copy, which never changes (`304` on
  `If-None-Match`), and `Cache-Control: private, max-age=31536000, immutable`.

Errors: `INVALID_INPUT` (an id that is not a positive integer), `FILE_NOT_FOUND` (404).

### `GET /api/usage`

Tokens and cost of the runs, by local calendar day of the server, per agent,
of the assistant's chat turns, of the questions to the agents, and the daily cap.

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
  },
  "questions": {
    "today": { "questions": 2, "inputTokens": 12, "outputTokens": 700, "cacheCreationInputTokens": 15000, "cacheReadInputTokens": 30000, "costUsd": 0.06 },
    "week": { "questions": 5, "...": "same totals" }
  }
}
```

- `days`: the last 7 days, oldest first, today last, days without runs at 0.
- `week`: from Monday of the current week to today.
- Every run started counts towards the cap, whatever its status.
- `budget` is `null` unless `HQ_WEEKLY_BUDGET_USD` is set; `spentUsd` is
  `week.costUsd` plus `questions.week.costUsd`, and `share` is
  `spentUsd / weeklyUsd` (above 1 when the budget is exceeded).
- `agents`: the totals of each agent that has runs in the period (today, or
  Monday to today), most expensive first. The desk's meter lists the week's.
- `chat`: the turns of the assistant's chat (`chat_turns`), answered or not,
  with the tool calls they made. The chat is not a run: its turns are not in
  `today`, `week`, `days`, the cap nor `budget`.
- `questions`: the owner's questions to the agents (`agent_questions`), answered
  or not. A question is not a run: it is not in `today`, `week`, `days` nor the
  cap, but it counts in `budget`, and the whiteboard adds it to the cost of the
  day and of the week.

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
`desk` (the panel of `/` and `/bureau`); bot messages are the ones Telegram
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

### Questions to an agent

A question of the owner to an agent, answered by the agent without a run (no
agent lock, no daily cap, nothing in `runs`, nobody woken), read-only, and
metered (`architecture.md`, "Questions to an agent"). One discussion per
agent. A question has this shape:

```json
{
  "id": 7,
  "question": "How do you make your videos?",
  "answer": "I write the script, then render it with **Remotion**...",
  "status": "done",
  "error": null,
  "model": "claude-sonnet-5-5",
  "costUsd": 0.031,
  "askedAt": "2026-11-08T10:00:00.000Z",
  "answeredAt": "2026-11-08T10:00:21.000Z",
  "proposal": null
}
```

`status` is `running`, `done` or `failed`; `answer` is null unless `done`
(Markdown); `error` says why a question failed: `timeout` (no answer after 5
minutes), `budget` (its `--max-budget-usd` reached), `error` (the engine
failed), `interrupted` (the app stopped during it). `model` is the one the CLI
reported, the agent's alias until then. `proposal` is the run the answer
proposes when the message asked for work (`architecture.md`, "A task or a
discussion"), null otherwise: `{ "task": "...", "state": "pending", "runId":
null, "decidedAt": null }`, `state` being `pending`, `launched` (with
`runId`) or `dismissed`. The answer never holds the block of the proposal.

#### `GET /api/rooms/[room]/agents/[agent]/ask`

The current discussion (since the last reset), oldest first, the latest 50.

```json
{ "agent": { "room": "demo", "id": "scout", "name": "Scout" }, "questions": [{ "...": "question shape" }], "busy": false }
```

`busy`: a question waits for its answer. Errors: `ROOM_NOT_FOUND`,
`ROOM_INVALID`, `AGENT_NOT_FOUND`.

#### `POST /api/rooms/[room]/agents/[agent]/ask`

Body: `{ "question": "How do you make your videos?" }` (trimmed, 1 to 4000
characters). Response `202` with the question as recorded, `running`: the
agent answers in the background, read the discussion again for the answer.

```json
{ "question": { "id": 8, "status": "running", "answer": null, "...": "question shape" } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT`, `ROOM_NOT_FOUND`, `ROOM_INVALID`,
`AGENT_NOT_FOUND`, `QUESTION_BUSY` (the agent answers another question),
`SHUTTING_DOWN`. A run in progress and the daily cap never refuse a question.

#### `DELETE /api/rooms/[room]/agents/[agent]/ask`

« Nouvelle discussion »: the questions leave the discussion (and the context
the agent gets); their rows stay, so their cost stays in `/api/usage`.
Response `200`: `{ "cleared": 2 }`, how many questions were cleared. Errors:
`ROOM_NOT_FOUND`, `ROOM_INVALID`, `AGENT_NOT_FOUND`, `QUESTION_BUSY` (a
question is in progress: wait for its answer).

#### `POST /api/rooms/[room]/agents/[agent]/ask/[question]/proposal`

The owner's decision on the run an answer proposes: the only way such a run
starts. Body: `{ "action": "launch" }` (« Lancer le tour ») or
`{ "action": "dismiss" }` (« On en parle d'abord »). `launch` starts the run
with the proposal's task as `POST /api/runs` does from the desk (no
`reason`), and answers `202`; `dismiss` answers `200`. Both give the
question as it is now and the run, or null:

```json
{ "question": { "id": 8, "proposal": { "task": "...", "state": "launched", "runId": 13, "decidedAt": "..." }, "...": "question shape" }, "run": { "...": "run shape" } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT` (no `action`, another value, a
`question` that is not a positive integer), `ROOM_NOT_FOUND`,
`ROOM_INVALID`, `AGENT_NOT_FOUND`, `QUESTION_NOT_FOUND`,
`PROPOSAL_NOT_FOUND` (the answer proposes no run), `PROPOSAL_DECIDED`
(already launched or set aside), and for `launch` the refusals of a run
(`AGENT_BUSY`, `RESOURCE_BUSY`, `DAILY_CAP_REACHED`, `SHUTTING_DOWN`):
the proposal then stays `pending`.

### `GET /api/rooms/[room]/agents/[agent]/thread`

The thread of the agent's sheet, oldest first (`architecture.md`, "The sheet
of an agent"): the current discussion (since the last reset, the latest 50
questions), the latest 15 runs of the agent and the latest 20 items it
submitted, read from their own tables. At the same time, a question comes
before a run, a run before an item.

```json
{
  "agent": { "room": "demo", "id": "scout", "name": "Scout" },
  "entries": [
    { "kind": "question", "at": "2026-11-08T10:00:00.000Z", "question": { "...": "question shape" } },
    {
      "kind": "run",
      "at": "2026-11-08T10:01:00.000Z",
      "run": { "id": 12, "status": "done", "task": "...", "reason": null, "costUsd": 0.21, "startedAt": "...", "endedAt": "...", "summary": "..." }
    },
    {
      "kind": "item",
      "at": "2026-11-08T10:04:00.000Z",
      "item": { "id": 31, "type": "report", "title": "...", "status": "pending", "question": false, "createdAt": "..." }
    }
  ],
  "busy": false
}
```

`at` is when the question was asked, the run started or the item was
submitted. `item.question`: an item of questions (`hq_ask`, type `question`).
`busy`: a question waits for its answer. Errors: `ROOM_NOT_FOUND`,
`ROOM_INVALID`, `AGENT_NOT_FOUND`.

### `GET /api/routines`

The scheduler's state, the journal of routine firings, newest first, and the
routines of each agent as of now. `?limit=` from 1 to 500 (default 50).

```json
{
  "scheduler": { "enabled": true, "running": true, "timeZone": "Europe/Paris" },
  "firings": [{ "...": "Firing shape" }],
  "agents": [{ "room": "demo", "agentId": "scout", "armed": true, "routines": [{ "...": "as in GET /api/state" }] }]
}
```

`agents` lists every agent that has routines, with its armed state and its
routines in the shape of `GET /api/state` (`nextAt` computed at the time of
the request). The interface reads this route every minute and after each run,
so that a next fire that has come moves on, and an agent armed from Telegram
shows it, without loading the state again.

Errors: `INVALID_INPUT` for a bad `limit`.

### `GET /api/fs/dirs`

Lists the sub-folders of a folder, read-only, for the folder explorer behind
« Parcourir » of the « Ajouter une salle » form (a browser never gives the
absolute path of a folder picked in its own dialog). It works only inside the
**projects root**: `projectsRoot` of `myhq.json` (relative to the home, or
absolute), else the parent folder of the home, where the repositories are
usually kept (`home-layout.md`, "myhq.json"). Paths on the wire are relative
to that root, written with `/`; the root itself is the empty path.

Query: `path` (optional, at most 1000 characters): the folder to list, relative
to the root. Other parameters are ignored.

Response `200`:

```json
{
  "rootName": "projects",
  "path": "my-app",
  "parent": "",
  "target": "../my-app",
  "project": true,
  "room": null,
  "dirs": [
    { "name": "src", "path": "my-app/src", "project": false, "room": null }
  ]
}
```

- `rootName`: the last segment of the root, for the first crumb.
- `path`, `parent`: the folder listed and the one above it (`null` at the root).
- `target`: what `POST /api/onboarding` expects for this folder, relative to
  the home (absolute when there is no relative way, another drive).
- `project`: the folder holds a `.git`, a `package.json`, a `pyproject.toml` or
  a README. `room`: the name of the room whose `targetRepo` is this folder, else
  `null`. Both exist for the folder listed and for each entry of `dirs`.
- `dirs`: only folders (no file), sorted by name, without the hidden ones
  (a name starting with `.`) and the heavy ones (`node_modules`, `data`,
  `build`; `.git` and `.next` are hidden). A link is listed only when it leads
  to a folder inside the root.

Errors: `INVALID_INPUT` (a `path` over 1000 characters), `PATH_OUTSIDE_ROOT` (400), `DIR_NOT_FOUND` (404),
`ROOT_NOT_FOUND` (404). A path that leaves the root is refused, never trimmed.

### `POST /api/onboarding`

Starts a run of the onboarding agent on a repository and returns at once; its
room proposal arrives on the desk as a `room_proposal` approval. Same lock
(one onboarding run at a time) and daily cap as any run.

Body: `{ "path": "../my-project" }` (relative to the home, or absolute).
Response `202`: `{ "run": { "room": "_hq", "agentId": "onboarding", "...": "Run shape" } }`.

Errors: `INVALID_JSON`, `INVALID_INPUT`, `TARGET_NOT_FOUND` (404),
`AGENT_BUSY` (409), `DAILY_CAP_REACHED` (429).

### `POST /api/agents/propose`

Starts a run of the receptionist in agent mode for a need no agent covers,
and returns at once; its proposal arrives on the desk as an `agent_proposal`
approval (`architecture.md`, "Proposing a missing agent"). Same lock as the
onboarding runs (it is the same agent) and same daily cap as any run. Run
reason `agent_need`.

Body: `{ "need": "Draw the illustrations of the site.", "room": "demo" }`.
`need`: 1 to 2000 characters. `room`, optional: the room the need comes from,
a hint for the receptionist (it must be a room of the home).
Response `202`: `{ "run": { "room": "_hq", "agentId": "onboarding", "reason": "agent_need", "...": "Run shape" } }`.

Errors: `INVALID_JSON`, `INVALID_INPUT`, `ROOM_NOT_FOUND` (404), `AGENT_BUSY`
(409), `DAILY_CAP_REACHED` (429). A refused request keeps nothing: ask again
later.

### `POST /api/export`

Writes the daily export of one day now (and replaces its file). The body is
optional: `{ "date": "2026-11-02" }`, yesterday in `HQ_TIMEZONE` by default.

```json
{ "export": { "date": "2026-11-02", "file": "/abs/path/2026-11-02.json", "runs": 4, "messages": 1, "approvals": 3 } }
```

Errors: `INVALID_JSON`, `INVALID_INPUT`, `EXPORT_NOT_CONFIGURED` (404).

### `GET /api/settings`

The settings the page `/reglages` shows, read fresh from `myhq.json`, the
`room.json` files and the database (`home-layout.md`, "The settings page").
Secrets are never part of it.

```json
{
  "settings": {
    "layout": "floor-per-project",
    "language": { "value": "fr", "options": ["fr", "en"] },
    "timeZone": { "file": null, "effective": "Europe/Paris", "source": "env", "fallback": "Europe/Paris" },
    "scheduler": { "file": true, "effective": true, "source": "file", "fallback": false, "running": true },
    "maxRunsPerDay": { "file": null, "effective": 12, "source": "env", "fallback": 12 },
    "notifyTypes": { "selected": ["brief"], "known": ["mail_alert", "blog_post"] },
    "rooms": [
      {
        "name": "demo",
        "color": "#ff3d7f",
        "shared": false,
        "agents": [
          { "id": "scout", "name": "Scout", "model": "sonnet", "armed": true, "hasRoutines": true, "maxBudgetUsd": 2, "notifySummary": false }
        ]
      }
    ],
    "invalidRooms": [],
    "defaultMaxBudgetUsd": 1,
    "errors": []
  }
}
```

- `timeZone`, `scheduler` and `maxRunsPerDay` carry the value in force
  (`effective`), the value of the `myhq.json` key (`file`, null when unset),
  where the effective one comes from (`source`: `file`, `env`, `default`, and
  `system` for the time zone of the machine) and what applies without the key
  (`fallback`). `running` tells that this process holds the scheduler lock.
- `armed` is the state in force (the database wins over `room.json`).
- `errors` lists the keys of `myhq.json` that are invalid, one line each; those
  keys are ignored (the environment or the default applies).

### `PUT /api/settings/<group>`

Saves one group of the settings page and returns every setting, in the shape
above. `<group>` is one of the four below; the body is validated with zod, unknown
fields are refused, and nothing is written when anything is invalid. Files are
written atomically (temporary file, then rename), keep their unknown keys and use
2-space JSON. The changes apply without a restart.

| Group | Body | Writes |
|---|---|---|
| `layout` | `{ "layout": "room-per-project", "language": "fr", "timeZone": "Europe/Paris" }` (`timeZone` null removes the key) | `floor.layout`, `language`, `timeZone` of `myhq.json` |
| `limits` | `{ "scheduler": true, "maxRunsPerDay": 12 }` (each may be null: the key is removed and the environment applies) | `scheduler`, `maxRunsPerDay` of `myhq.json`; the scheduler starts or stops at once |
| `notifications` | `{ "notifyTypes": ["brief"], "summaries": [{ "room": "demo", "agent": "scout", "summary": true }] }` | `notifyTypes` of `myhq.json` (removed when empty); `notifyRuns: "summary"` of the agents named (removed with `false`) |
| `rooms` | `{ "rooms": [{ "name": "demo", "color": "#ff3d7f", "agents": [{ "id": "scout", "model": "opus", "armed": true, "maxBudgetUsd": 2 }] }] }` (`color` and `maxBudgetUsd` may be null) | `color` of the room, `model` and `maxBudgetUsd` of the agents in `room.json`; the armed state of an agent whose value changed, through the same mechanism as `PATCH /api/rooms/[room]/agents/[agent]` |

`model` is `opus`, `sonnet` or `haiku`; `color` a hex colour (`#rgb` or `#rrggbb`);
`maxBudgetUsd` a number above 0; `maxRunsPerDay` an integer from 0; `timeZone` an
IANA name; `language` a BCP 47 tag; `notifyTypes` snake_case. In `rooms`, only what
differs from the current state is written, and every room is checked (it exists,
the edited file still passes the room schema) before any file is.

Errors: `INVALID_JSON`, `INVALID_INPUT`, `SETTINGS_GROUP_NOT_FOUND`,
`SETTINGS_FILE_INVALID`, `ROOM_NOT_FOUND`, `ROOM_INVALID`, `AGENT_NOT_FOUND`.

## Not in the API

The HQ MCP server is not reached over HTTP: `claude -p` starts it over stdio
for each run (see `architecture.md`). Its seventeen tools write to the same
database, and their effects reach the interface through `/api/events`.

`hq_items` is the one that reads an item's state for an agent, as the
counterpart of the `Approval` objects above (the API is the owner's view, the
tool the agent's, limited to its reach):

- `hq_items { id, maxChars? }` returns `{ id, type, title, status, room, agent,
  forRoom, submittedAt, decidedAt, note, body, bodyTruncated, remarks: [{ quote,
  comment, point? }], files: [{ name, path? }] }`. `status` is `pending`,
  `approved`, `rejected`, `revise`, `unseen` or `seen`. `body` is cut to
  `maxChars` (default 20000, at most 60000). `path` is the absolute path of the
  read-only copy of the file, when it is on disk.
- `hq_items { status?, type? }` returns `{ items: [{ id, type, title, status,
  room, agent, forRoom, submittedAt, decidedAt }], truncated }`: the items
  created or decided in the last 30 days, newest first, at most 50, among the
  items of the agent's room, those delivered for it (`forRoom`) and, for an
  agent of a shared room, those of the rooms that ordered from it.
- It is read-only and never marks a decision seen (unlike `hq_read_decisions`).
  An item out of reach is an error (`outside what you may read`), an unknown id
  is another (`No item #N exists`).
