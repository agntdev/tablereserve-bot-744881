import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { requireOwner } from "../toolkit/index.js";
import { now } from "../time.js";

const composer = new Composer<Ctx>();
interface D1 { prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } } }
type RuntimeCtx = Ctx & { env?: { DB?: D1 } };
interface Booking { partySize: number; datetime: string; tables: number; reference: string }
composer.command("upcoming", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  const database = (ctx as RuntimeCtx).env?.DB;
  if (!database) { await ctx.reply("Upcoming bookings aren't set up yet."); return; }
  const rows = await database.prepare("SELECT party_size as partySize, datetime, tables, reference FROM reservations WHERE datetime >= ? AND status = 'confirmed' ORDER BY datetime LIMIT 100").bind(now().toISOString().slice(0, 16)).all<Booking>();
  if (!rows.results.length) { await ctx.reply("No upcoming bookings yet — new reservations will appear here."); return; }
  await ctx.reply(`Upcoming bookings:\n${rows.results.map((b) => `${b.datetime.replace("T", " ")} · ${b.partySize} guests · ${b.tables} table${b.tables === 1 ? "" : "s"} · ${b.reference}`).join("\n")}`);
});
export default composer;
