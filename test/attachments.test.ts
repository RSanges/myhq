import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Assistant } from "../src/assistant/assistant";
import { EMPTY_ASSISTANT_CONFIG } from "../src/assistant/home-config";
import { Telegram } from "../src/assistant/telegram";
import { hqSubmit, readContext, ToolError, type HqContext } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import {
  attachmentMaxBytes,
  attachmentPath,
  AttachmentError,
  findApprovalFile,
  resolveAttachment,
} from "../src/server/attachments";
import { getDbAt, type Db } from "../src/server/db";
import { APPROVAL_SELECT, toApproval, type ApprovalRowWithAction } from "../src/server/feed";
import { fileResponse, parseRange } from "../src/server/file-response";
import { notify, notifyPendingApprovals, type SendOptions } from "../src/server/notify";
import { planTelegramMedia, TELEGRAM_PHOTO_MAX_BYTES, TELEGRAM_UPLOAD_MAX_BYTES } from "../src/server/telegram-media";
import { insertAnnotation } from "../src/ui/annotate";
import { fileEntries, formatTimecode, timedQuote } from "../src/ui/attachments-model";
import type { ApprovalFile } from "../src/ui/schemas";
import { startFakeTelegram } from "./fake-telegram";
import { makeHome } from "./helpers";

const MB = 1024 * 1024;

/** A home, its database, and an agent working directory with a few files. */
function setup(): { db: Db; ctx: HqContext; work: string; dataDir: string } {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  db.prepare(
    "INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'scout', 'claude', 't', 'running', ?)",
  ).run(new Date().toISOString());
  const work = path.join(config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(path.join(work, "livraisons"), { recursive: true });
  fs.writeFileSync(path.join(work, "livraisons", "clip-01.mp4"), Buffer.from("fake mp4 bytes, version 1"));
  fs.writeFileSync(path.join(work, "cover.png"), Buffer.from("fake png"));
  fs.writeFileSync(path.join(work, "notes.txt"), "not a render");
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "scout", room: "demo", home: config.home, workDir: work };
  return { db, ctx, work, dataDir: config.dataDir };
}

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

function approvalDto(db: Db, id: number) {
  return toApproval(db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction);
}

test("attachments: a path out of the working directory is refused, absolute or with ..", () => {
  const { work } = setup();
  for (const bad of ["/etc/passwd.png", "C:\\Windows\\win.png", "C:/x/clip.mp4", "\\\\server\\share\\clip.mp4", "../clip.mp4", "livraisons/../../x.png", "livraisons\\..\\..\\x.png"]) {
    assert.throws(() => resolveAttachment(work, { path: bad }, MB), AttachmentError, bad);
  }
});

test("attachments: a link that leads out of the working directory is refused", (t) => {
  const { work } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-outside-"));
  fs.writeFileSync(path.join(outside, "secret.png"), "outside");
  try {
    // A junction needs no privilege on Windows, and is a plain directory link elsewhere.
    fs.symlinkSync(outside, path.join(work, "escape"), "junction");
  } catch {
    t.skip("cannot create a directory link here");
    return;
  }
  assert.throws(() => resolveAttachment(work, { path: "escape/secret.png" }, MB), /leads out of your working directory/);
});

test("attachments: a missing file, a type outside the list, an empty file or one above the cap is refused", () => {
  const { work } = setup();
  assert.throws(() => resolveAttachment(work, { path: "missing.mp4" }, MB), /does not exist/);
  assert.throws(() => resolveAttachment(work, { path: "notes.txt" }, MB), /not an accepted type/);
  assert.throws(() => resolveAttachment(work, { path: "livraisons" }, MB), /not an accepted type/);
  fs.writeFileSync(path.join(work, "empty.wav"), "");
  assert.throws(() => resolveAttachment(work, { path: "empty.wav" }, MB), /empty/);
  assert.throws(() => resolveAttachment(work, { path: "cover.png" }, 4), /above the cap/);
  const ok = resolveAttachment(work, { path: "livraisons/clip-01.mp4", caption: "Plan 1" }, MB);
  assert.equal(ok.name, "clip-01.mp4");
  assert.equal(ok.mime, "video/mp4");
  assert.equal(ok.caption, "Plan 1");
});

test("attachments: the cap is HQ_ATTACHMENT_MAX_MB, 200 MB by default", () => {
  assert.equal(attachmentMaxBytes({}), 200 * MB);
  assert.equal(attachmentMaxBytes({ HQ_ATTACHMENT_MAX_MB: "20" }), 20 * MB);
  assert.equal(attachmentMaxBytes({ HQ_ATTACHMENT_MAX_MB: "nope" }), 200 * MB);
  const ctx = readContext({ HQ_DB_PATH: "/x/data/hq.db", HQ_RUN_ID: "1", HQ_AGENT_ID: "a", HQ_ROOM: "r", HQ_WORK_DIR: "/w", HQ_ATTACHMENT_MAX_MB: "5" });
  assert.equal(ctx.workDir, "/w");
  assert.equal(ctx.attachmentMaxBytes, 5 * MB);
});

test("hq_submit: the files are copied with their sha256, and the copy does not follow later edits", () => {
  const { db, ctx, work, dataDir } = setup();
  const original = fs.readFileSync(path.join(work, "livraisons", "clip-01.mp4"));
  const result = hqSubmit(db, ctx, {
    type: "video_render",
    title: "Clip",
    body: "Le premier plan.",
    attachments: [{ path: "livraisons/clip-01.mp4", caption: "Plan 1" }, { path: "cover.png" }],
  });
  assert.equal(result.files, 2);
  const dto = approvalDto(db, result.approvalId);
  assert.deepEqual(
    dto.files.map((file) => [file.name, file.mime, file.kind, file.size, file.sha256, file.caption]),
    [
      ["clip-01.mp4", "video/mp4", "video", original.length, sha256(original), "Plan 1"],
      ["cover.png", "image/png", "image", 8, sha256("fake png"), null],
    ],
  );
  const [clip] = dto.files;
  assert.equal(clip!.url, `/api/approvals/${result.approvalId}/files/${clip!.id}`);
  const copy = attachmentPath(dataDir, result.approvalId, clip!.id, clip!.name);
  assert.equal(path.dirname(copy), path.join(dataDir, "attachments", String(result.approvalId)));
  assert.equal(path.basename(copy), `${clip!.id}.mp4`, "named from integers and the extension only");

  // The agent retouches its render: what the owner validates does not change.
  fs.writeFileSync(path.join(work, "livraisons", "clip-01.mp4"), "version 2, longer than the first one");
  assert.deepEqual(fs.readFileSync(copy), original);
  assert.equal(findApprovalFile(db, dataDir, result.approvalId, clip!.id)?.sha256, sha256(original));
  assert.equal(findApprovalFile(db, dataDir, result.approvalId + 1, clip!.id), null, "a file belongs to its item");
});

test("hq_submit: a refused attachment submits nothing, and a run without a working directory takes none", () => {
  const { db, ctx } = setup();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n;
  assert.throws(
    () => hqSubmit(db, ctx, { type: "video_render", title: "T", body: "B", attachments: [{ path: "cover.png" }, { path: "../x.mp4" }] }),
    ToolError,
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, before);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM approval_files").get() as { n: number }).n, 0);
  const noWorkDir: HqContext = { ...ctx, workDir: undefined };
  assert.throws(() => hqSubmit(db, noWorkDir, { type: "t", title: "T", body: "B", attachments: [{ path: "cover.png" }] }), /not available/);
  // Without attachments, nothing changes.
  const plain = hqSubmit(db, noWorkDir, { type: "t", title: "T", body: "B" });
  assert.deepEqual(approvalDto(db, plain.approvalId).files, []);
});

test("file response: the whole file, then 206 with ranges, 416 past the end, 304 on the same ETag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-range-"));
  const file = path.join(dir, "1.mp4");
  fs.writeFileSync(file, "0123456789");
  const info = { path: file, name: "clip-01.mp4", mime: "video/mp4", sha256: "abc", download: false };
  const get = (headers: Record<string, string> = {}, method = "GET") => fileResponse(new Request("http://x/f", { method, headers }), info);

  const full = get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-length"), "10");
  assert.equal(await full.text(), "0123456789");

  const first = get({ range: "bytes=0-1" });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), "bytes 0-1/10");
  assert.equal(first.headers.get("content-length"), "2");
  assert.equal(await first.text(), "01");

  const open = get({ range: "bytes=7-" });
  assert.equal(open.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await open.text(), "789");

  const suffix = get({ range: "bytes=-3" });
  assert.equal(suffix.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await suffix.text(), "789");

  const clamped = get({ range: "bytes=8-100" });
  assert.equal(clamped.headers.get("content-range"), "bytes 8-9/10");

  const past = get({ range: "bytes=10-" });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */10");

  const head = get({ range: "bytes=0-4" }, "HEAD");
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("content-length"), "5");
  assert.equal(await head.text(), "");

  assert.equal(get({ "if-none-match": '"abc"' }).status, 304);
  assert.match(get().headers.get("content-disposition")!, /^inline; filename="clip-01.mp4"/);
  const download = fileResponse(new Request("http://x/f"), { ...info, name: "pièce.3mf", mime: "model/3mf", download: true });
  assert.match(download.headers.get("content-disposition")!, /^attachment; filename="pi_ce.3mf"; filename\*=UTF-8''pi%C3%A8ce.3mf$/);
});

test("parseRange: malformed values serve the whole file", () => {
  assert.equal(parseRange(null, 10), null);
  assert.equal(parseRange("items=0-1", 10), null);
  assert.equal(parseRange("bytes=5-2", 10), null);
  assert.equal(parseRange("bytes=-", 10), null);
  assert.deepEqual(parseRange("bytes=0-1, 4-5", 10), { start: 0, end: 1 });
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
});

test("timed remarks: the quote names the file and the time, and reaches the agent with a revision", () => {
  assert.equal(formatTimecode(12.7), "0:12");
  assert.equal(formatTimecode(245), "4:05");
  assert.equal(formatTimecode(3723), "1:02:03");
  assert.equal(formatTimecode(Number.NaN), "0:00");
  assert.equal(timedQuote("clip-01.mp4", 12.4), "clip-01.mp4 à 0:12");

  const onText = { quote: "le premier plan", comment: "Plus court.", position: 3 };
  const atTime = { quote: timedQuote("clip-01.mp4", 12), comment: "Le raccord saute ici." };
  const list = insertAnnotation([onText], atTime);
  assert.deepEqual(list, [onText, atTime], "a remark at a time goes after the remarks on the text");

  const { db, ctx } = setup();
  const { approvalId } = hqSubmit(db, ctx, { type: "video_render", title: "Clip", body: "Le premier plan.", attachments: [{ path: "livraisons/clip-01.mp4" }] });
  decideApproval(db, approvalId, { decision: "revise", annotations: [atTime] });
  const task = db.prepare("SELECT text FROM tasks WHERE source = 'revise' AND ref_id = ?").get(approvalId) as { text: string };
  assert.match(task.text, /1\. À propos de « clip-01\.mp4 à 0:12 » : Le raccord saute ici\./);
});

test("previews: an image named like a 3D part or a PDF is its preview, shown once", () => {
  const file = (id: number, name: string, kind: ApprovalFile["kind"]): ApprovalFile => ({
    id, name, kind, mime: "x", size: 1, sha256: "", caption: null, url: `/f/${id}`,
  });
  const entries = fileEntries([file(1, "piece.3mf", "model"), file(2, "Piece.png", "image"), file(3, "clip.mp4", "video"), file(4, "other.png", "image")]);
  assert.deepEqual(
    entries.map((entry) => [entry.file.name, entry.preview?.name ?? null]),
    [["piece.3mf", "Piece.png"], ["clip.mp4", null], ["other.png", null]],
  );
});

test("Telegram: the method follows the type and the size of the first file it can carry", () => {
  const f = (id: number, kind: "video" | "image" | "audio" | "model" | "pdf", size: number) => ({ id, kind, size });
  assert.deepEqual(planTelegramMedia([f(1, "video", 5 * MB)], { ffmpeg: false }), { fileId: 1, method: "sendVideo", thumbnail: false });
  assert.deepEqual(planTelegramMedia([f(1, "image", 2 * MB)], { ffmpeg: false }), { fileId: 1, method: "sendPhoto", thumbnail: false });
  assert.deepEqual(planTelegramMedia([f(1, "audio", 2 * MB)], { ffmpeg: false }), { fileId: 1, method: "sendAudio", thumbnail: false });
  // Too heavy for a bot: a thumbnail with ffmpeg, the next file it can carry, or text.
  assert.deepEqual(planTelegramMedia([f(1, "video", TELEGRAM_UPLOAD_MAX_BYTES + 1)], { ffmpeg: true }), { fileId: 1, method: "sendPhoto", thumbnail: true });
  assert.equal(planTelegramMedia([f(1, "video", TELEGRAM_UPLOAD_MAX_BYTES + 1)], { ffmpeg: false }), null);
  assert.deepEqual(
    planTelegramMedia([f(1, "video", TELEGRAM_UPLOAD_MAX_BYTES + 1), f(2, "image", MB)], { ffmpeg: false }),
    { fileId: 2, method: "sendPhoto", thumbnail: false },
  );
  assert.equal(planTelegramMedia([f(1, "image", TELEGRAM_PHOTO_MAX_BYTES + 1)], { ffmpeg: true }), null);
  assert.equal(planTelegramMedia([f(1, "model", MB), f(2, "pdf", MB)], { ffmpeg: true }), null);
});

test("Telegram: a media alert is a multipart upload with its caption and buttons, and falls back to text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-tg-"));
  const file = path.join(dir, "1.mp4");
  fs.writeFileSync(file, "video bytes");
  const env = { HQ_TELEGRAM_BOT_TOKEN: "t0k3n", HQ_TELEGRAM_CHAT_ID: "42", HQ_TELEGRAM_POLLING: "true" };
  const calls: { url: string; body: unknown }[] = [];
  const ok = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body });
    return new Response("{}");
  }) as typeof fetch;
  const media = { method: "sendVideo" as const, file, name: "clip-01.mp4", mime: "video/mp4" };
  assert.equal(await notify("x".repeat(2000), env, ok, { approvalId: 7, media }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.telegram.org/bott0k3n/sendVideo");
  const form = calls[0]!.body as FormData;
  assert.equal(form.get("chat_id"), "42");
  assert.equal((form.get("caption") as string).length, 1024);
  assert.equal(form.get("supports_streaming"), "true");
  assert.match(form.get("reply_markup") as string, /inline_keyboard/);
  const video = form.get("video") as File;
  assert.equal(video.name, "clip-01.mp4");
  assert.equal(await video.text(), "video bytes");

  const urls: string[] = [];
  const refused = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("{}", { status: String(input).endsWith("/sendVideo") ? 413 : 200 });
  }) as typeof fetch;
  assert.equal(await notify("hello", env, refused, { approvalId: 7, media }), true);
  assert.deepEqual(urls.map((url) => url.split("/").pop()), ["sendVideo", "sendMessage"]);
});

test("Telegram: the alert of an item lists its files and carries its video; a 3D part alone stays text", async () => {
  const { db, ctx, work } = setup();
  fs.writeFileSync(path.join(work, "piece.stl"), "solid piece");
  const video = hqSubmit(db, ctx, { type: "video_render", title: "Clip", body: "B", attachments: [{ path: "livraisons/clip-01.mp4" }] });
  const part = hqSubmit(db, ctx, { type: "cad_part", title: "Pièce", body: "B", attachments: [{ path: "piece.stl" }] });
  const sent: { text: string; options?: SendOptions }[] = [];
  await notifyPendingApprovals(db, async (text, options) => {
    sent.push({ text, options });
    return true;
  }, {});
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.options?.approvalId, video.approvalId);
  assert.equal(sent[0]!.options?.media?.method, "sendVideo");
  assert.equal(sent[0]!.options?.media?.name, "clip-01.mp4");
  assert.ok(fs.existsSync(sent[0]!.options!.media!.file), "the copy is sent, not the agent's file");
  assert.match(sent[0]!.text, /Fichiers joints : clip-01\.mp4/);
  assert.equal(sent[1]!.options?.approvalId, part.approvalId);
  assert.equal(sent[1]!.options?.media, undefined);
  assert.match(sent[1]!.text, /Fichiers joints : piece\.stl/);
});

test("Telegram: Approuver on an alert that carries a file edits its caption", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = Number(
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'video_render', 'Clip', 'B', 'pending', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  const fake = await startFakeTelegram("tok");
  const assistant = new Assistant({
    telegram: new Telegram("tok", fake.url),
    chatId: "42",
    config,
    db,
    assistant: EMPTY_ASSISTANT_CONFIG,
    extensions: [],
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    log: () => {},
    typingIntervalMs: 20,
  });
  await assistant.handleUpdate({
    update_id: 1,
    callback_query: { id: "cb1", from: { id: 42 }, message: { message_id: 9, chat: { id: 42 }, caption: "MyHQ : un item attend ta validation" }, data: `hq:a:${id}` },
  } as never);
  await assistant.idle();
  const edits = fake.calls.filter((call) => call.method.startsWith("editMessage"));
  assert.deepEqual(edits.map((call) => call.method), ["editMessageCaption"]);
  assert.equal(edits[0]!.params.caption, "MyHQ : un item attend ta validation\n\nDécision : Approuvé");
  await fake.close();
});
