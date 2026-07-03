# Implementation Plan: Phase 2 — Payments & Reports

## Overview

Add payment recording (append-only ledger), per-customer balance calculation, a reports page with monthly collection / delivery success rate / overdue accounts, and CSV export. Requires migration v2 (payments table), a new subscription service module, two new EJS templates, and additions to the admin router and sidebar.

## Dependencies on Existing Code

All Phase 2 code depends on the following existing interfaces and patterns already established in the codebase:

- **db.js** — Migration v2 block goes after migration v1 block, same pattern: `if (currentVersion < 2) { db.exec(...); }`. The `initializeDatabase()` function returns the db singleton and is called once at startup. The `_migrations` table tracks applied versions.

- **routes/admin.js** — The `setupAdminRoutes(app, db)` function registers all admin routes. New routes must be added inside this function. Uses `renderView(res, 'admin/...', data)` for template rendering. Uses `requireAuth` middleware for authentication. Uses `req.session.flash` for success/error messages. Existing services imported at line 12: `const { generateDispatch, ... } = require('../services/dispatch')`.

- **views/admin/layout.ejs** — Sidebar navigation items follow the pattern: `<a href="/admin/..." class="<%= activePage === '...' ? 'active' : '' %>">`. New sidebar links for Payments and Reports must be added after the existing Dispatch link.

- **public/css/style.css** — Badge classes follow the pattern `.badge-{status}`. Table styling via `.data-table`. Stat cards via `.stat-card` and children.

- **All monetary values stored in paise** (integers). Display by dividing by 100. Input from admin is in rupees.

- **subscriptions.remaining_days** is decremented on `/done` and incremented on `/skip` (already in routes/telegram.js).

---

## Step 1: Migration v2 — payments table

**File:** `db.js`

**Action:** Add migration version 2 block immediately after the migration v1 block ends (after the `INSERT INTO _migrations` for v1), and before the seed delivery boys section.

**SQL to add inside the `if (currentVersion < 2)` block:**
```sql
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,            -- in paise
  mode VARCHAR(20) NOT NULL,           -- cash, upi, bank_transfer
  payment_date DATE NOT NULL,
  notes TEXT,
  recorded_by VARCHAR(100),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_payments_customer ON payments(customer_id);
```

**Migration registration:**
```js
db.prepare(
  'INSERT INTO _migrations (version, name) VALUES (?, ?)'
).run(2, 'v2_create_payments_table');
```

**Why:** The payments table is append-only. No edit or delete endpoints exist (per PRD section 6.2). The `UNIQUE` constraint is deliberately not on `(customer_id, payment_date)` because multiple payments can occur on the same date.

**Verification:** Restart server, check `_migrations` table has version 2 row, check payments table exists.

**Dependencies:** None. No existing data references payments, so no migration of existing data is needed.

**Risk:** Low. Follows exact same pattern as migration v1.

---

## Step 2: services/subscription.js — Balance and ledger logic

**File:** `services/subscription.js` (new file)

**Exports:**
```
module.exports = { getBalance, getPaymentLedger, recordPayment, getPaymentModes };
```

**Dependencies:** Receives `db` parameter in every function (no module-level state).

### Function: `getBalance(db, customerId)`

**Purpose:** Calculate the customer's effective remaining days by comparing total payments against delivered days.

**Parameters:** `db` (better-sqlite3 Database), `customerId` (number)

**Returns:** `{ paidDays, consumedDays, balanceDays, subscriptionRemaining, isOverdue }`

**SQL queries:**
1. `SELECT monthly_rate FROM customers WHERE id = ?`
2. `SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE customer_id = ?`
3. `SELECT COUNT(*) AS delivered_count FROM deliveries WHERE customer_id = ? AND status = 'delivered'`
4. `SELECT remaining_days, total_days, status FROM subscriptions WHERE customer_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`

**Computation:**
- If monthly_rate > 0: `paidDays = Math.floor(totalPaid / monthlyRate * 30)`
- `consumedDays = deliveredCount`
- `balanceDays = paidDays - consumedDays`
- `isOverdue = balanceDays <= 0 AND subscription.status = 'active'`

**Why separate from subscription.remaining_days:** The subscription's `remaining_days` field tracks per-cycle remaining, but the payment-based balance is the true financial position. Overdue detection requires comparing what was paid vs. what was consumed.

### Function: `getPaymentLedger(db, customerId)`

**Purpose:** Return chronological list of payments for a customer with running total.

**Parameters:** `db`, `customerId` (number)

**Returns:** Array of payment objects, each with an added `runningTotalPaise` and `runningTotalRupees` field.

**SQL query:** `SELECT * FROM payments WHERE customer_id = ? ORDER BY payment_date ASC, created_at ASC`

**Post-processing:** Iterate through rows, compute cumulative sum of `amount` into `runningTotalPaise`. Add `amount_rupees = (amount / 100).toFixed(2)` and `runningTotalRupees = (runningTotalPaise / 100).toFixed(2)` to each row.

### Function: `recordPayment(db, data)`

**Purpose:** Insert a single payment record inside a transaction. Validates and returns the new row ID.

**Parameters:**
- `db` — database instance
- `data` — object with:
  - `customerId` (number, required)
  - `amount` (number, in paise, must be > 0)
  - `mode` (string, must be one of: 'cash', 'upi', 'bank_transfer')
  - `paymentDate` (string, YYYY-MM-DD format)
  - `notes` (string, optional, defaults to empty string)
  - `recordedBy` (string, optional, defaults to 'Admin')

**Returns:** `{ id: number }` — the new payment row ID

**Throws:** Error if validation fails (zero/negative amount, invalid mode, missing customer)

**SQL:** `INSERT INTO payments (customer_id, amount, mode, payment_date, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?)`

**Validation:**
- `customerId` must be truthy and positive
- `amount` must be > 0
- `mode` must be one of `['cash', 'upi', 'bank_transfer']`
- `paymentDate` must be a valid date string

### Function: `getPaymentModes()`

**Purpose:** Return the valid payment modes for dropdown rendering.

**Returns:** `['cash', 'upi', 'bank_transfer']`

**Parameters:** None (pure function)

**Why:** Centralizes the allowed values so the template and validation stay in sync without magic strings.

---

## Step 3: Update layout.ejs — Add sidebar links

**File:** `views/admin/layout.ejs`

**Action:** Add two sidebar navigation links (Payments and Reports) after the Dispatch link and before the closing `</nav>` tag.

**Template additions for Payments link:**
```ejs
<a href="/admin/payments" class="<%= activePage === 'payments' ? 'active' : '' %>">
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
  Payments
</a>
```

**Template additions for Reports link:**
```ejs
<a href="/admin/reports" class="<%= activePage === 'reports' ? 'active' : '' %>">
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
  Reports
</a>
```

**Why:** Without these links, the new pages would only be accessible by manually typing URLs. The `activePage` pattern already exists in every existing link.

**Risk:** Low. Pure template change, follows exact existing pattern.

---

## Step 4: views/admin/payments.ejs — Payment recording form and ledger

**File:** `views/admin/payments.ejs` (new file)

**Data contract (passed from route handler):**
```js
{
  customers: [ { id, code, name, monthly_rate, delivery_boy_name } ],
  paymentModes: ['cash', 'upi', 'bank_transfer'],
  ledger: { rows: [...], customerName, customerCode, balance: { ... } } or null,
  flash: { type, message } or null,
  activePage: 'payments'
}
```

**Template sections (in order):**

1. **Header row:** Title "Payments" (h1). No add button — form is always visible.

2. **Flash message block** — identical pattern to customers.ejs and dispatch.ejs.

3. **Payment recording form** (card with white background):
   - Form action: `POST /admin/payments`
   - Grid layout: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`
   - **Customer** (select, required) — dropdown of all active customers, option value = customer id, display text = "C001 - Name"
   - **Amount (Rs)** (number input, required, min=0.01, step=0.01)
   - **Mode** (select) — options from `paymentModes` array
   - **Payment Date** (date input, required) — default to today
   - **Notes** (text input, optional)
   - Submit button: "Record Payment"

4. **Customer ledger filter section** (below the form):
   - Compact card with customer dropdown and "View Ledger" button
   - Form submits via GET to `/admin/payments?customer_id=X`

5. **Ledger table** (visible only when `ledger` is not null):
   - Customer name and code header above table
   - Balance summary card showing: Paid Days, Consumed Days, Balance Days, Overdue badge
   - Table with columns: Date, Amount (Rs), Mode, Notes, Recorded By
   - Running total row at bottom: "Total: Rs X,XXX.XX"
   - Empty state: "No payments recorded for this customer."

**Data flow:** Admin selects customer from filter dropdown, submits GET /admin/payments?customer_id=123. Route handler calls `getPaymentLedger(db, customerId)` and `getBalance(db, customerId)`. Template renders ledger table + balance card. The recording form at the top remains visible.

---

## Step 5: views/admin/reports.ejs — Reports page

**File:** `views/admin/reports.ejs` (new file)

**Data contract:**
```js
{
  monthlyCollection: { totalPaise, totalRupees, paymentCount },
  deliveryStats: { total, delivered, skipped, issue, pending, successRate },
  overdueAccounts: [ { id, code, name, phone, balanceDays, monthly_rate } ],
  reportMonth: 'YYYY-MM',
  flash: { type, message } or null,
  activePage: 'reports'
}
```

**Template sections:**

1. **Header:** Title "Reports" + month selector form (input type="month", submits GET to `/admin/reports?month=YYYY-MM`)

2. **Monthly Collection card** (green left border stat-card):
   - "Total Collected: Rs X,XXX.XX" (large font)
   - "Payments Recorded: N" (smaller, muted text)

3. **Delivery Success Rate card** (blue left border stat-card):
   - "Success Rate: XX.X%" (large font, color-coded: green >= 90%, amber >= 75%, red < 75%)
   - "X delivered out of Y total"

4. **Overdue Accounts section:**
   - Red header with count badge
   - Table with columns: Code, Name, Phone, Balance (days), Rate (Rs)
   - Empty state: "No overdue accounts. All customers are up to date."

5. **CSV Export buttons:**
   - Three buttons: "Export Payments CSV", "Export Customers CSV", "Export Deliveries CSV"
   - Links to `/admin/reports/payments.csv`, `/admin/reports/customers.csv`, `/admin/reports/deliveries.csv`
   - Styled as outlined buttons

---

## Step 6: routes/admin.js — Payment and reports routes

**File:** `routes/admin.js`

### New import (add at top of file, near existing dispatch import at line 12):
```js
const { getBalance, getPaymentLedger, recordPayment, getPaymentModes } = require('../services/subscription');
```

### Route: GET /admin/payments

**Path:** `/admin/payments` | **Middleware:** `requireAuth`

**Handler logic:**
1. Query all active customers for dropdown
2. Check for `req.query.customer_id`: if present, call `getPaymentLedger(db, customerId)` and `getBalance(db, customerId)`, attach customer name/code to ledger object
3. Read and clear `req.session.flash`
4. Call `renderView(res, 'admin/payments', { customers, paymentModes: getPaymentModes(), ledger, flash, activePage: 'payments' })`

### Route: POST /admin/payments

**Path:** `/admin/payments` | **Middleware:** `requireAuth`

**Handler logic:**
1. Extract `customer_id`, `amount`, `mode`, `payment_date`, `notes` from `req.body`
2. Validate: `customer_id` present, `amount` is positive number, `mode` in `['cash','upi','bank_transfer']`, `customer_id` references existing customer
3. Convert amount to paise: `Math.round(parseFloat(amount) * 100)`
4. Call `recordPayment(db, { customerId, amount, mode, paymentDate, notes, recordedBy: 'Admin' })`
5. Set `req.session.flash` with success/error, redirect to `/admin/payments`

### Route: GET /admin/reports

**Path:** `/admin/reports` | **Middleware:** `requireAuth`

**Handler logic:**
1. Determine report month from `req.query.month` or default to current month
2. Compute month boundaries
3. Query monthly collection, delivery stats, overdue accounts
4. Call `renderView(res, 'admin/reports', { monthlyCollection, deliveryStats, overdueAccounts, reportMonth, flash, activePage: 'reports' })`

### Route: GET /admin/reports/payments.csv

**Path:** `/admin/reports/payments.csv` | **Middleware:** `requireAuth`

**Handler logic:**
1. Query payments with JOIN to customers
2. Set headers: `Content-Type: text/csv` and `Content-Disposition: attachment; filename="payments.csv"`
3. Build CSV string, send with `res.send()`

### Route: GET /admin/reports/customers.csv

**Path:** `/admin/reports/customers.csv` | **Middleware:** `requireAuth`

**Handler logic:** Same pattern as payments.csv, query customers table with JOIN to delivery_boys.

### Route: GET /admin/reports/deliveries.csv

**Path:** `/admin/reports/deliveries.csv` | **Middleware:** `requireAuth`

**Handler logic:** Same pattern, query deliveries with JOINs, optional `?month=YYYY-MM` filter.

---

## Step 7: No package.json changes needed

The subscription service is pure JavaScript with no imports beyond the database instance passed as a parameter. No CSV library needed — CSV is generated via string concatenation.

**Verification:** `npm ls` shows no new packages. `require('./services/subscription')` works without additional npm install.

---

## Data Flow Diagrams

### Payment Recording Flow
```
[Admin clicks Payments in sidebar]
  → GET /admin/payments
  → routes/admin.js queries all active customers
  → Renders payments.ejs with customer dropdown + form

[Admin fills form: selects customer, enters Rs 500, selects cash, enters date]
  → POST /admin/payments (body: customer_id=1, amount=500, mode=cash, payment_date=2026-07-02)
  → routes/admin.js validates: amount > 0, mode in ['cash','upi','bank_transfer'], customer exists
  → calls services/subscription.js recordPayment(db, {customerId, amount: 50000, mode, paymentDate, notes})
  → recordPayment does INSERT INTO payments ...
  → sets flash.success, redirects to /admin/payments
  → GET /admin/payments renders page with flash message
```

### Ledger View Flow
```
[Admin selects customer from ledger filter dropdown]
  → GET /admin/payments?customer_id=1
  → routes/admin.js: if query.customer_id present:
     → calls getPaymentLedger(db, 1) → SELECT ... ORDER BY payment_date ASC
     → calls getBalance(db, 1) → computes paidDays, consumedDays, balanceDays
  → Renders payments.ejs with ledger data + balance card
```

### Reports Flow
```
[Admin clicks Reports in sidebar]
  → GET /admin/reports
  → routes/admin.js:
     → Queries monthly payment SUM/COUNT
     → Queries delivery stats for month
     → Iterates active customers, calls getBalance() on each for overdue detection
  → Renders reports.ejs with 3 sections + CSV buttons

[Admin clicks "Export Payments CSV"]
  → GET /admin/reports/payments.csv
  → routes/admin.js queries all payments with JOIN to customers
  → Returns CSV file download
```

---

## Testing Strategy

### Unit tests (services/subscription.js):
- `getPaymentLedger()` with 0 payments returns empty array
- `getPaymentLedger()` with 3 payments returns array with running totals
- `recordPayment()` with valid data inserts row and returns id
- `recordPayment()` with zero amount throws error
- `recordPayment()` with invalid mode throws error
- `getBalance()` with no payments and no deliveries returns 0 for all fields
- `getBalance()` with full payment and partial consumption returns positive balance
- `getBalance()` with insufficient payment returns negative balance (overdue=true)

### Integration tests (routes/admin.js):
- `GET /admin/payments` returns 302 when unauthenticated
- `GET /admin/payments` returns 200 when authenticated
- `POST /admin/payments` with valid data records payment and redirects
- `POST /admin/payments` with empty fields returns error flash
- `POST /admin/payments` with negative amount returns error flash
- `GET /admin/reports` returns 200 when authenticated
- `GET /admin/reports/payments.csv` returns CSV with correct headers
- `GET /admin/reports/customers.csv` returns CSV with correct headers
- `GET /admin/reports/deliveries.csv` returns CSV with correct headers

### Manual verification checklist:
- [ ] Start server, check `_migrations` has version 2
- [ ] Open `/admin/payments`, see customer dropdown and form
- [ ] Record a payment, see success flash
- [ ] View ledger for that customer, see payment row with running total
- [ ] Record another payment for same customer, ledger running total updates
- [ ] Open `/admin/reports`, see collection data matching recorded payments
- [ ] Export CSVs, verify they open correctly in Excel/Google Sheets
- [ ] Negative amount is rejected with error
- [ ] Empty customer is rejected with error
- [ ] Invalid mode is rejected with error

---

## Success Criteria

- [ ] Migration v2 creates payments table automatically on server restart
- [ ] Admin can record a payment in under 15 seconds (select customer, enter amount, submit)
- [ ] Per-customer ledger shows chronological payment history with running balance
- [ ] Reports page shows monthly collection, delivery success rate, overdue accounts
- [ ] CSV export works for payments, customers, and deliveries with proper headers
- [ ] Balance floors at 0 for display, but overdue flag triggers when balance is negative
- [ ] Payments are append-only: no edit or delete endpoints exist
- [ ] Validation rejects zero amounts and invalid payment modes

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| getBalance() performance degrades with 100 customers | Low | Low | Query is O(n) per customer, ~100 customers is trivial for SQLite. If needed, batch with GROUP BY. |
| CSV injection (formulas in exported data) | Low | Medium | Escape `=` `+` `-` `@` at start of CSV cells by prefixing with single quote. |
| Missing sidebar link for Payments/Reports | Low | Medium | Both links added in Step 3 before routes are created; verified in checklist. |
| flash message not cleared after redirect | Low | Low | Existing pattern of `req.session.flash = null` after reading prevents this. |

---

## File Change Summary

| File | Action | Lines (approx) |
|------|--------|----------------|
| `db.js` | Modify: add migration v2 block | +15 |
| `services/subscription.js` | Create: new service module | +120 |
| `views/admin/layout.ejs` | Modify: add 2 sidebar links | +16 |
| `views/admin/payments.ejs` | Create: payment form + ledger template | +180 |
| `views/admin/reports.ejs` | Create: reports template | +150 |
| `routes/admin.js` | Modify: add 6 new routes + 1 import | +210 |

**Total: ~690 new/changed lines across 6 files.**