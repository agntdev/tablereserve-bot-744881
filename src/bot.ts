import { Composer } from "grammy";
import { createBot, type BotContext, type CreateBotOptions } from "./toolkit/index.js";
import type { StorageAdapter } from "grammy";
import start from "./handlers/start.js";
import help from "./handlers/help.js";
import bookingStart from "./handlers/booking-start.js";
import today from "./handlers/today.js";
import upcoming from "./handlers/upcoming.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  booking?: {
    date?: string;
    dateOffset?: number;
    time?: string;
    partySize?: number;
    startedAt?: number;
  };
}

export type Ctx = BotContext<Session>;

/**
 * BuildBotOptions lets a runtime-specific ENTRY POINT (never a feature handler)
 * override how the bot is assembled:
 *
 *  - `handlers`: a pre-loaded list of feature Composers. The Cloudflare Workers
 *    entry (src/worker.ts) passes these from a BUILD-TIME manifest, because the
 *    Workers runtime has no filesystem — `readdirSync` + dynamic `import()` only
 *    work under Node (dev, the test harness, and the Fly/long-poll entry). When
 *    omitted, buildBot falls back to the Node disk scan, so nothing on the Node
 *    path changes.
 *  - `storage`: an explicit grammY session StorageAdapter (Workers passes a
 *    Durable-Object-backed one; Node auto-selects Redis/in-memory).
 */
export interface BuildBotOptions {
  handlers?: Composer<Ctx>[];
  storage?: StorageAdapter<Session>;
  telemetryEnv?: CreateBotOptions<Session>["telemetryEnv"];
  telemetryReporterOptions?: CreateBotOptions<Session>["telemetryReporterOptions"];
}

/**
 * buildBot — assembles the bot, AUTO-LOADS every feature handler from
 * src/handlers/, then registers the global fallback. Does NOT start the bot.
 * Add a feature by creating src/handlers/<name>.ts that default-exports a grammY
 * Composer — NEVER edit this file (concurrent feature PRs would conflict).
 *
 * Runtime-agnostic: the Node entry (src/index.ts) and the test harness call
 * `buildBot(token)` and get the disk-scanned handlers; the Workers entry
 * (src/worker.ts) calls `buildBot(token, { handlers, storage })` with a
 * build-time manifest because Workers has no filesystem.
 */
export function buildBot(token: string, opts: BuildBotOptions = {}) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
    storage: opts.storage,
    telemetryEnv: opts.telemetryEnv,
    telemetryReporterOptions: opts.telemetryReporterOptions,
  });

  // Keep registration synchronous: the harness replays immediately after this
  // factory returns, and a deferred import would miss the first update.
  const handlers = opts.handlers ?? [start, help, bookingStart, today, upcoming];
  for (const h of handlers) bot.use(h);

  bot.on("message", (ctx) => ctx.reply("Sorry, I didn't understand that. Try /help."));

  return bot;
}
