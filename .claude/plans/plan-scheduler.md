# Implementation Plan: Route Push Scheduling

## Overview

Create `services/scheduler.js` with functions to push formatted delivery routes to each delivery boy via Telegram at 5:30 AM (and on boot as fallback), and send an aggregated end-of-route summary to the admin at 7:30 AM. Idempotency uses a `scheduler_log` SQLite table, not filesystem touch files.

---

## Requirements

- `pushRoutesToAllBoys(db, bot)` sends a formatted route message to each delivery boy's `telegram_chat_id`
- `routesPushedForToday(db)` checks idempotency via the `scheduler_log` table (type=`route_push`)
- `hasSummaryBeenSentToday(db)` checks idempotency for admin summary (type=`admin_summary`)
- `sendDailySummaryToAdmin(db, bot)` sends aggregated delivery stats to the admin's Telegram chat at 7:30 AM
- Boot-time check: if server starts and routes were not pushed today, push immediately
- Add `ADMIN_TELEGRAM_CHAT_ID` to `.env` validation in `server.js`
- Follow existing patterns: JSDoc on all exported functions, try/catch that never crashes server, `node:test` for tests
- Tests use in-memory database and mock bot object

---

## Architecture Changes

| File | Action | Description |
|------|--------|-------------|
| `services/scheduler.js` | **CREATE** | Scheduler service: route push, admin summary, idempotency checks |
| `db.js` | **MODIFY** | Add migration v3 for `scheduler_log` table |
| `server.js` | **MODIFY** | Add `ADMIN_TELEGRAM_CHAT_ID` to env validation; wire boot check and cron jobs |
| `test/scheduler.test.js` | **CREATE** | Tests for all scheduler functions |
| `.env` | **MODIFY** | Add `ADMIN_TELEGRAM_CHAT_ID` placeholder (user action) |

---

## Implementation Steps

### Phase 1: Database Schema — Add migration v3 in `db.js`

After the v2 migration block, add:

```sql
CREATE TABLE scheduler_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  log_date TEXT NOT NULL,
  executed_at TEXT DEFAULT (datetime('now')),
  details TEXT,
  UNIQUE(type, log_date)
);
```

The `UNIQUE(type, log_date)` constraint is the idempotency mechanism. `INSERT OR IGNORE` ensures only one entry per type per day.

Migration registration:
```js
db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(3, 'v3_create_scheduler_log');
```

---

### Phase 2: Scheduler Service — Create `services/scheduler.js`

**Dependencies**:
- `const { getTodaysRouteForBoy } = require('./dispatch');`
- Telegram message formatting helpers

#### Function: `hasEventRunToday(db, type)`

Checks whether a scheduler event type has already been logged today.

```js
function hasEventRunToday(db, type) {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM scheduler_log WHERE type = ? AND log_date = date('now')"
  ).get(type);
  return row.count > 0;
}
```

#### Function: `routesPushedForToday(db)`

Convenience wrapper around `hasEventRunToday(db, 'route_push')`.

#### Function: `pushRoutesToAllBoys(db, bot)`

Async function that:
1. Checks idempotency via `routesPushedForToday(db)`
2. Queries active delivery boys with non-null `telegram_chat_id`
3. For each boy, sends a formatted route message via `bot.sendMessage()`
4. Logs the event in `scheduler_log` (even on partial failure)
5. Returns `{ pushed: boolean, sent: number, failed: number, errors: string[] }`

#### Function: `hasSummaryBeenSentToday(db)`

Convenience wrapper around `hasEventRunToday(db, 'admin_summary')`.

#### Function: `sendDailySummaryToAdmin(db, bot)`

1. Checks idempotency via `hasSummaryBeenSentToday(db)`
2. Checks `ADMIN_TELEGRAM_CHAT_ID` env var
3. Queries: total deliveries, status breakdown, per-boy breakdown
4. Builds formatted message with date, totals, per-boy stats
5. Sends via `bot.sendMessage()`
6. Logs event in `scheduler_log`
7. Returns `{ sent: boolean, total: number }`

---

### Phase 3: server.js Integration

#### 3a. Add `ADMIN_TELEGRAM_CHAT_ID` to `validateEnv()`

```js
['ADMIN_TELEGRAM_CHAT_ID', 'Telegram chat ID for admin (get from @userinfobot)'],
```

#### 3b. Add requires

```js
const {
  routesPushedForToday,
  pushRoutesToAllBoys,
  sendDailySummaryToAdmin,
} = require('./services/scheduler');
```

#### 3c. Boot-time async route push (after backup block)

Wrap in async IIFE since `pushRoutesToAllBoys` is async:

```js
(async () => {
  try {
    if (!routesPushedForToday(db)) {
      const result = await pushRoutesToAllBoys(db, bot);
      console.log('[Boot] Routes pushed to ' + result.sent + ' delivery boys' +
        (result.failed > 0 ? ', ' + result.failed + ' failed' : ''));
    } else {
      console.log('[Boot] Routes already pushed today, skipping');
    }
  } catch (err) {
    console.error('[Boot] Warning: Route push failed —', err.message);
  }
})();
```

#### 3d. 5:30 AM cron

```js
cron.schedule('30 5 * * *', () => {
  console.log('[Cron] Running 5:30 AM route push...');
  (async () => {
    try {
      const result = await pushRoutesToAllBoys(db, bot);
      if (result.pushed) {
        console.log('[Cron] Routes pushed to ' + result.sent + ' delivery boys');
      } else {
        console.log('[Cron] Routes already pushed today, skipping');
      }
    } catch (err) {
      console.error('[Cron] Warning: Route push failed —', err.message);
    }
  })();
});
```

#### 3e. 7:30 AM cron

```js
cron.schedule('30 7 * * *', () => {
  console.log('[Cron] Running 7:30 AM admin summary...');
  try {
    const result = sendDailySummaryToAdmin(db, bot);
    if (result.sent) {
      console.log('[Cron] Admin summary sent (' + result.total + ' deliveries)');
    } else {
      console.log('[Cron] Admin summary skipped (already sent or no chat ID)');
    }
  } catch (err) {
    console.error('[Cron] Warning: Admin summary failed —', err.message);
  }
});
```

#### 3f. Renumber steps

| Old | New | Description |
|-----|-----|-------------|
| 5 | 5 | Dispatch check |
| 6 | 6 | Boot backup |
| — | 7 | Boot route push (new) |
| 7 | 8 | 3 AM backup cron |
| — | 9 | 5:30 AM route push cron (new) |
| — | 10 | 7:30 AM admin summary cron (new) |
| 8 | 11 | Start listening |
| 9 | 12 | Graceful shutdown |

---

### Phase 4: Tests — Create `test/scheduler.test.js`

**Framework**: `node:test`, `assert`, in-memory `better-sqlite3`.

#### Test database

In-memory SQLite with full schema (same core tables as `test/dispatch.test.js` + `scheduler_log` table).

#### Mock bot

```js
function createMockBot() {
  const sentMessages = [];
  return {
    sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); return {}; },
    getSentMessages: () => sentMessages,
  };
}
```

#### Test groups

| Group | Tests |
|-------|-------|
| `hasEventRunToday` | false when no entry; true after insert; false for different type |
| `routesPushedForToday` | false initially; true after push |
| `pushRoutesToAllBoys` | sends to boys with chat_id; idempotent; skips NULL chat_id; handles failures |
| `hasSummaryBeenSentToday` | false initially; true after summary |
| `sendDailySummaryToAdmin` | sends correct totals; has status breakdown; idempotent; handles missing env |

---

## Edge Cases

- **Server boots after 5:30 AM**: Boot-time check pushes immediately (async IIFE)
- **No delivery boys have telegram_chat_id**: Push sends 0 messages, logs event anyway
- **Bot send fails mid-batch**: Partial success — event logged, errors array returned
- **ADMIN_TELEGRAM_CHAT_ID not set**: Admin summary warns and returns gracefully
- **Midnight rollover**: SQLite `date('now')` is UTC; cron is local time (IST UTC+5:30)
- **Migration already applied**: Fresh DB runs v1→v2→v3 sequentially

---

## Implementation Order

1. **`db.js`** — Add migration v3 first
2. **`services/scheduler.js`** — Create the module
3. **`test/scheduler.test.js`** — Write tests (TDD: RED)
4. **`test/scheduler.test.js`** + **`services/scheduler.js`** — TDD: GREEN
5. **`server.js`** — Wire boot check, crons, env validation
6. **`.env`** — Add `ADMIN_TELEGRAM_CHAT_ID`