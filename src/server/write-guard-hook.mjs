// MyHQ write guard: a Claude Code PreToolUse hook (plain JavaScript, no
// dependency, so that it starts fast with `node`).
//
// MyHQ installs it in `<working directory>/.claude/settings.local.json` before
// each agent run and chat turn (see write-guard.ts), and gives it the write
// roots of that run in the MYHQ_WRITE_GUARD environment variable (JSON, see
// GuardConfig in write-guard-lib.mjs). Claude Code runs it before every Write, Edit, MultiEdit
// and NotebookEdit call, with the call as JSON on stdin. It refuses (exit
// code 2, reason on stderr, which Claude Code shows to the model) any write
// whose resolved path (links resolved, case ignored where the file system
// ignores it) leaves the roots; it says nothing (exit code 0, no output) when
// the write is inside them, so the CLI's own permission flow goes on. Any
// error (no configuration, unreadable input, a link that cannot be resolved)
// is a refusal: the guard fails closed.

// The decisions live in write-guard-lib.mjs, which must sit beside this file
// (the frozen build copies both). This file is only the entry point: it always
// runs, under whatever name, path or link it is started, and anything that
// goes wrong (a missing library included) ends in a refusal.

async function main() {
  let decision;
  try {
    // Imported here, so that a missing library is a refusal too (exit code 2), never a crash.
    const { decide, readConfig } = await import("./write-guard-lib.mjs");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    decision = decide(JSON.parse(Buffer.concat(chunks).toString("utf8")), readConfig());
  } catch (error) {
    decision = { allow: false, reason: `MyHQ write guard: write refused: ${error instanceof Error ? error.message : String(error)}.` };
  }
  if (!decision.allow) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
}

void main();
