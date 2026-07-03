# Implementation Plan: Admin Visibility Improvements

## Overview

Add three visibility improvements to the admin UI: (1) remaining subscription days column on the customers page, (2) financial summary card on the dashboard, and (3) expiring subscriptions alert banner on the dashboard. No schema changes — all data is already in the database.

## Requirements

- Add `remaining_days` column to the customers table view, derived from the subscriptions table
- Add financial summary card to dashboard: total collected this month (₹), expected monthly revenue (₹), overdue count
- Add expiring subscriptions alert (remaining_days <= 3) to dashboard
- Follow existing design patterns (stat-card, data-table, #1B4332 green theme)

## Files to Change (3 files, 4 changes total)

### File 1: `routes/admin.js` — 2 changes

#### Change A: Add remaining_days subquery to customer list SQL

**Current SQL:**
```sql
SELECT c.*, db.name AS delivery_boy_name
FROM customers c
LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
ORDER BY c.code ASC
```

**New SQL:**
```sql
SELECT c.*, db.name AS delivery_boy_name,
  (SELECT remaining_days FROM subscriptions
   WHERE customer_id = c.id AND status = 'active'
   ORDER BY id DESC LIMIT 1) AS remaining_days
FROM customers c
LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
ORDER BY c.code ASC
```

Rationale: A correlated subquery with `LIMIT 1` prevents duplicate rows (unlike a JOIN) and returns `NULL` for customers with no active subscription. The subquery filters `status = 'active'` so expired or paused subscriptions are excluded.

#### Change B: Add 4 new queries to dashboard handler

Insert these queries after the `activeCustomers` query and before the `renderView` call:

**Query 1 — Total collected this month:**
```javascript
const monthStart = today.slice(0, 7) + '-01';

const collectionRow = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total_paise
  FROM payments
  WHERE payment_date >= ? AND payment_date < date(?, 'start of month', '+1 month')
`).get(monthStart, today);
```

**Query 2 — Expected monthly revenue:**
```javascript
const expectedRevenueRow = db.prepare(`
  SELECT COALESCE(SUM(monthly_rate), 0) AS expected_paise
  FROM customers WHERE status = 'active'
`).get();
```

**Query 3 — Overdue count (single-pass computation):**
```javascript
const activeCustomersWithSub = db.prepare(`
  SELECT c.id, c.monthly_rate,
    COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id = c.id), 0) AS total_paid,
    COALESCE((SELECT COUNT(*) FROM deliveries WHERE customer_id = c.id AND status = 'delivered'), 0) AS delivered_count
  FROM customers c
  INNER JOIN subscriptions s ON s.customer_id = c.id AND s.status = 'active'
  WHERE c.status = 'active'
`).all();

let overdueCount = 0;
for (const c of activeCustomersWithSub) {
  const paidDays = c.monthly_rate > 0
    ? Math.floor(c.total_paid / c.monthly_rate * 30)
    : 0;
  if (paidDays - c.delivered_count < 0) {
    overdueCount++;
  }
}
```

**Query 4 — Expiring subscriptions:**
```javascript
const expiringSubs = db.prepare(`
  SELECT c.code, c.name, s.remaining_days
  FROM customers c
  INNER JOIN subscriptions s ON s.customer_id = c.id
  WHERE c.status = 'active' AND s.status = 'active' AND s.remaining_days <= 3
  ORDER BY s.remaining_days ASC, c.name ASC
`).all();
```

**Then update the renderView call** to pass the new data:
```javascript
renderView(res, 'admin/dashboard', {
  // ... existing properties unchanged ...
  monthlyCollected: collectionRow.total_paise,
  expectedRevenue: expectedRevenueRow.expected_paise,
  overdueCount,
  expiringSubs,
});
```

### File 2: `views/admin/customers.ejs` — Add "Rem. Days" column

**Change A:** Add a `Rem. Days` column header between the Rate (₹) header and the Token header:
```ejs
            <th>Rem. Days</th>
```

**Change B:** Add a data cell between the rate cell and the token cell:
```ejs
              <td class="<%= c.remaining_days !== null && c.remaining_days <= 3 ? 'text-red-600 font-medium' : '' %> tabular-nums">
                <%= c.remaining_days !== null ? c.remaining_days : '—' %>
              </td>
```

Key behaviors:
- Em-dash (`—`) for customers with no active subscription (remaining_days is NULL)
- Red text when remaining_days <= 3
- Tabular-nums class for consistent number alignment
- Normal text for all other values

### File 3: `views/admin/dashboard.ejs` — Add financial summary + expiring alert

Insert the financial summary stat-cards and the expiring subscriptions alert **outside** the `if (!hasDeliveries)` block so they appear even when today's dispatch hasn't been generated.

**Financial Summary Row (3 stat-cards using existing pattern):**
```ejs
  <!-- Financial Summary -->
  <div class="stats-grid mb-6">
    <div class="stat-card">
      <div class="stat-card-border" style="background:#16a34a"></div>
      <div class="stat-card-body">
        <p class="stat-card-count tabular-nums">₹ <%= (+monthlyCollected / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) %></p>
        <p class="stat-card-label">Collected This Month</p>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-border" style="background:#2563eb"></div>
      <div class="stat-card-body">
        <p class="stat-card-count tabular-nums">₹ <%= (+expectedRevenue / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) %></p>
        <p class="stat-card-label">Expected Monthly Revenue</p>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-border" style="background:<%= overdueCount > 0 ? '#dc2626' : '#6b7280' %>"></div>
      <div class="stat-card-body">
        <p class="stat-card-count <%= overdueCount > 0 ? 'text-red-600' : '' %>"><%= overdueCount %></p>
        <p class="stat-card-label">Overdue Accounts</p>
      </div>
    </div>
  </div>
```

Stat-card accent colors: green for collections, blue for revenue, red/gray for overdue (red when count > 0, gray when 0).

**Expiring Subscriptions Alert (warning banner):**
```ejs
  <!-- Expiring Subscriptions Alert -->
  <% if (expiringSubs.length > 0) { %>
    <div class="bg-amber-50 border-l-4 border-l-amber-500 border border-amber-200 rounded-lg p-4 mb-6">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"/>
        </svg>
        <div class="flex-1">
          <p class="text-sm font-semibold text-amber-800">Expiring Subscriptions (<%= expiringSubs.length %>)</p>
          <p class="text-sm text-amber-700 mt-1">
            <% expiringSubs.forEach(function(e, i) { %>
              <a href="/admin/customers" class="underline hover:text-amber-900"><%= e.code %> — <%= e.name %> (<%= e.remaining_days %> day<%= e.remaining_days !== 1 ? 's' : '' %>)</a><%= i < expiringSubs.length - 1 ? ', ' : '' %>
            <% }); %>
          </p>
        </div>
      </div>
    </div>
  <% } %>
```

The banner uses amber (warning) colors, distinct from the green success flash and red error flash messages elsewhere. It includes a warning triangle SVG icon and links to the customers page. When no subscriptions are expiring, the entire banner is hidden.

## Complete File Change Summary

| File | What Changes | Impact |
|------|-------------|--------|
| `routes/admin.js` (line ~163) | Add subquery to SELECT for remaining_days | 1 line modified |
| `routes/admin.js` (line ~148) | Insert 4 new queries + pass to view | ~40 lines added |
| `views/admin/customers.ejs` | Add `<th>Rem. Days</th>` + `<td>` cell | 2 lines added, spanning adjusted |
| `views/admin/dashboard.ejs` | Insert stat-cards row + alert banner before dispatch section | ~50 lines added |

## Edge Cases Covered

| Scenario | Expected Behavior |
|----------|------------------|
| Customer has no subscription | Em-dash in customers table, excluded from overdue count |
| Customer has expired subscription | Em-dash in customers table (subquery filters `status = 'active'`) |
| Customer has paused subscription | Em-dash in customers table (not status='active') |
| Zero overdue accounts | Card shows "0" with gray border, no red styling |
| Zero monthly collections | Card shows "₹ 0.00" |
| Zero expiring subscriptions | No amber banner at all |
| remaining_days = 0, 1, 2, 3 | Shows in expiring banner AND red text in customers table |
| remaining_days = 4 | No banner, normal text in customers table |
| Multiple customers expiring | Comma-separated list in banner ordered by remaining_days ASC |
| Customer has never had any deliveries | paidDays = 0, consumedDays = 0, balanceDays = 0, NOT overdue |

## Testing Strategy

- **Customers page**: Check em-dash appears for customers with no/expired subscriptions; verify numeric values match the subscriptions table; check red text for <= 3 days remaining
- **Dashboard financial cards**: Compare "Collected This Month" value against the payments page ledger; verify "Expected Monthly Revenue" matches sum of active customer rates; check overdue count matches the reports page overdue list
- **Expiring banner**: Set a subscription's remaining_days to 1, 2, or 3 via DB and confirm the banner appears; set to 4 and confirm it disappears

## Risks and Mitigations

- **Risk**: Duplicate rows if a customer has multiple active subscriptions. **Mitigation**: Subquery with `ORDER BY id DESC LIMIT 1` ensures one row.
- **Risk**: Overdue count formula diverges from reports page. **Mitigation**: Uses identical formula from existing reports page logic.
- **Risk**: Performance regression. **Mitigation**: All queries are single-pass with no per-customer DB hits in loops.