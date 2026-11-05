import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqReadDecisions, hqSubmit, type HqContext } from "../src/mcp/tools";
import { decisionText, parseAnnotations, pointText, type Annotation } from "../src/server/annotations";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt } from "../src/server/db";
import { insertAnnotation } from "../src/ui/annotate";
import { containBox, imagePoint, pinShownAt, pointInPicture, pointQuote, videoPoint } from "../src/ui/attachments-model";
import { makeHome } from "./helpers";

test("a point of an image is the same at any size it is shown: shares of its width and height", () => {
  // The image fills its own box (no bands): shown at 800 x 450, then at 320 x 180 (a phone), then enlarged.
  const sizes = [
    { width: 800, height: 450 },
    { width: 320, height: 180 },
    { width: 1600, height: 900 },
  ];
  for (const size of sizes) {
    const drawn = containBox(size, null);
    assert.deepEqual(drawn, { left: 0, top: 0, ...size });
    assert.deepEqual(pointInPicture(size.width * 0.62, size.height * 0.18, drawn), { x: 0.62, y: 0.18 });
  }
  // Kept to the thousandth; the corners and the edges are in, beyond them is not.
  assert.deepEqual(pointInPicture(123.456, 0, containBox({ width: 400, height: 300 }, null)), { x: 0.309, y: 0 });
  assert.deepEqual(pointInPicture(400, 300, containBox({ width: 400, height: 300 }, null)), { x: 1, y: 1 });
  assert.equal(pointInPicture(-1, 10, containBox({ width: 400, height: 300 }, null)), null);
  assert.equal(pointInPicture(10, 301, containBox({ width: 400, height: 300 }, null)), null);
});

test("a point of a video's frame leaves out the black bands of the player", () => {
  // A 1920 x 1080 frame in a 640 x 640 player: drawn 640 x 360, a band of 140 above and below.
  const drawn = containBox({ width: 640, height: 640 }, { width: 1920, height: 1080 });
  assert.deepEqual(drawn, { left: 0, top: 140, width: 640, height: 360 });
  assert.equal(pointInPicture(320, 100, drawn), null, "a click in a band is not on the frame");
  assert.deepEqual(pointInPicture(256, 140 + 252, drawn), { x: 0.4, y: 0.7 });
  // The same spot of the frame in a wide player (bands beside it) gives the same point.
  const wide = containBox({ width: 1000, height: 360 }, { width: 1920, height: 1080 });
  assert.deepEqual(wide, { left: 180, top: 0, width: 640, height: 360 });
  assert.deepEqual(pointInPicture(180 + 256, 252, wide), { x: 0.4, y: 0.7 });
  // A portrait frame (9:16) in a landscape player.
  const portrait = containBox({ width: 800, height: 450 }, { width: 1080, height: 1920 });
  assert.equal(portrait.height, 450);
  assert.ok(Math.abs(portrait.width - 253.125) < 1e-9 && Math.abs(portrait.left - 273.4375) < 1e-9);
  // Before the frame is known, the whole box.
  assert.deepEqual(containBox({ width: 640, height: 360 }, { width: 0, height: 0 }), { left: 0, top: 0, width: 640, height: 360 });
});

test("quotes: the image in percent of its width and height, the video with its time and its point", () => {
  assert.equal(pointQuote("cover.png", imagePoint(1, { x: 0.6234, y: 0.1844 })), "cover.png, point à 62 % de la largeur et 18 % de la hauteur");
  assert.equal(pointQuote("clip-01.mp4", videoPoint(2, { x: 0.4, y: 0.7 }, 12.4)), "clip-01.mp4 à 0:12, point à 40 % ; 70 %");
  assert.equal(pointQuote("long.mp4", videoPoint(2, { x: 0, y: 1 }, 3_725.9)), "long.mp4 à 1:02:05, point à 0 % ; 100 %");
  assert.deepEqual(imagePoint(1, { x: 1.2, y: -0.1 }), { fileId: 1, kind: "image", x: 1, y: 0 }, "kept inside the image");
  assert.deepEqual(videoPoint(2, { x: 0.4, y: 0.7 }, 12.40049), { fileId: 2, kind: "video", x: 0.4, y: 0.7, t: 12.4 }, "the time to the millisecond");
});

test("a video's pin shows within half a second of its time", () => {
  assert.equal(pinShownAt(12.4, 12.4), true, "paused on it");
  assert.equal(pinShownAt(12.4, 12.0), true);
  assert.equal(pinShownAt(12.4, 12.89), true);
  assert.equal(pinShownAt(12.4, 12.9), false);
  assert.equal(pinShownAt(12.4, 11.9), false);
  assert.equal(pinShownAt(0, 0.3), true);
});

test("a point is checked by its kind: an image or a video in shares of 0 to 1, a video with its time", () => {
  const ok = (point: unknown) =>
    decisionSchema.safeParse({ decision: "revise", annotations: [{ quote: "cover.png, point", comment: "Ici.", point }] }).success;
  assert.equal(ok({ fileId: 4, kind: "image", x: 0.62, y: 0.18 }), true);
  assert.equal(ok({ fileId: 4, kind: "image", x: 1.2, y: 0.18 }), false);
  assert.equal(ok({ fileId: 4, kind: "image", x: 0.5, y: -0.01 }), false);
  assert.equal(ok({ fileId: 4, kind: "image", x: 0.5, y: 0.5, t: 3 }), false, "an image has no time");
  assert.equal(ok({ fileId: 4, kind: "image", x: 0.5, y: 0.5, z: 1, normal: [0, 0, 1] }), false);
  assert.equal(ok({ fileId: 5, kind: "video", x: 0.4, y: 0.7, t: 12.4 }), true);
  assert.equal(ok({ fileId: 5, kind: "video", x: 0.4, y: 0.7 }), false, "a video's point needs its time");
  assert.equal(ok({ fileId: 5, kind: "video", x: 0.4, y: 0.7, t: -1 }), false);
  assert.equal(ok({ fileId: 6, kind: "model", x: 12, y: -3, z: 8, normal: [0, 0, 1] }), true);
  assert.equal(ok({ fileId: 6, kind: "model", x: 0.5, y: 0.5 }), false, "a part's point needs its z and its normal");
  assert.equal(ok({ fileId: 6, kind: "sound", x: 0.5, y: 0.5 }), false);
});

test("the 3D pins stored before images and videos had theirs read as they did", () => {
  // As the annotations column holds them since the 3D viewer: no kind.
  const stored = JSON.stringify([
    { quote: "piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z", comment: "Paroi trop fine ici.", point: { fileId: 4, x: 12.4, y: -3, z: 8.5, normal: [0, 0, 1] } },
  ]);
  const [remark] = parseAnnotations(stored);
  assert.deepEqual(remark?.point, { fileId: 4, x: 12.4, y: -3, z: 8.5, normal: [0, 0, 1] }, "read unchanged, no kind added");
  assert.equal(
    pointText(remark!.point!),
    "Point dans le repère de la pièce (mm) : x=12.4 y=-3.0 z=8.5 ; normale sortante de la face : (0.00, 0.00, 1.00)",
  );
  assert.equal(pointQuote("piece.3mf", remark!.point!), "piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z");
  // The same point with its kind reads the same.
  assert.equal(pointText({ ...remark!.point!, kind: "model" }), pointText(remark!.point!));
});

test("remarks on an image and a video's frame reach the agent with their points, in the revision task and hq_read_decisions", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  db.prepare("INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'scout', 'claude', 't', 'running', ?)").run(
    new Date().toISOString(),
  );
  const work = path.join(config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(path.join(work, "out"), { recursive: true });
  fs.writeFileSync(path.join(work, "out", "cover.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(work, "out", "clip-01.mp4"), Buffer.from("000000186674797069736f6d", "hex"));
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "scout", room: "demo", home: config.home, workDir: work };
  const { approvalId } = hqSubmit(db, ctx, {
    type: "visuel",
    title: "Cover",
    body: "La couverture et le teaser.",
    attachments: [{ path: "out/cover.png" }, { path: "out/clip-01.mp4" }],
  });
  const files = db.prepare("SELECT id, name FROM approval_files WHERE approval_id = ? ORDER BY id").all(approvalId) as { id: number; name: string }[];
  const [cover, clip] = files;
  assert.ok(cover && clip);

  const onImage = imagePoint(cover.id, pointInPicture(496, 81, containBox({ width: 800, height: 450 }, null))!);
  const onFrame = videoPoint(clip.id, { x: 0.4, y: 0.7 }, 12.4);
  let annotations: Annotation[] = [{ quote: "La couverture", comment: "Titre plus court.", position: 0 }];
  annotations = insertAnnotation(annotations, { quote: pointQuote(cover.name, onImage), comment: "Logo trop près du bord.", point: onImage });
  annotations = insertAnnotation(annotations, { quote: pointQuote(clip.name, onFrame), comment: "Le texte passe sous le visage.", point: onFrame });

  decideApproval(db, approvalId, { decision: "revise", annotations });
  const stored = parseAnnotations((db.prepare("SELECT annotations FROM approvals WHERE id = ?").get(approvalId) as { annotations: string }).annotations);
  assert.deepEqual(stored[1]?.point, { fileId: cover.id, kind: "image", x: 0.62, y: 0.18 });
  assert.deepEqual(stored[2]?.point, { fileId: clip.id, kind: "video", x: 0.4, y: 0.7, t: 12.4 });

  const expected = [
    "1. À propos de « La couverture » : Titre plus court.",
    "2. À propos de « cover.png, point à 62 % de la largeur et 18 % de la hauteur » : Logo trop près du bord.",
    "   Point sur l'image : 62 % depuis la gauche, 18 % depuis le haut",
    "3. À propos de « clip-01.mp4 à 0:12, point à 40 % ; 70 % » : Le texte passe sous le visage.",
    "   Point sur l'image de la vidéo à 0:12 (12.40 s) : 40 % depuis la gauche, 70 % depuis le haut",
  ].join("\n");
  const task = db.prepare("SELECT text FROM tasks WHERE source = 'revise' AND ref_id = ?").get(approvalId) as { text: string };
  assert.equal(task.text, `Revise your submission #${approvalId} "Cover" (visuel). User's remarks:\n${expected}`);
  assert.equal(hqReadDecisions(db, ctx).decisions[0]?.note, expected);
  assert.equal(decisionText("Bien dans l'ensemble.", stored), `${expected}\n\nRemarque générale : Bien dans l'ensemble.`);
});
