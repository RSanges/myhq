import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeCall = { method: string; params: Record<string, unknown> };

/**
 * A small HTTP server standing in for api.telegram.org: it records every Bot
 * API call, serves queued updates to getUpdates and serves files by id.
 */
export async function startFakeTelegram(token: string, port = 0) {
  const calls: FakeCall[] = [];
  const updates: Record<string, unknown>[] = [];
  const files = new Map<string, Buffer>();
  let nextMessageId = 100;

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "";
    const file = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(url);
    if (file) {
      const content = file[1] === token ? files.get(decodeURIComponent(file[2]!)) : undefined;
      if (!content) return send(404, { ok: false, error_code: 404, description: "Not Found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(content);
      return;
    }
    const call = /^\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!call || call[1] !== token) return send(404, { ok: false, error_code: 404, description: "Not Found" });
    const method = call[2]!;
    const params = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
    calls.push({ method, params });
    let result: unknown = true;
    if (method === "getUpdates") {
      const offset = Number(params.offset ?? 0);
      if (!updates.some((u) => Number(u.update_id) >= offset)) await new Promise((r) => setTimeout(r, 20));
      result = updates.filter((u) => Number(u.update_id) >= offset);
    } else if (method === "sendMessage") {
      result = { message_id: nextMessageId++, chat: { id: Number(params.chat_id) }, text: params.text };
    } else if (method === "getFile") {
      result = { file_id: params.file_id, file_path: `files/${String(params.file_id)}` };
    }
    send(200, { ok: true, result });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    push(update: Record<string, unknown>) {
      updates.push(update);
    },
    addFile(fileId: string, content: string) {
      files.set(fileId, Buffer.from(content, "utf8"));
    },
    /** Texts sent with sendMessage, in order. */
    sent(): string[] {
      return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
    },
    async waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`fake Telegram: condition not met. Calls: ${JSON.stringify(calls)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close(): Promise<void> {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export type FakeTelegram = Awaited<ReturnType<typeof startFakeTelegram>>;
