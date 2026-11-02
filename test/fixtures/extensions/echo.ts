// A test extension of the assistant: a command, a question of its own that
// claims the next message, and a command that throws.
import type { AssistantExtension } from "../../../src/assistant/extension";

let waiting = false;

const extension: AssistantExtension = {
  name: "echo",
  commands: [{ command: "echo", description: "Repeats the text" }],
  async handle(text, ctx) {
    if (waiting) {
      waiting = false;
      return `Noted: ${text}`;
    }
    if (text === "/ask") {
      waiting = true;
      return "Question?";
    }
    if (text === "/boom") throw new Error("boom");
    if (!text.startsWith("/echo")) return null;
    ctx.log("echo called");
    const telegram = ctx.env.HQ_TELEGRAM_BOT_TOKEN ? "visible" : "hidden";
    return `echo: ${text.slice(5).trim()} (${ctx.env.ECHO_SECRET ?? "no secret"}, telegram ${telegram})`;
  },
};

export default extension;
