// Reading a 3D part for the desk's viewer (src/ui/model-viewer.tsx). Whatever
// the format, the part comes out in its own frame as its author drew it: in
// millimetres, Z up, the frame of build123d and of the slicers. A 3MF says its
// unit (millimetre by default), an STL is in millimetres, a GLB is in metres
// with Y up (glTF), turned back to Z up. Each format's loader is imported only
// when a file of that format is read. Only the viewer chunk imports this file.

import { Group, Matrix4, Mesh, Vector3, type Object3D } from "three";
import type { ModelFormat } from "./attachments-model";

/** Millimetres per unit of a 3MF `<model unit="...">` (3MF core specification). */
export const THREE_MF_UNITS: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** The scale of a 3MF to millimetres, from the unit of its root model (1 when absent or unknown). */
export async function threeMfScale(data: ArrayBuffer): Promise<number> {
  const { strFromU8, unzipSync } = await import("three/examples/jsm/libs/fflate.module.js");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), { filter: (file) => /\.(rels|model)$/i.test(file.name) });
  } catch {
    return 1;
  }
  const rels = files["_rels/.rels"] ? strFromU8(files["_rels/.rels"]) : "";
  const target = /<Relationship\b[^>]*Type="[^"]*\/3dmodel"[^>]*>/i.exec(rels)?.[0].match(/Target="\/?([^"]+)"/i)?.[1];
  const name = (target && files[target] ? target : null) ?? Object.keys(files).find((file) => /\.model$/i.test(file));
  if (!name) return 1;
  const unit = /<(?:\w+:)?model\b[^>]*?\bunit\s*=\s*["']([a-z]+)["']/i.exec(strFromU8(files[name]!))?.[1]?.toLowerCase();
  return (unit && THREE_MF_UNITS[unit]) || 1;
}

/**
 * The part in a file, as a group whose own frame is the part's frame (see the
 * head of this file): what the viewer places on its grid, and what a point
 * placed on the part is given in.
 */
export async function loadModel(format: ModelFormat, data: ArrayBuffer): Promise<Group> {
  const part = new Group();
  let content: Object3D;
  switch (format) {
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      content = new Mesh(new STLLoader().parse(data));
      break;
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      content = new ThreeMFLoader().parse(data);
      content.scale.setScalar(await threeMfScale(data));
      break;
    }
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      content = (await new GLTFLoader().parseAsync(data, "")).scene;
      // glTF: metres, Y up. Back to millimetres, Z up (glTF +Z, the front, becomes -Y).
      content.rotation.x = Math.PI / 2;
      content.scale.setScalar(1000);
      break;
    }
  }
  part.add(content);
  part.updateMatrixWorld(true);
  return part;
}

/**
 * A point hit in the scene, given in the frame of `part`: its coordinates in
 * millimetres and the unit normal of the face, turned to face `towards` (the
 * direction of the ray that hit it) so that it points out of the face seen.
 */
export function pointInPart(
  part: Object3D,
  worldPoint: Vector3,
  worldNormal: Vector3,
  towards?: Vector3,
): { point: Vector3; normal: Vector3 } {
  const normal = worldNormal.clone().normalize();
  if (towards && normal.dot(towards) > 0) normal.negate();
  const inverse = new Matrix4().copy(part.matrixWorld).invert();
  return { point: worldPoint.clone().applyMatrix4(inverse), normal: normal.transformDirection(inverse) };
}
