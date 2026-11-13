import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { app } from "../src/server/app";
import { liveFileResponse, liveRoomResponse, liveRunResponse } from "../src/server/live-routes";
import { makeHome } from "./helpers";

test("the live routes: the tiles, one run, and its media file with a weak ETag that is revalidated", async () => {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "sonnet", allowedTools: ["Write"], pieces: ["renders/*.png"] }],
    },
  );
  const saved = process.env.MYHQ_HOME;
  process.env.MYHQ_HOME = config.home;
  try {
    // First, so that the startup of the app (which closes interrupted runs) is behind us.
    const { db } = app();
    const started = Date.now() - 60_000;
    const runId = Number(
      db
        .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)")
        .run(new Date(started).toISOString()).lastInsertRowid,
    );
    const work = path.join(config.home, "data", "work", "demo", "scout");
    fs.mkdirSync(path.join(work, "renders"), { recursive: true });
    fs.writeFileSync(path.join(work, "renders", "a.png"), "png bytes");
    fs.writeFileSync(path.join(work, "secret.png"), "not a piece");

    const live = (await liveRoomResponse().json()) as { now: string; tiles: { runId: number; piece: { versions: { url: string }[] } }[] };
    assert.ok(Date.parse(live.now) > 0);
    assert.equal(live.tiles.length, 1);
    const url = live.tiles[0]!.piece.versions[0]!.url;
    assert.match(url, new RegExp(`^/api/live/runs/${runId}/file\\?path=renders%2Fa\\.png&v=\\d+$`));

    const one = (await liveRunResponse(String(runId)).json()) as { tile: { runId: number }; timeline: unknown[] };
    assert.equal(one.tile.runId, runId);
    assert.deepEqual(one.timeline, []);
    assert.equal((await liveRunResponse("999")).status, 404);
    assert.equal((await liveRunResponse("abc")).status, 400);

    const file = await liveFileResponse(new Request(`http://x${url}`), String(runId));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.equal(file.headers.get("cache-control"), "private, no-cache");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    const etag = file.headers.get("etag")!;
    assert.match(etag, /^W\/"9-\d+"$/);
    assert.equal(await file.text(), "png bytes");
    const ranged = await liveFileResponse(new Request(`http://x${url}`, { headers: { range: "bytes=0-2" } }), String(runId));
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), "png");
    assert.equal((await liveFileResponse(new Request(`http://x${url}`, { headers: { "if-none-match": etag } }), String(runId))).status, 304);
    assert.equal((await liveFileResponse(new Request(`http://x${url}`, { method: "HEAD" }), String(runId))).status, 200);

    const absent = await liveFileResponse(new Request("http://x/f?path=renders%2Fnone.png"), String(runId)).text();
    const forbidden = await liveFileResponse(new Request("http://x/f?path=secret.png"), String(runId)).text();
    assert.equal(forbidden, absent, "the same answer whether the file exists or not");
    for (const bad of ["secret.png", "renders/none.png", "../x.png"]) {
      const refused = await liveFileResponse(new Request(`http://x/f?path=${encodeURIComponent(bad)}`), String(runId));
      assert.equal(refused.status, 404, bad);
      assert.doesNotMatch(await refused.text(), /secret|none|\.\./, "the answer does not repeat the path");
    }
    assert.equal((await liveFileResponse(new Request("http://x/f"), String(runId))).status, 400);
  } finally {
    if (saved === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved;
  }
});
