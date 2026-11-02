import { z } from "zod";

/** An error with a stable code and an HTTP status, returned as is by the API. */
export class HqError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HqError";
  }
}

export type ApiErrorBody = { error: { code: string; message: string } };

/** Maps any thrown value to the API error response. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HqError) {
    return Response.json({ error: { code: error.code, message: error.message } } satisfies ApiErrorBody, {
      status: error.status,
    });
  }
  if (error instanceof z.ZodError) {
    const message = error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "(body)"}: ${issue.message}`)
      .join("; ");
    return Response.json({ error: { code: "INVALID_INPUT", message } } satisfies ApiErrorBody, { status: 400 });
  }
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: { code: "INTERNAL", message } } satisfies ApiErrorBody, { status: 500 });
}

/** Reads a JSON body, with an explicit error when it is not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HqError("INVALID_JSON", 400, "The request body must be valid JSON.");
  }
}
