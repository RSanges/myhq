// MyHQ read guard: a Claude Code PreToolUse hook (plain JavaScript, no
// dependency, so that it starts fast with `node`).
//
// MyHQ installs it in `<working directory>/.claude/settings.local.json` before
// the door's call and, when the home has `privateDirs`, before each agent run
// and question (see read-guard.ts), and gives it the folders of that call in
// the MYHQ_READ_GUARD environment variable (JSON, see ReadGuardConfig in
// read-guard-lib.mjs). Claude Code runs it before every Read, Glob and Grep
// call, with the call as JSON on stdin. It refuses (exit code 2, reason on
// stderr, which Claude Code shows to the model) a read whose resolved path
// (links resolved, case ignored where the file system ignores it) leaves the
// allowed folders or enters a denied one; it says nothing (exit code 0, no
// output) otherwise, so the CLI's own permission flow goes on. Any error (no
// configuration, unreadable input, a missing library) is a refusal: the guard
// fails closed.

async function main() {
  let decision;
  try {
    // Imported here, so that a missing library is a refusal too (exit code 2), never a crash.
    const { decideRead, readReadConfig } = await import("./read-guard-lib.mjs");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    decision = decideRead(JSON.parse(Buffer.concat(chunks).toString("utf8")), readReadConfig());
  } catch (error) {
    decision = { allow: false, reason: `MyHQ read guard: read refused: ${error instanceof Error ? error.message : String(error)}.` };
  }
  if (!decision.allow) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
}

void main();
