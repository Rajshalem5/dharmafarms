# Implementation Plan: Issue Tracking Board (PRD F-25)

## Overview

Add an Issue Tracking Board to the admin panel (Phase 3, section 6.3 of PRD). The board shows all deliveries with `status = 'issue'`, filtered by date range, delivery boy, and resolution status. Admin can resolve issues with a resolution note and timestamp. Reuses existing `deliveries` table columns (`issue_reason`, `resolved_at`, `resolved_note`, `marked_at`, `delivery_date`).

No new database migration needed — the deliveries table already has all required columns.

## Files Affected

| File | Action | Lines |
|------|--------|-------|
| `views/admin/issues.ejs` | **New** | ~120 lines |
| `routes/admin.js` | **Modify** | +2 routes (~90 lines) |
| `views/admin/layout.ejs` | **Modify** | +1 sidebar link (~5 lines) |

## Implementation Steps

### Step 1: Sidebar Link — `views/admin/layout.ejs`

Insert an "Issues" link between Dispatch and Payments (after `</a>` closing Dispatch at line 33, before the Payments `<a>` at line 34). Uses the same SVG icon + `activePage` pattern as all other sidebar links.

```html
<a href="/admin/issues" class="<%= activePage === 'issues' ? 'active' : '' %>">
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
  Issues
</a>
```

Dependencies: None. Risk: Low.

### Step 2: Route Handlers — `routes/admin.js`

**2a. GET /admin/issues** — Insert before the Payments route (before line 517 `// ── Payments page`).

Builds a dynamic WHERE clause with parameterized queries (same pattern as reports route lines 634-674). Filters:

| Parameter | Type | Validation |
|-----------|------|------------|
| `date_from` | string | YYYY-MM-DD regex |
| `date_to` | string | YYYY-MM-DD regex |
| `delivery_boy_id` | int | parseInt, must be > 0 |
| `status` | string | one of: 'open', 'resolved', 'all' |

SQL query structure:

```sql
SELECT
  d.id, d.delivery_date, d.status, d.issue_reason, d.marked_at,
  d.resolved_at, d.resolved_note,
  c.code AS customer_code, c.name AS customer_name,
  db.name AS boy_name, db.id AS boy_id
FROM deliveries d
JOIN customers c ON c.id = d.customer_id
JOIN delivery_boys db ON db.id = d.delivery_boy_id
WHERE d.status = 'issue'
  -- conditionally appended based on filters:
  AND d.delivery_date >= ?     -- if date_from provided
  AND d.delivery_date <= ?     -- if date_to provided
  AND d.delivery_boy_id = ?    -- if delivery_boy_id provided
  AND d.resolved_at IS NULL    -- if status='open'
  -- if status='resolved': AND d.resolved_at IS NOT NULL
  -- if status='all' or unset: no condition
ORDER BY d.delivery_date DESC, d.marked_at DESC
```

Returns: `{ issues, deliveryBoys, filters, flash, activePage: 'issues' }`

Also fetches active delivery boys for the filter dropdown.

**2b. POST /admin/issues/:id/resolve** — Insert after the GET route handler.

Edges cases checked in order:
1. Invalid issue ID (NaN from parseInt) → flash error
2. Missing resolution note (`!resolved_note || !resolved_note.trim()`) → flash error
3. Delivery not found in database → flash error
4. Delivery not marked as 'issue' → flash error
5. Delivery already has resolved_at → flash "already resolved"

Update query:

```sql
UPDATE deliveries
SET resolved_at = datetime('now'), resolved_note = ?
WHERE id = ? AND status = 'issue' AND resolved_at IS NULL
```

Double-check ensures race conditions: `resolved_at IS NULL` in WHERE means only the first concurrent resolve succeeds.

On success: flash "Issue resolved successfully"
On any validation failure: flash error with specific message

Redirect preserves current filter query params so admin stays on their filtered view.

Dependencies: None. Risk: Low.

### Step 3: View Template — `views/admin/issues.ejs` (new)

Layout structure:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Issue Tracking Board                  [N open]  [showing X issues]        │
├────────────────────────────────────────────────────────────────────────────┤
│  [flash message if present]                                                 │
├────────────────────────────────────────────────────────────────────────────┤
│  Filter bar:                                                                │
│  [From Date] [To Date] [Delivery Boy ▼] [Status ▼] [Apply] [Clear Filters] │
├────────────────────────────────────────────────────────────────────────────┤
│  Date      │ Code │ Customer │ Boy │ Reason           │ Status   │ Actions  │
│  ──────────┼──────┼──────────┼─────┼──────────────────┼──────────┼──────────│
│  Jul 3     │ C001 │ Priya    │ Raju│ Gate dog barking │ 🔴 Open  │ Resolve  │
│  Jul 2     │ C015 │ Anil     │ Sam │ Not home         │ ✅ Reso. │ —        │
├────────────────────────────────────────────────────────────────────────────┤
│  Empty state (when no issues match filters):                                │
│  ✅ No issues reported — All deliveries are running smoothly.               │
└────────────────────────────────────────────────────────────────────────────┘
```

Key elements:
- **Open count badge**: `issues.filter(i => !i.resolved_at).length + " open"` in `bg-red-100 text-red-700`
- **Filter form**: `method="GET"`, inputs pre-filled from `filters` object; uses existing report month-selector pattern
- **Table**: Uses existing `.data-table` class; columns: Date (whitespace-nowrap), Code (monospace), Customer, Boy, Reason + timestamp, Status badge, Resolution note/timestamp or "—", Actions
- **Badges**: `.badge-issue` for Open, `.badge-delivered` for Resolved — already exist in style.css, no new CSS
- **Empty state**: Checkmark-circle SVG, "No issues reported", "All deliveries are running smoothly." — follows reports.ejs empty state pattern
- **Resolve modal**: Follows delivery-boys.ejs edit modal pattern — fixed overlay, `bg-black/50` backdrop, centered white card, textarea, submit/cancel, close on backdrop click
- **JavaScript**: `openResolveModal(id, code, name)` sets form action/modal text; `closeResolveModal()` hides; single quotes escaped in customer name

Dependencies: Step 2 (needs `issues`, `deliveryBoys`, `filters`, `flash`, `activePage`). Risk: Low.

### Step 4: Tests (optional) — `test/issues.test.js`

Test cases following AAA pattern:
1. GET /admin/issues returns 200 with issues template
2. GET /admin/issues with date range filter
3. GET /admin/issues with delivery boy filter
4. GET /admin/issues with status=open (only unresolved)
5. GET /admin/issues with status=resolved (only resolved)
6. POST /admin/issues/:id/resolve stores resolved_at + resolved_note
7. POST /admin/issues/:id/resolve with missing note → flash error
8. POST /admin/issues/:id/resolve on already resolved → flash error
9. POST /admin/issues/:id/resolve on non-existent → flash error
10. GET /admin/issues with no issues shows empty state

## Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Invalid date format in filter | Regex validation rejects, silently unset |
| Missing resolution note | Server validation + HTML5 `required` on textarea |
| Already-resolved issue | Check `delivery.resolved_at` before UPDATE; WHERE double-checks |
| Non-existent delivery ID | Lookup first; flash error if not found |
| Delivery not marked as issue | Check `delivery.status !== 'issue'` |
| Race condition (concurrent resolve) | WHERE `resolved_at IS NULL` — only first succeeds |
| Apostrophes in customer name | JS `.replace(/'/g, "\\'")` in onclick handler |
| No filters applied | Default: empty strings for dates/boy, 'all' for status |
| No delivery boys in DB | Empty array, dropdown shows "All Boys" only |
| Zero issues | Empty state SVG + text instead of table |
| Filters after resolve | POST redirect preserves current query params |

## Acceptance Criteria Checklist

- [ ] Sidebar "Issues" link between Dispatch and Payments with exclamation-circle icon
- [ ] Sidebar link shows active state on /admin/issues
- [ ] GET /admin/issues renders with all unresolved issues by default
- [ ] Filter by date range, delivery boy, status works individually and combined
- [ ] Filter values persist in form inputs after submission
- [ ] "Clear Filters" link resets all filters
- [ ] Open badge renders in red (`.badge-issue`), Resolved in green (`.badge-delivered`)
- [ ] Empty state shows "No issues reported" with checkmark icon
- [ ] Open issue rows show "Resolve" button
- [ ] Resolved rows show resolution note/timestamp, no Resolve button
- [ ] POST /admin/issues/:id/resolve stores resolved_at and resolved_note
- [ ] POST rejects missing resolution note (flash error)
- [ ] POST rejects already-resolved issues (flash error)
- [ ] POST rejects non-existent deliveries (flash error)
- [ ] POST redirect preserves current filter params
- [ ] Flash success message after successful resolve
- [ ] Open count badge in header updates correctly
- [ ] Delivery boy dropdown only shows active boys
- [ ] Modal opens/closes via backdrop click and close button
- [ ] All existing tests still pass

## Existing Patterns Referenced

| Pattern | Location |
|---------|----------|
| `renderView(res, 'admin/...', { ...data, activePage })` | `routes/admin.js:21-26` |
| `req.session.flash = { type, message }` + read-then-clear | `routes/admin.js:174-175, 191` |
| Sidebar link with SVG + active class | `views/admin/layout.ejs:18-41` |
| GET filter form with pre-filled values | `views/admin/reports.ejs:6` |
| Empty state with SVG + text | `views/admin/reports.ejs:66-68` |
| Edit modal with overlay backdrop | `views/admin/delivery-boys.ejs:85-110` |
| `.data-table` for table styling | `style.css:140-168` |
| `.badge-issue` (red) and `.badge-delivered` (green) | `style.css:202-230` |
| Query param validation (date regex) | `routes/admin.js:634-640` |
| Dynamic WHERE clause building | `routes/admin.js:652-674` |