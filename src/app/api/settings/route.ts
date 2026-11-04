import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { buildSettingsView } from "@/server/settings";

/** The settings of the home as the settings page shows them. See docs/api.md. */
export async function GET() {
  await connection();
  try {
    const { config, db } = app();
    return Response.json({ settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
