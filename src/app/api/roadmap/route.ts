import { connection } from "next/server";
import { handleGetRoadmap } from "@/server/roadmap";

/** The roadmap of the home (docs/roadmap.json), validated. See docs/api.md. */
export async function GET() {
  await connection();
  return handleGetRoadmap();
}
