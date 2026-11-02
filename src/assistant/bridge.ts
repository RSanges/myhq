import fs from "node:fs";
import path from "node:path";
import { getConfig, type Env, type HqConfig } from "../server/config";
import { getDbAt, type RunRow } from "../server/db";
import { acquireLock } from "../server/lock";
import type { StartRunRequest } from "../server/runner";
import { Assistant } from "./assistant";
import type { ChatRunner } from "./chat";
import { loadExtensions, tsImporter, type ModuleImporter } from "./extension";
import { EMPTY_ASSISTANT_CONFIG, loadAssistantConfig, type AssistantConfig } from "./home-config";
import { readSettings } from "./settings";
import { setPolling } from "./status";
import { parseUpdate, Telegram, TelegramError } from "./telegram";

export { acquireLock, type Lock } from "../server/lock";

export type BridgeOptions = {
  env?: Env;
  config?: HqConfig;
  fetchImpl?: typeof fetch;
  /** Long polling timeout given to getUpdates, in seconds. */
  pollTimeoutSec?: number;
  /** Pause after a failed getUpdates. */
  retryMs?: number;
  importer?: ModuleImporter;
  runChat?: ChatRunner;
  startRun?: (request: StartRunRequest) => RunRow;
  log?: (message: string) => void;
};

export type Bridge = {
  assistant: Assistant;
  /** Stops polling, waits for the loop and the queued messages, frees the lock. */
  stop(): Promise<void>;
};

export function readOffset(file: string): number {
  try {
    const value = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Starts the Telegram bridge: long polling with getUpdates (no inbound port),
 * for the one configured chat. Returns null, with a log line, when polling is
 * off (HQ_TELEGRAM_POLLING is not "true"), when the token or chat id is
 * missing, or when another process already reads the bot.
 */
export async function startBridge(options: BridgeOptions = {}): Promise<Bridge | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(`[assistant] ${message}`));
  const settings = readSettings(env);
  if (!settings.polling) {
    log("Telegram polling is off (HQ_TELEGRAM_POLLING): alerts are sent without buttons");
    return null;
  }
  if (!settings.token || !settings.chatId) {
    log("HQ_TELEGRAM_POLLING is on but HQ_TELEGRAM_BOT_TOKEN or HQ_TELEGRAM_CHAT_ID is missing: not polling");
    return null;
  }
  const config = options.config ?? getConfig(env);
  const stateDir = path.join(config.dataDir, "assistant");
  const lock = acquireLock(path.join(stateDir, "bridge.lock"));
  if (!lock) {
    log("another MyHQ process already reads the bot: not polling");
    return null;
  }

  let assistantConfig: AssistantConfig = EMPTY_ASSISTANT_CONFIG;
  try {
    assistantConfig = loadAssistantConfig(config.home);
  } catch (error) {
    log(`invalid assistant.json, running with the core commands only: ${(error as Error).message}`);
  }
  const { extensions, errors } = await loadExtensions(
    config.home,
    assistantConfig.extensions,
    options.importer ?? tsImporter,
  );
  for (const error of errors) log(`extension not loaded: ${error}`);
  if (extensions.length > 0) log(`extensions: ${extensions.map((e) => e.extension.name).join(", ")}`);

  const telegram = new Telegram(settings.token, settings.apiBase, options.fetchImpl);
  const assistant = new Assistant({
    telegram,
    chatId: settings.chatId,
    config,
    db: getDbAt(config.dbPath),
    assistant: assistantConfig,
    extensions,
    env,
    chatMaxBudgetUsd: settings.chatMaxBudgetUsd,
    runChat: options.runChat,
    startRun: options.startRun,
    log,
  });

  // The command menu is set at start, or after the first successful poll if
  // Telegram was out of reach.
  let menuSet = false;
  const setMenu = async () => {
    try {
      await telegram.setMyCommands(assistant.commandMenu());
      menuSet = true;
    } catch (error) {
      log(`setMyCommands: ${(error as Error).message}`);
    }
  };
  await setMenu();

  const offsetFile = path.join(stateDir, "offset.txt");
  const controller = new AbortController();
  const pollTimeoutSec = options.pollTimeoutSec ?? 50;
  const retryMs = options.retryMs ?? 10_000;

  const loop = async () => {
    let offset = readOffset(offsetFile);
    while (!controller.signal.aborted) {
      let updates: { update_id: number }[];
      try {
        updates = await telegram.getUpdates(offset + 1, pollTimeoutSec, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) break;
        const conflict = error instanceof TelegramError && error.code === 409;
        log(
          conflict
            ? "getUpdates: another program reads this bot (409); only one reader may run"
            : `getUpdates: ${(error as Error).message}`,
        );
        await sleep(retryMs, controller.signal);
        continue;
      }
      if (!menuSet) await setMenu();
      for (const raw of updates) {
        // The offset moves first: an update that crashes is never replayed.
        offset = Math.max(offset, raw.update_id);
        fs.writeFileSync(offsetFile, String(offset));
        const parsed = parseUpdate(raw);
        if (!parsed.ok) {
          log(`update ${parsed.updateId} ignored: ${parsed.error}`);
          continue;
        }
        await assistant.handleUpdate(parsed.update);
      }
    }
  };

  setPolling(true);
  log(`polling Telegram for chat ${settings.chatId}`);
  const done = loop()
    .catch((error) => log(`polling stopped: ${(error as Error).message}`))
    .finally(() => setPolling(false));

  return {
    assistant,
    async stop() {
      controller.abort();
      await done;
      await assistant.idle();
      lock.release();
    },
  };
}

const globalForBridge = globalThis as unknown as { __myhqBridge?: Promise<Bridge | null> };

/** Starts the bridge once per process (called at server start). */
export function startAssistant(): Promise<Bridge | null> {
  globalForBridge.__myhqBridge ??= startBridge().catch((error) => {
    console.error(`[assistant] not started: ${(error as Error).message}`);
    return null;
  });
  return globalForBridge.__myhqBridge;
}
