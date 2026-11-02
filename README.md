# MyHQ

MyHQ is a local office where AI agents work in rooms, one room per project, and
bring you what needs your approval. It runs on your own machine: agents run
through the official Claude Code binary (`claude -p`), and everything an agent
wants to publish goes through your approval queue.

**Status: early, pre-alpha, nothing runnable yet.** This repository currently
holds the project rules and the architecture. The first slice (the core) is
the next thing to be built.

## Concepts

- **Room**: one project. A folder with a `room.json` (target repository, agents,
  routines) and the role prompts of its agents.
- **Agent and role**: an agent is a role (a Markdown system prompt) plus a model,
  a list of allowed tools and a working directory. Roles are plain files you
  can read and edit by hand.
- **Run**: one execution of an agent, a `claude -p` process. Every run records
  its events, tokens and cost.
- **Approval queue**: the only way an agent can put something out. A post, a
  public reply, an email or a pull request is submitted as a pending item. You
  approve it, reject it, or ask for a revision.
- **HQ MCP server**: a small MCP server that is the agents' only door to the
  office (messages, submissions, task updates, memory). Everything that goes
  through it is logged.
- **Onboarding**: adding a project is itself an agent run that submits the
  proposed room to your approval queue. The project only gets a short block in
  its `CLAUDE.md`, nothing else.
- **The assistant on Telegram**: notifies you when an item waits for you or a
  run fails, lets you approve from your phone, and can be extended with
  commands of your own.

## Home directory

MyHQ loads your rooms, role prompts and data from a *home* directory, set by
the `MYHQ_HOME` environment variable (absolute path, or relative to the root of
this repository). The default is `./home`, which is ignored by Git. You can
also point it at a separate repository of your own, so that your prompts and
data never mix with the code.

```
<home>/
  rooms/
    <room>/
      room.json
      roles/
        <agent>.md
  assistant/
    commands/         extensions for the Telegram assistant
  data/               SQLite database and work directories (ignored by Git)
```

See [docs/home-layout.md](docs/home-layout.md) for the `room.json` schema.

## Stack

Next.js 16, TypeScript (strict), Tailwind, SQLite via `better-sqlite3`, zod, the
official MCP SDK. No ORM and no UI library. It must run unchanged on Windows,
macOS and Linux, and it is meant to stay up as a service (pm2) on port 4242.

More in [docs/architecture.md](docs/architecture.md) and
[CLAUDE.md](CLAUDE.md) (working rules for Claude Code sessions in this repo).

## Why not the Agent SDK

Claude subscription terms allow using the unmodified Claude Code binary on a
personal plan, and driving it with `claude -p` stays inside that frame. Using
the Agent SDK with a subscription does not, so MyHQ never does.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Romain Sanges.
