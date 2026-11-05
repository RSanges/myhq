import { connection, type NextRequest } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { dirsQuerySchema, listDirs } from "@/server/fs-browse";

/** The sub-folders of a folder of the projects root, for the room browser. See docs/api.md. */
export async function GET(request: NextRequest) {
  await connection();
  try {
    const query = dirsQuerySchema.parse({ path: request.nextUrl.searchParams.get("path") ?? undefined });
    return Response.json(listDirs(app().config, query));
  } catch (error) {
    return errorResponse(error);
  }
}
