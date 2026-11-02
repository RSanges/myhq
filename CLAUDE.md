# MyHQ: project rules

MyHQ is a local office where AI agents work in rooms, one room per project, and
bring the user what needs their approval. Read `README.md` first, then
`docs/architecture.md` (how it works) and `docs/home-layout.md` (what a home
directory looks like).

- **Language**: code, comments, docs and commit messages in English. The user
  interface is in French for now, with every string centralized in a single
  module so it can be translated later. No em dashes or en dashes anywhere, in
  any file or message (use colons, commas, parentheses).
- **Models**: the orchestrating session never works as a worker. Room agents run
  on Opus, Sonnet or Haiku depending on the role, through the official Claude
  Code binary (`claude -p`), never through the Agent SDK. A second "local"
  engine (OpenAI-compatible endpoint) is planned behind the same interface,
  not implemented.
- **Security**: no production secrets in this repository or in the agents'
  environment. Deployments and anything like `db:push`, `vercel` or
  `eas submit` are denied to agents. An agent writes only in its own working
  directory (a dedicated Git worktree for agents that write code).
- **Approval**: anything published under a project's name (post, public reply,
  email, pull request) goes through the approval queue.
- **Metering**: every run records its tokens and cost.
- **Stack**: Next.js 16 (read `node_modules/next/dist/docs/` before writing
  Next.js code, this version differs from what models remember), strict
  TypeScript, Tailwind, SQLite via `better-sqlite3`, zod on every input,
  minimum dependencies, no ORM, no UI library.
- **Portability**: relative paths, SQLite, no OS-specific dependency except
  optional notifications. The app must move unchanged from Windows to Linux.
- **Home directory**: rooms, role prompts, data and personal extensions are
  loaded from `MYHQ_HOME` (absolute path, or relative to the repository root;
  default `./home`, ignored by Git). Nothing personal is ever committed in this
  repository: no real project names, no people, no paths of a given machine,
  no budget figures. The maintainer's own home lives in a private repository.
- **Always on**: the app runs as a pm2 service (`next build` then `next start`
  on port 4242), not as a `npm run dev` left open.
