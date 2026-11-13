import { connection } from "next/server";
import { liveRoomResponse } from "@/server/live-routes";

/** The tiles of the surveillance room: the runs in progress and those ended under 5 minutes ago. See docs/api.md. */
export async function GET() {
  await connection();
  return liveRoomResponse();
}
