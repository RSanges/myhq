import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";
import { onboardingSchema, startOnboarding } from "@/server/onboarding";

/** Starts an onboarding run for a target repository. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const { config } = app();
    const body = onboardingSchema.parse(await readJson(request));
    const run = startOnboarding(body, { config });
    return Response.json({ run: toRun(run) }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
