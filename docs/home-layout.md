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
  assistant/
    commands/            extensions for the Telegram assistant
  data/                  created at first launch, ignored by Git
    hq.db                SQLite database
    work/<room>/<agent>/ default working directory of each agent
```

All paths written in `room.json` are relative to the home directory.

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

## roles/*.md

Plain Markdown, passed as is to `--append-system-prompt-file`. It describes who
the agent is, what it does, what it may and may not do, and what it submits to
the approval queue through `hq_submit`. Roles are meant to be read and edited by
hand and versioned with the rest of the home.

## assistant/commands/

Reserved for the Telegram assistant's extensions (commands that are specific to
one user and do not belong in the core). The loading mechanism is designed in
slice 2 (see `architecture.md`).
