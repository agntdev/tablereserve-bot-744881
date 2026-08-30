import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  adminChatId,
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
  requireOwner,
} from "../toolkit/index.js";
import { remindAt } from "../toolkit/session/durable.js";
import { now } from "../time.js";

registerMainMenuItem({ label: "Book a table", data: "booking:start", order: 10 });
registerMainMenuItem({ label: "Table settings", data: "booking:config", order: 30 });

const composer = new Composer<Ctx>();
const SLOT_MINUTES = 15;
const SITTING_MINUTES = 90;
const OPEN_MINUTES = 12 * 60;
const LAST_START_MINUTES = 20 * 60 + 30;
const WINDOW_DAYS = 30;

interface TableConfig { totalTables: number; seatsPerTable: number; maxPartySize: number }
interface Booking { id: string; guestName: string; chatId: number; partySize: number; datetime: string; tables: number; reference: string; status: "confirmed" | "cancelled" | "no-show" }
interface D1Statement { bind(...values: unknown[]): D1Statement; run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> }
interface D1 { prepare(sql: string): D1Statement }
type RuntimeCtx = Ctx & { env?: { DB?: D1; CHAT_DO?: unknown; BOT_TOKEN?: string } };

function dayKey(offset: number): string {
  const d = new Date(now().getTime()); d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function labelDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
function labelTime(minutes: number): string { return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }
function back(): ReturnType<typeof inlineKeyboard> { return inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]); }
function db(ctx: RuntimeCtx): D1 | undefined { return ctx.env?.DB; }

async function prepare(ctx: RuntimeCtx): Promise<boolean> {
  const database = db(ctx);
  if (!database) return false;
  await database.prepare("CREATE TABLE IF NOT EXISTS reservation_config (id INTEGER PRIMARY KEY CHECK (id = 1), total_tables INTEGER NOT NULL, seats_per_table INTEGER NOT NULL, max_party_size INTEGER NOT NULL)").run();
  await database.prepare("CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, guest_name TEXT NOT NULL, chat_id INTEGER NOT NULL, party_size INTEGER NOT NULL, datetime TEXT NOT NULL, tables INTEGER NOT NULL, reference TEXT NOT NULL UNIQUE, status TEXT NOT NULL)").run();
  return true;
}
async function config(ctx: RuntimeCtx): Promise<TableConfig | undefined> {
  if (!(await prepare(ctx))) return undefined;
  const result = await db(ctx)!.prepare("SELECT total_tables as totalTables, seats_per_table as seatsPerTable, max_party_size as maxPartySize FROM reservation_config WHERE id = 1").all<TableConfig>();
  const row = result.results[0];
  if (row) return row;
  const initial = { totalTables: 10, seatsPerTable: 4, maxPartySize: 8 };
  await db(ctx)!.prepare("INSERT INTO reservation_config (id, total_tables, seats_per_table, max_party_size) VALUES (1, ?, ?, ?)").bind(initial.totalTables, initial.seatsPerTable, initial.maxPartySize).run();
  return initial;
}
async function bookingsAt(ctx: RuntimeCtx, datetime: string): Promise<Booking[]> {
  const start = new Date(`${datetime}:00Z`).getTime();
  const from = new Date(start - SITTING_MINUTES * 60 * 1000).toISOString().slice(0, 16);
  const until = new Date(start + SITTING_MINUTES * 60 * 1000).toISOString().slice(0, 16);
  const result = await db(ctx)!.prepare("SELECT id, guest_name as guestName, chat_id as chatId, party_size as partySize, datetime, tables, reference, status FROM reservations WHERE datetime > ? AND datetime < ? AND status = 'confirmed'").bind(from, until).all<Booking>();
  return result.results;
}
async function availableTables(ctx: RuntimeCtx, datetime: string, cfg: TableConfig): Promise<number> {
  const occupied = (await bookingsAt(ctx, datetime)).reduce((sum, booking) => sum + booking.tables, 0);
  return Math.max(0, cfg.totalTables - occupied);
}
function reset(ctx: Ctx): void { ctx.session.booking = {}; }
function begin(ctx: Ctx): void { ctx.session.booking = { startedAt: now().getTime() }; }
function expired(ctx: Ctx): boolean { const started = ctx.session.booking?.startedAt; return !started || now().getTime() - started > 5 * 60 * 1000; }
function dateKeyboard(page = 0) {
  const start = Math.max(0, Math.min(WINDOW_DAYS - 5, page));
  const rows = [];
  for (let offset = start; offset < Math.min(start + 5, WINDOW_DAYS); offset += 1) rows.push([inlineButton(labelDate(dayKey(offset)), `booking:date:${offset}`)]);
  const nav = [];
  if (start > 0) nav.push(inlineButton("Earlier", `booking:dates:${Math.max(0, start - 5)}`));
  if (start + 5 < WINDOW_DAYS) nav.push(inlineButton("Later", `booking:dates:${start + 5}`));
  if (nav.length) rows.push(nav);
  rows.push([inlineButton("Back to menu", "menu:main")]);
  return inlineKeyboard(rows);
}
async function timeKeyboard(ctx: RuntimeCtx, cfg: TableConfig, page: number) {
  const date = ctx.session.booking?.date;
  if (!date) return back();
  const buttons = [];
  for (let minute = OPEN_MINUTES; minute <= LAST_START_MINUTES; minute += SLOT_MINUTES) {
    if ((await availableTables(ctx, `${date}T${labelTime(minute)}`, cfg)) > 0) buttons.push(inlineButton(labelTime(minute), `booking:time:${minute}`));
  }
  const start = Math.max(0, Math.min(Math.max(0, buttons.length - 20), page));
  const rows = []; for (let i = start; i < Math.min(start + 20, buttons.length); i += 4) rows.push(buttons.slice(i, i + 4));
  const nav = [];
  if (start > 0) nav.push(inlineButton("Earlier", `booking:times:${Math.max(0, start - 20)}`));
  if (start + 20 < buttons.length) nav.push(inlineButton("Later", `booking:times:${start + 20}`));
  if (nav.length) rows.push(nav);
  rows.push([inlineButton("Choose another date", "booking:start")]);
  return inlineKeyboard(rows);
}
function randomCode(): string {
  const bytes = new Uint32Array(2); crypto.getRandomValues(bytes);
  return `RSV-${bytes[0].toString(36).toUpperCase()}${bytes[1].toString(36).toUpperCase()}`.slice(0, 16);
}

composer.callbackQuery("booking:start", async (ctx) => {
  await ctx.answerCallbackQuery(); begin(ctx);
  await ctx.editMessageText("Choose a date for your table.", { reply_markup: dateKeyboard() });
});
composer.callbackQuery(/^booking:dates:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (expired(ctx)) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  await ctx.editMessageText("Choose a date for your table.", { reply_markup: dateKeyboard(Number(ctx.match[1])) });
});
composer.callbackQuery(/^booking:date:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (expired(ctx)) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const offset = Number(ctx.match[1]);
  if (!Number.isInteger(offset) || offset < 0 || offset >= WINDOW_DAYS) { await ctx.editMessageText("That date is no longer available. Choose another date.", { reply_markup: dateKeyboard() }); return; }
  const cfg = await config(ctx as RuntimeCtx);
  if (!cfg) { await ctx.editMessageText("Bookings aren't set up yet. Please try again shortly.", { reply_markup: back() }); return; }
  ctx.session.booking = { ...ctx.session.booking, date: dayKey(offset), dateOffset: offset };
  const keyboard = await timeKeyboard(ctx as RuntimeCtx, cfg, 0);
  if (keyboard.inline_keyboard.length === 1) { await ctx.editMessageText("No tables are free on that date. Choose another date.", { reply_markup: dateKeyboard() }); return; }
  await ctx.editMessageText("Choose an available arrival time.", { reply_markup: keyboard });
});
composer.callbackQuery(/^booking:times:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (expired(ctx)) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const cfg = await config(ctx as RuntimeCtx);
  if (!cfg) { await ctx.editMessageText("Bookings aren't set up yet. Please try again shortly.", { reply_markup: back() }); return; }
  const keyboard = await timeKeyboard(ctx as RuntimeCtx, cfg, Number(ctx.match[1]));
  if (keyboard.inline_keyboard.length === 1) { await ctx.editMessageText("No tables are free on that date. Choose another date.", { reply_markup: dateKeyboard() }); return; }
  await ctx.editMessageText("Choose an available arrival time.", { reply_markup: keyboard });
});
composer.callbackQuery(/^booking:time:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (expired(ctx)) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const minute = Number(ctx.match[1]);
  if (!ctx.session.booking?.date || minute < OPEN_MINUTES || minute > LAST_START_MINUTES || minute % SLOT_MINUTES) { await ctx.editMessageText("That time isn't available. Start again to choose another slot.", { reply_markup: back() }); return; }
  ctx.session.booking.time = labelTime(minute);
  const cfg = await config(ctx as RuntimeCtx);
  if (!cfg) { await ctx.editMessageText("Bookings aren't set up yet. Please try again shortly.", { reply_markup: back() }); return; }
  const choices = Array.from({ length: cfg.maxPartySize }, (_, i) => i + 1).map((n) => inlineButton(`${n} guest${n === 1 ? "" : "s"}`, `booking:party:${n}`));
  const rows = []; for (let i = 0; i < choices.length; i += 4) rows.push(choices.slice(i, i + 4));
  rows.push([inlineButton("Choose another time", `booking:date:${ctx.session.booking.dateOffset ?? 0}`)]);
  await ctx.editMessageText("How many guests will be joining you?", { reply_markup: inlineKeyboard(rows) });
});
composer.callbackQuery(/^booking:party:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (expired(ctx)) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const size = Number(ctx.match[1]); const cfg = await config(ctx as RuntimeCtx);
  const draft = ctx.session.booking;
  if (!cfg || !draft?.date || !draft.time) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const tables = Math.ceil(size / cfg.seatsPerTable);
  if (!Number.isInteger(size) || size < 1 || size > cfg.maxPartySize || tables > cfg.totalTables) { await ctx.editMessageText(`We can seat up to ${cfg.maxPartySize} guests in one booking. Choose a smaller party.`, { reply_markup: back() }); return; }
  if (tables > await availableTables(ctx as RuntimeCtx, `${draft.date}T${draft.time}`, cfg)) { await ctx.editMessageText("There isn't enough room at that time for your party. Choose another time.", { reply_markup: inlineKeyboard([[inlineButton("Choose another time", "booking:start")]]) }); return; }
  draft.partySize = size;
  await ctx.editMessageText(`Your table for ${size} is ready to confirm on ${labelDate(draft.date)} at ${draft.time}.`, { reply_markup: inlineKeyboard([[inlineButton("Confirm booking", "booking:confirm")], [inlineButton("Start over", "booking:start")]]) });
});
composer.callbackQuery("booking:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (expired(ctx)) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const draft = ctx.session.booking; const cfg = await config(ctx as RuntimeCtx);
  if (!draft?.date || !draft.time || !draft.partySize || !cfg) { await ctx.editMessageText("That booking has expired. Start again when you're ready.", { reply_markup: back() }); return; }
  const datetime = `${draft.date}T${draft.time}`; const tables = Math.ceil(draft.partySize / cfg.seatsPerTable);
  if (tables > await availableTables(ctx as RuntimeCtx, datetime, cfg)) { await ctx.editMessageText("That table was just booked. Choose another time.", { reply_markup: inlineKeyboard([[inlineButton("Choose another time", "booking:start")]]) }); return; }
  const booking: Booking = { id: randomCode(), guestName: ctx.from?.first_name ?? "Guest", chatId: ctx.chat?.id ?? 0, partySize: draft.partySize, datetime, tables, reference: randomCode(), status: "confirmed" };
  await db(ctx as RuntimeCtx)!.prepare("INSERT INTO reservations (id, guest_name, chat_id, party_size, datetime, tables, reference, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(booking.id, booking.guestName, booking.chatId, booking.partySize, booking.datetime, booking.tables, booking.reference, booking.status).run();
  reset(ctx);
  await ctx.editMessageText(`Your table is confirmed. Your reference is ${booking.reference}.`, { reply_markup: inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${booking.reference}`), inlineButton("Cancel booking", `booking:cancel:${booking.reference}`)]]) });
  const owner = adminChatId(ctx as RuntimeCtx); if (owner) { try { await ctx.api.sendMessage(owner, `New reservation: ${booking.partySize} guests on ${labelDate(draft.date)} at ${draft.time}. Reference: ${booking.reference}.`); } catch { /* A blocked owner notification must not undo a booking. */ } }
  const reminderAt = new Date(`${datetime}:00Z`).getTime() - 2 * 60 * 60 * 1000;
  if (reminderAt > now().getTime() && (ctx as RuntimeCtx).env?.CHAT_DO && (ctx as RuntimeCtx).env?.BOT_TOKEN) await remindAt((ctx as RuntimeCtx).env as never, booking.chatId, reminderAt, `Your table is in two hours. Reference: ${booking.reference}.`, inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${booking.reference}`), inlineButton("Cancel booking", `booking:cancel:${booking.reference}`)]]));
});
composer.callbackQuery(/^booking:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Cancel this booking? This will release your table.", { reply_markup: inlineKeyboard([[inlineButton("Keep booking", `booking:keep:${ctx.match[1]}`), inlineButton("Cancel booking", `booking:cancel-confirm:${ctx.match[1]}`)]]) });
});
composer.callbackQuery(/^booking:keep:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Your booking is still confirmed.", { reply_markup: inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${ctx.match[1]}`), inlineButton("Cancel booking", `booking:cancel:${ctx.match[1]}`)]]) });
});
composer.callbackQuery(/^booking:(cancel-confirm|reschedule):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery(); const action = ctx.match[1]; const reference = ctx.match[2];
  if (!(await prepare(ctx as RuntimeCtx))) { await ctx.editMessageText("Bookings aren't set up yet. Please try again shortly.", { reply_markup: back() }); return; }
  const result = await db(ctx as RuntimeCtx)!.prepare("SELECT chat_id as chatId FROM reservations WHERE reference = ?").bind(reference).all<{ chatId: number }>();
  if (result.results[0]?.chatId !== ctx.chat?.id) { await ctx.editMessageText("That booking isn't available here. Start a new booking if you need a table.", { reply_markup: back() }); return; }
  if (action === "cancel-confirm") { await db(ctx as RuntimeCtx)!.prepare("UPDATE reservations SET status = 'cancelled' WHERE reference = ?").bind(reference).run(); await ctx.editMessageText("Your booking is cancelled. We hope to welcome you another time.", { reply_markup: back() }); }
  else { begin(ctx); await ctx.editMessageText("Choose a new date for your table. Your old table stays held until you confirm a new one.", { reply_markup: dateKeyboard() }); }
});
composer.callbackQuery("booking:config", async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as RuntimeCtx))) return;
  const cfg = await config(ctx as RuntimeCtx); if (!cfg) { await ctx.editMessageText("Table settings aren't set up yet.", { reply_markup: back() }); return; }
  await ctx.editMessageText(`Your dining room has ${cfg.totalTables} tables, ${cfg.seatsPerTable} seats per table, and bookings up to ${cfg.maxPartySize} guests.`, { reply_markup: inlineKeyboard([[inlineButton("Tables", "booking:cfg:tables")], [inlineButton("Seats per table", "booking:cfg:seats")], [inlineButton("Max party size", "booking:cfg:max")], [inlineButton("Back to menu", "menu:main")]]) });
});
composer.callbackQuery(/^booking:cfg:(tables|seats|max)$/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as RuntimeCtx))) return;
  const field = ctx.match[1]; const values = field === "tables" ? [1,2,3,4,5,6,8,10,12,16,20] : field === "seats" ? [2,3,4,5,6,8,10,12] : [2,4,6,8,10,12,16,20];
  await ctx.editMessageText("Choose the new setting.", { reply_markup: inlineKeyboard(values.map((n) => [inlineButton(String(n), `booking:set:${field}:${n}`)]).concat([[inlineButton("Back", "booking:config")]])) });
});
composer.callbackQuery(/^booking:set:(tables|seats|max):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as RuntimeCtx))) return;
  const cfg = await config(ctx as RuntimeCtx); if (!cfg) { await ctx.editMessageText("Table settings aren't set up yet.", { reply_markup: back() }); return; }
  const field = ctx.match[1]; const value = Number(ctx.match[2]); if (field === "tables") cfg.totalTables = value; else if (field === "seats") cfg.seatsPerTable = value; else cfg.maxPartySize = value;
  await db(ctx as RuntimeCtx)!.prepare("UPDATE reservation_config SET total_tables = ?, seats_per_table = ?, max_party_size = ? WHERE id = 1").bind(cfg.totalTables, cfg.seatsPerTable, cfg.maxPartySize).run();
  await ctx.editMessageText("Your table settings are saved.", { reply_markup: inlineKeyboard([[inlineButton("Back to settings", "booking:config")]]) });
});

export default composer;
