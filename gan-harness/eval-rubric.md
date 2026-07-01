# Eval Rubric: Dharma Farms Milk Operations

Weighted scoring across 4 dimensions. Each scored 1-5. Final = weighted sum.

## Design Quality (weight: 0.2)

| Score | Criteria |
|-------|----------|
| 1 | Default CSS framework look. Generic cards, gradients, stock colors. |
| 2 | Some custom styling but inconsistent. Mix of custom and framework defaults. |
| 3 | Green palette used consistently. Dense but readable tables. Mobile-responsive. |
| 4 | Clean spreadsheet-meets-terminal aesthetic. Alternating rows. Compact. High data density per pixel. |
| 5 | Looks like a real operations tool built by someone who actually runs a business. No design fluff. Every element justified. |

Checklist: [ ] No gradients or blobs. [ ] Tables have alternating rows. [ ] Customer page is mobile-first. [ ] Admin side loads under 2s on 4G.

## Originality (weight: 0.1)

| Score | Criteria |
|-------|----------|
| 1 | Generic CRUD app. Looks like every other web app scaffold. |
| 2 | Telegram bot present but minimal. Admin panel is standard dashboard template. |
| 3 | Telegram bot feels intentional. Commands are terse and operational. Branding is farm-appropriate. |
| 4 | Bot interaction is smoother than a mobile app would be for delivery boys. The Telegram interface is genuinely better than the alternative. |
| 5 | Recognizably different from the sea of delivery apps. The approach (spreadsheet + Telegram) is clearly optimized for the actual constraints of the business. |

Checklist: [ ] Telegram commands are 1-2 words max. [ ] No mobile app exists or is needed.

## Craft (weight: 0.4)

| Score | Criteria |
|-------|----------|
| 1 | Telegram bot fails on edge cases. No error handling. Payments can be deleted. UI breaks on empty data. |
| 2 | Core flow works but error states are unhandled (wrong command, invalid delivery number, empty route). |
| 3 | All Telegram commands handle errors gracefully. Dispatch regen is safe. Payment ledger is append-only. Confirmation dialogs on deletes. |
| 4 | Every state handled: loading, empty, error, success. Pause/resume updates dispatch same-day if before cutoff. Telegram feedback confirms every action. |
| 5 | Production-grade edge case handling. Duplicate dispatch generation idempotent. Bot recovers from network blips. Payment audit trail cannot be tampered with. |

Checklist: [ ] deploy.sh or equivalent setup. [ ] Bot handles unknown commands. [ ] Dispatch regen is idempotent. [ ] Payment entries are append-only. [ ] Customer self-service has valid + invalid token handling.

## Functionality (weight: 0.3)

| Score | Criteria |
|-------|----------|
| 1 | Flows are incomplete. Admin adds customer but dispatch doesn't pick them up. Telegram bot can't mark items. |
| 2 | Core flow works but has gaps. Dispatch generates but can't handle pauses. Payment recording works but balance doesn't update. |
| 3 | All 4 critical flows work end-to-end with no gaps. 100 customers + 5 delivery boys load within reasonable time. |
| 4 | All must-have + should-have features work. Customer self-service pause updates dispatch in real time (or by cutoff). Issue flow complete. |
| 5 | All 14 features working. Production-ready. Can onboard a real milk delivery business tomorrow. |

### Critical Flows to Test

**Flow 1: Admin -> Dispatch -> Bot -> Done**
1. Admin adds customer "Ramesh" with "Buffalo Milk 2L" plan
2. Generate today's dispatch
3. Delivery boy opens Telegram, sends `/route`, sees Ramesh in list
4. Sends `/done 1`, admin dashboard shows 1 delivered
5. Result: PASS/FAIL

**Flow 2: Payment Recording**
1. Admin records ₹3000 UPI payment for Ramesh
2. Ramesh's balance updates from ₹5000 due to ₹2000 due
3. Payment history shows entry with date, amount, mode, recorded-by
4. Result: PASS/FAIL

**Flow 3: Customer Pause**
1. Customer opens self-service page with valid token
2. Sees plan: "Buffalo Milk 2L -- Active"
3. Pauses from tomorrow for 3 days
4. Admin generates dispatch for tomorrow -- Ramesh not in list
5. Customer resumes -- next day's dispatch includes Ramesh again
6. Result: PASS/FAIL

**Flow 4: Issue Resolution**
1. Delivery boy sends `/issue 2 Dog on street`
2. Issue appears in admin issue board
3. Admin marks resolved with note "Owner secured dog"
4. Result: PASS/FAIL

## Scoring Template

| Dimension | Score (1-5) | Weight | Weighted |
|-----------|-------------|--------|----------|
| Design Quality | | 0.2 | |
| Originality | | 0.1 | |
| Craft | | 0.4 | |
| Functionality | | 0.3 | |
| **Total** | | **1.0** | |

Thresholds: >= 4.0 Excellent, >= 3.0 Good, >= 2.0 Needs Work, < 2.0 Failed