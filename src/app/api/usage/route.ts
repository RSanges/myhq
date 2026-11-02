import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { getUsage } from "@/server/usage";

/** Tokens and cost by day and by week, and the daily cap. See docs/api.md. */
export async function GET() {
  await connection();
  try {
    const { config, db } = app();
    return Response.json(getUsage(db, config.maxRunsPerDay, config.weeklyBudgetUsd));
  } catch (error) {
    return errorResponse(error);
  }
}
