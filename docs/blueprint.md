# Table Reservation Bot — Bot specification

**Archetype:** booking

**Voice:** professional and warm — write every user-facing message, button label, error, and empty state in this voice.

A restaurant reservation system that shows real-time table availability, lets guests book by date/time/party size, and provides confirmation codes. Owners receive booking notifications, manage no-shows, and view daily capacity summaries.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Restaurant guests
- Restaurant staff/owner

## Success criteria

- Guests receive instant confirmation codes for valid bookings
- Owner receives real-time notifications for all new bookings
- Time slots never exceed table capacity when displayed

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main booking menu
- **Book a table** (button, actor: user, callback: booking:start) — Initiates reservation flow
- **/today** (command, actor: admin, command: /today) — Shows owner today's bookings
- **/upcoming** (command, actor: admin, command: /upcoming) — Lists all future bookings

## Flows

### Reservation flow
_Trigger:_ booking:start

1. Select date within 30-day window
2. Choose available time slot (based on table capacity)
3. Select party size (validated against max seating)
4. Confirm booking with reference code
5. Receive post-booking options (reschedule/cancel)

_Data touched:_ booking, table_configuration

### Owner management
_Trigger:_ /today

1. Display today's bookings with table assignments
2. Option to mark no-show

_Data touched:_ booking

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram chat ID for owner notifications
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **booking** _(retention: persistent)_ — Reservation records with status tracking
  - fields: guest_name, party_size, datetime, tables, reference, status
- **table_configuration** _(retention: persistent)_ — Restaurant table layout and capacity
  - fields: total_tables, seats_per_table, max_party_size

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Send daily capacity summary
- Mark booking as no-show
- Adjust table configuration

## Notifications

- Guests receive 2-hour pre-booking reminders
- Owner gets instant new-booking notifications
- Daily summary of all upcoming reservations

## Permissions & privacy

- Guest data only visible to owner
- No public exposure of booking details
- Reference codes prevent PII exposure

## Edge cases

- All tables booked for selected date/time
- Party size exceeding available seating
- Guest attempts to book outside operating hours

## Required tests

- End-to-end booking flow with capacity validation
- Owner no-show marking updates booking status
- Reminder notifications with action buttons

## Assumptions

- Default 90-minute sitting duration
- 15-minute time slot granularity
- 30-day booking window
