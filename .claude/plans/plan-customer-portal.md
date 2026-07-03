# Implementation Plan: Customer Portal (Phase 4)

## Overview

Token-based self-service web portal where customers can view subscription status, pause/resume deliveries, and check remaining balance. Mobile-first, zero-login, no build step. Part of Phase 4 implementation for Dharma Farms.

## Requirements (from PRD Section 6.4)

- F-30: Token-based customer portal accessible via 64-char hex token link
- F-31: Subscription status display (name, delivery boy, status badge, remaining days, today's delivery)
- F-32: Pause subscription for date range (dispatch excludes them for those dates)
- F-33: Resume subscription with one tap
- F-34: Token management on admin side (already done)
- F-35: Cloudflare Tunnel exposure (deployment concern, not code)

## Assumptions (Explicitly Stated)

1. **Token column exists.** Verified: `db.js:91` — `customers` table has `token VARCHAR(64) UNIQUE`.
2. **Token generated on customer creation.** Verified: `routes/admin.js` generates token via `crypto.randomBytes(32).toString('hex')` on customer create.
3. **Admin token regeneration exists.** Verified: `routes/admin.js` has `POST /admin/customers/:id/regenerate-token`.
4. **Log sanitization exists.** Verified: `server.js` lines 171-180 redact `/my-account/<64-char-hex>` to `/my-account/[REDACTED]` in all log output.
5. **Dispatch respects paused subscriptions.** Verified: `services/dispatch.js` filters `(s.paused_until IS NULL OR s.paused_until <= date('now'))`.
6. **remaining_days model.** Pause adds days back to remaining_days (days not consumed during pause are credited). Resume does not subtract them. This is consistent with how `/skip` increments remaining_days.
7. **No customer routes exist yet.** Verified: `server.js` does not import or call `setupCustomerRoutes`. No `routes/customer.js` file exists. `Glob **/customer*` returns only `views/admin/customers.ejs`.

## Architecture Changes

### Data Flow

```
Customer opens link
  -> GET /my-account/:token
  -> Server queries: customers (by token) + subscriptions + deliveries
  -> If no match: render "Account not found" (identical for all failure modes)
  -> If match: render portal.ejs with customer data

Customer pauses
  -> POST /my-account/:token/pause  body: { start_date, end_date }
  -> Server validates token, validates dates (start >= tomorrow, end > start)
  -> Updates subscription: status='paused', paused_until=end_date, remaining_days += (end_date - start_date + 1)
  -> Re-renders portal with green success banner

Customer resumes
  -> POST /my-account/:token/resume
  -> Server validates token, validates subscription is paused
  -> Updates subscription: status='active', paused_until=NULL
  -> Re-renders portal with green success banner

Dispatch generator (existing code in services/dispatch.js):
  -> Filters out paused subscriptions via paused_until comparison
  -> When paused_until passes, customer re-enters dispatch automatically
```

### Files to Create (2)

| File | Purpose |
|------|---------|
| `routes/customer.js` | GET /my-account/:token, POST /my-account/:token/pause, POST /my-account/:token/resume |
| `views/customer/portal.ejs` | Mobile-first self-service page (standalone, no admin layout) |

### Files to Modify (2)

| File | Change |
|------|--------|
| `server.js` | Add import at line 28 + mount at line 232 |
| `services/subscription.js` | Add `pauseSubscription()` and `resumeSubscription()` |

## Database Schema Reference

**subscriptions** (`db.js:97-107`):
- `id`, `customer_id` (FK), `start_date` (TEXT), `end_date` (TEXT/null), `total_days` (INT), `remaining_days` (INT), `status` (TEXT: active/paused/expired), `paused_until` (TEXT/null), `created_at` (TEXT)
- Dates in `YYYY-MM-DD` format

**deliveries** (`db.js:109-121`):
- `id`, `customer_id` (FK), `delivery_boy_id` (FK), `delivery_date` (TEXT), `status` (TEXT: pending/delivered/skipped/issue/arriving), `issue_reason`, `marked_at`, `resolved_at`, `resolved_note`, `created_at`
- UNIQUE constraint on `(customer_id, delivery_date)`

**customers** (`db.js:82-95`):
- `id`, `code`, `name`, `phone`, `address`, `delivery_boy_id` (FK), `monthly_rate`, `status`, `token` (VARCHAR(64) UNIQUE), `notes`, `created_at`, `updated_at`

## Implementation Steps

### Phase 1: Service Layer — Pause/Resume Logic

**File:** `services/subscription.js`

Add two exported functions after the existing `getBalance()` function:

**`pauseSubscription(db, customerId, startDate, endDate)`**

Validation rules (in order):
- Customer must exist in DB
- Customer must have an active subscription (`status = 'active'`)
- Subscription must NOT already be paused (`paused_until IS NULL`)
- `startDate` must be >= tomorrow (`date('now', '+1 day')`)
- `endDate` must be > `startDate`
- Dates must match `YYYY-MM-DD` format

SQL update:
```sql
UPDATE subscriptions
SET status = 'paused',
    paused_until = ?,
    remaining_days = remaining_days + (?)
WHERE customer_id = ? AND status = 'active' AND paused_until IS NULL
```

The `(?)` value = `DATEDIFF days between endDate and startDate + 1`. Since SQLite doesn't have a built-in DATEDIFF, calculate the difference in JavaScript using `(new Date(endDate) - new Date(startDate)) / 86400000 + 1`.

Return `{ paused: true, pausedUntil: endDate, remainingDaysAdded: daysAdded }`.

Throw `new Error('...')` for all validation failures.

**`resumeSubscription(db, customerId)`**

Validation rules:
- Customer must exist in DB
- Customer must have a subscription
- Subscription must be paused (`paused_until IS NOT NULL`)

SQL update:
```sql
UPDATE subscriptions
SET status = 'active',
    paused_until = NULL
WHERE customer_id = ? AND paused_until IS NOT NULL
```

Return `{ resumed: true }`.

Throw `new Error('...')` for validation failures.

**Decision (confirmed):** Delete pending deliveries within the pause range. On pause, also run:
```sql
DELETE FROM deliveries
WHERE customer_id = ? AND delivery_date >= ? AND delivery_date <= ? AND status = 'pending'
```
This prevents dashboard showing stale "pending" counts, keeps `/route` clean for delivery boys, and avoids ghost data in reports. Only affects `pending` rows — never touches delivered/completed rows.

### Phase 2: Route Handler — Customer Endpoints

**File:** `routes/customer.js`

Three route handlers. Export `setupCustomerRoutes(app, db)` function.

**GET /my-account/:token**

```
1. const token = (req.params.token || '').trim()
2. const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(token)
3. If no customer OR customer.status !== 'active':
   -> res.render('customer/portal', { error: true })
4. Query subscription: SELECT * FROM subscriptions WHERE customer_id = ? AND status IN ('active', 'paused') ORDER BY id DESC LIMIT 1
5. Query today's delivery: SELECT status FROM deliveries WHERE customer_id = ? AND delivery_date = date('now')
6. Query delivery boy: SELECT name FROM delivery_boys WHERE id = ?
7. Compute tomorrow's date: new Date(Date.now() + 86400000).toISOString().slice(0,10)
8. res.render('customer/portal', { error: false, customerName, customerCode, deliveryBoyName, subscriptionStatus, remainingDays, pausedUntil, todayDeliveryStatus, hasTodayDispatch, token, tomorrow })
```

**POST /my-account/:token/pause**

```
1. Validate token (same lookup as GET) -> if fail, render error: true
2. Parse start_date, end_date from req.body
3. Validate dates: both present, match YYYY-MM-DD, start_date >= tomorrow, end_date > start_date
4. Call pauseSubscription(db, customerId, startDate, endDate)
5. On success: re-query data, render with { pauseSuccess: true, pauseEndDate: endDate }
6. On validation error: re-query data, render with { pauseError: 'message' }
7. On exception: re-query data, render with { pauseError: 'Could not pause. Please try again.' }
```

**POST /my-account/:token/resume**

```
1. Validate token -> if fail, render error: true
2. Call resumeSubscription(db, customerId)
3. On success: re-query data, render with { resumeSuccess: true }
4. On validation error: re-query data, render with { resumeError: 'message' }
5. On exception: re-query data, render with { resumeError: 'Could not resume. Please try again.' }
```

**Security-critical implementation details:**
- All three endpoints: if token lookup fails, render the same `{ error: true }` template. No 404, no redirect, no hint about what went wrong.
- Never catch and display `error.message` from exceptions (could leak internal DB info).
- Token from `req.params.token` is used directly in the SQL query via `?` placeholder — no injection risk.

### Phase 3: Template — Customer Portal View

**File:** `views/customer/portal.ejs`

Standalone EJS (no layout). Full HTML document with inline CSS and inline vanilla JS.

**HTML structure:**
- `<!DOCTYPE html>` with viewport meta tag
- System font stack, green theme (`#1B4332` primary, `#F0FDF4` background)
- Header: "Dharma Farms" brand bar
- Error state: "Account not found" card
- Happy path: customer name card, status badge, 2-column metrics grid (remaining days, today's delivery status), action section
- Action section: pause form (date inputs + submit button) when active, resume button when paused, "contact admin" message when expired
- Success/error message banners
- Vanilla JS: disable submit buttons on click to prevent double-submit

**Edge cases handled:**
- No deliveries for today: shows "No delivery today" gray badge
- Subscription expired: shows expired badge, no action buttons
- Long customer names: CSS handles overflow
- Date input on mobile: native date picker

**Mobile-first CSS:**
- 44px minimum tap targets on all buttons
- Single column layout at 375px
- Max-width 640px centered on desktop
- Responsive metrics grid (2-column on mobile)
- Touch-friendly date inputs

### Phase 4: Integration — Mount Routes in Server

**File:** `server.js`

**Change 1** — Add import after line 27 (`const { setupAdminRoutes } = require('./routes/admin');`):
```javascript
const { setupCustomerRoutes } = require('./routes/customer');
```

**Change 2** — Add mount after line 231 (`setupAdminRoutes(app, db);`):
```javascript
setupCustomerRoutes(app, db);
```

Must come after body-parsing middleware and session middleware, but before the 404 handler at line 235.

### Phase 5: Verification

| # | Test | Expected Result | Verifies |
|---|------|----------------|----------|
| 1 | Open `http://localhost:3000/my-account/{valid-token}` | Portal renders: name, delivery boy, green "Active" badge, remaining days, today's status | Happy path |
| 2 | Open with random 64-char hex | "Account not found" only | Token security |
| 3 | Deactivate customer, use their token | "Account not found" only (identical to test 2) | No leakage |
| 4 | Submit pause with valid future dates | Green success banner, status shows paused | Pause works |
| 5 | Check DB: `SELECT * FROM deliveries WHERE customer_id=X` | Customer excluded from dispatch | Dispatch exclusion |
| 6 | Submit pause again while paused | Error: "already paused" | Duplicate detection |
| 7 | Click Resume | Green success banner, status shows active | Resume works |
| 8 | Submit resume while active | Error: "already active" | Duplicate detection |
| 9 | Submit pause with past date | Error: "must be tomorrow or later" | Date validation |
| 10 | Submit pause with end < start | Error: "must be after start date" | Date validation |
| 11 | Chrome DevTools at 375px | Single column, readable, 44px+ buttons | Mobile layout |
| 12 | Chrome DevTools at 1440px | Centered, max 640px, looks intentional | Desktop layout |
| 13 | Check server console after tests | All URLs show [REDACTED], never raw token | Log security |
| 14 | Set subscription end_date to yesterday, reload portal | Gray "Expired" badge, no buttons | Expired state |

## Template Variables (Data Contract)

| Variable | Type | Always Present | Description |
|----------|------|----------------|-------------|
| `error` | boolean | Yes | True when account not found |
| `customerName` | string | When !error | Customer's name |
| `customerCode` | string | When !error | e.g. C001 |
| `deliveryBoyName` | string | When !error | Assigned boy name |
| `subscriptionStatus` | string | When !error | active/paused/expired |
| `remainingDays` | number | When !error | From subscription.remaining_days |
| `pausedUntil` | string/null | When !error | YYYY-MM-DD or null |
| `todayDeliveryStatus` | string/null | When !error | delivered/skipped/issue/arriving/pending or null |
| `token` | string | When !error | Raw 64-char hex (for form actions) |
| `tomorrow` | string | When !error | YYYY-MM-DD (for date input min) |
| `pauseSuccess` | boolean | After pause POST | True if pause succeeded |
| `pauseEndDate` | string | After successful pause | YYYY-MM-DD end date |
| `pauseError` | string/null | After failed pause | Error message |
| `resumeSuccess` | boolean | After resume POST | True if resume succeeded |
| `resumeError` | string/null | After failed resume | Error message |

## Security Architecture

```
                    TOKEN IN URL (64-char hex, 256-bit entropy)
                               |
                               v
                    express.urlencoded parsing
                               |
                               v
                    Log sanitization middleware (server.js:171-180)
                    -> /my-account/[REDACTED] in logs only
                               |
                               v
                    Customer route handler (routes/customer.js)
                    -> Parameterized query: SELECT * FROM customers WHERE token = ?
                    -> If no match: error=true (identical for all failure modes)
                    -> If match: render data
                               |
                               v
                    EJS template (views/customer/portal.ejs)
                    -> All dynamic output via <%= %> (escaped)
                    -> Never <%- %> (raw output)
```

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pause/resume race condition (rapid clicks) | Low | Low | SQLite serializes writes. Second write sees updated state and shows validation error. |
| Pause after dispatch already generated for pause range | Low | Low | Pause handler deletes `pending` deliveries within the range. Handled — see Phase 1. |
| remaining_days vs financial balance inconsistency | Low | Medium | remaining_days is subscription state, separate from financial getBalance(). Pause only affects the former. |
| Server crash on import typo | Low | Low | Startup fails with clear require() error. Fix immediately. |
| Template uses undefined variable | Low | Low | EJS throws on undefined variable access. Test all states before deploying. |

## What This Plan Does NOT Cover

- No customer notifications (SMS/Telegram) — out of scope for v1
- No payment/balance display in customer portal
- No admin layout wrapping — portal is standalone
- No Cloudflare Tunnel configuration — deployment concern
- No tests — the project has no test framework configured. Verification is manual via the checklist above.

## Complete File Manifest

**Files to create:**
- `routes/customer.js` (~80 lines)
- `views/customer/portal.ejs` (~160 lines)

**Files to modify:**
- `services/subscription.js` — add ~60 lines (pause/resume functions)
- `server.js` — add 2 lines (import at line 28, mount at line 232)

**No other files need changes.** The existing `dispatch.js` already handles paused subscriptions. The existing `admin.js` already handles token generation and regeneration. The existing `db.js` already has the `token` column. The existing `server.js` already has log sanitization.

## Implementation Order

1. `services/subscription.js` — Add pauseSubscription() and resumeSubscription()
2. `routes/customer.js` — Create route handler with 3 endpoints
3. `views/customer/portal.ejs` — Create mobile-first template
4. `server.js` — Add import and mount line
5. Run all 14 verification tests