import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { getState } from "../src/server/feed";
import { HqError } from "../src/server/errors";
import { loadHome } from "../src/server/rooms";
import { sniffImageType, spriteResponse, SPRITE_MAX_BYTES } from "../src/server/sprites";
import { makeHome } from "./helpers";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("sheet")]);
const agent = { id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };

function homeWith(sprite: string | undefined, files: Record<string, Buffer | string> = {}) {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      agents: [{ ...agent, ...(sprite === undefined ? {} : { sprite }) }, { ...agent, id: "writer", name: "Writer" }],
    },
  );
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(config.home, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return config;
}

const get = (config: ReturnType<typeof makeHome>, room: string, agentId: string, headers: HeadersInit = {}) =>
  spriteResponse(new Request(`http://localhost/api/sprites/${room}/${agentId}`, { headers }), config, room, agentId);

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof HqError ? error.code : String(error);
  }
  return undefined;
};

test("serves the sheet declared in room.json, with its type and an ETag", async () => {
  const config = homeWith("rooms/demo/sprites/scout.png", { "rooms/demo/sprites/scout.png": PNG });
  const response = get(config, "demo", "scout");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const etag = response.headers.get("etag");
  assert.match(etag ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);

  const again = get(config, "demo", "scout", { "If-None-Match": etag! });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), etag);

  // A redrawn sheet changes the ETag.
  const file = path.join(config.home, "rooms/demo/sprites/scout.png");
  fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from("more")]));
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.notEqual(get(config, "demo", "scout").headers.get("etag"), etag);
});

test("serves a WebP sheet", async () => {
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
  const config = homeWith("rooms/demo/sprites/scout.webp", { "rooms/demo/sprites/scout.webp": webp });
  assert.equal(get(config, "demo", "scout").headers.get("content-type"), "image/webp");
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(Buffer.from("GIF89a")), null);
});

test("the path is read from the validated room.json, never from the URL", () => {
  const config = homeWith("rooms/demo/sprites/scout.png", {
    "rooms/demo/sprites/scout.png": PNG,
    "secret.png": Buffer.concat([PNG, Buffer.from("secret")]),
  });
  for (const agentId of ["../../secret.png", "..%2F..%2Fsecret.png", "scout/../../secret"]) {
    assert.equal(code(() => get(config, "demo", agentId)), "AGENT_NOT_FOUND");
  }
  assert.equal(code(() => get(config, "../demo", "scout")), "ROOM_NOT_FOUND");
});

test("a sprite path that leaves the home makes the room invalid, and is never served", () => {
  const config = homeWith("../outside.png");
  fs.writeFileSync(path.join(config.home, "..", "outside.png"), PNG);
  assert.equal(loadHome(config.home).rooms.length, 0);
  assert.equal(code(() => get(config, "demo", "scout")), "ROOM_INVALID");
});

test("a wrong extension is refused by the schema", () => {
  const config = homeWith("rooms/demo/sprites/scout.txt", { "rooms/demo/sprites/scout.txt": PNG });
  assert.match(loadHome(config.home).invalid[0]!.error, /\.png or \.webp/);
  assert.equal(code(() => get(config, "demo", "scout")), "ROOM_INVALID");
});

test("a link that points outside the home is refused", (t) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(makeHome().home), "myhq-outside-"));
  fs.writeFileSync(path.join(outside, "scout.png"), PNG);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const config = homeWith("rooms/demo/sprites/scout.png");
  try {
    // A directory junction needs no privilege on Windows.
    fs.symlinkSync(outside, path.join(config.home, "rooms/demo/sprites"), "junction");
  } catch {
    t.skip("links are not allowed on this machine");
    return;
  }
  assert.equal(code(() => get(config, "demo", "scout")), "SPRITE_NOT_FOUND");
});

test("missing file, no sprite, oversized file and fake image all answer SPRITE_NOT_FOUND", () => {
  const missing = homeWith("rooms/demo/sprites/scout.png");
  assert.equal(code(() => get(missing, "demo", "scout")), "SPRITE_NOT_FOUND");
  assert.equal(code(() => get(missing, "demo", "writer")), "SPRITE_NOT_FOUND");
  assert.equal(code(() => get(missing, "demo", "nobody")), "AGENT_NOT_FOUND");
  assert.equal(code(() => get(missing, "nowhere", "scout")), "ROOM_NOT_FOUND");

  const huge = homeWith("rooms/demo/sprites/scout.png", {
    "rooms/demo/sprites/scout.png": Buffer.concat([PNG, Buffer.alloc(SPRITE_MAX_BYTES)]),
  });
  assert.equal(code(() => get(huge, "demo", "scout")), "SPRITE_NOT_FOUND");

  const fake = homeWith("rooms/demo/sprites/scout.png", { "rooms/demo/sprites/scout.png": "<html>not an image</html>" });
  assert.equal(code(() => get(fake, "demo", "scout")), "SPRITE_NOT_FOUND");
});

test("/api/state exposes the sprite URL only for a declared sheet that exists", () => {
  const config = homeWith("rooms/demo/sprites/scout.png", { "rooms/demo/sprites/scout.png": PNG });
  const db = getDbAt(config.dbPath);
  const scheduler = { enabled: false, running: false, timeZone: "Europe/Paris" };
  const agents = getState(db, loadHome(config.home), scheduler).rooms[0]!.agents;
  assert.equal(agents[0]!.sprite, "/api/sprites/demo/scout");
  assert.equal(agents[1]!.sprite, null);

  fs.rmSync(path.join(config.home, "rooms/demo/sprites/scout.png"));
  assert.equal(getState(db, loadHome(config.home), scheduler).rooms[0]!.agents[0]!.sprite, null);
});
