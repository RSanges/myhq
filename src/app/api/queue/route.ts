import { connection } from "next/server";
import { app } from "@/server/app";
import { pokeDesk } from "@/server/desk";
import { errorResponse, readJson } from "@/server/errors";
import { moveInQueue, queueMoveSchema, queueView } from "@/server/queue";
import { loadHome } from "@/server/rooms";
import { wakeAgents } from "@/server/runner";

/** The queue: every pending task in order, with why it waits, and the reading of the machine. See docs/api.md. */
export async function GET() {
  await connection();
  try {
    const { config, db } = app();
    return Response.json(queueView(db, config, loadHome(config.home)));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Moves a pending task in the queue (first, up, down, back to automatic order), then wakes the agents in the new order. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const input = queueMoveSchema.parse(await readJson(request));
    const { config, db } = app();
    moveInQueue(db, input);
    wakeAgents(config, db);
    pokeDesk(config.home);
    return Response.json(queueView(db, config, loadHome(config.home)));
  } catch (error) {
    return errorResponse(error);
  }
}
