import { createHash, timingSafeEqual } from "node:crypto";
import type { HqConfig } from "./config";
import { HqError } from "./errors";

/**
 * POST /api/runs from outside the desk: when HQ_TRIGGER_TOKEN is set, a
 * request that carries a `reason` must present `Authorization: Bearer
 * <token>`. The desk sends no reason and is not affected. Compared in
 * constant time (on digests, so that the length does not leak either).
 */
export function authorizeTrigger(config: HqConfig, authorization: string | null, reason: string | undefined): void {
  if (reason === undefined || !config.triggerToken) return;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!match || !timingSafeEqual(digest(match[1]!), digest(config.triggerToken))) {
    throw new HqError("UNAUTHORIZED", 401, "A run with a reason needs Authorization: Bearer <HQ_TRIGGER_TOKEN>.");
  }
}
