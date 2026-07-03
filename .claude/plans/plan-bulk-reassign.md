# Implementation Plan: Bulk Reassign Customers When a Delivery Boy Leaves

## Overview

When a delivery boy becomes inactive (leaves/quits), their assigned customers need to be transferred to another active delivery boy. Currently, the admin must edit each customer individually to change their `delivery_boy_id`. This plan adds a **Reassign** button next to inactive boys on the delivery-boys page that opens a modal to bulk-transfer all their customers to a selected active boy in one click.

**Scope:** 3 files changed, ~60 new lines total. No DB schema change — the `customers.delivery_boy_id` column already exists.

## Requirements

1. On the delivery-boys page, show a **"Reassign"** button next to each inactive boy (not next to active ones)
2. Clicking opens a modal: *"Reassign X customers from [boy name] to:"* with a dropdown of active delivery boys
3. One click reassigns all customers from the old boy to the new boy
4. Flash message on success: *"X customers reassigned from Raju to Suresh"*
5. Follow the existing edit modal pattern (`style="display:none"`, fixed overlay, click-outside-to-close)

## Files Changed

| File | Action | Lines of Change |
|------|--------|-----------------|
| `routes/admin.js` | Add route POST `/admin/delivery-boys/:id/reassign` | ~25 new lines |
| `views/admin/delivery-boys.ejs` | Add Reassign button + modal + JS | ~35 new lines |

No new services. No DB migration. No new npm packages.

## Detailed Steps

### Step 1: Add POST route `routes/admin.js` — `/admin/delivery-boys/:id/reassign`

**Location:** After the toggle-status route (~line 567), before the closing `}` of `setupAdminRoutes`.

**Logic (single transaction):**

```
1. Parse input: targetBoyId = parseInt(req.body.target_boy_id)
2. Validate source boy exists:
   SELECT id, name FROM delivery_boys WHERE id = ?
   → flash error + redirect if not found
3. Validate source boy is inactive:
   → flash error "Cannot reassign from an active boy. Deactivate them first." + redirect
4. Validate target boy exists and is active:
   SELECT id, name FROM delivery_boys WHERE id = ?
   → flash error if not found or inactive
5. Guard: source id === target id → flash error + redirect
6. Count active customers assigned to source boy:
   SELECT COUNT(*) AS count FROM customers WHERE delivery_boy_id = ? AND status = 'active'
7. If count === 0: flash "No active customers assigned to [name]." + redirect
8. In a transaction:
   UPDATE customers SET delivery_boy_id = ?, updated_at = datetime('now')
   WHERE delivery_boy_id = ? AND status = 'active'
9. Flash: "N customers reassigned from [source_name] to [target_name]."
10. Redirect to /admin/delivery-boys
```

**Validation guards:**
- Source boy must be *inactive* (prevents accidental bulk move of an active boy's customers)
- Target boy must be *active*
- Source and target cannot be the same boy
- target_boy_id must be a positive integer
- Only reassign *active* customers (inactive customers stay with the old boy for record-keeping)

**Why `status = 'active'` filter:** Inactive customers are historical records. They don't get daily deliveries, so there's no operational need to reassign them. Keeping them linked to the old boy preserves the audit trail.

### Step 2: Add JSON endpoint `routes/admin.js` — `/admin/delivery-boys/:id/customer-count`

**Location:** After the GET /admin/delivery-boys/:id route (~line 490).

**Logic:**
```
SELECT COUNT(*) AS count FROM customers WHERE delivery_boy_id = ? AND status = 'active'
→ { count: N }
```

**Why needed:** The modal needs to show "Reassign X customers from [name] to:" before the admin submits. The count is fetched via this lightweight JSON endpoint when the modal opens, following the same pattern as the edit modal's JSON endpoint.

### Step 3: Update `views/admin/delivery-boys.ejs` — Reassign button

**Location:** In the Actions `<td>`, after the toggle-status form, only for inactive boys.

```ejs
<% if (boy.status === 'inactive') { %>
  <button onclick="openReassign(<%= boy.id %>, '<%= boy.name.replace(/'/g, "\\'") %>')"
          class="text-purple-600 hover:text-purple-800 text-sm cursor-pointer">
    Reassign
</button>
<% } %>
```

**Why only inactive boys:** The feature is specifically for the "boy leaves/quits" scenario. An active boy's customers shouldn't be bulk-reassignable — that would be a different feature (route optimization, territory changes) with different UX requirements.

### Step 4: Add reassign modal to `views/admin/delivery-boys.ejs`

**Modal HTML** (after the edit modal, following the same pattern):

```html
<div id="reassignModal" class="fixed inset-0 bg-black/50 hidden items-center justify-center z-50" style="display:none">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold text-[#1B4332]">Reassign Customers</h2>
      <button onclick="closeReassign()" class="text-gray-400 hover:text-gray-600 text-xl cursor-pointer">&times;</button>
    </div>
    <form id="reassignForm" method="POST">
      <p class="text-gray-700 mb-4" id="reassignInfo">
        Reassign <span id="reassignCount">0</span> customers from
        <strong id="reassignSourceName"></strong> to:
      </p>
      <div class="mb-4">
        <select name="target_boy_id" id="reassignTargetBoy" required
                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2D6A4F]">
          <option value="">Select delivery boy...</option>
          <% deliveryBoys.filter(function(b) { return b.status === 'active'; }).forEach(function(boy) { %>
            <option value="<%= boy.id %>"><%= boy.name %></option>
          <% }); %>
        </select>
      </div>
      <div class="flex gap-3">
        <button type="submit" class="bg-purple-600 hover:bg-purple-700 text-white font-medium py-2 px-6 rounded-lg transition-colors duration-150 cursor-pointer">
          Reassign
        </button>
        <button type="button" onclick="closeReassign()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2 px-6 rounded-lg transition-colors duration-150 cursor-pointer">Cancel</button>
      </div>
    </form>
  </div>
</div>
```

**Why filter dropdown to active boys only:** The dropdown is populated with `deliveryBoys.filter(b => b.status === 'active')` so the admin can only choose a currently-active boy as the target. The `deliveryBoys` array is already passed to the template.

### Step 5: Add JavaScript for the reassign modal

```js
function openReassign(id, name) {
  fetch('/admin/delivery-boys/' + id + '/customer-count')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      document.getElementById('reassignCount').textContent = data.count;
      document.getElementById('reassignSourceName').textContent = name;
      document.getElementById('reassignForm').action = '/admin/delivery-boys/' + id + '/reassign';
      document.getElementById('reassignTargetBoy').value = '';
      document.getElementById('reassignModal').style.display = 'flex';
    });
}
function closeReassign() {
  document.getElementById('reassignModal').style.display = 'none';
}
document.getElementById('reassignModal').addEventListener('click', function(e) {
  if (e.target === this) closeReassign();
});
```

## Edge Cases Handled

| Edge Case | Handling |
|-----------|----------|
| Source boy is active | Reassign button not shown; if POSTed directly, route returns error flash |
| Source boy not found | POST route returns flash error + redirect |
| Target boy is inactive | POST route validates target is active; flash error if not |
| Source == target | POST route checks and rejects with flash error |
| No customers assigned to source boy | POST route counts first; flash "No active customers to reassign" |
| Boy name contains single quote | JS `replace(/'/g, "\\'")` escapes for onclick attribute |
| Admin changes mind | Cancel button + click-outside-to-close on modal |
| Internet drops mid-click | POST is synchronous form submit; SQLite transaction is atomic |

## Routes Summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | /admin/delivery-boys/:id/customer-count | JSON with count of active customers assigned to a boy |
| POST | /admin/delivery-boys/:id/reassign | Bulk-update delivery_boy_id for all active customers |

## Verification

1. `npm start` — server boots without errors
2. Navigate to `/admin/delivery-boys` — active boys have no "Reassign" button; inactive boys have one
3. Toggle a boy inactive, then click "Reassign" — modal opens showing correct customer count and source name
4. Select a target boy and submit — success flash: *"X customers reassigned from Raju to Suresh"*
5. Navigate to `/admin/customers` — verify those customers now show the new boy name
6. Try to POST directly with invalid data (empty target, same boy, inactive target) — appropriate error flashes
7. Toggle an inactive boy back to active — "Reassign" button disappears
8. Verify the dispatch page still groups correctly under the new boy's name