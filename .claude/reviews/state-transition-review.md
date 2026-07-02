# Code Review: State Transition Logic in routes/telegram.js

**Reviewed**: 2026-07-02
**Scope**: Committed changes (3 commits) + uncommitted server.js change
**Decision**: **APPROVE** with comments

## Summary

Clean implementation of the terminal-status transition rule. All 41 tests pass. The uncommitted change in `server.js` is actually a latent bug fix — the previous `require()` form didn't work with the installed package's export structure.

## Findings

### CRITICAL
None

### HIGH
None

### MEDIUM

1. **`server.js:21` — `require()` form change (uncommitted)**
   - **Issue**: The previous `const TelegramBot = require('node-telegram-bot-api')` would fail at runtime. The package exports an object, not a function — `new TelegramBot(...)` would throw `TypeError: TelegramBot is not a constructor`.
   - **Fix present**: `const { TelegramBot } = require('node-telegram-bot-api')` correctly destructures the constructor from the exports object.
   - **Risk**: If a future version of the package changes its export structure, this could break again. Consider adding a startup check or a brief comment explaining why destructuring is required.

2. **`routes/telegram.js:86` — `console.error` in catch handler (pre-existing)**
   - **Issue**: Production error logging uses `console.error` instead of a structured logger.
   - **Context**: This is a small project with no logging library. Acceptable for the current scope.

### LOW

1. **`routes/telegram.js` — Handler functions near 50-line boundary**
   - `handleDone` and `handleSkip` are ~50 lines each. The validation + check + update pattern is clear and `lookupDelivery` already extracted the query. Not worth splitting further.

2. **`test/routes.telegram.test.js` — Test data duplication**
   - Tests insert customers C005-C007 inline with similar field patterns. Acceptable for node:test with shared state — the alternative (factory function) adds complexity.

## Validation Results

| Check | Result |
|---|---|
| Tests | Pass (41/41) |
| Build | N/A (no build step) |

## Files Reviewed

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `routes/telegram.js` | Modified | +98 / -35 |
| `test/routes.telegram.test.js` | Modified | +189 / -5 |
| `server.js` | Modified (uncommitted) | +1 / -1 |