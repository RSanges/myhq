import { app } from "@/server/app";
import { errorResponse, HqError, readJson } from "@/server/errors";
import { buildSettingsView, saveSettings, SETTINGS_GROUPS, type SettingsGroup } from "@/server/settings";

type Params = { params: Promise<{ group: string }> };

const isGroup = (value: string): value is SettingsGroup => Object.hasOwn(SETTINGS_GROUPS, value);

/** Saves one group of settings (layout, limits, notifications, rooms) and returns them all. See docs/api.md. */
export async function PUT(request: Request, ctx: Params) {
  try {
    const { group } = await ctx.params;
    if (!isGroup(group)) {
      throw new HqError("SETTINGS_GROUP_NOT_FOUND", 404, `No settings group "${group}".`);
    }
    const body = await readJson(request);
    const { config, db } = app();
    saveSettings(config, db, group, body);
    return Response.json({ settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
