# Plan: 8 Post-Test Fixes for Dharma Farms

## Overview

Eight targeted fixes addressing bugs and missing features. Fixes 1-5 are bugs/edge cases. Fixes 6-8 are feature improvements.

---

## Fix 1 — Case-insensitive Customer Code Lookup (HIGH)

**Problem:** `lookupDelivery()` in `routes/telegram.js` (line 34) uses `WHERE c.code = ?`, which is case-sensitive. Delivery boys may send `/done c001` (lowercase). SQLite default BINARY collation will not match.

**Files:** `routes/telegram.js`

**Change:** Add `COLLATE NOCASE` to the WHERE clause:
```sql
WHERE c.code = ? COLLATE NOCASE AND d.delivery_date = date('now') AND c.delivery_boy_id = ?
```

**Tests (4 cases in `test/routes.telegram.test.js`):** Lowercase variants of /done, /skip, /arriving, /issue that should match despite case mismatch.

---

## Fix 2 — Customer Soft-Delete via Admin UI (MEDIUM)

**Problem:** No way to deactivate a customer from the admin UI. The `customers` table has a `status` column but no route/button to toggle it. Delivery boys already have this pattern (lines 460-481 of `routes/admin.js`).

**Files:** `routes/admin.js`, `views/admin/customers.ejs`

**Change in `routes/admin.js`:** Add after the `regenerate-token` route:
```javascript
app.post('/admin/customers/:id/toggle-status', requireAuth, (req, res) => {
  const customer = db.prepare(
    'SELECT id, code, name, status FROM customers WHERE id = ?'
  ).get(req.params.id);
  if (!customer) {
    req.session.flash = { type: 'error', message: 'Customer not found.' };
    return res.redirect('/admin/customers');
  }
  const newStatus = customer.status === 'active' ? 'inactive' : 'active';
  db.prepare("UPDATE customers SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newStatus, customer.id);
  req.session.flash = { type: 'success', message: `${customer.code} — ${customer.name} is now ${newStatus}.` };
  res.redirect('/admin/customers');
});
```

**Change in `views/admin/customers.ejs`:** After the "New Token" button in the Actions column, add:
```ejs
<form action="/admin/customers/<%= c.id %>/toggle-status" method="POST" class="inline">
  <button type="submit" class="<%= c.status === 'active' ? 'text-red-600 hover:text-red-800' : 'text-green-600 hover:text-green-800' %> text-sm cursor-pointer">
    <%= c.status === 'active' ? 'Deactivate' : 'Activate' %>
  </button>
</form>
```

**Tests (3 cases):** Toggle active to inactive, toggle inactive to active, flash error for non-existent.

---

## Fix 3 — Missing Delivery Boy Validation on Customer Edit (MEDIUM)

**Problem:** The add route validates `delivery_boy_id` exists (lines 200-206). The edit route (line 255) does not.

**File:** `routes/admin.js`

**Change:** After the rate validation, before the UPDATE, add:
```javascript
if (delivery_boy_id) {
  const boy = db.prepare('SELECT id FROM delivery_boys WHERE id = ?').get(delivery_boy_id);
  if (!boy) {
    req.session.flash = { type: 'error', message: 'Invalid delivery boy selected.' };
    return res.redirect('/admin/customers');
  }
}
```

**Tests (1 case):** Edit with non-existent delivery_boy_id=999 should redirect with error.

---

## Fix 4 — Expired Subscriptions Not Auto-Updated (MEDIUM)

**Problem:** When `end_date` passes, subscriptions stay `status='active'`. The dispatch query has `(end_date >= date('now'))` as a safety filter, but the status is never updated, confusing reports.

**Files:** `services/subscription.js`, `services/dispatch.js`

**Change in `services/subscription.js`:** Add exported function:
```javascript
function autoExpireSubscriptions(db) {
  const info = db.prepare(`
    UPDATE subscriptions SET status = 'expired'
    WHERE status = 'active' AND end_date IS NOT NULL AND end_date < date('now')
  `).run();
  return info.changes;
}
```
Add to `module.exports`.

**Change in `services/dispatch.js`:** Require `autoExpireSubscriptions` from `./subscription`. Call it at the start of both `generateDispatch()` and `regenerateDispatch()`.

**Tests (2 cases in `test/subscription.test.js`):** Past end_date changes status to 'expired'; future end_date does not.

---

## Fix 5 — Missing Validation on Reports Month Parameter (LOW)

**Problem:** Reports route (`routes/admin.js` line 601) uses `req.query.month` directly without validation.

**File:** `routes/admin.js`

**Change:** After extracting `reportMonth`, validate format:
```javascript
let reportMonth = req.query.month || today.toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(reportMonth)) {
  reportMonth = today.toISOString().slice(0, 7);
}
```

**Tests (1 case):** `/admin/reports?month=invalid` should render without error.

---

## Fix 6 — Phone Number in Route Display (MEDIUM)

**Problem:** `formatStatusLine()` in `services/telegram.js` shows code and name but not phone. Delivery boys need the phone to call customers. The `customer_phone` field is already returned by `getTodaysRouteForBoy()` in `dispatch.js` (line 76) but not rendered.

**Files:** `services/telegram.js`, `test/telegram.test.js`

**Change in `services/telegram.js` `formatStatusLine()`:** Add phone after name:
```javascript
function formatStatusLine(delivery) {
  const icon = STATUS_ICONS[delivery.status] || '❓';
  const code = delivery.customer_code;
  const name = delivery.customer_name;
  const phone = delivery.customer_phone ? ` - ${delivery.customer_phone}` : '';
  const time = delivery.marked_at ? ` (${delivery.marked_at})` : '';
  const reason = delivery.issue_reason ? ` — ${delivery.issue_reason}` : '';

  return `${icon} ${code} - ${name}${phone}${time}${reason}`;
}
```

Output format per line:
```
{i+1}. {icon} {code} - {name} - {phone}
```

If `marked_at` present: `(06:15)`
If `issue_reason` present: ` — No milk required`

**Change in `test/telegram.test.js`:** Add `customer_phone: '9000000001'` to every entry in `sampleDeliveries` and to each individual `formatStatusLine` test case. Add `assert.match(result, /9000000001/)` assertions.

---

## Fix 7 — Dashboard Per-Boy Stats Table (MEDIUM)

**Problem:** Dashboard template already receives `boyStats` data (passed at line 151 of `routes/admin.js`, queried at lines 115-130) but renders it as badge cards rather than a compact table.

**File:** `views/admin/dashboard.ejs`

**Change:** Add a per-boy table below the stats cards:
```ejs
<% if (boyStats.length > 0) { %>
  <div class="bg-white rounded-xl shadow-sm overflow-hidden mt-6">
    <div class="px-5 py-4 border-b border-gray-100">
      <h2 class="text-lg font-semibold text-[#1B4332]">Per Delivery Boy</h2>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Delivery Boy</th>
          <th>Total</th>
          <th>Delivered</th>
          <th>Skipped</th>
          <th>Issues</th>
          <th>Arriving</th>
          <th>Pending</th>
        </tr>
      </thead>
      <tbody>
        <% boyStats.forEach(function(b) { %>
          <tr>
            <td class="font-medium"><%= b.boy_name %></td>
            <td><%= b.total %></td>
            <td class="text-green-600 font-medium"><%= b.delivered %></td>
            <td class="text-amber-600"><%= b.skipped %></td>
            <td class="text-red-600"><%= b.issue %></td>
            <td class="text-blue-600"><%= b.arriving %></td>
            <td class="text-gray-500"><%= b.pending %></td>
          </tr>
        <% }); %>
      </tbody>
    </table>
  </div>
<% } %>
```

No changes needed in `routes/admin.js` — `boyStats` is already queried and passed.

**Tests:** None new. Existing dashboard tests verify rendering still works.

---

## Fix 8 — Suggest /finish After Last Delivery (LOW)

**Problem:** After marking the last customer, the delivery boy must remember to send `/finish`. The bot should detect this and suggest it.

**Files:** `routes/telegram.js`, `test/routes.telegram.test.js`

**Change in `routes/telegram.js`:** Add helper function after `isTerminalStatus()`:
```javascript
function allDeliveriesComplete(db, boyId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status IN ('delivered', 'skipped', 'issue') THEN 1 ELSE 0 END) AS done
    FROM deliveries
    WHERE delivery_boy_id = ? AND delivery_date = date('now')
  `).get(boyId);
  return row.total > 0 && row.total === row.done;
}
```

Modify the return statements in `handleDone()`, `handleSkip()`, `handleIssue()`:

In `handleDone()`:
```javascript
const reply = `✅ ${code} — ${delivery.name} marked as delivered at ${timeStr}.`;
if (allDeliveriesComplete(db, boy.id)) {
  return bot.sendMessage(chatId, reply + '\n\nAll deliveries completed! Send /finish for route summary.');
}
return bot.sendMessage(chatId, reply);
```

In `handleSkip()`:
```javascript
const reply = `⏭️ ${code} — ${delivery.name} marked as skipped at ${timeStr}.`;
if (allDeliveriesComplete(db, boy.id)) {
  return bot.sendMessage(chatId, reply + '\n\nAll deliveries completed! Send /finish for route summary.');
}
return bot.sendMessage(chatId, reply);
```

In `handleIssue()`:
```javascript
const reply = `⚠️ ${code} — ${delivery.name} issue recorded: ${reason}`;
if (allDeliveriesComplete(db, boy.id)) {
  return bot.sendMessage(chatId, reply + '\n\nAll deliveries completed! Send /finish for route summary.');
}
return bot.sendMessage(chatId, reply);
```

**Note:** `issue` is not in the existing `isTerminalStatus()` (which only blocks transitions from 'delivered'/'skipped'), but it IS included in `allDeliveriesComplete()` because from the delivery boy's perspective, issue means the stop is done.

**Tests (1 case in `test/routes.telegram.test.js`):** Create a delivery boy with 1 delivery, mark it done, verify response includes `/finish` suggestion:
```javascript
describe('/finish suggestion on last delivery', () => {
  it('suggests /finish when all deliveries are completed', async () => {
    bot.clearMessages();
    testDb.prepare(
      'INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region) VALUES (?, ?, ?, ?, ?)'
    ).run(10, 'SingleBoy', '9000000010', 1010, 'Test');
    testDb.prepare(
      'INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(20, 'C010', 'OneDelivery', '9000000020', '1 Test St', 10, 300000, 'active');
    testDb.prepare(
      'INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status) VALUES (?, date(\'now\'), date(\'now\', \'+30 days\'), 30, 30, \'active\')'
    ).run(20);
    testDb.prepare(
      'INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status) VALUES (?, ?, date(\'now\'), \'pending\')'
    ).run(20, 10);
    await bot.simulateMessage('/done C010', 1010);
    const last = bot.lastMessage();
    assert.ok(last, 'Should have sent a message');
    assert.match(last.text, /\/finish|All deliveries completed|route summary/i);
  });
});
```

---

## Implementation Order

All fixes are independent. Recommended order:

1. Fix 1 (case-insensitive lookup) — HIGH severity, low risk
2. Fix 6 (phone in route) — MEDIUM, low risk
3. Fix 7 (dashboard table) — MEDIUM, low risk
4. Fix 8 (suggest /finish) — LOW, low risk
5. Fix 2 (customer soft-delete) — MEDIUM, medium risk
6. Fix 3 (delivery boy validation) — MEDIUM, low risk
7. Fix 4 (expired subscriptions) — MEDIUM, medium risk
8. Fix 5 (month validation) — LOW, low risk

---

## Files Modified (Complete List)

| File | Fixes |
|------|-------|
| `routes/telegram.js` | 1, 8 |
| `routes/admin.js` | 2, 3, 5 |
| `services/telegram.js` | 6 |
| `services/subscription.js` | 4 |
| `services/dispatch.js` | 4 |
| `views/admin/customers.ejs` | 2 |
| `views/admin/dashboard.ejs` | 7 |
| `test/telegram.test.js` | 6 |
| `test/routes.admin.test.js` | 2, 3, 5 |
| `test/subscription.test.js` | 4 |
| `test/routes.telegram.test.js` | 1, 8 |

---

## Running Tests

```bash
# All tests
node --test test/

# Individual files
node --test test/telegram.test.js
node --test test/subscription.test.js
node --test test/routes.admin.test.js
node --test test/routes.telegram.test.js

# Filtered
node --test --test-name-pattern="phone" test/telegram.test.js
node --test --test-name-pattern="finish" test/routes.telegram.test.js
```