import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";
import { now } from "../time.js";

registerMainMenuItem({ label: "Today's bookings", data: "booking:today", order: 20 });

const composer = new Composer<Ctx>();
interface D1Statement { bind(...values: unknown[]): D1Statement; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> }
interface D1 { prepare(sql: string): D1Statement }
type RuntimeCtx = Ctx & { env?: { DB?: D1 } };
interface Booking { reference: string; guestName: string; partySize: number; datetime: string; tables: number; status: string }
function todayKey(): string { return now().toISOString().slice(0, 10); }
function menu(bookings: Booking[]) {
  return inlineKeyboard(bookings.filter((b) => b.status === "confirmed").map((b) => [inlineButton(`Mark ${b.reference} no-show`, `booking:noshow:${b.reference}`)]).concat([[inlineButton("Back to menu", "menu:main")]]));
}
async function showToday(ctx: RuntimeCtx): Promise<void> {
  if (!(await requireOwner(ctx))) return;
  const database = ctx.env?.DB;
  if (!database) { await ctx.reply("Today's bookings aren't set up yet."); return; }
  const rows = await database.prepare("SELECT guest_name as guestName, party_size as partySize, datetime, tables, reference, status FROM reservations WHERE datetime >= ? AND datetime < ? ORDER BY datetime").bind(`${todayKey()}T00:00`, `${todayKey()}T23:59`).all<Booking>();
  if (!rows.results.length) { await ctx.reply("No bookings today yet — new reservations will appear here."); return; }
  const lines = rows.results.map((b) => `${b.datetime.slice(11)} · ${b.partySize} guests · ${b.tables} table${b.tables === 1 ? "" : "s"} · ${b.reference}${b.status === "no-show" ? " (no-show)" : ""}`);
  await ctx.reply(`Today's bookings:\n${lines.join("\n")}`, { reply_markup: menu(rows.results) });
}
composer.command("today", async (ctx) => showToday(ctx as RuntimeCtx));
composer.callbackQuery("booking:today", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const database = (ctx as RuntimeCtx).env?.DB; if (!database) { await ctx.editMessageText("Today's bookings aren't set up yet.", { reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]) }); return; } const rows = await database.prepare("SELECT guest_name as guestName, party_size as partySize, datetime, tables, reference, status FROM reservations WHERE datetime >= ? AND datetime < ? ORDER BY datetime").bind(`${todayKey()}T00:00`, `${todayKey()}T23:59`).all<Booking>(); const text = rows.results.length ? `Today's bookings:\n${rows.results.map((b) => `${b.datetime.slice(11)} · ${b.partySize} guests · ${b.tables} table${b.tables === 1 ? "" : "s"} · ${b.reference}`).join("\n")}` : "No bookings today yet — new reservations will appear here."; await ctx.editMessageText(text, { reply_markup: menu(rows.results) }); });
composer.callbackQuery(/^booking:noshow:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const database = (ctx as RuntimeCtx).env?.DB; if (!database) { await ctx.editMessageText("Today's bookings aren't set up yet."); return; } await database.prepare("UPDATE reservations SET status = 'no-show' WHERE reference = ? AND status = 'confirmed'").bind(ctx.match[1]).run(); await ctx.editMessageText("That booking is marked as a no-show.", { reply_markup: inlineKeyboard([[inlineButton("Today's bookings", "booking:today")]]) }); });

export default composer;
