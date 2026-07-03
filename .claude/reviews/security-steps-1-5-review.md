# Code Review: Security Hardening (Steps 1-5)

**Reviewed**: 2026-07-03
**Author**: Rajshalem5
**Branch**: shalem
**Decision**: APPROVE

## Summary

Clean implementation of Steps 1-5 from the security plan. All three middleware layers (Helmet headers, log sanitization, rate limiting) are correctly placed in the middleware stack. Tests follow existing patterns and cover the new functionality. No security issues or regressions.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. **Rate limiter config duplicated in test** — `test/routes.admin.test.js:178-183`
   - The test's `createApp()` duplicates the `rateLimit()` config from `server.js:207-213`. If the rate limit window or max changes, both must be updated.
   - **Suggestion**: Acceptable given the test isolates its own Express app (not using server.js's `createApp`). Documented in the plan as expected.

2. **In-memory rate limiter resets on restart** — `server.js:207`
   - Rate limit state is lost on PM2 restart. An attacker could restart the server and get 5 fresh attempts.
   - **Suggestion**: Accepted per plan risk mitigation. Acceptable for a single-admin system with physical access control.

### LOW

1. **Short variable names in rate limit test** — `test/server.test.js:304-305`
   - `srv` and `d` instead of the more descriptive `server` and `db` used elsewhere in the file.
   - **Suggestion**: Rename to `testServer` and `testDb` for consistency with the rest of the file.

## Validation Results

| Check | Result |
|---|---|
| Tests (server) | Pass — 15/15 |
| Tests (admin) | Pass — 86/86 |
| Tests (full suite) | Pass — 214/214 |

## Files Reviewed

| File | Change |
|------|--------|
| `package.json` | Modified — added `helmet@8.2.0`, `express-rate-limit@8.5.2` |
| `server.js` | Modified — added Helmet middleware, log sanitizer, rate limiter config |
| `routes/admin.js` | Modified — applied `app.locals.loginLimiter` to POST /admin/login |
| `test/server.test.js` | Modified — added 3 new tests (Helmet, sanitizer, rate limiter) |
| `test/routes.admin.test.js` | Modified — added `rateLimit` import and loginLimiter to test's `createApp()` |

## Per-File Review

### server.js

- **Helmet** (line 154): Correctly placed as first middleware. Sets `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, and other security defaults.
- **Log sanitizer** (lines 162-171): Regex targets only `/my-account/<64-char-hex>` pattern. Mutates `req.originalUrl` and syncs `req.url`. Calls `next()` in all paths. Edge case: adds negligible overhead on every request (one regex test per request).
- **Rate limiter** (lines 207-214): 5 attempts/min. Standard headers enabled. Stores in `app.locals` for route access. Restarts with a clean counter on server reboot (accepted risk).

### routes/admin.js

- **Line 75**: `app.locals.loginLimiter` applied as middleware to `POST /admin/login`. The limiter returns 429 before the handler runs when limit is exceeded — no password comparison overhead on blocked requests.

### test/server.test.js

- **Helmet test** (lines 233-239): Checks two specific headers (`x-content-type-options`, `x-frame-options`). Verifies actual values, not just presence.
- **Sanitizer test** (lines 241-244): Uses 64-char lowercase hex string. Confirms 404 rather than crash. Does not verify sanitization in logs (acceptable — this is a no-crash integration test).
- **Rate limit test** (lines 301-324): Creates isolated server per test. Uses `try/finally` for cleanup. Sends 6 requests in sequence. Short variable names: `srv` and `d` are less descriptive than `server`/`db` used elsewhere.

### test/routes.admin.test.js

- **Lines 178-183**: Mirror of production rate limiter config. Necessary because the test creates its own Express app without going through `server.js`.

## Recommendations

- No blocking issues. All findings are MEDIUM or LOW.
- Consider extracting the rate limiter config to a shared constant if it needs to change frequently.