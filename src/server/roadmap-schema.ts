import { z } from "zod";

// Shape of <home>/docs/roadmap.json (documented in docs/api.md). Pure module
// (no Node import) so that the interface can validate the API response with
// the very same schema. Unknown extra fields are tolerated and dropped.

export const roadmapStatusSchema = z.enum(["fait", "en cours", "à faire", "bloqué"]);
export const openPointStatusSchema = z.enum(["ouvert", "tranché"]);

const text = z.string().default("");

export const roadmapSliceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: roadmapStatusSchema,
  /** Percentage, 0 to 100. */
  progress: z.number().min(0).max(100),
  criterion: text,
  /** Date the slice was proved, empty while it is not. */
  proved: text,
  note: text,
});

export const roadmapItemSchema = z.object({
  /** `id` of the slice the item belongs to. */
  slice: z.number().int(),
  name: z.string(),
  status: roadmapStatusSchema,
  owner: text,
  date: text,
  note: text,
});

export const roadmapOpenPointSchema = z.object({
  name: z.string(),
  status: openPointStatusSchema,
  note: text,
});

export const roadmapEventSchema = z.object({
  /** Local date and time, such as `2026-11-02T14:27` (an offset is accepted). */
  at: z.string(),
  text: z.string(),
});

export const roadmapSchema = z.object({
  updatedAt: z.string().min(1),
  slices: z.array(roadmapSliceSchema),
  items: z.array(roadmapItemSchema),
  openPoints: z.array(roadmapOpenPointSchema),
  events: z.array(roadmapEventSchema),
});

export type RoadmapStatus = z.infer<typeof roadmapStatusSchema>;
export type OpenPointStatus = z.infer<typeof openPointStatusSchema>;
export type RoadmapSlice = z.infer<typeof roadmapSliceSchema>;
export type RoadmapItem = z.infer<typeof roadmapItemSchema>;
export type RoadmapOpenPoint = z.infer<typeof roadmapOpenPointSchema>;
export type RoadmapEvent = z.infer<typeof roadmapEventSchema>;
export type Roadmap = z.infer<typeof roadmapSchema>;
