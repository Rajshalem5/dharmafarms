# Code Review: Dashboard Visibility Improvements

**Reviewed**: 2026-07-03
**Branch**: shalem
**Decision**: APPROVE

## Summary

Small, focused change adding a "Rem. Days" column to the admin customers table. The column shows remaining subscription days with conditional red styling for expiring subscriptions (<= 3 days) and an em-dash for customers with no active subscription. Clean, follows existing patterns, no issues found.

## Findings

### CRITICAL
None

### HIGH
None

### MEDIUM
None

### LOW
None

## Validation Results

| Check | Result |
|---|---|
| Tests | Pass (97/97, 0 failures) |
| Lint | Skipped (no linter configured) |

## Files Reviewed

| File | Change Type | Lines Changed |
|---|---|---|
| `views/admin/customers.ejs` | Modified | +3 |

## Analysis

### What's reviewed

The single uncommitted change adds:

1. **`<th>Rem. Days</th>`** (line 64) — New column header inserted between the "Rate (₹)" and "Token" columns
2. **Conditional `<td>` cell** (lines 79-81) — Renders the `remaining_days` value from the route handler's query, with:
   - `text-red-600 font-medium` when remaining_days <= 3 (expiring soon)
   - `tabular-nums` for consistent number alignment
   - Em-dash (`—`) fallback when `remaining_days` is null (no active subscription)

### Positive observations

- **Follows existing patterns** — Uses the same `<thead>`/`<tbody>`/`data-table` structure as adjacent columns
- **Edge cases handled** — Null remaining_days (no subscription) shows em-dash instead of blank or "0"
- **Accessible styling** — Red text for expiring is paired with meaningful content (not color-only)
- **Zero-dependency** — Pure EJS template rendering, no new JS or CSS needed
- **Already part of the dashboard feature** — The `remaining_days` subquery was added in an earlier commit to the customer list SQL

### The corresponding route changes (already committed)

The `routes/admin.js` customer list query (committed in prior work) already includes:
```sql
(SELECT remaining_days FROM subscriptions
 WHERE customer_id = c.id AND status = 'active'
 ORDER BY id DESC LIMIT 1) AS remaining_days
```

This ensures the data for the "Rem. Days" column is available in the template.

## Conclusion

Clean, minimal change. No security, correctness, or quality issues. All tests pass. Approved.