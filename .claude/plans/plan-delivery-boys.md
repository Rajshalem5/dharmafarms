# Implementation Plan: Delivery Boy Management in Admin Panel

## Overview

Add a delivery boy management page to the admin panel, enabling the admin to list, add, edit, and toggle the active/inactive status of delivery boys. The `delivery_boys` table already exists (migration v1, defined in `db.js`), so **no database schema changes are needed**. This feature slots into the existing Phase 1 codebase (Express, EJS, SQLite, Tailwind CDN + local CSS).

## Requirements

- List all delivery boys in a table with name, phone, region, Telegram connection status, and active/inactive badge
- Add new delivery boy via a form (name, phone, region)
- Edit existing delivery boy (name, phone, region) via a modal
- Status toggle (active/inactive) with one click via a POST form
- Sidebar link "Delivery Boys" in the admin navigation, between Customers and Dispatch
- Follow existing patterns: `renderView()`, `requireAuth`, flash messages, `activePage` highlighting

## Architecture Changes

Only three files need to change:

| File | Action | Lines of Change |
|------|--------|-----------------|
| `routes/admin.js` | Add 5 new route handlers (list, create, JSON, edit, toggle-status) | ~80 new lines |
| `views/admin/layout.ejs` | Add 1 sidebar link between Customers and Dispatch | Insert 4 lines |
| `views/admin/delivery-boys.ejs` | **New file** — full EJS template | ~150 lines |

No database migration. No new services. No new npm packages.

## Detailed Implementation Steps

### Step 1: Add route handlers to `routes/admin.js`

**Location:** After the dispatch routes, before the closing `}` of `setupAdminRoutes`.

**Route 1 — GET /admin/delivery-boys (list):**
```
Query: SELECT * FROM delivery_boys ORDER BY name ASC
Pass to view: { deliveryBoys, flash, activePage: 'delivery-boys' }
Use: renderView(res, 'admin/delivery-boys', data)
```

**Route 2 — GET /admin/delivery-boys/:id (JSON for edit modal):**
```
Query: SELECT * FROM delivery_boys WHERE id = ?
404 if not found, return JSON otherwise
```

**Route 3 — POST /admin/delivery-boys (create):**
```
Validate: name.trim() required, phone matches PHONE_RE (/^\d{10,15}$/)
Region is optional (defaults to null if empty)
Insert: INSERT INTO delivery_boys (name, phone, region) VALUES (?, ?, ?)
Flash success/error, redirect to /admin/delivery-boys
```

**Route 4 — POST /admin/delivery-boys/:id/edit (update):**
```
Validate: same as create
Update: UPDATE delivery_boys SET name = ?, phone = ?, region = ? WHERE id = ?
Check info.changes === 0 for not-found
Flash success/error, redirect to /admin/delivery-boys
```

**Route 5 — POST /admin/delivery-boys/:id/toggle-status:**
```
Query current status: SELECT status FROM delivery_boys WHERE id = ?
If not found: flash error and redirect
Flip: status === 'active' ? 'inactive' : 'active'
Update: UPDATE delivery_boys SET status = ? WHERE id = ?
Flash message: "X is now active/inactive"
Redirect to /admin/delivery-boys
```

**Why these patterns:** Every existing route in `admin.js` follows POST-redirect with flash messages. The `PHONE_RE` regex is already defined. The `renderView()` helper handles layout wrapping. No new imports needed.

### Step 2: Create `views/admin/delivery-boys.ejs`

**Template structure (modeled after `customers.ejs`):**

1. **Header row:** Flexbox with page title "Delivery Boys" on the left, "+ Add Delivery Boy" button on the right that toggles the add form.

2. **Flash message:** Identical to `customers.ejs` — green background for success, red for error, shows `flash.message`.

3. **Add form:** Hidden by default (`class="hidden"`), grid layout with 3 fields:
   - Name (text input, required)
   - Phone (text input, required, placeholder "10-15 digits")
   - Region (text input, optional, placeholder e.g. "North, South, East, West, Central")
   - Save button
   - Grid: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`

4. **Empty state:** "No delivery boys yet. Add your first delivery boy to get started." — shown when `deliveryBoys.length === 0`.

5. **Data table:** Wrapped in `bg-white rounded-xl shadow-sm overflow-hidden`, with these columns:
   - Name
   - Phone
   - Region
   - Telegram Status: if `telegram_chat_id` is not null, show "Connected" with `badge-delivered` class; otherwise show "Not Connected" with `badge-pending` class
   - Status: `<span class="badge-<%= boy.status %>"><%= boy.status %></span>`
   - Actions: "Edit" button + "Toggle Status" POST form

6. **Edit modal:** Same pattern as `customers.ejs` — `fixed inset-0 bg-black/50`, white card, form fields for Name/Phone/Region, form action set dynamically via JavaScript, Update + Cancel buttons.

7. **Inline JavaScript:**
   - `editDeliveryBoy(id)` — fetches `/admin/delivery-boys/:id`, populates form fields, sets form action, shows modal
   - `closeEdit()` — hides modal
   - Click-outside-to-close handler

### Step 3: Add sidebar link in `views/admin/layout.ejs`

**Location:** After the Customers link and before the Dispatch link.

```html
<a href="/admin/delivery-boys" class="<%= activePage === 'delivery-boys' ? 'active' : '' %>">
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
  Delivery Boys
</a>
```

### Step 4: Verification

**Manual test checklist:**

1. `npm start` — server boots without errors. No new dependencies to install.
2. Navigate to `/admin/delivery-boys` — page renders with the 5 seed delivery boys in a table.
3. Click "Add Delivery Boy" — form appears. Fill and submit — new row appears with success flash.
4. Submit with empty name — error flash, no DB insert.
5. Submit with invalid phone (e.g. "abc") — error flash, no DB insert.
6. Click "Edit" on a row — modal opens with pre-filled data. Change name, submit — table updates.
7. Click "Toggle Status" on an active boy — badge changes to inactive, flash says "X is now inactive".
8. Click "Toggle Status" on the same inactive boy — badge changes back to active, flash says "X is now active".
9. Sidebar link highlights correctly on the Delivery Boys page.
10. Dashboard still works — inactive boys are excluded from the per-boy stats.

## Edge Cases Handled

| Edge Case | Handling |
|-----------|----------|
| Empty name submitted | Validation rejects, flash error, no DB insert |
| Invalid phone (non-digit characters) | `PHONE_RE` regex rejects, flash error |
| Phone shorter than 10 digits | Regex rejects, flash error |
| Empty region | Defaults to null in DB, shows "-" in table |
| Toggle on non-existent ID | Flash error "Delivery boy not found", redirect |
| Toggle on already-inactive boy | Flips to active — works correctly both ways |
| Edit non-existent ID | `info.changes === 0` check, flash error |
| No delivery boys exist (fresh DB with no seed) | Empty state message shown |

## Routes Summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | /admin/delivery-boys | List all delivery boys |
| GET | /admin/delivery-boys/:id | JSON for edit modal |
| POST | /admin/delivery-boys | Create new delivery boy |
| POST | /admin/delivery-boys/:id/edit | Update delivery boy |
| POST | /admin/delivery-boys/:id/toggle-status | Toggle active/inactive |