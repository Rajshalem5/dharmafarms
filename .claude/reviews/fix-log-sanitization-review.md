# Code Review: Fix log sanitization corrupting req.url

**Reviewed**: 2026-07-03
**Branch**: shalem
**Decision**: APPROVE

## Summary

A one-line fix that removes `req.url = req.originalUrl;` from the log sanitization middleware. This prevents the middleware from overwriting `req.url` with the redacted URL (`/my-account/[REDACTED]`), which was breaking Express route matching and causing `req.params.token` to be `[REDACTED]` instead of the actual customer token.

## Findings

### CRITICAL
None

### HIGH
None

### MEDIUM
None

### LOW
None

**Unrelated note:** The test in `test/server.test.js` uses hardcoded `delivery_boy_id = 1` (line 284). This is safe because each test run creates a fresh in-memory database where auto-increment starts at 1, but it's worth documenting this assumption.

## Validation Results

| Check | Result |
|---|---|
| Server tests (test/server.test.js) | **18/18 pass** |
| Full test suite | **236/249 pass** (13 pre-existing failures in `test/routes.customer.test.js` — unrelated to this change) |

## Files Reviewed

| File | Change | Description |
|------|--------|-------------|
| `server.js` | Modified | Removed `req.url = req.originalUrl;` (1 line deletion) |
| `test/server.test.js` | Modified | Added reproducer test (16 lines added) |

## Verification

- **Before fix**: `req.params.token` = `[REDACTED]`, customer lookup returns `null`
- **After fix**: `req.params.token` = real token, customer lookup succeeds
- The middleware still sanitizes `req.originalUrl` for logging purposes
- `req.url` is no longer touched, so Express route matching works correctly