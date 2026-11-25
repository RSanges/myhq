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

/**
 * Whether a value is an HqError. Not only `instanceof`: Next.js builds the
 * instrumentation hook (the Telegram bridge) and each route apart, so a
 * service kept on `globalThis` by one of them (the chat service, for example)
 * throws the HqError class of its own copy of this module, which a route's
 * `instanceof` does not recognize. Its name, code and status say what it is.
 */
export function isHqError(error: unknown): error is HqError {
  if (error instanceof HqError) return true;
  if (!(error instanceof Error) || error.name !== "HqError") return false;
  const { code, status } = error as Partial<HqError>;
  return typeof code === "string" && typeof status === "number";
}

/** Maps any thrown value to the API error response. */
export function errorResponse(error: unknown): Response {
  if (isHqError(error)) {
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

/**
 * Reads a JSON body that must come with `content-type: application/json`. A
 * page of another site can post a plain form to the app without asking first,
 * never a JSON request: requiring the type keeps such a form from triggering
 * the gesture. UNSUPPORTED_MEDIA_TYPE (415) otherwise.
 */
export async function readJsonRequest(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^\s*application\/json\s*(;|$)/i.test(type)) {
    throw new HqError("UNSUPPORTED_MEDIA_TYPE", 415, "Send a JSON body with content-type: application/json.");
  }
  return readJson(request);
}

/** Reads a JSON body, with an explicit error when it is not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HqError("INVALID_JSON", 400, "The request body must be valid JSON.");
  }
}
