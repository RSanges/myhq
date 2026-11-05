import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Box3, Group, Vector3 } from "three";
import { strToU8, zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { hqReadDecisions, hqSubmit, type HqContext } from "../src/mcp/tools";
import { decisionText, type Annotation } from "../src/server/annotations";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt, type ApprovalRow } from "../src/server/db";
import { insertAnnotation } from "../src/ui/annotate";
import { faceLabel, formatMm, modelFormat, pointQuote, roundPoint } from "../src/ui/attachments-model";
import { loadModel, pointInPart, threeMfScale } from "../src/ui/model-load";
import { makeHome } from "./helpers";

/** A binary STL of the given triangles (millimetres). */
function stl(triangles: number[][][]): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + 50 * triangles.length);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, index) => {
    triangle.flat().forEach((value, k) => view.setFloat32(84 + index * 50 + 12 + k * 4, value, true));
  });
  return buffer;
}

/** A GLB of one triangle without normals (glTF: metres, Y up). */
function glb(vertices: number[][]): ArrayBuffer {
  const bin = new Float32Array(vertices.flat());
  const min = [0, 1, 2].map((axis) => Math.min(...vertices.map((v) => v[axis]!)));
  const max = [0, 1, 2].map((axis) => Math.max(...vertices.map((v) => v[axis]!)));
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length, type: "VEC3", min, max }],
    bufferViews: [{ buffer: 0, byteLength: bin.byteLength }],
    buffers: [{ byteLength: bin.byteLength }],
  });
  const jsonBytes = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, " "));
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.byteLength, 8);
  const chunk = (length: number, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.writeUInt32LE(type, 4);
    return head;
  };
  const all = Buffer.concat([header, chunk(jsonBytes.length, 0x4e4f534a), jsonBytes, chunk(bin.byteLength, 0x004e4942), Buffer.from(bin.buffer)]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

/** A 3MF package whose root model has the given `<model>` attributes. */
function threeMf(modelAttributes: string): ArrayBuffer {
  const zip = zipSync({
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    "3D/3dmodel.model": strToU8(`<?xml version="1.0"?><model ${modelAttributes} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>`),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

const sizeOf = (object: Group) => {
  const box = new Box3().setFromObject(object, true);
  return { min: box.min.toArray().map((v) => Math.round(v * 1000) / 1000), max: box.max.toArray().map((v) => Math.round(v * 1000) / 1000) };
};

test("viewer: the format follows the extension, whatever its case; anything else is no 3D part", () => {
  assert.equal(modelFormat("piece.3mf"), "3mf");
  assert.equal(modelFormat("Piece.3MF"), "3mf");
  assert.equal(modelFormat("bracket.v2.stl"), "stl");
  assert.equal(modelFormat("scene.glb"), "glb");
  assert.equal(modelFormat("piece.step"), null);
  assert.equal(modelFormat("piece_planche.png"), null);
  assert.equal(modelFormat("notice.pdf"), null);
  assert.equal(modelFormat("3mf"), null);
});

test("viewer: an STL is read in millimetres, as it is", async () => {
  const part = await loadModel("stl", stl([[[0, 0, 0], [12, 0, 0], [0, 5, 3]]]));
  assert.deepEqual(sizeOf(part), { min: [0, 0, 0], max: [12, 5, 3] });
});

test("viewer: a GLB in metres with Y up comes back in millimetres with Z up", async () => {
  // glTF +Y is up and +Z is the front: they become +Z and -Y.
  const part = await loadModel("glb", glb([[0, 0, 0], [0.01, 0, 0], [0, 0.02, 0.03]]));
  assert.deepEqual(sizeOf(part), { min: [0, -30, 0], max: [10, 0, 20] });
});

test("viewer: a 3MF says its unit, millimetre when it does not", async () => {
  assert.equal(await threeMfScale(threeMf('unit="millimeter"')), 1);
  assert.equal(await threeMfScale(threeMf('unit="inch"')), 25.4);
  assert.equal(await threeMfScale(threeMf('xml:lang="en-US" unit="centimeter"')), 10);
  assert.equal(await threeMfScale(threeMf("")), 1);
  assert.equal(await threeMfScale(threeMf('unit="furlong"')), 1);
  assert.equal(await threeMfScale(new TextEncoder().encode("not a zip").buffer as ArrayBuffer), 1);
});

test("citation: a point hit on the placed part is given in the part's frame, with the face seen", async () => {
  const part = await loadModel("stl", stl([[[0, 0, 0], [40, 0, 0], [0, 30, 0]]]));
  // The viewer centres the part and sets it on its grid: the scene is no longer the part's frame.
  const placement = new Group();
  placement.position.set(-20, -15, 5);
  placement.add(part);
  placement.updateMatrixWorld(true);
  const hit = new Vector3(12.44, -3.04, 8.46).add(placement.position);
  // An inverted face seen from above: its normal is turned towards the camera.
  const { point, normal } = pointInPart(part, hit, new Vector3(0, 0, -1), new Vector3(0, 0, -1));
  const stored = roundPoint(7, point, normal);
  assert.deepEqual(stored, { fileId: 7, x: 12.4, y: -3, z: 8.5, normal: [0, 0, 1] });
  assert.equal(pointQuote("piece.3mf", stored), "piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z");

  // A GLB: the point comes back in millimetres, Z up, not in the file's metres.
  const converted = await loadModel("glb", glb([[0, 0, 0], [0.01, 0, 0], [0, 0.02, 0.03]]));
  const corner = converted.localToWorld(new Vector3(0, 0, 20));
  assert.deepEqual(roundPoint(1, pointInPart(converted, corner, new Vector3(-1, 0, 0)).point, new Vector3(-1, 0, 0)), {
    fileId: 1,
    x: 0,
    y: 0,
    z: 20,
    normal: [-1, 0, 0],
  });
});

test("citation: rounded to the tenth, never -0,0; the normal is unit, and named by its axis when it is one", () => {
  assert.equal(formatMm(-0.04), "0,0");
  assert.equal(formatMm(0.05), "0,1");
  assert.equal(formatMm(-12.36), "-12,4");
  assert.equal(formatMm(1234.5), "1234,5");
  const point = roundPoint(3, { x: -0.04, y: 99.96, z: 1e-9 }, { x: 0, y: 0, z: -5 });
  assert.deepEqual(point, { fileId: 3, x: 0, y: 100, z: 0, normal: [0, 0, -1] });
  assert.equal(faceLabel([0, 0, -1]), "face -Z");
  assert.equal(faceLabel([1, 0, 0]), "face +X");
  assert.equal(faceLabel([0, -0.999, 0.04]), "face -Y", "within 5 degrees of an axis");
  assert.equal(faceLabel([0.71, 0, 0.71]), "normale (0,71 ; 0,00 ; 0,71)");
  assert.equal(pointQuote("bracket.stl", roundPoint(1, { x: 5, y: 0, z: 2 }, { x: 1, y: 0, z: 1 })), "bracket.stl, point (5,0 ; 0,0 ; 2,0) mm, normale (0,71 ; 0,00 ; 0,71)");
});

test("a remark on a point is stored with its point and reaches the agent with it, in the revision task", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  db.prepare("INSERT INTO runs (id, room, agent_id, engine, task, status, started_at) VALUES (1, 'demo', 'scout', 'claude', 't', 'running', ?)").run(
    new Date().toISOString(),
  );
  const work = path.join(config.home, "data", "work", "demo", "scout");
  fs.mkdirSync(path.join(work, "out"), { recursive: true });
  fs.writeFileSync(path.join(work, "out", "piece.stl"), Buffer.from(stl([[[0, 0, 0], [40, 0, 0], [0, 30, 0]]])));
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "scout", room: "demo", home: config.home, workDir: work };
  const { approvalId } = hqSubmit(db, ctx, { type: "piece_3mf", title: "Bracket", body: "Le support.", attachments: [{ path: "out/piece.stl" }] });
  const fileId = (db.prepare("SELECT id FROM approval_files WHERE approval_id = ?").get(approvalId) as { id: number }).id;

  const point = roundPoint(fileId, { x: 12.44, y: -3.04, z: 8.46 }, { x: 0, y: 0, z: 1 });
  const onText: Annotation = { quote: "Le support", comment: "Nom à revoir.", position: 0 };
  const onPart: Annotation = { quote: pointQuote("piece.stl", point), comment: "Paroi trop fine ici.", point };
  const annotations = insertAnnotation([onText], onPart);
  assert.deepEqual(annotations, [onText, onPart], "a remark on the part goes after the remarks on the text");

  decideApproval(db, approvalId, { decision: "revise", annotations });
  const stored = JSON.parse((db.prepare("SELECT annotations FROM approvals WHERE id = ?").get(approvalId) as Pick<ApprovalRow, "annotations">).annotations);
  assert.deepEqual(stored[1].point, { fileId, x: 12.4, y: -3, z: 8.5, normal: [0, 0, 1] });

  const expected = [
    "1. À propos de « Le support » : Nom à revoir.",
    "2. À propos de « piece.stl, point (12,4 ; -3,0 ; 8,5) mm, face +Z » : Paroi trop fine ici.",
    "   Point dans le repère de la pièce (mm) : x=12.4 y=-3.0 z=8.5 ; normale sortante de la face : (0.00, 0.00, 1.00)",
  ].join("\n");
  const task = db.prepare("SELECT text FROM tasks WHERE source = 'revise' AND ref_id = ?").get(approvalId) as { text: string };
  assert.equal(task.text, `Revise your submission #${approvalId} "Bracket" (piece_3mf). User's remarks:\n${expected}`);
  assert.equal(hqReadDecisions(db, ctx).decisions[0]?.note, expected);
  assert.equal(
    decisionText(null, [{ quote: "q", comment: "c", point: { fileId: 1, x: -0.04, y: 0, z: 1.25, normal: [0.71, -0.0001, 0.71] } }]),
    "1. À propos de « q » : c\n   Point dans le repère de la pièce (mm) : x=0.0 y=0.0 z=1.3 ; normale sortante de la face : (0.71, 0.00, 0.71)",
  );
});

test("a point is checked: a file id, finite coordinates, a normal of three components in [-1, 1], nothing else", () => {
  const ok = (point: unknown) =>
    decisionSchema.safeParse({ decision: "revise", annotations: [{ quote: "piece.stl, point", comment: "Ici.", point }] }).success;
  const good = { fileId: 4, x: 1.5, y: -2, z: 0, normal: [0, 0, 1] };
  assert.equal(ok(good), true);
  assert.equal(ok({ ...good, fileId: 0 }), false);
  assert.equal(ok({ ...good, fileId: 1.5 }), false);
  assert.equal(ok({ ...good, x: Number.POSITIVE_INFINITY }), false);
  assert.equal(ok({ ...good, z: 2e6 }), false);
  assert.equal(ok({ ...good, normal: [0, 0, 2] }), false);
  assert.equal(ok({ ...good, normal: [0, 1] }), false);
  assert.equal(ok({ ...good, face: "+Z" }), false);
  const { fileId: _fileId, ...withoutFile } = good;
  void _fileId;
  assert.equal(ok(withoutFile), false);
});
