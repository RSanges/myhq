import { z } from "zod";
import { normalizeRoomColor } from "./room-color";
import type { Desk, DeskObject } from "./schemas";

// The model of the hub, the desk drawn as a scene (`/`): which state of which
// object of public/iso/hub/hub.json to draw for the objects of GET /api/desk.
// No drawing here (that is hub.tsx); the format is in scripts/iso/README.md.

const int = z.number().int();
const point = z.tuple([int, int]);
const rect = z.tuple([int, int, int.min(0), int.min(0)]);
const maskSchema = z.object({ frame: int, at: point, mode: z.enum(["room", "pastel"]), slot: int.min(0).max(15) });
const frameRefSchema = z.object({ frame: int, at: point, masks: z.array(maskSchema) });
const stateSchema = frameRefSchema.extend({ hit: rect, hover: frameRefSchema }).nullable();
const objectSchema = z.object({
  module: z.string(),
  states: z.record(z.string(), stateSchema),
  today: z.object({ frame: int, cells: z.array(point) }).optional(),
});

export const HUB_NAMES = ["pile", "mail", "postits", "newspaper", "calendar", "phone"] as const;
export type HubName = (typeof HUB_NAMES)[number];

export const hubSchema = z
  .object({
    version: z.literal(1),
    background: z.object({ file: z.string(), w: int.min(1), h: int.min(1) }),
    atlas: z.object({ file: z.string(), w: int.min(1), h: int.min(1), frames: z.array(rect) }),
    hover: z.object({ lift: int.min(0) }),
    objects: z.object({
      pile: objectSchema,
      mail: objectSchema,
      postits: objectSchema,
      newspaper: objectSchema,
      calendar: objectSchema.extend({ today: z.object({ frame: int, cells: z.array(point) }) }),
      phone: objectSchema,
    }),
  })
  .superRefine((hub, ctx) => {
    // Every frame a state points to must exist in the atlas, and every state the scene asks for must be there.
    const frames = hub.atlas.frames.length;
    const check = (frame: number, path: (string | number)[]) => {
      if (frame < 0 || frame >= frames) ctx.addIssue({ code: "custom", path, message: `frame ${frame} is not in the atlas` });
    };
    for (const name of HUB_NAMES) {
      const object = hub.objects[name];
      for (const state of STATES[name]) {
        if (!(state in object.states)) ctx.addIssue({ code: "custom", path: ["objects", name, "states"], message: `state "${state}" is missing` });
      }
      for (const [key, state] of Object.entries(object.states)) {
        if (!state) continue;
        for (const ref of [state, state.hover]) {
          check(ref.frame, ["objects", name, "states", key]);
          for (const mask of ref.masks) check(mask.frame, ["objects", name, "states", key, "masks"]);
        }
      }
    }
    check(hub.objects.calendar.today.frame, ["objects", "calendar", "today"]);
    if (hub.objects.calendar.today.cells.length < 37) {
      ctx.addIssue({ code: "custom", path: ["objects", "calendar", "today", "cells"], message: "a month needs 37 cells" });
    }
  });
export type Hub = z.infer<typeof hubSchema>;
export type HubState = NonNullable<Hub["objects"]["pile"]["states"][string]>;
export type HubFrameRef = z.infer<typeof frameRefSchema>;

/** The highest state of the objects drawn by count. */
export const MAX_STATE = { pile: 14, mail: 5, postits: 5 } as const;

const range = (max: number) => Array.from({ length: max + 1 }, (_, index) => String(index));

/** The states the scene draws, per object. */
const STATES: Record<HubName, string[]> = {
  pile: range(MAX_STATE.pile),
  mail: range(MAX_STATE.mail),
  postits: range(MAX_STATE.postits),
  newspaper: ["absent", "present"],
  calendar: ["default"],
  phone: ["idle", "unread"],
};

/** The object of the scene each kind of desk object is drawn as. */
export const HUB_OBJECT: Record<DeskObject["object"], HubName> = {
  pile: "pile",
  tray: "mail",
  newspaper: "newspaper",
  postits: "postits",
  calendar: "calendar",
  phone: "phone",
};

/** The spine of a folder whose room has no (valid) colour: a neutral grey of the palette (ink4). */
export const NEUTRAL_SPINE = "#b8adb9";

export type SceneObject = {
  name: HubName;
  /** The object of the home's desk, null when the home does not configure one of this kind (drawn empty, not interactive). */
  object: DeskObject | null;
  /** The key of the state in hub.json. */
  state: string;
  /** The colour of each tint slot (the folders of the pile, from the bottom). */
  tints: string[];
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.floor(value)));

/** The state of an object for its desk object; an object in error is drawn empty. */
export function stateOf(name: HubName, object: DeskObject | null): string {
  const count = object && object.status === "ok" ? object.count : 0;
  switch (name) {
    case "pile":
    case "mail":
    case "postits":
      return String(clamp(count, MAX_STATE[name]));
    case "newspaper":
      return count > 0 ? "present" : "absent";
    case "calendar":
      return "default";
    case "phone":
      return count > 0 ? "unread" : "idle";
  }
}

/** The colours of the pile's folders: the room colour of each pending item in order, a neutral grey without one. */
export function spineColors(object: DeskObject | null): string[] {
  if (!object || object.status !== "ok") return [];
  const spines = object.spines ?? [];
  return Array.from({ length: clamp(object.count, MAX_STATE.pile) }, (_, index) => normalizeRoomColor(spines[index]?.color) ?? NEUTRAL_SPINE);
}

/** Every object of the scene, in the order of HUB_NAMES, with the state to draw for the desk of the home. */
export function sceneObjects(desk: Desk | null): SceneObject[] {
  return HUB_NAMES.map((name) => {
    const object = desk?.objects.find((each) => HUB_OBJECT[each.object] === name) ?? null;
    return { name, object, state: stateOf(name, object), tints: name === "pile" ? spineColors(object) : [] };
  });
}

/** The cell of the wall calendar for a day: rows from the top, Monday first (`(weekday of the 1st) + day - 1`). */
export function todayCell(date: Date): number {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  return ((first.getDay() + 6) % 7) + date.getDate() - 1;
}

/** What the badge of an object says: its count (99+ beyond), « ! » for an object in error, null when there is nothing. */
export function badgeText(object: DeskObject | null): string | null {
  if (!object) return null;
  if (object.status === "error") return "!";
  if (object.count <= 0) return null;
  return object.count > 99 ? "99+" : String(object.count);
}

/** `pastel` mode of a tint mask: 55 % of the way from the colour to #fffaf0 (pastel() of scripts/iso/image.mjs). */
export function pastel(color: string): string {
  const paper = [0xff, 0xfa, 0xf0];
  const channels = [1, 3, 5].map((at, index) => {
    const value = parseInt(color.slice(at, at + 2), 16);
    return Math.round(value + (paper[index]! - value) * 0.55);
  });
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The largest integer scale, in device pixels per art pixel, at which the
 * scene fits the width (and the height, when one is given); at least 1.
 */
export function fitScale(size: { w: number; h: number }, room: { width: number; height?: number }, ratio: number): number {
  const byWidth = Math.floor((room.width * ratio) / size.w);
  const byHeight = room.height === undefined ? byWidth : Math.floor((room.height * ratio) / size.h);
  return Math.max(1, Math.min(byWidth, byHeight));
}
