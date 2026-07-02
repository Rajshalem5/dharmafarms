# Code Review: routes/telegram.js + test/routes.telegram.test.js

**Reviewed**: 2026-07-01
**Files**: Added (2)

## Summary

Clean, well-structured TDD implementation of 8 Telegram bot commands with 19 passing tests. All queries use parameterized SQL. No security vulnerabilities. One MEDIUM finding around `/start` account hijacking risk.

## Findings

### CRITICAL
None

### HIGH
None

### MEDIUM

1. **`/start` can hijack another boy's Telegram link** — `routes/telegram.js:106-121`
   - `handleStart` looks up a boy by phone number and updates their `telegram_chat_id` without checking if the boy already has one set. If Boy A (chat_id=1001, phone=9876543210) is registered, and someone else with a different chat_id sends `/start 9876543210`, Boy A's chat_id gets overwritten.
   - **Fix**: Add a check before UPDATE: `if (boy.telegram_chat_id !== null) return bot.sendMessage(chatId, 'This phone is already registered to another account. Contact admin.')`

2. **Test ordering dependency** — `test/routes.telegram.test.js:276-310`
   - The `/done` duplicate test (line 301) depends on the previous test (line 276) having already marked C001 as delivered. This works because `node:test` runs describe-block tests sequentially, but creates a brittle ordering dependency.
   - **Fix**: Make each test fully self-contained by inserting its own delivery row, or add a `beforeEach` reset.

3. **Minimal error context** — `routes/telegram.js:76`
   - `console.error('Telegram handler error:', err)` logs the error but doesn't include identifying context (chatId, command text) for debugging.
   - **Fix**: Include context: `console.error('Telegram error [chatId=%s, cmd=%s]:', chatId, command, err)`

### LOW

1. **Repeated customer-lookup query** — `routes/telegram.js:151-156, 204-209, 264-269, 302-307`
   - The same delivery-finding join query is duplicated in 4 handlers. Extract to a shared helper like `findDeliveryForBoy(db, code, boyId)`.

2. **Test regex operator precedence** — `test/routes.telegram.test.js:248`
   - `C001.*Ram|C002.*Shyam|C001|C002` — due to regex `|` precedence, the `.*` only applies to the first alternative. Works because fallback alternatives catch matches anyway.

## Validation Results

| Check | Result |
|---|---|
| Tests (routes/telegram) | **Pass** — 19/19 |
| Tests (all project) | **Pass** — 42/42 |
| Lint | Skipped (no linter configured) |
| Type check | Skipped (no TypeScript) |

## Files Reviewed

| File | Type |
|---|---|
| `routes/telegram.js` | Added (373 lines) |
| `test/routes.telegram.test.js` | Added (473 lines) |

## Decision: **APPROVE** with comments

No CRITICAL or HIGH issues. The MEDIUM items are worth addressing before production deployment, particularly the `/start` hijacking risk (#1). Validation passes cleanly.