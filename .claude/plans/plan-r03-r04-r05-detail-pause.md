# Implementation Plan: R-03, R-04, R-05 — Customer Detail Card, Transaction ID, Pause Simplification

**Date:** 2026-07-04
**Target:** Dharma Farms Revision 2.0

---

## Overview

Three features for the milk delivery admin dashboard, implemented in the order specified by the PRD:

| Feature | Description | Effort | DB Migration | Dependencies |
|---------|-------------|--------|-------------|--------------|
| R-05 | Pause days no longer modify remaining_days | Small | None | None |
| R-04 | Transaction ID field for payments | Small | v5 | None |
| R-03 | Customer detail page with all data | Large | None | R-04 (payments show transaction_id) |

**Implementation order:** R-05 first, R-04 second, R-03 last.

---

## R-05: Pause Days Not Adding Extra Days

### Problem Statement

Currently when a customer pauses, `pauseSubscription()` adds pause days to `remaining_days` (e.g., pause 5 days = remaining_days +5). When they resume, `resumeSubscription()` subtracts the unused portion. This logic is complex and error-prone. R-05 simplifies by: **pause stays pause. No days shift.**

### Files to Modify (2 files)

#### 1. `C:\Users\vajra\OneDrive\Desktop\mini project\services\subscription.js`

**Function: `pauseSubscription()`** -- currently at line ~194

Current behavior adds `daysAdded` to `remaining_days` and the resume function later subtracts the unused portion.

Change to: **Remove the `remaining_days + ?` increment entirely.** The UPDATE statement should only set `status = 'paused'`, `paused_until = ?`, `paused_from = ?` -- no change to `remaining_days` at all.

Delete the `daysAdded` calculation and the `+ ?` parameter and its value from the UPDATE. The return value changes to drop `remainingDaysAdded`.

**Function: `resumeSubscription()`** -- currently at line ~270

Current behavior calculates `excessDays` and subtracts from remaining_days on resume.

Change to: **No remaining_days adjustment.** The UPDATE should only set `status = 'active'`, `paused_until = NULL`. Keep the `paused_from` column for audit but never touch `remaining_days`.

Delete the entire excessDays calculation block and the `remaining_days - ?` part from the UPDATE. Return value unchanged.

**Return type changes:**
- `pauseSubscription()`: Return `{ paused: true, pausedUntil: endDate }` (drops `remainingDaysAdded`)
- `resumeSubscription()`: Return `{ resumed: true }` (unchanged)

#### 2. `C:\Users\vajra\OneDrive\Desktop\mini project\test\subscription.test.js`

**Affected describe blocks: `pauseSubscription` and `resumeSubscription`** -- lines ~470-738

Key test changes:

**pauseSubscription tests:**
- Remove assertion on `result.remainingDaysAdded`
- Change `remaining_days` assertion from incremented value back to original value (e.g., 28 -> 25)

**resumeSubscription tests:**
- All 5 resume tests currently assert remaining_days adjustments. These must ALL change to assert that remaining_days stays at the pre-pause value.
- The test `'adjusts remaining_days correctly when resumed via full pauseSubscription/resumeSubscription flow'`: Rewrite to verify remaining_days unchanged through pause/resume cycle.
- The test `'resets remaining_days to original when resumed immediately on the start date'`: Obsolete -- remove since no reset is needed.

### No dispatch.js changes needed

The dispatch generation in `services/dispatch.js` already correctly excludes paused subscriptions: `s.status = 'active'` in the WHERE clause. No changes needed here.

### No DB migration needed

R-05 uses the existing `paused_from`, `paused_until`, and `status` columns. The `subscriptions` table stays unchanged.

### Acceptance Criteria for R-05

- [ ] Pausing a subscription does NOT increment `remaining_days`
- [ ] Resuming a subscription does NOT decrement `remaining_days`
- [ ] `remaining_days` stays identical before and after the pause/resume cycle
- [ ] Dispatch generation still excludes paused customers
- [ ] Return value of `pauseSubscription()` drops `remainingDaysAdded` field
- [ ] All existing tests for pause/resume pass after rewriting assertions
- [ ] Customer portal still shows correct remaining_days before/after pause

---

## R-04: Transaction ID for Payments

### Problem Statement

UPI and bank transfer payments have UTR/reference numbers, but there is no field to record them. Admin cannot look up a payment if a customer disputes. Fix: add `transaction_id TEXT` column to payments table.

### Files to Modify (7 files)

#### 1. `C:\Users\vajra\OneDrive\Desktop\mini project\db.js`

**Add Migration v5** after the v4 block:

```javascript
// --- Migration v5: Add transaction_id to payments ---
if (currentVersion < 5) {
  db.exec('ALTER TABLE payments ADD COLUMN transaction_id TEXT;');
  db.prepare(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)'
  ).run(5, 'v5_add_transaction_id_to_payments');
}
```

Also update the test DB factories in all test files to include the `transaction_id` column on the payments table.

#### 2. `C:\Users\vajra\OneDrive\Desktop\mini project\services\subscription.js`

**`recordPayment()` function** -- line 48:

- Add `transactionId` to the function signature's destructuring (data param).
- Update the INSERT statement to include `transaction_id` column.
- Add validation: if `mode` is `'upi'` or `'bank_transfer'` and `transactionId` is empty/falsy, throw error.
- For cash, transactionId is optional -- default to `null` if not provided.

**`getPaymentLedger()` function**: No change needed -- `transaction_id` is already in the `SELECT *` output.

**`getPaymentModes()` function**: No change needed.

#### 3. `C:\Users\vajra\OneDrive\Desktop\mini project\routes\admin.js`

**Payment POST handler** -- line 847:

- Extract `transaction_id` from `req.body`.
- Pass it to `recordPayment()` as the new `transactionId` field.
- Add validation error message rendered as flash message.

**CSV export for payments** -- line 1018:

- Add `transaction_id` to the CSV header and row mapping.

#### 4. `C:\Users\vajra\OneDrive\Desktop\mini project\views\admin\payments.ejs`

**Payment recording form:**

- Add a new form field after the payment date field: "Transaction ID / UPI Ref"
- Add client-side validation JS: when mode is UPI or bank_transfer, show required indicator; when cash, hide it.

**Ledger table:**

- Add "Transaction ID" column header between "Mode" and "Amount".
- Add transaction_id cell in each row.

#### 5. `C:\Users\vajra\OneDrive\Desktop\mini project\test\subscription.test.js`

Add new describe block after `getPaymentModes`:

```javascript
describe('recordPayment -- transaction_id', () => {
  // Tests:
  // - records payment with transaction_id for UPI mode
  // - records payment with transaction_id for bank_transfer mode
  // - rejects UPI payment without transaction_id
  // - rejects bank_transfer payment without transaction_id
  // - accepts cash payment without transaction_id (optional)
  // - stores and retrieves transaction_id in getPaymentLedger
});
```

Update `createTestDb()` to add `transaction_id TEXT` column to the payments table.

#### 6. `C:\Users\vajra\OneDrive\Desktop\mini project\test\routes.admin.test.js`

Update the in-memory DB factory to include `transaction_id TEXT` in the payments CREATE TABLE.
Update seed INSERT statements.
Add tests for payment with transaction_id validation.

#### 7. `C:\Users\vajra\OneDrive\Desktop\mini project\test\routes.customer.test.js`

Update the in-memory DB factory to add `transaction_id TEXT` to the payments table schema.

### Acceptance Criteria for R-04

- [ ] Migration v5 creates `transaction_id TEXT` column on payments table
- [ ] Payment form shows new "Transaction ID / UPI Ref" text field
- [ ] Field is required (with visual indicator) when mode is UPI or bank_transfer
- [ ] Field is optional (can be blank) when mode is cash
- [ ] Server rejects UPI/bank_transfer without transaction_id with clear error
- [ ] Transaction ID appears in the payment ledger table
- [ ] Transaction ID appears in CSV export
- [ ] Transaction ID appears in customer detail page (R-03)
- [ ] All existing tests pass after adding the column to test DB schemas

---

## R-03: Customer Detail Card

### Problem Statement

Admin currently sees customers in a flat table. No single page shows everything about one customer: deliveries, payments, bottle stats, subscription, quick stats. Admin has to click between Payments page and Customer list to piece together info.

### Files to Create (1) and Modify (5)

#### 1. `C:\Users\vajra\OneDrive\Desktop\mini project\views\admin\customer-detail.ejs` (NEW)

Full detail page for a single customer. Structure:

**Layout:** Rendered via `renderView()` helper (wraps in admin layout with sidebar). Active page: `customers`.

**Sections (in order):**

1. **Back link + Customer Info Card**
   - "< Back to Customers" link at top
   - Card showing: name, code, phone, address, delivery boy name, monthly rate (Rs), status badge, truncated token (last 4 chars + "Copy" button)

2. **Quick Stats Bar** (4 stat cards)
   - Remaining Days (from subscription)
   - Bottles Pending (SUM(bottles_given) - SUM(bottles_returned))
   - This Month Paid (SUM of payments in current month)
   - Current Balance (from getBalance - balanceDays)

3. **Date Range Filter**
   - [From] [To] date inputs + [Apply] button
   - Preset buttons: [This Month] [Last Month] [Last 30 Days]
   - All tables below filter by selected date range
   - Default: "This Month"

4. **Subscription Info**
   - Start date, end date, total days, remaining days
   - Status badge (active/paused/expired)
   - Pause history: if paused, show paused_from and paused_until
   - Educational note: "Pause days: no days added" (R-05 behavior)

5. **Delivery History Table**
   - Columns: Date, Status (badge), Bottles Given, Bottles Returned, Issue
   - Filtered by date range
   - Empty state: "No deliveries in this date range"

6. **Payment History Table**
   - Columns: Date, Amount (Rs), Mode, Transaction ID, Notes, Running Balance
   - Running balance calculated cumulatively
   - Filtered by date range

7. **Bottle Tracker** (prepares for R-02, even if bottles not yet implemented)
   - Summary row: Total Given, Total Returned, Current Pending
   - Datewise breakdown table: Date, Given, Returned, Pending Delta
   - If bottles data is empty, show "Bottle tracking will appear here once enabled"

#### 2. `C:\Users\vajra\OneDrive\Desktop\mini project\routes\admin.js`

**Add new route after the customer edit route:**

```javascript
// -- Customer detail page --

app.get('/admin/customers/:id/detail', requireAuth, (req, res) => {
  const customerId = parseInt(req.params.id, 10);

  // 1. Fetch customer data
  const customer = db.prepare(`
    SELECT c.*, db.name AS delivery_boy_name
    FROM customers c LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
    WHERE c.id = ?
  `).get(customerId);

  if (!customer) {
    req.session.flash = { type: 'error', message: 'Customer not found.' };
    return res.redirect('/admin/customers');
  }

  // 2. Parse date range from query params
  const today = new Date().toISOString().slice(0, 10);
  const currentMonthStart = today.slice(0, 7) + '-01';

  let fromDate, toDate;
  const preset = req.query.preset || 'this_month';
  if (preset === 'last_month') {
    // Calculate first and last day of previous month
    const y = parseInt(today.slice(0, 4), 10);
    const m = parseInt(today.slice(5, 7), 10);
    fromDate = new Date(y, m - 2, 1).toISOString().slice(0, 10);
    toDate = new Date(y, m - 1, 0).toISOString().slice(0, 10);
  } else if (preset === 'last_30') {
    const d = new Date(); d.setDate(d.getDate() - 30);
    fromDate = d.toISOString().slice(0, 10);
    toDate = today;
  } else {
    fromDate = currentMonthStart;
    toDate = today;
  }
  // Override with explicit dates if provided
  if (req.query.date_from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from)) fromDate = req.query.date_from;
  if (req.query.date_to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to)) toDate = req.query.date_to;

  // 3. Subscription info
  const subscription = db.prepare(
    'SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY id DESC LIMIT 1'
  ).get(customerId);

  // 4. Delivery history (date range filtered)
  const deliveryHistory = db.prepare(`
    SELECT delivery_date, status, issue_reason, marked_at
    FROM deliveries WHERE customer_id = ? AND delivery_date >= ? AND delivery_date <= ?
    ORDER BY delivery_date DESC
  `).all(customerId, fromDate, toDate);

  // 5. Payment history (date range filtered) with running balance
  const payments = db.prepare(`
    SELECT * FROM payments
    WHERE customer_id = ? AND payment_date >= ? AND payment_date <= ?
    ORDER BY payment_date ASC, created_at ASC
  `).all(customerId, fromDate, toDate);

  let runningTotal = 0;
  const paymentHistory = payments.map(function(row) {
    runningTotal += row.amount;
    return {
      id: row.id,
      payment_date: row.payment_date,
      amount: row.amount,
      amount_rupees: (row.amount / 100).toFixed(2),
      mode: row.mode,
      transaction_id: row.transaction_id,
      notes: row.notes,
      recorded_by: row.recorded_by,
      created_at: row.created_at,
      runningTotalRupees: (runningTotal / 100).toFixed(2),
    };
  });

  // 6. Quick stats
  const remainingDays = subscription ? subscription.remaining_days : 0;

  // Bottle stats (graceful if R-02 not yet migrated)
  let bottleStats = { total_given: 0, total_returned: 0 };
  let bottleBreakdown = [];
  try {
    bottleStats = db.prepare(`
      SELECT COALESCE(SUM(bottles_given), 0) AS total_given,
             COALESCE(SUM(bottles_returned), 0) AS total_returned
      FROM deliveries WHERE customer_id = ?
    `).get(customerId);
    bottleBreakdown = db.prepare(`
      SELECT delivery_date, COALESCE(bottles_given,0) AS given, COALESCE(bottles_returned,0) AS returned
      FROM deliveries WHERE customer_id = ? AND delivery_date >= ? AND delivery_date <= ?
        AND (bottles_given > 0 OR bottles_returned > 0)
      ORDER BY delivery_date DESC
    `).all(customerId, fromDate, toDate);
  } catch (e) { /* Columns not yet migrated */ }

  // 7. This month paid
  const thisMonthPayment = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments
    WHERE customer_id = ? AND payment_date >= ? AND payment_date <= ?
  `).get(customerId, currentMonthStart, today);

  // 8. Balance
  const balance = require('./services/subscription').getBalance(db, customerId);

  // 9. Render
  const flash = req.session.flash || null;
  req.session.flash = null;

  renderView(res, 'admin/customer-detail', {
    customer: customer,
    customerRate: (customer.monthly_rate / 100).toFixed(2),
    subscription: subscription,
    deliveryHistory: deliveryHistory,
    paymentHistory: paymentHistory,
    remainingDays: remainingDays,
    bottlesPending: bottleStats.total_given - bottleStats.total_returned,
    bottlesGiven: bottleStats.total_given,
    bottlesReturned: bottleStats.total_returned,
    bottleBreakdown: bottleBreakdown,
    thisMonthPaid: (thisMonthPayment.total_paid / 100).toFixed(2),
    balance: balance,
    fromDate: fromDate,
    toDate: toDate,
    preset: preset,
    flash: flash,
    activePage: 'customers',
    tokenPreview: customer.token ? customer.token.slice(-4) : null,
  });
});
```

**Add transaction ID search filtering** to the GET `/admin/payments` handler:

After ledgerRows assignment, if `req.query.transaction_id` is present, filter in-memory:
```javascript
if (req.query.transaction_id) {
  const filter = req.query.transaction_id.trim().toLowerCase();
  ledgerRows = ledgerRows.filter(function(r) {
    return r.transaction_id && r.transaction_id.toLowerCase().includes(filter);
  });
}
```

#### 3. `C:\Users\vajra\OneDrive\Desktop\mini project\views\admin\customers.ejs`

**Change the customer name cell** -- line 74 -- to be a clickable link:

Before: `<td><%= c.name %></td>`
After:
```html
<td>
  <a href="/admin/customers/<%= c.id %>/detail" class="text-blue-600 hover:text-blue-800 hover:underline font-medium"><%= c.name %></a>
</td>
```

#### 4. `C:\Users\vajra\OneDrive\Desktop\mini project\views\admin\payments.ejs`

**Add transaction ID search field** to the "View Customer Ledger" section -- after the customer dropdown, add:
```html
<div class="flex-1">
  <label for="search_txn" class="block text-sm font-medium text-gray-700 mb-1">Transaction ID (search)</label>
  <input type="text" name="transaction_id" id="search_txn"
         class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2D6A4F]"
         placeholder="Search by transaction ID...">
</div>
```

#### 5. `C:\Users\vajra\OneDrive\Desktop\mini project\test\routes.admin.test.js`

Add new describe block:
```javascript
describe('GET /admin/customers/:id/detail -- customer detail page', function() {
  // Tests:
  // - returns 200 and renders customer-detail for authenticated user
  // - shows customer info card (name, code, phone, address)
  // - shows subscription info
  // - shows quick stats bar with 4 metrics
  // - shows delivery history table
  // - shows payment history table with transaction IDs
  // - shows bottle tracker section
  // - date range presets alter query params
  // - invalid customer ID redirects with flash
  // - requires authentication (redirects to login)
});
```

#### 6. `C:\Users\vajra\OneDrive\Desktop\mini project\views\admin\layout.ejs`

No changes needed. The customer detail page reuses the existing `renderView()` helper with `activePage: 'customers'`.

### Acceptance Criteria for R-03

- [ ] Clicking customer name in customers table navigates to `/admin/customers/:id/detail`
- [ ] Customer info card shows: name, code, phone, address, delivery boy, rate, status, token (last 4 chars)
- [ ] Quick stats bar shows: remaining days, bottle pending, this month paid, current balance
- [ ] Date range filter has [From] [To] date inputs with [This Month] [Last Month] [Last 30 Days] presets
- [ ] Delivery history table shows: date, status, bottles given, bottles returned, issue
- [ ] Payment history table shows: date, amount, mode, transaction ID, notes, running balance
- [ ] Bottle tracker shows: total given, total returned, current pending, datewise breakdown
- [ ] Subscription info section shows: start, end, remaining days, pause history
- [ ] All tables filter by selected date range
- [ ] All tables show empty state when no data in range
- [ ] Invalid customer ID redirects with flash error
- [ ] Page requires authentication
- [ ] Back link returns to customer list

---

## Migration Summary

| Step | Version | SQL | File |
|------|---------|-----|------|
| R-05 | None | No schema change | `services/subscription.js` |
| R-04 | v5 | `ALTER TABLE payments ADD COLUMN transaction_id TEXT;` | `db.js` |

---

## Complete File Change Manifest

### Files Created (1)
| File | Purpose |
|------|---------|
| `views/admin/customer-detail.ejs` | Full customer detail page with all sections |

### Files Modified (8)
| File | What Changes |
|------|--------------|
| `db.js` | Add Migration v5 (transaction_id column) |
| `services/subscription.js` | R-05: Remove remaining_days increment/decrement from pause/resume; R-04: Accept transaction_id in recordPayment |
| `routes/admin.js` | R-04: Transaction ID validation + CSV export + search filter; R-03: Add GET /admin/customers/:id/detail route |
| `views/admin/customers.ejs` | R-03: Make customer name a clickable link to detail page |
| `views/admin/customer-detail.ejs` | NEW: Full customer detail page |
| `views/admin/payments.ejs` | R-04: Add transaction_id field to form, ledger table, and search filter |
| `test/subscription.test.js` | R-05: Rewrite pause/resume assertions; R-04: Add transaction_id tests + schema |
| `test/routes.admin.test.js` | R-04: Update payment tests for transaction_id; R-03: Add customer detail tests |
| `test/routes.customer.test.js` | R-04: Update schema only |

---

## Implementation Order (Sequential)

### Step 1: R-05 -- Pause Logic Simplification

1. Edit `services/subscription.js`:
   - `pauseSubscription()`: Remove `daysAdded` calculation and `remaining_days + ?` from UPDATE
   - `resumeSubscription()`: Remove entire `excessDays` calculation and `remaining_days - ?` from UPDATE
   - Update JSDoc comments to reflect new behavior

2. Edit `test/subscription.test.js`:
   - Rewrite all remaining_days assertions in pause/resume tests to expect no change
   - Remove tests that validated the old adjustment logic

**Verification:** `npm test` -- all subscription tests pass.

### Step 2: R-04 -- Transaction ID

1. Edit `db.js` -- add Migration v5
2. Edit `services/subscription.js` -- add transaction_id to recordPayment
3. Edit `routes/admin.js` -- add transaction_id validation + CSV column + search filter
4. Edit `views/admin/payments.ejs` -- add form field + ledger column + search + client-side validation
5. Edit `test/subscription.test.js` -- add transaction_id tests + update schema
6. Edit `test/routes.admin.test.js` -- update schema + add transaction_id payment tests
7. Edit `test/routes.customer.test.js` -- update schema

**Verification:** `npm test` -- all tests pass. Manually verify: record a payment with UPI + transaction_id, see it in ledger.

### Step 3: R-03 -- Customer Detail Card

1. Create `views/admin/customer-detail.ejs` with all 7 sections
2. Edit `routes/admin.js` -- add GET /admin/customers/:id/detail route with all queries
3. Edit `views/admin/customers.ejs` -- make customer name clickable
4. Edit `views/admin/payments.ejs` -- add transaction_id search filter
5. Edit `test/routes.admin.test.js` -- add customer detail tests

**Verification:** `npm test` -- all tests pass. Manually verify: click a customer name, see detail page, filter by date range.

---

## Test Plan

### Unit Tests (all driven by `npm test`)

| Test File | Existing Tests | New/Modified Tests | Total |
|-----------|---------------|-------------------|-------|
| `test/subscription.test.js` | ~30 | ~10 (5 for R-05 rewrite, 5 for R-04 transaction_id) | ~40 |
| `test/routes.admin.test.js` | ~100 | ~10 (R-04 payment + R-03 detail) | ~110 |
| `test/routes.customer.test.js` | ~10 | 0 (schema only) | ~10 |

### Manual Test Cases

1. **R-05 pause cycle:** Create active subscription with 25 remaining. Pause for 5 days. Verify remaining stays 25. Resume. Verify remaining still 25.
2. **R-04 transaction ID:** Record UPI payment with transaction_id "UPI123456". Verify rendered in ledger table. Record cash payment without transaction_id. Verify accepted. Record bank_transfer without transaction_id. Verify rejected.
3. **R-03 customer detail:** Navigate to customer detail. Verify all 7 sections render. Apply "Last Month" preset. Verify tables filter. Click back link. Verify returns to customer list.

---

## Dependencies and Sequencing

```
R-05          (no deps)
  |
  v
R-04          (no deps, but must not conflict with R-05 changes to subscription.js)
  |
  v
R-03          (depends on R-04 for transaction_id display in payment table)
```

R-05 touches `pauseSubscription()` and `resumeSubscription()` in `subscription.js`.
R-04 also touches `subscription.js` (the `recordPayment()` function). These two changes are in separate functions, so there is no file-level conflict -- but implement sequentially to avoid concurrent edit errors.

R-03 depends on R-04 because the customer detail page shows transaction_ids in the payment history table. R-03 does NOT depend on R-05 for display purposes, but R-05's simpler behavior should be reflected in the subscription info section.

---

## Risk Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| R-05 breaking existing pause/resume for active subscriptions | Medium | Test against a copy of the production DB before deploying. The migration is code-only (no schema change), so rollback is a git revert + server restart. |
| R-04 migration v5 collision with existing data | Low | ALTER TABLE ADD COLUMN on SQLite is safe for existing rows -- new column defaults to NULL. |
| R-03 page too large with all queries | Low | Use paginated queries if delivery history exceeds 100 rows. For current ~100 customers x 30 days = ~3000 deliveries, all in-memory is fine. |
| bottles_given/bottles_returned columns not yet migrated (R-02) | Low | Wrapped in try-catch so R-03 works before R-02 is deployed. Bottle section shows "not yet available" gracefully. |
| Long route handler for customer detail | Medium | Consider extracting data-fetching into a `getCustomerDetailData()` service function if the route handler exceeds 100 lines. |

