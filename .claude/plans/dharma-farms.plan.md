# Dharma Farms - Implementation Plan

**Project:** Daily milk delivery operations system (~100 customers, 5 delivery boys)
**Tech:** Node.js 20+, Express 4.x, EJS, SQLite (better-sqlite3), Telegram Bot (polling)
**Deployment:** Admin\'s Windows computer, PM2
**Timeline:** ~3 weeks (4 phases)

> **Key constraint:** Admin boots the PC around 4:30 AM for the delivery window. PC may be off the rest of the day. All scheduled tasks (dispatch generation, backup, route push) must work on server start — not depend on the PC being on at specific night-time hours.

---

## Overview

The plan is split into 4 phases, each independently deliverable and testable. Phase 1 is the smallest launchable product. Each subsequent phase layers on without requiring rewrites of earlier phases.

### Design System (Applied Across All Phases)

| Token | Value | Usage |
|-------|-------|-------|
| `--green-900` | #1B4332 | Sidebar, headings, primary buttons |
| `--green-600` | #2D6A4F | Secondary accents, hover states |
| `--bg` | #F0FDF4 | Page background |
| `--text` | #374151 | Body text |
| `--red` | #DC2626 | Issues, errors, overdue |
| `--amber` | #F59E0B | Warnings, skips |
| `--green` | #10B981 | Delivered, success, active |

- **Typography**: `system-ui` stack for admin dashboard, `ui-monospace` stack for Telegram bot output in admin views
- **Layout**: Left sidebar (240px, #1B4332 bg, white text), content area with #F0FDF4 bg, striped table rows, no gradients, no rounded cards, no illustrations
- **Telegram output**: Plain text with emoji markers only (checkmark / cross / bell), no markdown, no rich formatting

---

## Phase 1: Core Delivery Loop (Days 1-4)

**Goal:** Admin adds customer -> dispatch generates -> Telegram bot marks done -> dashboard reflects. Nothing else.

### Files to Create

```
dharma-farms/
├── package.json
├── .env
├── server.js                  # Entry point: Express init, route mounting, Telegram polling start
├── db.js                      # SQLite init, schema creation, migration tracking
├── routes/
│   ├── admin.js               # GET/POST: dashboard, customers, dispatch pages
│   └── telegram.js            # Telegram command handlers (/start, /route, /done N, /skip N, /issue N)
├── services/
│   ├── dispatch.js            # generateDispatch(): create today\'s delivery rows for active customers
│   └── telegram.js            # formatRouteMessage(), sendTelegramMessage() - formatting helpers
├── views/
│   ├── login.ejs              # Admin login page
│   ├── admin/
│   │   ├── layout.ejs         # HTML shell: sidebar nav, CSS link, body wrapper
│   │   ├── dashboard.ejs      # Today\'s progress: X/Y delivered, active customers, issues
│   │   ├── customers.ejs      # Customer table + add/edit forms
│   │   └── dispatch.ejs       # Today\'s deliveries grouped by delivery boy
├── public/
│   └── css/
│       └── style.css          # Custom overrides: striped rows, sidebar, color tokens
└── data/                      # Created at runtime (gitignored)
```

### Database Tables (Phase 1)

```sql
-- Created by db.js on first launch
CREATE TABLE customers ...
CREATE TABLE delivery_boys ...
CREATE TABLE subscriptions ...
CREATE TABLE deliveries ...
-- payments table NOT YET created (deferred to Phase 2)
CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
```

### Data Flow: Add Customer -> Dispatch -> Telegram -> Done

1. Admin logs in at `GET /admin/login` -> validates bcrypt hash against ADMIN_PASSWORD from `.env`
2. Admin clicks "Add Customer" at `GET /admin/customers` -> fills form -> `POST /admin/customers`
3. Server inserts into `customers` table, creates an active `subscriptions` row with 30 days
4. Admin clicks "Generate Dispatch" at `GET /admin/dispatch` -> `POST /admin/dispatch/generate`
5. `dispatch.js:generateDispatch()` queries active customers with active subscriptions, inserts rows into `deliveries` (status=pending) for today\'s date
6. Delivery boy opens Telegram -> sends `/start` -> bot asks for phone number -> server stores `telegram_chat_id` on `delivery_boys` record
7. Delivery boy sends `/route` -> server queries `deliveries` for today where `delivery_boy_id` matches, formats as numbered list, sends via Telegram
8. Delivery boy sends `/done 1` -> server updates row #1 to status=delivered, `marked_at=NOW()`, replies with confirmation + next customer
9. Admin opens dashboard at `GET /admin` -> counts deliveries by status group, renders overview
10. Admin opens dispatch at `GET /admin/dispatch` -> shows full table grouped by boy

### Telegram Commands (Phase 1)

| Command | Handler Logic |
|---------|---------------|
| `/start` | Reply with welcome + phone number request (Telegram contact button). Store `chat_id` on matching `delivery_boys.phone` |
| `/route` | Query today\'s pending deliveries for this boy. Format as numbered list. Send to chat |
| `/done N` | Find delivery #N in today\'s route for this boy. UPDATE status=\'delivered\', `marked_at=NOW()`. Reply confirmation + next customer |
| `/skip N` | Same but status=\'skipped\'. Add +1 day to subscription remaining_days |
| `/issue N <reason>` | Same but status=\'issue\', store `issue_reason`. Reply with issue acknowledged |
| `/arriving N` | Same but status=\'arriving\'. Reply with confirmation |
| `/finish` | Aggregate today\'s statuses for this boy. Reply with summary: X delivered, Y skipped, Z issues. No DB change |

### Telegram Polling Configuration

```javascript
// In server.js
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Polling error recovery
bot.on(\'polling_error\', (err) => {
  console.error(\'[Telegram] Polling error:\', err.message);
  // Bot auto-recovers; log for diagnostics
});
```

No webhook, no public endpoint for Telegram. Polling works behind NAT.

### Validation Steps (Phase 1)

1. `npm install` completes without errors (10 packages)
2. `npm start` starts server, SQLite `.db` file appears in `data/`
3. Open `http://localhost:3000/admin/login` -> login page renders
4. Login with admin password -> redirects to dashboard (shows empty state with 0s)
5. Navigate to Customers -> "Add Customer" -> fill form -> submit -> customer appears in table
6. Navigate to Dispatch -> "Generate Today\'s Dispatch" -> table shows delivery rows
7. Open Telegram -> message the bot -> `/start` responds with welcome
8. Send `/route` -> bot replies with numbered list matching admin\'s dispatch
9. Send `/done 1` -> bot confirms -> dashboard refresh shows 1 delivered
10. Send `/skip 2` -> bot confirms -> subscription `remaining_days` incremented by 1
11. Send `/issue 3 no milk` -> bot confirms -> dashboard shows yellow alert for that row

### Acceptance Criteria (Phase 1)

- [ ] Admin can add a customer with name, phone, address, rate, assigned delivery boy
- [ ] Admin can generate today\'s dispatch in one click
- [ ] Delivery boy sees their exact route via `/route` on Telegram
- [ ] `/done N`, `/skip N`, `/issue N` update the database and reply confirmation
- [ ] Admin dashboard shows live counts: X of Y delivered, Z issues
- [ ] `/finish` returns a summary without crashing
- [ ] Skip adds +1 day to remaining_days automatically
- [ ] Worker can run with just `npm start` -- no build step, no config beyond `.env`

---

## Phase 2: Payments & Admin (Days 5-8)

**Goal:** Payment recording, per-customer ledger, reports page, CSV export, admin polish.

### Files to Create

```
dharma-farms/
├── routes/
│   └── admin.js               # ADD: payments GET/POST, reports GET/CSV
├── services/
│   └── subscription.js        # NEW: getBalance(), extendDays(), getLedger()
├── views/
│   └── admin/
│       ├── payments.ejs       # NEW: Payment recording form + per-customer ledger
│       └── reports.ejs        # NEW: Monthly collection, delivery success rate, CSV button
```

### Database Changes (Phase 2)

```sql
-- New table added (db.js creates it on next restart if not exists)
CREATE TABLE payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  amount          INTEGER NOT NULL,                  -- in paise
  mode            VARCHAR(20) NOT NULL,              -- cash | upi | bank_transfer
  payment_date    DATE NOT NULL,
  notes           TEXT,
  recorded_by     VARCHAR(100),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_payments_customer ON payments(customer_id);
```

### Data Flow: Record Payment

1. Admin navigates to `GET /admin/payments` -> sees: searchable customer list with balance column, "Record Payment" button per row
2. Admin clicks "Record Payment" for a customer -> form: amount (INR -> stored as paise), mode (dropdown: cash/upi/bank_transfer), date (defaults to today), notes (optional)
3. `POST /admin/payments` -> INSERT into `payments` table -> redirect with success flash
4. Balance calculation: `(total_paid_amount / monthly_rate_in_paise) * 30` minus consumed days
5. Ledger view per customer: chronological list of all payments + balance running total

### Reports Page (`GET /admin/reports`)

| Section | Query | Display |
|---------|-------|---------|
| Monthly Collection | SUM of payments this month | Amount in INR |
| Delivery Success Rate | (delivered / total) * 100 | Percentage + green/amber/red indicator |
| Overdue Accounts | Customers with expired subscription still receiving? | Table with customer name, days overdue, amount due |
| CSV Export | Button per section | Triggers `GET /admin/reports/export?type=payments|customers|deliveries` -> stream CSV response |

### CSV Export Endpoint

```javascript
// In admin.js
router.get(\'/reports/export/:type\', requireAdmin, (req, res) => {
  const rows = queryExportData(req.params.type);
  res.setHeader(\'Content-Type\', \'text/csv\');
  res.setHeader(\'Content-Disposition\', `attachment; filename=${req.params.type}-${today}.csv`);
  // Stream rows as CSV using manual write (no csv library needed for basic CSV)
});
```

### Validation Steps (Phase 2)

1. Restart server -> payments table auto-created (check with SQLite Browser or `SELECT * FROM payments`)
2. Navigate to Payments page -> "Record Payment" form renders
3. Record a payment of Rs 500 for a customer -> appears in ledger
4. Open same customer\'s ledger -> shows payment entry with running balance
5. Reports page shows monthly collection matching the recorded payment
6. Export CSV -> downloads file -> open in Excel/Google Sheets -> 3 columns: customer, amount, date
7. Customer balance calculation matches: (paid / rate) * 30 - consumed days

### Acceptance Criteria (Phase 2)

- [ ] Admin can record a payment in under 15 seconds (select customer, enter amount, submit)
- [ ] Per-customer ledger shows chronological payment history with running balance
- [ ] Reports page shows monthly revenue, delivery success rate, overdue accounts
- [ ] CSV export works for all 3 report types with proper headers
- [ ] No negative balances shown (floor at 0)
- [ ] Payments are append-only: no edit or delete button (audit trail maintained)

---

## Phase 3: Scheduling & Polish (Days 9-12)

**Goal:** Auto-dispatch via node-cron, DB backup, issue tracking board, error recovery hardening.

### Files to Create

```
dharma-farms/
├── services/
│   └── scheduler.js           # NEW: node-cron job definitions
├── views/
│   └── admin/
│       └── issues.ejs         # NEW: Issue tracking board
```

### Changes to Existing Files

```javascript
// server.js - ADD:
const { startScheduler } = require(\'./services/scheduler\');
startScheduler();

// Graceful shutdown handling
process.on(\'SIGINT\', () => {
  console.log(\'[Server] Shutting down gracefully...\');
  bot.stopPolling();
  db.close();
  process.exit(0);
});
```

### Scheduling Strategy (PC-on-at-4:30-AM aware)

> PC is off at 9PM and 3AM. All schedule-dependent tasks run on server boot instead. Cron jobs fire only during hours the PC is on.

| Trigger | Job | Implementation |
|---------|-----|----------------|
| Server start (~4:30 AM) | Auto-dispatch for today | `generateDispatch(today)` — runs if today\'s deliveries don\'t exist yet. Idempotent |
| Server start (~4:30 AM) | SQLite backup | `backupDatabase()` — copies `.db` to `backup/`. Runs once per day (checks if today\'s backup exists) |
| 5:30 AM cron | Push routes to Telegram | For each delivery boy with deliveries today, send their route |
| 7:30 AM cron | Push completion summary | Send end-of-route summary to admin |

```javascript
// server.js - On startup
const { generateDispatch } = require(\'./services/dispatch\');
const { backupDatabase } = require(\'./services/scheduler\');

// Auto-generate today\'s dispatch on server boot (idempotent)
if (!dispatchExistsForToday()) {
  console.log(\'[Boot] Generating today\\\'s dispatch...\');
  generateDispatch(today);
}

// Daily backup on server boot (once per day)
if (!backupExistsForToday()) {
  console.log(\'[Boot] Running database backup...\');
  backupDatabase();
}
```

```javascript
// services/scheduler.js — Cron jobs that fire WHILE the PC is on
const cron = require(\'node-cron\');

function startScheduler() {
  // Push routes at 5:30 AM (PC has been on since ~4:30)
  cron.schedule(\'30 5 * * *\', () => {
    console.log(\'[Scheduler] Pushing routes to delivery boys...\');
    pushRoutesToAllBoys();
  });

  // End-of-route summary at 7:30 AM
  cron.schedule(\'30 7 * * *\', () => {
    console.log(\'[Scheduler] Sending completion summary...\');
    sendAdminSummary();
  });
}
```

### Backup Implementation

```javascript
function backupDatabase() {
  const src = path.join(__dirname, \'..\', \'data\', \'dharma-farms.db\');
  const backupDir = path.join(__dirname, \'..\', \'backup\');
  const date = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir, `dharma-farms-${date}.db`);

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(src, dest);

  // Clean backups older than 30 days
  const THIRTY_DAYS = 30 * 86400 * 1000;
  fs.readdirSync(backupDir).forEach(f => {
    const fp = path.join(backupDir, f);
    if (Date.now() - fs.statSync(fp).mtimeMs > THIRTY_DAYS) {
      fs.unlinkSync(fp);
    }
  });
  console.log(`[Backup] Created: ${dest}`);
}
```

### Edge Cases Handled

| Edge Case | Implementation |
|-----------|---------------|
| Empty route (no active customers) | Dispatch generator returns 0 rows. Dashboard shows "No deliveries today." Telegram `/route` replies "No deliveries scheduled today." |
| Re-generate same day | DELETE existing deliveries for today, then re-INSERT. Wrapped in transaction. |
| Telegram bot polling error | Logged + auto-recovered by node-telegram-bot-api. Server continues running. |
| Bot polling stops silently | Health check endpoint `GET /health` returns bot polling status. PM2 monitors process. |
| 5:30AM push to offline boy | Log warning, skip. Boy will see route when they send `/route` manually. |
| SQLite busy during backup | `fs.copyFileSync` is atomic at filesystem level on Windows. If busy, backup fails silently and logs error. |
| Windows path separators | All paths use `path.join()` -- not hardcoded `/` or `\` |
| Server crash during 5-7AM window | PM2 auto-restarts. If restart takes >10 seconds, delivery boys use phone fallback (existing behavior). |
| Multiple rapid `/done` from same boy | Sequential processing: each command processed as it arrives. SQLite handles sequential writes. |
| PC boots at 5AM instead of 4:30AM | On-boot dispatch generator checks if today\'s deliveries exist. If not, creates them. No dependency on boot time. |
| PC boots multiple times in one day | Backup and dispatch both check idempotency (\"already exists?\") before running. No duplicate rows or backups. |
| PC not turned on at all (emergency) | Delivery boys use paper backup (existing manual process). No data loss. System resumes when PC boots next. |

### Validation Steps (Phase 3)

1. Start server -> check console logs for "Generating today's dispatch..." and "Running database backup..."
2. Verify `backup/` directory has today's backup file: `dharma-farms-YYYY-MM-DD.db`
3. Verify today's deliveries exist in the database
4. Stop server, restart it -> check console says "already exists, skipping" for both dispatch and backup
5. Change system clock to tomorrow, start server -> dispatch generates for new date, backup creates new file
6. Change clock back to today, start server -> dispatch and backup are skipped (already exist)
7. Wait for 5:30AM (or test with next-minute cron) -> bot messages appear in delivery boy Telegram chats
8. Wait for 7:30AM -> admin receives end-of-route summary (if admin Telegram chat ID configured)
9. Stop Telegram bot -> restart server -> bot auto-reconnects on boot
10. `GET /health` returns `{ "status": "ok", "telegram": "connected", "db": "ok" }`
11. Navigate to Issues board -> see issues logged from `/issue` commands -> resolve one -> status changes

### Acceptance Criteria (Phase 3)

- [ ] Dispatch auto-generates on server boot if today's deliveries don't exist
- [ ] Delivery boys receive route via Telegram at 5:30 AM automatically
- [ ] Daily SQLite backup created on first server boot of the day
- [ ] Backups older than 30 days auto-deleted
- [ ] Restarting server mid-day does NOT create duplicate dispatch or backup
- [ ] Issue tracking board shows all issues with filter and resolve action
- [ ] Server gracefully handles SIGINT (stops polling, closes DB)
- [ ] Health endpoint responds within 200ms
- [ ] `/route` returns "No deliveries" for empty days instead of error

---

## Phase 4: Customer Portal (Days 13-16)

**Goal:** Token-based self-service page where customers can pause/resume and check balance.

### Files to Create

```
dharma-farms/
├── routes/
│   └── customer.js            # NEW: GET /my-account/:token, POST /my-account/:token/pause, /resume
└── views/
    └── customer/
        └── portal.ejs         # NEW: Self-service page (mobile-first)
```

### Changes to Existing Files

```sql
-- ALTER TABLE customers ADD COLUMN token VARCHAR(64) UNIQUE;
-- Token is generated when admin creates customer:
-- crypto.randomBytes(32).toString(\'hex\')  -> 64-char hex string
```

```javascript
// In routes/admin.js - ADD: token generation on customer creation
const crypto = require(\'crypto\');
// When inserting customer:
// token = crypto.randomBytes(32).toString(\'hex\')
```

### Customer Portal Flow

1. Admin creates customer -> system generates 64-char hex token -> displayed on customer creation success page
2. Admin prints token on invoice or pastes in SMS: "Manage your account: http://localhost:3000/my-account/TOKEN"
3. Customer opens link -> `GET /my-account/:token`
4. Server looks up `customers WHERE token = :token` -> 404 if invalid -> renders portal.ejs
5. Portal page shows:
   - Customer name and assigned delivery boy
   - Current subscription status (active / paused / expired)
   - Remaining days on subscription
   - Today\'s delivery status (pending/delivered/skipped/issue)
   - **If active**: "Pause Deliveries" section with date range picker (start date, end date)
   - **If paused**: "Resume Deliveries" button + shows pause end date
6. Customer pauses: `POST /my-account/:token/pause` with body `{ start_date, end_date }`
   - Server validates dates (start must be tomorrow or later, end must be after start)
   - Updates `subscriptions`: `status=\'paused\'`, `paused_until=end_date`, `remaining_days += (end_date - start_date) + 1`
   - Re-renders portal with confirmation message
7. Customer resumes: `POST /my-account/:token/resume`
   - Updates `subscriptions`: `status=\'active\'`, clears `paused_until`
   - Re-renders portal with confirmation

### Edge Cases in Customer Portal

| Edge Case | Handling |
|-----------|----------|
| Invalid token | Render inline error message with no stack trace. HTTP 200 (not 404) to avoid token scanning |
| Expired token (customer deactivated) | Show "Account not found" - same message as invalid token (no attacker info) |
| Already paused + try pause again | Show "Your subscription is already paused until [date]" |
| Already active + try resume | Show "Your subscription is already active" |
| Past date in pause range | Show validation error: "Start date must be tomorrow or later" |
| Overlapping pause with previous pause | Allow it (pauses stack). `paused_until` always reflects the latest pause end |
| No active subscription | Show "No active subscription found" with current plan history link |
| Token with leading/trailing whitespace | Trim before lookup |
| Concurrent pause+resume race | SQLite serializes writes. Second write sees updated state |
| Mobile browser layout | Meta viewport tag, single-column layout, large touch targets (min 44px) |

### Portal Page Design

- Mobile-first: single column, stacked layout
- Desktop: max-width 640px centered card
- Color: #F0FDF4 background, #1B4332 header bar, #374151 text
- Status badges: green (#10B981) for active, amber (#F59E0B) for paused, gray for expired
- Touch-friendly: minimum 44px tap targets on pause/resume buttons
- Loading state: spinner while form submits (vanilla JS, no framework)
- Error state: inline banner with #DC2626 left border
- Success state: green banner with #10B981 left border + confirmation text

### Validation Steps (Phase 4)

1. Server restart -> check `token` column exists on customers table
2. Create a new customer -> verify token appears in admin response
3. Open `http://localhost:3000/my-account/TOKEN` in browser -> portal renders with customer info
4. Check today\'s delivery status shows correctly (pending/delivered)
5. Submit pause form with valid date range -> confirmation shown
6. Open dispatch page -> customer does NOT appear in today\'s dispatch
7. Submit resume form -> confirmation shown -> customer reappears in dispatch
8. Test with invalid token -> shows "Account not found" (no stack trace, same message for expired)
9. Test pause with past date -> validation error shown
10. Test on mobile viewport (375px width) -> layout stacks, buttons tappable

### Acceptance Criteria (Phase 4)

- [ ] Customer opens token link -> sees their name, subscription status, remaining days
- [ ] Customer pauses for specific dates -> dispatch excludes them for those dates
- [ ] Customer resumes -> dispatch includes them again next day
- [ ] Invalid/expired token shows generic "Account not found" message
- [ ] Page renders correctly on 375px mobile viewport
- [ ] No login, no password, no OTP required
- [ ] Admin can view/regenerate token from edit customer page
- [ ] Pause date validation prevents past dates

---

## File Creation Order (By Phase)

| Phase | Order | File | Depends On |
|-------|-------|------|------------|
| P1 | 1 | `db.js` | nothing |
| P1 | 2 | `.env` | nothing |
| P1 | 3 | `package.json` | nothing |
| P1 | 4 | `services/telegram.js` | db.js |
| P1 | 5 | `services/dispatch.js` | db.js |
| P1 | 6 | `routes/telegram.js` | services/telegram.js |
| P1 | 7 | `routes/admin.js` | services/dispatch.js |
| P1 | 8 | `views/login.ejs` | nothing |
| P1 | 9 | `views/admin/layout.ejs` | nothing |
| P1 | 10 | `views/admin/dashboard.ejs` | routes/admin.js |
| P1 | 11 | `views/admin/customers.ejs` | routes/admin.js |
| P1 | 12 | `views/admin/dispatch.ejs` | routes/admin.js |
| P1 | 13 | `public/css/style.css` | nothing |
| P1 | 14 | `server.js` | all of the above |
| P2 | 15 | `services/subscription.js` | db.js |
| P2 | 16 | `views/admin/payments.ejs` | routes/admin.js |
| P2 | 17 | `views/admin/reports.ejs` | routes/admin.js |
| P2 | 18 | (update) `routes/admin.js` | services/subscription.js |
| P3 | 19 | `services/scheduler.js` | services/dispatch.js, services/telegram.js |
| P3 | 20 | `views/admin/issues.ejs` | routes/admin.js |
| P3 | 21 | (update) `server.js` | services/scheduler.js |
| P4 | 22 | `routes/customer.js` | services/subscription.js |
| P4 | 23 | `views/customer/portal.ejs` | routes/customer.js |
| P4 | 24 | (update) `routes/admin.js` | crypto token generation |

---

## Database Migration Strategy

Because we\'re using SQLite with better-sqlite3, migrations are tracked simply:

```javascript
// In db.js
const MIGRATIONS = [
  {
    version: 1,
    sql: 'CREATE TABLE IF NOT EXISTS customers (...); CREATE TABLE IF NOT EXISTS delivery_boys (...); ...'
  },
  {
    version: 2,
    sql: 'CREATE TABLE IF NOT EXISTS payments (...);'
  },
  {
    version: 3,
    sql: 'ALTER TABLE customers ADD COLUMN token VARCHAR(64) UNIQUE;'
  }
];

// Schema version tracking via a schema_version table
// On startup: SELECT MAX(version) FROM schema_version -> run unapplied migrations
```

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Telegram bot polling stops silently | Low | High | Health endpoint (`GET /health`) reports polling status. PM2 restarts process on crash. Admin checks dashboard daily |
| SQLite file corruption | Low | High | Daily fs.copyFileSync backup at 3AM. Worst case: lose 1 day of delivery records |
| 5AM route push fails (internet down) | Medium | Medium | Boy sends `/route` manually to get their list. Delivery continues with paper backup |
| Admin computer restarts during 5-7AM | Low | High | PM2 auto-start on Windows login (`pm2 startup`). Worst case: 2-3 min downtime |
| Delivery boy sends wrong format command | Medium | Low | Bot replies with error message showing correct format. `/help` command lists all commands |
| Customer token link shared to wrong person | Low | Medium | Customer portal only shows name + delivery status. No PII other than name. Admin can regenerate token |
| Multiple boys mark same delivery | Low | Low | Second update is idempotent (status same). If different: last write wins, logged for audit |
| BOT_TOKEN leaked | Low | Critical | `.env` is gitignored. If leaked: regenerate token from BotFather, update `.env`, restart PM2 |
| Computer runs out of disk space | Low | Medium | Backups auto-clean after 30 days. DB is <1MB. 30 backups <30MB. Negligible |
| Delivery boy changes phone number | Low | Medium | Re-register with `/start`. Admin updates phone in delivery_boys. Old chat_id orphaned |

---

## Deployment Sequence (After Phase 1)

```bash
# Prerequisites: Node.js 20+ installed, admin\'s Windows computer
cd dharma-farms
npm install

# Create .env file with:
# BOT_TOKEN=<from BotFather>
# SESSION_SECRET=<random 64-char hex>
# ADMIN_PASSWORD=<bcrypt hash of admin password>
# PORT=3000

# First run (creates DB + schema)
npm start
# Verify: http://localhost:3000

# Install PM2 globally
npm install -g pm2
pm2 start server.js --name dharma-farms
pm2 save

# Configure PM2 to auto-start on Windows login:
pm2 startup
# Follow the Windows instructions printed by PM2

# For customer portal (Phase 4):
# Install cloudflared from Cloudflare
cloudflared tunnel --url http://localhost:3000
# This gives a public URL like https://xyz.trycloudflare.com
# Optionally: point a custom domain at the tunnel

# Verify after reboot:
# 1. Windows starts automatically (or admin logs in)
# 2. PM2 launches dharma-farms (runs npm start)
# 3. Server is up on port 3000
# 4. cloudflared tunnel reconnects (if customer portal needed)
```

---

## Testing Strategy (Per Phase)

### Phase 1 Testing
- **Manual test path** (primary): Admin flow -> create customer -> generate dispatch -> check Telegram
- **Edge cases**: Empty dispatch (no active customers), duplicate dispatch generation same day, `/done` with invalid index, `/start` without matching phone in DB

### Phase 2 Testing
- **Record payment** -> verify ledger shows it -> verify reports page reflects it
- **Edge cases**: Zero amount payment, future date payment, duplicate payments same day

### Phase 3 Testing
- **Cron test**: Change cron to run every 2 minutes -> verify dispatch generates, backup file appears
- **Recovery test**: Kill server -> PM2 restarts -> verify Telegram bot reconnects -> verify routes still work

### Phase 4 Testing
- **Token link**: Open in browser -> verify correct customer data -> verify operations work
- **Mobile**: Chrome DevTools mobile mode -> verify layout
- **Security**: Try random tokens -> verify "Account not found" response

---

## What Phase 1 Does NOT Include (Explicitly)

- No customer portal (Phase 4)
- No auto-dispatch scheduling (Phase 3)
- No payment recording (Phase 2)
- No reports or CSV (Phase 2)
- No issue tracking board (Phase 3)
- No backup scheduling (Phase 3)
- No health endpoint (Phase 3)
- No Telegram route push at 5AM (Phase 3)
- No CSV export library (manual generation)
- No TypeScript, React, Docker, ORM, VPS, Redis, WebSocket
- No customer notifications, no payment reminders, no invoice PDF

Phase 1 is **deliberately minimal**: the smallest system that replaces paper for the core operational loop.

---

## Total File Count (All Phases)

**Phase 1:** 14 files (8 code, 4 views, 1 CSS, 1 config)
**Phase 2:** +4 files (1 service, 2 views, updates to 1 route)
**Phase 3:** +2 files (1 service, 1 view, updates to server.js)
**Phase 4:** +2 files (1 route, 1 view)
**Total at launch:** 22 files

---

## Appendix: npm Packages (All Phases)

```json
{
  "dependencies": {
    "express": "^4.21.0",
    "ejs": "^3.1.10",
    "better-sqlite3": "^11.0.0",
    "node-telegram-bot-api": "^0.66.0",
    "node-cron": "^3.0.3",
    "express-session": "^1.18.0",
    "bcrypt": "^5.1.1",
    "dotenv": "^16.4.5",
    "connect-sqlite3": "^0.9.15"
  }
}
```

9 production dependencies. No devDependencies. No TypeScript. No build step.