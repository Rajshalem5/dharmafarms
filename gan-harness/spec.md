# Product Specification: Dharma Farms Milk Operations

> Generated from brief: "Milk subscription delivery service for ~100 customers with 5 delivery boys. Daily 5-7 AM delivery. Monthly prepaid. Replace manual ledgers and WhatsApp chaos."

## Vision

A lean operations system for a real milk delivery business. Admin dispatches daily routes in under 2 minutes. Delivery boys punch DONE/SKIP/ISSUE via Telegram with zero typing. Customers check balance and pause/resume from a browser on their phone. No apps, no WhatsApp Business, no over-engineering. The goal: eliminate paper ledgers, WhatsApp forwarding chaos, and end-of-month reconciliation headaches.

## Design Direction

- **Color palette**: #1B4332 (dark forest green, primary), #2D6A4F (mid green, secondary), #F0FDF4 (very light green, page background), #374151 (charcoal, body text), #DC2626 (red, issues/errors), #F59E0B (amber, warnings/skips), #10B981 (green, delivered/success).
- **Typography**: Inter or system-ui for admin dashboard (dense, readable at small sizes). Monospace stack for Telegram bot output (looks like a terminal).
- **Layout philosophy**: Dense admin dashboard with a single sidebar nav. No hero sections, no illustration, no empty cards. Every pixel carries data.
- **Visual identity**: Spreadsheet-meets-terminal. Tables with row-level actions. No gradients. No blobs. Striped alternating rows. Delivery boy Telegram output uses plain text with emoji markers (checkmark, cross, bell) only.
- **Inspiration**: Basecamp's admin view. Stripe's dashboard. A well-organized spreadsheet.

## Features (prioritized)

### Must-Have (Sprint 1 -- Week 1)

1. **Customer Directory**: Table with name, address, phone, active status, monthly rate, current balance. Add/edit customer form. Search by name or phone. Acceptance: Admin can add a customer, see them in the list, edit their details, and deactivate them.

2. **Subscription Plans**: Each customer has a plan (items + quantities e.g. "Buffalo Milk 1L x 2, Cow Milk 500ml x 1"). Plan has start date, auto-renew monthly, can be paused with start/end dates. Acceptance: Admin sets a customer's plan. Pausing it removes them from daily dispatch for the pause duration.

3. **Daily Dispatch Generator**: Button "Generate Today's Dispatch" creates delivery items for all active (non-paused) customers. Shows route grouped by delivery boy assignment. Each row: customer name, address, items, status (pending/delivered/skipped/issue). Acceptance: Clicking generate produces a clean list. Re-generating on the same day replaces the previous list.

4. **Telegram Bot -- Core Commands**: Bot responds to:
   - `/start` -- registration flow (link delivery boy to their route by phone or assigned code)
   - `/route` -- shows today's deliveries for this delivery boy, formatted as numbered list
   - `/done N` -- marks delivery #N as delivered
   - `/skip N` -- marks delivery #N as skipped (customer not home etc.)
   - `/issue N <reason>` -- marks delivery #N as issue, records reason
   - `/arriving` -- signals impending arrival (for future notification use)
   - `/finish` -- ends today's route, shows summary (X delivered, Y skipped, Z issues)
   Acceptance: Delivery boy sends `/route` and sees their deliveries. Sends `/done 3` and that item is marked delivered in admin panel in real-time.

5. **Payment Ledger**: Per-customer payment history table. Columns: date, amount, mode (cash/UPI/bank transfer), notes, recorded-by. Running balance shown. Acceptance: Admin records a payment. Customer balance updates. History shows all entries.

6. **Admin Dashboard**: Single-page overview showing: today's delivery progress (X of Y delivered), pending collections (amount due this month), active customer count, recent issues. Acceptance: Page loads and shows real data with no dummy placeholders.

### Should-Have (Sprint 2 -- Week 2)

7. **Customer Self-Service Web Page**: Simple mobile-responsive page at `/my-account/:token`. Shows: customer name, plan summary, current balance, delivery status for today. Two actions: Pause deliveries (date range picker), Resume deliveries (button). No login -- access via a token printed on their invoice or shared via SMS. Acceptance: Customer opens link, sees their data, pauses from 5th to 10th, dispatch reflects the pause next morning.

8. **Auto-Dispatch Scheduling**: Cron job or scheduled task generates today's dispatch at 9 PM every day automatically instead of requiring manual click. Acceptance: Admin checks dispatch at 10 PM and it's already generated.

9. **Issue Tracking Board**: All marked issues from delivery boys collected into a board. Filter by date, delivery boy, resolved/unresolved. Mark as resolved with notes. Acceptance: From Telegram `/issue 2 Dog on street` shows up in admin with full context.

10. **Monthly Invoice View**: Generated invoice per customer per month. Shows opening balance, daily deliveries count x rate, payments received, closing balance. Simple PDF or print view. Acceptance: Admin opens a customer's month and sees a clear single-page invoice.

### Nice-to-Have (Sprint 3 -- Week 3)

11. **Telegram Notification to Customer**: If customer provides phone and it's on Telegram, bot sends a daily "Your milk is arriving" message when delivery boy marks `/arriving`. Requires opt-in. Acceptance: Customer gets a Telegram message at ~6:15 AM saying "Your delivery is arriving."

12. **Payment Reminder (Telegram)**: Bot sends a monthly reminder to customers with outstanding balance beyond the 5th of the month. Acceptance: On 6th of month, customers with unpaid invoices receive a polite reminder.

13. **Export to CSV**: All main tables (customers, payments, delivery log) exportable as CSV. Acceptance: Click export, get a proper CSV download.

14. **Daily Completion Report (Admin)**: Auto-generated summary each morning for previous day: deliveries attempted, success rate, issues flagged, unusual gaps. Acceptance: Admin gets a page showing yesterday's numbers.

## Technical Stack

- **Frontend**: Plain HTML + CSS + vanilla JS. No React, no build step. Single-page app with hash routing. Serves from a simple backend template engine (or static files + fetch).
- **Backend**: Python (FastAPI or Flask) with SQLite. Single binary/gunicorn process. No Docker needed.
- **Telegram Bot**: python-telegram-bot library (v20+). Webhook mode pointing at the same backend.
- **Database**: SQLite. One file. Backs up via simple cron copy.
- **Key libraries**: python-telegram-bot, FastAPI/Flask, APScheduler (for auto-dispatch), Jinja2 (server-side templates), python-dotenv (config).
- **Deployment**: Single VPS or Raspberry Pi 4 at the farm. Nginx reverse proxy. Let's Encrypt SSL for customer page.

## Evaluation Criteria

### Design Quality (weight: 0.2)
- No CSS framework default look. Uses custom styles with green palette defined above.
- Admin dashboard is dense but scannable -- alternating rows, compact columns, no wasted whitespace.
- Customer self-service page is mobile-first and loads under 2 seconds on 4G.
- No gradients, no blobs, no generic illustrations, no rounded-card-itis.

### Originality (weight: 0.1)
- Telegram-as-UI for delivery boys is the defining creative choice. The bot should feel purpose-built, not tacked on.
- Admin dashboard feels like a well-designed spreadsheet, not a generic web app.

### Craft (weight: 0.4)
- Telegram bot commands work exactly as documented. Error states handled: unknown command, invalid delivery number, missing reason for `/issue`.
- Dispatch generation handles edge cases: empty route (no active customers), paused customers correctly excluded, re-generation same day replaces cleanly.
- Customer self-service page shows loading state, error state (invalid token), empty state (no active plan), and success feedback after pause/resume.
- Payment ledger maintains audit trail -- no editing or deleting past entries, only adding new ones with reversal notes.
- All deletion actions have confirmation dialogs. No irreversible data loss from a single click.

### Functionality (weight: 0.3)
- Critical flow 1: Admin adds customer -> sets plan -> dispatch generates -> delivery boy sees route -> marks delivered -> admin dashboard reflects it.
- Critical flow 2: Admin records payment -> balance updates -> customer self-service shows current balance.
- Critical flow 3: Customer pauses via self-service -> next day's dispatch excludes them -> resume reverses it.
- Critical flow 4: Delivery boy marks issue -> admin sees issue board -> marks resolved.
- All flows work with 100 customers and 5 delivery boys without slowdown.

## Sprint Plan

### Sprint 1: Core Dispatch (Week 1)

- Goals: Working dispatch loop (admin adds -> dispatch generates -> telegram bot reads -> marks done)
- Features: #1 (Customer Directory), #2 (Subscription Plans), #3 (Daily Dispatch Generator), #4 (Telegram Bot Core), #5 (Payment Ledger), #6 (Admin Dashboard)
- Definition of done: Admin can add customers, set plans, generate dispatch. Delivery boy sees route on Telegram and marks items done. Admin sees today's progress. Payment entry works.

### Sprint 2: Customer Self-Service & Polish (Week 2)

- Goals: Customer can pause/resume independently. Issues are tracked and resolvable. Dispatch auto-generates.
- Features: #7 (Customer Self-Service), #8 (Auto-Dispatch), #9 (Issue Board), #10 (Monthly Invoice)
- Definition of done: Customer pauses via web page, dispatch respects it. Issues from Telegram appear in admin. Cron dispatches daily. Invoice prints cleanly.

### Sprint 3: Notifications & Reports (Week 3)

- Goals: Telegram pings for arrivals. Payment reminders reduce chasing. Reports exportable.
- Features: #11 (Telegram Notification), #12 (Payment Reminder), #13 (CSV Export), #14 (Daily Report)
- Definition of done: Customer gets arrival notification. Overdue customers get reminder. Reports export. Daily summary exists.