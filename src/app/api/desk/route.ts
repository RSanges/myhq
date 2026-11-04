import { connection } from "next/server";
import { deskResponse } from "@/server/desk";

/** Every object of the desk with its count and items. See docs/api.md. */
export async function GET() {
  await connection();
  return deskResponse();
}
