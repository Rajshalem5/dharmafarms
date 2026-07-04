# Implementation Plan: R-01 B2B Customer Section + R-02 Bottle Return Tracking

## 1. Overview

This plan covers two related features from the Revision 2.0 PRD:

- **R-01**: B2B customer type (restaurants, chai stalls, hostels) with order-based consumption, no subscriptions, admin-entered daily quantities, and invoice generation.
- **R-02**: Bottle return tracking (bottles_given / bottles_returned) with residential auto-calculation, B2B manual entry, dashboard alerts, and Telegram bottle collection prompt.

Both features share the `customer_type` column and integrate through bottle tracking on B2B daily entries. They are implemented in a single combined phase.

### Migration Numbering Correction

The PRD Section 9 migration table erroneously lists v4, v5, v6. The actual `db.js` already uses v4 for `paused_from`. The correct mapping is:

| Version | PRD Label | Actual Migration | Status |
|---------|-----------|-----------------|--------|
| v1 | 1 | Core tables | Applied |
| v2 | 2 | Payments table | Applied |
| v3 | 3 | scheduler_log | Applied |
| v4 | 4 | paused_from on subscriptions | Applied |
| v5 | R-04 | transaction_id on payments | NEW |
| v6 | R-01 | customer_type on customers | NEW |
| v7 | R-02 | bottles_given/bottles_returned on deliveries | NEW |

---

## 2. Files to Create / Modify

### 2.1 New Files (7)

| # | File Path | Purpose |
|---|-----------|---------|
| 1 | `routes/b2b.js` | B2B-specific route handlers: daily entry, customer list, invoice, consumption ledger |
| 2 | `services/b2b.js` | B2B business logic: record consumption, calculate running balance, generate invoice data |
| 3 | `services/bottles.js` | Bottle tracking logic: record bottles, calculate pending balance, get alert candidates |
| 4 | `views/admin/b2b-customers.ejs` | B2B customer list + add/edit form (filtered to customer_type='b2b') |
| 5 | `views/admin/b2b-daily.ejs` | Daily consumption entry form + today's entries table |
| 6 | `views/admin/b2b-invoice.ejs` | Invoice page: customer selector, date range, printable consumption/payment/balance |
| 7 | `views/admin/b2b-ledger.ejs` | B2B consumption ledger per customer (shared with invoice data) |

### 2.2 Modified Files (10)

| # | File Path | Change |
|---|-----------|--------|
| 1 | `db.js` | Add migrations v5, v6, v7. Add bottle_config table |
| 2 | `server.js` | Mount `setupB2bRoutes(app, db)` |
| 3 | `routes/admin.js` | Add bottle alert to dashboard query; add customer_type to customer queries |
| 4 | `routes/telegram.js` | Add bottle collection prompt after `/done` for residential customers |
| 5 | `services/telegram.js` | Add `formatBottlePrompt()` function |
| 6 | `services/dispatch.js` | Exclude `customer_type='b2b'` from auto-dispatch generation |
| 7 | `views/admin/layout.ejs` | Add "B2B Customers" sidebar section with sub-items |
| 8 | `views/admin/dashboard.ejs` | Add bottle pending alerts section (customers with pending > 3) |
| 9 | `views/admin/customers.ejs` | Show `customer_type` in table, filter by type, add type selector in add/edit form |
| 10 | `public/css/style.css` | Add badge styles, invoice print styles, bottle alert styles |

### 2.3 Test Files (3 new)

| # | File Path | Purpose |
|---|-----------|---------|
| 1 | `test/routes.b2b.test.js` | Tests for B2B routes (daily entry, invoice, ledger, customer list) |
| 2 | `test/bottles.test.js` | Tests for bottle tracking service functions |
| 3 | `test/b2b.test.js` | Tests for B2B service functions (consumption, balance, invoice) |

---

## 3. Database Migration Details

### Migration v5: Transaction ID on Payments (R-04 prerequisite)

```sql
ALTER TABLE payments ADD COLUMN transaction_id TEXT;
```

### Migration v6: Customer Type on Customers (R-01)

```sql
ALTER TABLE customers ADD COLUMN customer_type VARCHAR(20) DEFAULT 'residential';
```

- Default is `'residential'` to preserve backward compatibility
- No need to update existing rows — they automatically get default
- Existing views and queries continue to work without modification

### Migration v7: Bottle Tracking on Deliveries (R-02)

```sql
ALTER TABLE deliveries ADD COLUMN bottles_given INTEGER DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN bottles_returned INTEGER DEFAULT 0;
```

- Default 0 for both columns
- Existing rows get 0 for both, which is correct (no bottle data for past deliveries)

### New Table: bottle_config

```sql
CREATE TABLE IF NOT EXISTS bottle_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO bottle_config (key, value) VALUES ('bottle_rate', '1');
INSERT OR IGNORE INTO bottle_config (key, value) VALUES ('bottle_unit', 'L');
```

- `bottle_rate`: 1 = 1L per bottle, 2 = 2 bottles of 500ml per litre
- `bottle_unit`: 'L' = litres, '500ml' = half-litre bottles

### New Table: b2b_daily_entries

```sql
CREATE TABLE b2b_daily_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  entry_date DATE NOT NULL,
  quantity_litres REAL NOT NULL,
  rate_per_litre INTEGER NOT NULL,  -- in paise
  bottles_given INTEGER DEFAULT 0,
  bottles_returned INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(customer_id, entry_date)
);
CREATE INDEX idx_b2b_entries_customer ON b2b_daily_entries(customer_id);
CREATE INDEX idx_b2b_entries_date ON b2b_daily_entries(entry_date);
```

---

## 4. Route Changes

### 4.1 New File: `routes/b2b.js`

Exports `setupB2bRoutes(app, db)` with these endpoints:

| Method | Path | Purpose | Auth Required |
|--------|------|---------|---------------|
| GET | `/admin/b2b` | Redirect to /admin/b2b/daily | Yes |
| GET | `/admin/b2b/customers` | List B2B customers (customer_type='b2b') | Yes |
| POST | `/admin/b2b/customers` | Add new B2B customer (no subscription) | Yes |
| GET | `/admin/b2b/customers/:id` | Get B2B customer JSON for edit | Yes |
| POST | `/admin/b2b/customers/:id/edit` | Update B2B customer | Yes |
| POST | `/admin/b2b/customers/:id/toggle-status` | Activate/deactivate B2B customer | Yes |
| GET | `/admin/b2b/daily` | Daily consumption entry form + today's entries | Yes |
| POST | `/admin/b2b/daily` | Record daily consumption quantity for a B2B customer | Yes |
| GET | `/admin/b2b/ledger/:id` | Consumption ledger for a B2B customer (JSON) | Yes |
| GET | `/admin/b2b/invoice` | Invoice page with customer selector + date range | Yes |
| GET | `/admin/b2b/invoice/:id` | Invoice data JSON (query params: ?from=&to=) | Yes |

### 4.2 Modified: `routes/admin.js`

- Dashboard: add bottle pending alert query, pass `bottleAlerts` to template
- Customer list: add `customer_type` to query SELECT, add type filter

### 4.3 Modified: `routes/telegram.js`

- After `/done`: auto-calculate `bottles_given`, send bottle reminder if pending > 0
- New `/bottles` command: `/bottles C001 3` records bottles collected

### 4.4 Modified: `services/dispatch.js`

- Add `AND c.customer_type = 'residential'` to `generateDispatch` query

---

## 5. Service Layer Changes

### 5.1 New File: `services/b2b.js`

Exports:
- `recordDailyEntry(db, data)` — returns `{ id, entryDate }`
- `getB2bConsumption(db, customerId, { from, to })` — returns consumption entries
- `getB2bBalance(db, customerId)` — returns `{ totalConsumptionPaise, totalPaymentsPaise, balancePaise }`
- `getB2bInvoiceData(db, customerId, { from, to })` — returns `{ consumption, payments, totals }`
- `getB2bCustomers(db, { status })` — returns filtered list with consumption stats
- `getB2bCustomerById(db, id)` — returns single B2B customer or null

### 5.2 New File: `services/bottles.js`

Exports:
- `getBottleConfig(db)` — returns `{ rate: 1|2, unit: 'L'|'500ml' }`
- `updateBottleConfig(db, { rate, unit })`
- `autoCalculateBottlesGiven(db, deliveryId, quantityLitres)`
- `recordBottlesReturned(db, deliveryId, bottlesReturned)`
- `getPendingBottles(db, customerId)` — SUM(bottles_given) - SUM(bottles_returned)
- `getBottleAlerts(db, threshold = 3)` — customers with pending > threshold
- `getBottleHistory(db, customerId)` — datewise bottle breakdown

---

## 6. View / EJS Template Changes

### 6.1 Modified: `views/admin/layout.ejs`
Add "B2B Customers" section in sidebar with sub-items: Daily Entry, Invoice, Customers.

### 6.2 Modified: `views/admin/dashboard.ejs`
Add bottle pending alert section (amber warning box) when customers have pending > 3.

### 6.3 Modified: `views/admin/customers.ejs`
Add customer_type column, filter tabs, type selector in add/edit form.

### 6.4 New: `views/admin/b2b-customers.ejs`
B2B customer list with columns: Code, Name, Phone, Address, Rate/L, Status, Actions. No delivery boy column.

### 6.5 New: `views/admin/b2b-daily.ejs`
Daily consumption entry form with customer dropdown, quantity, rate, bottles, notes. Below: today's entries table.

### 6.6 New: `views/admin/b2b-invoice.ejs`
Printable invoice with customer selector, date range, consumption table, payments table, balance, print button.

---

## 7. Telegram Bot Changes

### 7.1 Bottle Collection Prompt After `/done`
- Auto-calculate `bottles_given` from delivery quantity
- Send bottle reminder if pending > 0
- Non-blocking — informational message after delivery confirmation

### 7.2 New Command: `/bottles`
- `/bottles C001 3` — Record 3 bottles collected
- Updates `bottles_returned` on today's delivery
- Replies with updated pending count
- Added to `/help` command

---

## 8. Order of Implementation

### Step 1: Database Migrations (db.js)
Add migrations v5 (transaction_id), v6 (customer_type), v7 (bottles), bottle_config table + b2b_daily_entries table. Run and verify.

### Step 2: Dispatch Exclusion (services/dispatch.js)
Add `AND c.customer_type = 'residential'` to dispatch queries.

### Step 3: B2B Service Layer (services/b2b.js)
Implement all B2B business logic functions.

### Step 4: Bottle Service Layer (services/bottles.js)
Implement all bottle tracking functions.

### Step 5: B2B Routes (routes/b2b.js)
Add all B2B route handlers. Mount in server.js.

### Step 6: B2B Views (EJS templates)
Create b2b-customers.ejs, b2b-daily.ejs, b2b-invoice.ejs.

### Step 7: Layout Update (views/admin/layout.ejs)
Add B2B sidebar section.

### Step 8: Customer List Update (views/admin/customers.ejs)
Add customer_type column and filter.

### Step 9: Dashboard Bottle Alerts (views/admin/dashboard.ejs + routes/admin.js)
Add bottle alert query and display.

### Step 10: Telegram Bot Bottle Changes (routes/telegram.js + services/telegram.js)
Add auto-calculation, bottle prompt, /bottles command.

### Step 11: CSS Updates (public/css/style.css)
Add badge styles, invoice print styles, bottle alert styles.

### Step 12: Update Payment Form
Ensure B2B customers appear in payment dropdown.

### Step 13: Tests
Write all test files, run full test suite.

### Step 14: Manual Verification
Full end-to-end testing of all B2B and bottle tracking flows.

---

## 9. Acceptance Criteria

### R-01
- [ ] Admin can add a customer with `customer_type = 'b2b'` — no subscription auto-created
- [ ] B2B customers listed in "B2B Customers" sidebar section
- [ ] Auto-dispatch does NOT create deliveries for B2B customers
- [ ] Admin can record daily consumption quantity for a B2B customer
- [ ] Duplicate entry for same customer+date returns error
- [ ] B2B running balance = total consumption (litres x rate) minus total payments
- [ ] Invoice page shows customer, date range, consumption table, payments, balance
- [ ] Invoice is printable via browser Print
- [ ] B2B entries are append-only — no edit or delete endpoints

### R-02
- [ ] `bottles_given` and `bottles_returned` columns exist on deliveries table
- [ ] `bottle_config` table exists with seed data
- [ ] `/done` auto-calculates `bottles_given` for residential
- [ ] After `/done`, bot sends bottle reminder if pending > 0
- [ ] `/bottles C001 3` records bottles returned
- [ ] Dashboard shows bottle pending alerts for customers with pending > 3
- [ ] Bottle balance = SUM(bottles_given) - SUM(bottles_returned) per customer
- [ ] Existing deliveries have bottles_given=0, bottles_returned=0 after migration
- [ ] Empty state: no alerts when no customers have pending > 3

---

## 10. Potential Challenges

| Challenge | Mitigation |
|-----------|------------|
| Migration numbering conflict | Use v5-v8 as corrected in this plan |
| B2B payments integration | Payments table is already customer_id-based; no changes needed |
| Print CSS for invoice | Include all print styles in a `<style>` tag within the invoice page |
| Express 5 route parameter handling | Verify `req.params` works correctly |
| Telegram message length | Keep bottle prompt to 1-2 lines |