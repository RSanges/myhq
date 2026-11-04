# MyHQ

MyHQ is a local office where AI agents work in rooms, one room per project, and
bring you what needs your approval. It runs on your own machine: agents run
through the official Claude Code binary (`claude -p`), and everything an agent
wants to publish goes through your approval queue.

**Status: pre-alpha.** The first slice is in place (database, HQ MCP server,
runner, HTTP API, the one-page interface with approval desk, team, live feed
and usage meter), the assistant on Telegram of the second slice (commands,
approval buttons, conversation, voice notes, files, extensions from the home),
and the third slice on the MyHQ side: routines with an armed state and a
journal, generic role templates, `npm run init`, onboarding a project through
the approval queue, and a daily export. The fourth slice adds the animated
floor (`/room`): the plan of a small agency, with its offices, corridors and meeting
room, where agents type,
think, walk to a colleague's office or to yours as their runs happen.

## Concepts

- **Room**: one project. A folder with a `room.json` (target repository, agents,
  routines) and the role prompts of its agents.
- **Agent and role**: an agent is a role (a Markdown system prompt) plus a model,
  a list of allowed tools and a working directory. Roles are plain files you
  can read and edit by hand.
- **Run**: one execution of an agent, a `claude -p` process. Every run records
  its events, tokens and cost.
- **Routine**: a cron of an agent in `room.json`, with an optional task. It
  only starts runs when the agent is armed and the scheduler is on
  (`HQ_SCHEDULER=on`), through the same lock and daily cap as any run, and
  every firing is journaled.
- **Approval queue**: the only way an agent can put something out. A post, a
  public reply, an email or a pull request is submitted as a pending item. You
  approve it, reject it, or ask for a revision.
- **HQ MCP server**: a small MCP server that is the agents' only door to the
  office (messages, submissions, task updates, memory). Everything that goes
  through it is logged.
- **Onboarding**: adding a project is itself an agent run that submits the
  proposed room to your approval queue (« Ajouter une salle », or `/salle
  <path>` on Telegram). The roles are instantiated from generic templates
  shipped in `templates/roles/`. On approval the room is written in your home
  and the developer's Git worktree is created; the project only gets a short
  block for its `CLAUDE.md`, which you add yourself.
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
  assistant.json      the Telegram assistant: chat, voice, files, extensions
  myhq.json           settings of the home, such as the daily export (optional)
  assistant/
    commands/         extensions for the Telegram assistant
  data/               SQLite database, work directories and worktrees (ignored by Git)
```

See [docs/home-layout.md](docs/home-layout.md) for the `room.json`,
`assistant.json` and `myhq.json` schemas, the extension contract, and how to
plug an integration (an MCP server, the official GitHub one for example).

## The assistant on Telegram

Create a bot with BotFather, then set `HQ_TELEGRAM_BOT_TOKEN` and
`HQ_TELEGRAM_CHAT_ID` (your own chat with the bot) in `.env.local`. From then
on MyHQ sends you an alert when an item waits for your approval or a run fails.

To talk to it, also set `HQ_TELEGRAM_POLLING=true`. MyHQ then reads the bot's
messages by long polling (no inbound port, nothing exposed): `/pending`,
`/approve`, `/reject`, `/revise`, `/run`, `/status`, `/arm`, `/disarm`,
`/salle`, buttons on approval alerts, and a conversation with `claude -p`
configured in `<home>/assistant.json`. Polling is off by default because a bot can only
have one reader: switch off any other program that reads the same bot first.

## Stack

Next.js 16, TypeScript (strict), Tailwind, SQLite via `better-sqlite3`, zod, the
official MCP SDK, and PixiJS for the room view (loaded on `/room` only). No ORM
and no UI library. It must run unchanged on Windows,
macOS and Linux, and it is meant to stay up as a service (pm2) on port 4242.

More in [docs/architecture.md](docs/architecture.md) and
[CLAUDE.md](CLAUDE.md) (working rules for Claude Code sessions in this repo).

## Getting started

Requirements: Node.js 22 or later, and the Claude Code CLI installed natively
and signed in (`claude` in your PATH).

```sh
npm install
npm run init                 # home, claude check, .env.local, database
npm run dev                  # http://127.0.0.1:4242
npm test                     # Node test runner, no network, no Claude run
```

`npm run init` asks a few questions (home directory, optional Telegram bot,
daily cap, port, time zone) and can be run again at any time: it keeps what
is already there. Answers can also be piped, one per line. Every variable is
documented in [.env.example](.env.example).

Routines stay off until you set `HQ_SCHEDULER=on` in `.env.local` and arm an
agent (the switch on its card, or `/arm <room>/<agent>`). The HTTP API is
described in [docs/api.md](docs/api.md). The raw output of each run is kept in
`<home>/data/runs/<run>.jsonl`.

## Trying the room without a real run

`/room` animates the agents from the real event stream. To see it move without
spending a run, `scripts/replay-fixture.ts` plays a recorded run (the files of
`test/fixtures/*.jsonl`) into a **throwaway** home, one event per second, and
a MyHQ pointed at that home streams it like a real one:

```sh
# terminal 1: prepares <tmp>/myhq-replay-home (a neutral room of three agents) and waits 8 seconds
npx tsx scripts/replay-fixture.ts test/fixtures/stream-json-onboarding.jsonl

# terminal 2: an app on another port, on that home, never on your real one
MYHQ_HOME=<the folder the script printed> HQ_TELEGRAM_POLLING=false HQ_TELEGRAM_BOT_TOKEN= HQ_TELEGRAM_CHAT_ID= npm run dev -- -p 4343
# then open http://127.0.0.1:4343/room before the wait is over
```

The onboarding fixture has reads and an `hq_submit` (the agent walks to your
desk and drops a folder in the tray), `stream-json-message.synthetic.jsonl`
an `hq_message` (a walk to a colleague's table, a synthetic file, see its first
line), `stream-json-auth-error.jsonl` a failed run (a question mark). Options:
`--agent <id>` (scout, writer or analyst by default; `onboarding` plays the
receptionist at the reception desk of the floor), `--agents <n>` (a floor of
2 to 12 offices), `--interval <ms>`, `--delay <s>`, `--home <dir>`. The script refuses a folder it did not create, so it never
writes into your real home, and it never starts `claude`.

## Running as a service

MyHQ is meant to stay up, not to live in a terminal. It runs under
[pm2](https://pm2.keymetrics.io/) with [ecosystem.config.cjs](ecosystem.config.cjs)
(`next start` on 127.0.0.1:4242).

```sh
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 save                     # remember the process list for resurrect
```

From then on, closing the terminal does not stop the app. Useful commands:
`pm2 status`, `pm2 logs myhq`, `pm2 restart myhq`. After pulling new code:
`npm install`, `npm run build`, then `pm2 restart myhq`.

### Restart at boot on Windows

pm2 has no startup hook on Windows: a scheduled task runs `pm2 resurrect` when
you log on. In PowerShell, once:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command pm2 resurrect"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "MyHQ (pm2 resurrect)" -Action $action -Trigger $trigger -Settings $settings -Description "Restarts MyHQ at logon"
```

The task runs as your user, so agents find your Claude Code login and pm2 its
saved process list (`%USERPROFILE%\.pm2`). To start before anyone logs on, use
`New-ScheduledTaskTrigger -AtStartup` instead, and register the task with
`-User $env:USERNAME -Password <your password>` (run whether the user is logged
on or not). Test it with `Start-ScheduledTask "MyHQ (pm2 resurrect)"` then
`pm2 status`; remove it with `Unregister-ScheduledTask "MyHQ (pm2 resurrect)"`.

### Restart at boot on Linux

```sh
pm2 startup                  # prints a command to run once with sudo
pm2 save
```

## Accès depuis le téléphone et le Mac (Tailscale)

MyHQ listens on `127.0.0.1` only, and that does not change. To read and
validate from your phone or your Mac, put the PC and your devices on a private
[Tailscale](https://tailscale.com/) network (a tailnet) and let Tailscale serve
the app over HTTPS on that network. Nothing is exposed to the Internet.

1. Install Tailscale on the PC and sign in.
2. Install it on the phone and on the Mac, and sign in with the **same
   account**. The three devices now see each other.
3. On the PC, publish the app on the tailnet:

   ```sh
   tailscale serve --bg 4242
   ```

   or, spelled out: `tailscale serve --bg --https=443 http://127.0.0.1:4242`.
   Tailscale answers on `https://<machine>.<tailnet>.ts.net` with its own
   certificates (enable HTTPS in the admin console if it asks) and forwards to
   the local app. Check it with `tailscale serve status`. If you changed
   `HQ_PORT`, use that port instead of 4242.
4. In `.env.local`, set the address the alerts will point to, then restart the
   service (`pm2 restart myhq --update-env`):

   ```sh
   HQ_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
   ```

   Every Telegram alert about an item then ends with « Ouvrir : <url>/#approval-<id> »,
   a failed run links to `/#run-<id>`, and a brief or a summary ends with
   « Bureau : <url> ». The link opens the desk on that item: the right tab, the
   body open, the item highlighted for a moment. Without `HQ_PUBLIC_URL`,
   alerts are unchanged.
5. Open the address on the phone or the Mac (or follow a link of an alert).

The tailnet is the access control: only the devices signed in to your account
can reach the address, and MyHQ has no login of its own. Do not use
`tailscale funnel`, which would open it to the Internet. To undo, run
`tailscale serve reset` (and unset `HQ_PUBLIC_URL`).

## Why not the Agent SDK

Claude subscription terms allow using the unmodified Claude Code binary on a
personal plan, and driving it with `claude -p` stays inside that frame. Using
the Agent SDK with a subscription does not, so MyHQ never does.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Romain Sanges.
