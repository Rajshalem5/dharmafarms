# Code Review: Chunk 1 — Customer Portal (Pause/Resume)

**Reviewed**: 2026-07-03
**Branch**: shalem
**Decision**: APPROVE with comments

## Summary

Clean implementation of the customer portal pause/resume feature. All 246 tests pass. Parameterized queries throughout — no SQL injection risk. All failure modes correctly render `{ error: true }` without exposing internal error messages. Minor issues: silent error swallowing in catch blocks (no server-side logging) and one mutation pattern.

## Findings

### CRITICAL
None

### HIGH
1. **Silent error swallowing in all three route handlers** — `routes/customer.js:91-93, 119-122, 140-143`
   - **Issue**: All three endpoints have empty `catch {}` blocks. While this correctly prevents exposing error messages to the user, it also suppresses all server-side logging of unexpected errors (DB failure, disk full, etc.), making production debugging difficult.
   - **Suggested fix**: Add a `console.error` or logger call in the catch block before calling `renderError`. For example:
     ```js
     } catch (err) {
       console.error('[Customer] Error on', req.originalUrl, err.message);
       renderError(res);
     }
     ```
   - The user's instruction says "No error.message exposed" — logging server-side does not expose it to the client; it only helps with debugging.

### MEDIUM
1. **Mutation of returned object** — `routes/customer.js:116-117, 138`
   - **Issue**: `getPortalData()` returns a plain object, then the route handlers mutate it by adding `pauseSuccess`, `pauseEndDate`, `resumeSuccess` properties. Violates immutability principle.
   - **Suggested fix**: Use spread when constructing the final render payload:
     ```js
     res.render('customer/portal', { ...data, pauseSuccess: true, pauseEndDate: result.pausedUntil });
     ```

2. **`pauseSubscription` function length** — `services/subscription.js:194-251` (58 lines)
   - **Issue**: Slightly exceeds the 50-line guideline. The function is well-structured with clear sections, but the validation logic + transaction + delivery cleanup could be separated.

### LOW
1. **DST edge case in day calculation** — `services/subscription.js:229`
   - **Issue**: `Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1` could be off by 1 during DST transitions. At this scale (domestic milk delivery in India, which does not observe DST), this is purely theoretical.
   - **Status**: Acceptable — India does not observe DST.

## Validation Results

| Check | Result |
|---|---|
| Tests (246 total) | Pass ✓ |
| Subscription tests (32) | Pass ✓ |
| Customer route tests (13) | Pass ✓ |
| No lint/type-check configured | N/A |

## Files Reviewed

| File | Type | Lines |
|------|------|-------|
| `routes/customer.js` | Added | 147 |
| `services/subscription.js` | Modified | +134 (pause/resume) |
| `server.js` | Modified | +2 (import + mount) |
| `views/customer/portal.ejs` | Added | 2 (stub) |
| `test/routes.customer.test.js` | Added | 388 |
| `test/subscription.test.js` | Modified | +224 (tests) |
| `test/server.test.js` | Modified | +1 (update assertion) |

## Next Steps

- **Optional**: Add server-side error logging in catch blocks (HIGH finding #1)
- **Blocking before deploy**: Chunk 3 (real `portal.ejs` template) must replace the stub