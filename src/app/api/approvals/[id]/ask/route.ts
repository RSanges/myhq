import { handleItemAsk } from "@/assistant/item-ask";

/** « Demander à Rom2 » about an item of « À regarder ». See docs/api.md. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleItemAsk(request, id);
}
