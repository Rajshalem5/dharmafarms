# Dharma Farms -- Product Requirements Document

**Version:** 1.0
**Date:** July 1, 2026
**Status:** Final
**Classification:** Confidential -- Internal Use

---

## 1. Product Overview

### 1.1 Vision

Dharma Farms delivers milk to ~100 households daily between 5:00 AM and 7:00 AM through 5 delivery boys. The current operation runs on paper ledgers, phone calls, and informal WhatsApp messages -- creating payment gaps, no real-time delivery visibility, and administrative overhead. This system replaces that manual process with a digital stack that costs near-zero per month.

### 1.2 Scope

The system covers the complete daily delivery loop:

- **Admin**: Customer management, subscription tracking, dispatch generation, payment recording, reports
- **Delivery Boys**: Telegram bot for route viewing, status updates (done/skip/issue), and end-of-route summary
- **Customers**: Token-based web portal for pause/resume and balance check

What is explicitly out of scope for v1:
- No customer notifications (SMS/email/WhatsApp)
- No invoice or receipt PDF generation
- No payment gateway integration (payments recorded manually)
- No mobile app (Telegram + browser only)
- No multi-language support
- No inventory or supply chain management
- No analytics beyond basic reports

### 1.3 Target Users

| Role | Count | Primary Interface | Technical Literacy |
|------|-------|-------------------|--------------------|
| Admin (business owner) | 1 | Browser dashboard (localhost) | Moderate |
| Delivery boys | 5 | Telegram bot on personal phone | Low -- minimal typing |
| Customers | ~100 | Browser via token link | Varies -- mobile-first |

### 1.4 Key Constraints

- **Budget**: Zero paid APIs. No VPS. No SaaS subscriptions beyond domain name.
- **Internet**: Must work on basic Indian internet (2G/3G). Telegram must work on inexpensive Android phones.
- **Hardware**: Runs on the admin's Windows 11 home PC. No server-grade hardware.
- **Availability**: PC is booted for the delivery window (~4:30 AM to ~7:00 AM). May be off the rest of the day. All scheduling must be boot-aware, not time-dependent.
- **Timeline**: 3 weeks to MVP.

---

## 2. User Personas

### 2.1 Admin (Ramesh)

**Background:** Owner-operator of Dharma Farms. Runs the business from home. Uses a Windows 11 PC. Moderately comfortable with technology -- can use a browser, fill forms, and follow setup instructions. Currently manages everything on paper.

**Goals:**
- Replace paper ledgers with a digital customer database
- See which deliveries are done, skipped, or having issues in real time
- Track payments and know who is overdue
- Generate dispatch without manual list-making at 4:30 AM
- Export reports for business review

**Frustrations:**
- Manual dispatch takes 15 minutes every morning
- Cannot tell if a delivery boy is on track or falling behind
- Payment tracking is a notebook -- easy to miss who hasn't paid
- No way to see historical delivery success rates

**Success criteria:**
- Opens dashboard at 5 AM, sees today's dispatch ready
- Spots issues within minutes of a delivery boy reporting them
- Records a payment in under 15 seconds
- Exports monthly report without manual spreadsheet work

### 2.2 Delivery Boy (Raju)

**Background:** Early-30s, rides a motorcycle with milk crates. Has a basic Android phone with Telegram installed. Limited English. Comfortable with voice notes and simple text commands. Typing long messages is difficult.

**Goals:**
- See today's route list without a paper copy
- Mark deliveries as done with minimal effort
- Report problems without calling the admin
- Know when his route is complete

**Frustrations:**
- Paper lists get wet, lost, or damaged
- Calling admin for every skip or issue is time-consuming
- Cannot remember customer codes easily

**Success criteria:**
- Opens Telegram, sends `/route`, sees his list in seconds
- Sends `/done C001` after each delivery -- one command, done
- Sends `/issue C002 gate dog` to report a problem
- Sends `/finish` at route end, gets a summary
- Total Telegram interaction per day: under 2 minutes

### 2.3 Customer (Priya)

**Background:** Working professional, receives milk at home. Has a smartphone. Wants convenience but is not interested in downloading another app. Currently calls the admin to pause delivery when going out of town.

**Goals:**
- Pause milk delivery for a few days without calling
- Check remaining subscription balance
- Know when delivery is coming

**Frustrations:**
- Forgetting to call before a trip means milk is delivered and wasted
- Calling the admin at 6 AM to ask about balance is awkward
- No way to see if today's delivery is done

**Success criteria:**
- Opens a link from the invoice, sees subscription status
- Pauses delivery for specific dates in two taps
- Resumes with one tap
- Never needs to call the admin for pause/resume

---

## 3. Feature Catalog

### 3.1 Must-Have (Phase 1 -- Core Delivery Loop)

| ID | Feature | Description | User |
|----|---------|-------------|------|
| F-01 | Customer database | Admin creates, edits, deactivates customers with code, name, phone, address, rate, assigned boy | Admin |
| F-02 | Subscription tracking | Each customer has an active subscription with start date, total/remaining days, status | Admin |
| F-03 | Dispatch generation | One-click creation of today's delivery rows for all active customers with active subscriptions | Admin |
| F-04 | Telegram bot registration | Delivery boy sends `/start`, shares phone number, bot links chat ID to their record | Delivery boy |
| F-05 | Route display | `/route` returns today's numbered delivery list for that boy | Delivery boy |
| F-06 | Mark delivered | `/done C001` marks a delivery as delivered with timestamp | Delivery boy |
| F-07 | Mark skipped | `/skip C001` marks a delivery as skipped, extends subscription by +1 day | Delivery boy |
| F-08 | Report issue | `/issue C001 reason` marks a delivery with an issue and stores the reason | Delivery boy |
| F-09 | Arriving notification | `/arriving C001` sets arrival status | Delivery boy |
| F-10 | End-of-route summary | `/finish` returns a summary of today's deliveries for that boy | Delivery boy |
| F-11 | Admin dashboard | Overview page with today's counts: total, delivered, skipped, issues | Admin |
| F-12 | Duplicate command detection | If a delivery is already marked delivered, bot replies "Already marked delivered at HH:MM" instead of overwriting | Delivery boy |
| F-13 | Admin authentication | Password-protected admin dashboard via session + bcrypt | Admin |
| F-14 | Database persistence | All data stored in SQLite with WAL mode, migration tracking, and seed data | System |

### 3.2 Should-Have (Phase 2 -- Payments & Reports)

| ID | Feature | Description | User |
|----|---------|-------------|------|
| F-15 | Payment recording | Admin records payments with amount (INR), mode (cash/upi/bank_transfer), date, notes | Admin |
| F-16 | Customer ledger | Per-customer chronological payment history with running balance | Admin |
| F-17 | Reports page | Monthly collection, delivery success rate, overdue accounts | Admin |
| F-18 | CSV export | Export payments, customers, and deliveries as CSV files | Admin |
| F-19 | Balance calculation | Automated calculation of remaining days based on payments vs. consumed days | System |

### 3.3 Should-Have (Phase 3 -- Scheduling & Polish)

| ID | Feature | Description | User |
|----|---------|-------------|------|
| F-20 | Boot-time auto-dispatch | On server start, auto-generate today's dispatch if it doesn't exist (idempotent) | System |
| F-21 | Boot-time database backup | On first server start of the day, copy SQLite file to backup/ directory (30-day rotation) | System |
| F-22 | Scheduled route push | At 5:30 AM, push routes to all delivery boys proactively via Telegram | Delivery boy |
| F-23 | Boot-time route push | If server boots after 5:30 AM, push routes immediately as fallback | Delivery boy |
| F-24 | End-of-route summary to admin | At 7:30 AM, send aggregated delivery summary to admin via Telegram | Admin |
| F-25 | Issue tracking board | Admin page showing all issues with filter by date/boy/status, and resolve action | Admin |
| F-26 | Health endpoint | `GET /health` returns JSON with server status, Telegram polling status, DB status, uptime | System |
| F-27 | Error handling middleware | Centralized Express error handler and 404 handler | System |
| F-28 | .env validation on startup | Server checks required env vars at boot and exits with clear message if missing | System |
| F-29 | Graceful shutdown | SIGINT/SIGTERM handler stops Telegram polling, closes DB, exits cleanly | System |

### 3.4 Nice-to-Have (Phase 4 -- Customer Portal)

| ID | Feature | Description | User |
|----|---------|-------------|------|
| F-30 | Token-based customer portal | Mobile-first web page accessible via 64-char hex token link | Customer |
| F-31 | Subscription status display | Shows name, delivery boy, status badge, remaining days, today's delivery status | Customer |
| F-32 | Pause subscription | Customer selects date range to pause, dispatch excludes them for those dates | Customer |
| F-33 | Resume subscription | One-tap resume, dispatch includes them again | Customer |
| F-34 | Token management | Admin can view truncated token, copy it, and regenerate it | Admin |
| F-35 | Cloudflare Tunnel | Public URL exposing customer portal via outbound-only tunnel, admin dashboard stays local | System |
| F-36 | PM2 process management | Auto-restart on crash, auto-start on Windows login | System |

### 3.5 Future Considerations (Post-v1)

| ID | Feature | Rationale |
|----|---------|-----------|
| F-37 | Customer notifications (Telegram/SMS) | Notify when delivery is done or issue reported |
| F-38 | Payment reminders | Auto-alert admin when subscription is near expiry |
| F-39 | Invoice PDF generation | Printable invoices for customers |
| F-40 | Delivery boy performance analytics | Track on-time rates, issue frequency per boy |
| F-41 | Multi-route optimization | Suggest optimal delivery order per boy |
| F-42 | Customer history portal | Show past deliveries, payment history, pause history to customer |

---

## 4. Technical Architecture Summary

### 4.1 Technology Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Runtime | Node.js | 20+ LTS | Single-process, lightweight, widely available |
| Web framework | Express | 4.21.x | Mature, minimal, no ORM/no TypeScript needed |
| Database | SQLite via better-sqlite3 | 11.x | Single file, zero config, no server process, synchronous API |
| Template engine | EJS | 3.1.x | Server-side rendered, zero build step, no SPA complexity |
| Telegram bot | node-telegram-bot-api | 0.66.x | Polling mode (works behind NAT, no webhook needed) |
| Scheduler | node-cron | 3.0.x | Lightweight cron, no external dependency |
| Session storage | express-session + connect-sqlite3 | latest | Sessions in SQLite, no Redis needed |
| Auth (admin) | bcryptjs | latest | Pure JavaScript bcrypt, no native compilation on Windows |
| Auth (customer) | crypto.randomBytes | built-in | 64-char hex token, no password/OTP system |
| Styling | Tailwind CSS v4 + custom CSS | CDN | Utility-first CSS, no build step, local fallback |
| Process manager | PM2 | latest | Auto-restart on crash, Windows startup integration |
| Tunnel | Cloudflare Tunnel (cloudflared) | latest | Outbound-only tunnel, no open ports, free SSL |

### 4.2 npm Packages (9 production, 0 dev)

```
express, ejs, better-sqlite3, node-telegram-bot-api, node-cron,
express-session, bcryptjs, dotenv, connect-sqlite3
```

No TypeScript. No React. No Docker. No ORM. No build step.

### 4.3 Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Database | SQLite over PostgreSQL | 5 tables, ~100 customers, ~300 deliveries/day. SQLite handles this with zero config. No server process to install on Windows. | 
| Bot communication | Polling over Webhook | Works behind NAT. No SSL cert needed for bot. Auto-recovers from internet drops. |
| Rendering | SSR (EJS) over SPA | 3 admin pages, 1 customer page. No benefit from React/Vue. Zero build step. |
| Commands | Customer code (`/done C001`) over positional index (`/done 1`) | Positional indexing breaks after any update because remaining list renumbers. Customer code is stable and unambiguous. |
| Schedule | Boot-aware over time-based | PC is off at night. Dispatch generation and backup run on server start (idempotent), not at fixed hours. |
| Windows auth | bcryptjs over bcrypt | bcrypt requires native compilation (node-gyp + Visual Studio Build Tools). bcryptjs is pure JS, zero build issues on Windows. |
| Session store | SQLite over Redis | connect-sqlite3 stores sessions in the same database. No need for a second data store. |

### 4.4 Deployment Architecture

```
  Admin Browser (localhost:3000)        Delivery Boys (Telegram)        Customers (Mobile Browser)
           |                                    |                                |
           v                                    v                                v
  ┌─────────────────┐              ┌──────────────────────┐       ┌──────────────────────┐
  │ PM2 (process)   │              │ Telegram Bot API     │       │ Cloudflare Tunnel    │
  │ Express + EJS   │◄─────────────│ (polling, not webhook)│       │ (outbound-only)      │
  │                 │              └──────────────────────┘       └──────────────────────┘
  │ better-sqlite3  │                                                       │
  │ (synchronous)   │◄──────────────────────────────────────────────────────┘
  └────────┬────────┘
           │
           v
  ┌─────────────────────┐
  │ data/dharma-farms.db│
  │ (SQLite, WAL mode)  │
  │ data/sessions.db    │
  └─────────────────────┘
```

**Boot sequence (~4:30 AM):**
1. Admin boots PC, PM2 starts server.js automatically
2. dotenv loads .env, db.js creates/opens SQLite database, runs migrations, seeds data
3. Express app starts, session store initializes, routes are mounted
4. Telegram bot begins polling (auto-recovery on errors)
5. Boot check: `dispatchExistsForToday()`? If no, `generateDispatch()`
6. Boot check: `backupExistsForToday()`? If no, `backupDatabase()`
7. Boot check: `routesPushedForToday()`? If no, `pushRoutesToAllBoys()`
8. Server listens on port 3000

### 4.5 Design System

| Token | Value | Usage |
|-------|-------|-------|
| `--green-900` | #1B4332 | Sidebar, headings, primary buttons |
| `--green-600` | #2D6A4F | Secondary accents, hover states |
| `--bg` | #F0FDF4 | Page background |
| `--text` | #374151 | Body text |
| `--red` | #DC2626 | Issues, errors, overdue |
| `--amber` | #F59E0B | Warnings, skips |
| `--green` | #10B981 | Delivered, success, active |

**Style direction:** Spreadsheet-meets-terminal. Dense admin dashboard, 240px left sidebar, no rounded cards, no gradients, no illustrations. Tailwind CDN handles bulk styling with a local `style.css` fallback for core layout (internet-dependent CDN is a known risk -- mitigated by local fallback covering critical layout, table, and badge styles).

---

## 5. Data Model

### 5.1 Entity-Relationship Diagram

```
customers 1---* subscriptions 1---* deliveries
customers 1---* payments
delivery_boys 1---* deliveries
customers *---1 delivery_boys (assigned_to)
```

### 5.2 Tables

#### customers
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| code | VARCHAR(10) UNIQUE NOT NULL | C001, C002... |
| name | VARCHAR(100) NOT NULL | |
| phone | VARCHAR(15) NOT NULL | |
| address | TEXT NOT NULL | |
| delivery_boy_id | INTEGER REFERENCES delivery_boys(id) | NULL until assigned |
| monthly_rate | INTEGER NOT NULL | Stored in paise (Rs 1000 = 100000) |
| status | VARCHAR(20) DEFAULT 'active' | active, paused, inactive |
| token | VARCHAR(64) UNIQUE | 64-char hex from crypto.randomBytes(32) |
| notes | TEXT | |
| created_at | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |
| updated_at | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

#### delivery_boys
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| name | VARCHAR(100) NOT NULL | |
| phone | VARCHAR(15) NOT NULL | Used for /start registration |
| telegram_chat_id | BIGINT UNIQUE | Set when boy sends /start |
| region | VARCHAR(50) | North, South, East, West, Central |
| status | VARCHAR(20) DEFAULT 'active' | |

#### subscriptions
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| customer_id | INTEGER NOT NULL REFERENCES customers(id) | |
| start_date | DATE NOT NULL | |
| end_date | DATE | NULL = active |
| total_days | INTEGER NOT NULL DEFAULT 30 | |
| remaining_days | INTEGER NOT NULL DEFAULT 30 | Incremented on skip, decremented on delivery |
| status | VARCHAR(20) DEFAULT 'active' | active, paused, expired |
| paused_until | DATE | NULL when not paused |
| created_at | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

#### deliveries
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| customer_id | INTEGER NOT NULL REFERENCES customers(id) | |
| delivery_boy_id | INTEGER NOT NULL REFERENCES delivery_boys(id) | |
| delivery_date | DATE NOT NULL | |
| status | VARCHAR(20) DEFAULT 'pending' | pending, delivered, skipped, issue, arriving |
| issue_reason | TEXT | |
| marked_at | TIMESTAMP | When status was last updated |
| resolved_at | TIMESTAMP | When admin resolved an issue |
| resolved_note | TEXT | Admin's resolution note |
| created_at | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |
| UNIQUE(customer_id, delivery_date) | | One delivery per customer per day |

#### payments
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| customer_id | INTEGER NOT NULL REFERENCES customers(id) | |
| amount | INTEGER NOT NULL | In paise |
| mode | VARCHAR(20) NOT NULL | cash, upi, bank_transfer |
| payment_date | DATE NOT NULL | |
| notes | TEXT | |
| recorded_by | VARCHAR(100) | Admin name |
| created_at | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

### 5.3 Indexes

```sql
CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
```

### 5.4 Migration Strategy

Migrations are tracked in a `_migrations` table with `version` and `applied_at` columns. On server start, `db.js` checks `SELECT MAX(version) FROM _migrations` and applies any unapplied migrations in order.

| Version | Changes | Phase |
|---------|---------|-------|
| 1 | customers, delivery_boys, subscriptions, deliveries, indexes, seed data | Phase 1 |
| 2 | payments table + indexes | Phase 2 |
| 3 | ALTER TABLE customers ADD COLUMN token | Phase 4 |

---

## 6. Implementation Roadmap

### 6.1 Phase 1: Core Delivery Loop (Days 1-4)

**Goal:** Admin adds customer, dispatch generates, Telegram bot marks done, dashboard reflects. No payments, no scheduling, no customer portal.

**Files to create (14):**

```
dharma-farms/
├── package.json              # 9 dependencies, scripts
├── .env                      # BOT_TOKEN, SESSION_SECRET, ADMIN_PASSWORD, PORT
├── server.js                 # Entry point: Express, session, routes, Telegram boot
├── db.js                     # SQLite init, WAL mode, schema, migrations, seed data
├── routes/
│   ├── admin.js              # Login, dashboard, customers CRUD, dispatch generation
│   └── telegram.js           # /start, /route, /done, /skip, /issue, /arriving, /finish
├── services/
│   ├── dispatch.js           # generateDispatch, dispatchExistsForToday, getTodaysRouteForBoy
│   └── telegram.js           # formatRouteMessage, sendTelegramMessage
├── views/
│   ├── login.ejs             # Admin login page
│   └── admin/
│       ├── layout.ejs        # HTML shell with sidebar
│       ├── dashboard.ejs     # Today's overview with counts
│       ├── customers.ejs     # Customer table + add/edit forms
│       └── dispatch.ejs      # Today's deliveries grouped by boy
└── public/
    └── css/
        └── style.css         # Color tokens, sidebar, striped rows, badges
```

**Key decisions in Phase 1:**
- Commands use customer code (`/done C001`), not positional index (`/done 1`) -- eliminates renumbering bug
- Duplicate `/done` detection: if delivery is already delivered, reply "Already marked delivered at HH:MM" -- no silent overwrite
- WAL mode enabled: `db.pragma('journal_mode = WAL')` -- allows concurrent reads during writes
- bcryptjs instead of bcrypt -- avoids Windows native compilation issues
- bcryptjs for admin password hashing
- Tailwind CDN served from `public/css/` as a local fallback for the core layout, so the dashboard renders styled even without internet

**Telegram commands:**
| Command | Action | Response |
|---------|--------|----------|
| `/start` | Register phone number | Welcome + request contact |
| `/route` | Show today's deliveries | Numbered list with customer codes |
| `/done C001` | Mark delivered | Confirmation + next customer |
| `/skip C001` | Mark skipped, +1 day | Confirmation |
| `/issue C001 reason` | Report problem | Issue recorded |
| `/arriving C001` | Notify arrival | Arriving noted |
| `/finish` | End-of-route summary | X delivered, Y skipped, Z issues |
| `/help` | List commands | Command reference |

**Acceptance criteria:**
- [ ] `npm install` completes with no errors
- [ ] `npm start` boots server, creates `data/dharma-farms.db` with all 4 tables in WAL mode
- [ ] Admin login page renders, password authentication works via bcryptjs
- [ ] Admin can add a customer with name, phone, address, rate, assigned delivery boy
- [ ] Admin can generate today's dispatch in one click
- [ ] Delivery boy sees their exact route via `/route` on Telegram
- [ ] `/done C001`, `/skip C001`, `/issue C001 reason` update the database and reply confirmation
- [ ] Duplicate `/done` warns "Already marked delivered at HH:MM"
- [ ] `/skip` adds +1 day to remaining_days automatically
- [ ] `/issue` without reason returns error: "Please include a reason"
- [ ] Empty dispatch returns "No deliveries scheduled today"
- [ ] Admin dashboard shows live counts: X of Y delivered, Z issues
- [ ] `/finish` returns a summary without crashing
- [ ] Health endpoint returns JSON with status
- [ ] Migration v1 applied, `_migrations` table has version 1 row
- [ ] 5 delivery boys seeded in database

---

### 6.2 Phase 2: Payments & Reports (Days 5-8)

**Goal:** Payment recording, per-customer ledger, reports page, CSV export.

**Files to create/modify (4):**
- `services/subscription.js` (new) -- getBalance, extendDays, getPaymentLedger
- `views/admin/payments.ejs` (new) -- Payment recording form + per-customer ledger
- `views/admin/reports.ejs` (new) -- Monthly collection, delivery success rate, overdue accounts, CSV export
- `routes/admin.js` (update) -- Add payment GET/POST routes, reports GET/CSV routes

**Database changes:**
- Migration v2 creates `payments` table on server restart
- `payments` table is append-only -- no edit or delete endpoints

**Acceptance criteria:**
- [ ] Migration v2 creates payments table automatically on server restart
- [ ] Admin can record a payment in under 15 seconds (select customer, enter amount, submit)
- [ ] Per-customer ledger shows chronological payment history with running balance
- [ ] Reports page shows monthly collection, delivery success rate, overdue accounts
- [ ] CSV export works for payments, customers, and deliveries with proper headers
- [ ] Balance floors at 0 (no negative balances)
- [ ] Payments are append-only: no edit or delete endpoints exist
- [ ] Validation rejects zero amounts and invalid payment modes

---

### 6.3 Phase 3: Scheduling & Hardening (Days 9-12)

**Goal:** Auto-dispatch on boot, DB backup, route push, issue tracking, error recovery.

**Files to create/modify (3):**
- `services/scheduler.js` (new) -- Cron jobs, backup, boot-task helpers
- `views/admin/issues.ejs` (new) -- Issue tracking board with filter and resolve
- `server.js` (update) -- Add boot tasks, scheduler start, graceful shutdown, error middleware, health endpoint

**Scheduling strategy (boot-aware):**

| Trigger | Job | Idempotency |
|---------|-----|-------------|
| Server start (~4:30 AM) | Generate today's dispatch if not exists | `dispatchExistsForToday()` check |
| Server start (~4:30 AM) | Backup database if not backed up today | `backupExistsForToday()` check |
| Server start (~4:30 AM) | Push routes to all boys if not pushed today | `routesPushedForToday()` check (meta table or file touch) |
| 5:30 AM cron | Push routes to all boys (redundant trigger) | Same check -- safe to run multiple times |
| 7:30 AM cron | Send end-of-route summary to admin | One-shot per day |
| Server start | Clean backups older than 30 days | Always runs |

**Note on route push at boot:** This is the critical fix for the "PC boots after 5:30 AM" scenario. Without it, the 5:30 AM cron slot is missed and routes are never auto-pushed for that day. The boot-time check `if (!routesPushedForToday())` ensures routes are pushed regardless of boot time.

**Acceptance criteria:**
- [ ] Dispatch auto-generates on server boot if today's deliveries don't exist
- [ ] Database backup auto-creates on first server boot of the day
- [ ] Backups older than 30 days auto-deleted
- [ ] Restarting server mid-day does NOT create duplicate dispatch or backup
- [ ] Delivery boys receive route via Telegram at 5:30 AM (and on boot as fallback)
- [ ] Admin receives end-of-route summary at 7:30 AM
- [ ] Issue tracking board shows all issues with filter by date/boy/status
- [ ] Issue "Resolve" action stores resolution note and timestamp
- [ ] Empty issues state shows "No issues reported"
- [ ] Health endpoint responds within 200ms with correct status
- [ ] Server handles SIGINT gracefully (stops polling, closes DB)
- [ ] Centralized error handler returns 500 for unhandled exceptions
- [ ] 404 handler returns custom page for unknown routes
- [ ] Missing .env vars cause clear error on startup (not crash at first use)

---

### 6.4 Phase 4: Customer Portal & Deployment (Days 13-16)

**Goal:** Token-based self-service portal, PM2 management, Cloudflare Tunnel.

**Files to create/modify (4):**
- `routes/customer.js` (new) -- GET /my-account/:token, POST /my-account/:token/pause, /resume
- `views/customer/portal.ejs` (new) -- Mobile-first self-service page
- `routes/admin.js` (update) -- Token display, copy, regenerate on customer edit page
- Deployment configuration (PM2 startup, Cloudflare Tunnel setup)

**Customer portal endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/my-account/:token` | GET | Display customer info, subscription status, remaining days, today's delivery |
| `/my-account/:token/pause` | POST | Pause subscription for date range (start >= tomorrow, end > start) |
| `/my-account/:token/resume` | POST | Resume paused subscription |

**Security rules for customer portal:**
- Invalid token, expired token, and deactivated customer all return the same message: "Account not found" -- prevents token scanning
- Token is 64-char hex string from `crypto.randomBytes(32)` -- 256 bits of entropy, unguessable
- No login, no password, no OTP
- Request URLs containing tokens must NOT be logged verbatim (sanitize in logging middleware)
- Same error message for all failure modes (invalid token, expired, deactivated)

**Portal page design:**
- Mobile-first single column, max-width 640px centered on desktop
- Header bar: #1B4332 background, white text
- Touch-friendly: minimum 44px tap targets on buttons
- Loading state: inline CSS spinner on form submit
- Error state: red left border (#DC2626) + message
- Success state: green left border (#10B981) + confirmation
- Vanilla JS only (no framework)

**Deployment steps:**
1. `npm install -g pm2` and `pm2 start server.js --name dharma-farms`
2. `pm2 startup` prints PowerShell command, run as Administrator to create Windows Scheduled Task
3. `pm2 save` to snapshot process list
4. Install cloudflared via winget, authenticate, create tunnel to `localhost:3000`
5. Configure tunnel ingress to expose only `/my-account/*` path
6. Set tunnel as Windows service: `cloudflared service install`

**Acceptance criteria:**
- [ ] Customer opens token link and sees: name, subscription status, remaining days, today's delivery status
- [ ] Customer can pause for specific dates (start >= tomorrow, end > start)
- [ ] Pausing excludes customer from dispatch on paused dates
- [ ] Customer resume reverses the pause, re-includes in dispatch
- [ ] Invalid/expired token shows generic "Account not found" (no information leakage)
- [ ] Duplicate pause shows "already paused" message
- [ ] Duplicate resume shows "already active" message
- [ ] Past dates in pause form rejected with validation error
- [ ] Page renders correctly on 375px mobile viewport (single column, 44px+ touch targets)
- [ ] Admin can view truncated token and regenerate it
- [ ] PM2 manages process with auto-restart on crash
- [ ] PM2 starts on Windows login (boot automation)
- [ ] Cloudflare Tunnel exposes customer portal via public URL
- [ ] Tunnel restricts to customer-facing routes only
- [ ] `.env`, `data/`, and `backup/` are gitignored
- [ ] Full cold-boot test: Windows restart, PM2 auto-starts, server available on port 3000 within 30 seconds

---

### 6.5 Complete File Manifest (26 files)

```
dharma-farms/
├── package.json               # Phase 1
├── .env                       # Phase 1 (gitignored)
├── server.js                  # Phase 1, updated Phase 3
├── db.js                      # Phase 1, updated Phase 2+4
│
├── routes/
│   ├── admin.js               # Phase 1, updated Phase 2+3+4
│   ├── telegram.js            # Phase 1
│   └── customer.js            # Phase 4
│
├── services/
│   ├── telegram.js            # Phase 1
│   ├── dispatch.js            # Phase 1
│   ├── scheduler.js           # Phase 3
│   └── subscription.js        # Phase 2
│
├── views/
│   ├── login.ejs              # Phase 1
│   ├── admin/
│   │   ├── layout.ejs         # Phase 1
│   │   ├── dashboard.ejs      # Phase 1
│   │   ├── customers.ejs      # Phase 1
│   │   ├── dispatch.ejs       # Phase 1
│   │   ├── payments.ejs       # Phase 2
│   │   ├── reports.ejs        # Phase 2
│   │   └── issues.ejs         # Phase 3
│   └── customer/
│       └── portal.ejs         # Phase 4
│
├── public/
│   └── css/
│       └── style.css          # Phase 1
│
├── data/                      # Created at runtime (gitignored)
│   └── dharma-farms.db
├── backup/                    # Created by scheduler (gitignored)
│   └── dharma-farms-YYYY-MM-DD.db
└── scripts/                   # Optional seed scripts
```

---

## 7. Success Metrics

### 7.1 Operational Metrics

| Metric | Target | How Measured |
|--------|--------|-------------|
| Delivery status coverage | 100% of daily deliveries have a status | `SELECT COUNT(*) FROM deliveries WHERE delivery_date = today AND status != 'pending'` at end of day |
| Telegram command success rate | >95% of commands processed without error | Bot polling error log count per day |
| Payment recording latency | <15 seconds per payment | Manual timing (admin records payment, system confirms) |
| Dashboard load time | <1 second | Browser DevTools network tab |
| Bot response time | <2 seconds | Manual timing from send to reply |
| Dispatch generation time | <1 second for 100 customers | `console.time` in generateDispatch |
| Daily backup size | <1 MB | File size of backup .db file |
| Server uptime during delivery window | 100% | PM2 monitoring logs |

### 7.2 Business Metrics

| Metric | Current (Manual) | Target (Digital) |
|--------|-----------------|-------------------|
| Time to generate daily dispatch | ~15 minutes | <1 second (one click) |
| Time to see delivery status | End of day (phone call) | Real-time (within seconds of /done) |
| Time to identify issues | Next phone call | Immediate (dashboard alert) |
| Time to record a payment | ~2 minutes (notebook) | <15 seconds (form) |
| Time to generate monthly report | ~2 hours (manual spreadsheet) | <1 second (reports page) |
| Payment tracking accuracy | Prone to human error | Exact (append-only ledger) |
| Subscription balance visibility | Admin must manually calculate | Shown on customer page |

### 7.3 Quality Gates

Each phase must pass its acceptance criteria before the next phase begins:

- **Phase 1 gate:** All 14 acceptance criteria passing. 5 delivery boys can send `/done` and see it on the dashboard. Admin can add customers and generate dispatch.
- **Phase 2 gate:** All 7 acceptance criteria passing. Payment recording, ledger, reports, and CSV export work end-to-end.
- **Phase 3 gate:** All 10 acceptance criteria passing. Boot tasks, cron jobs, issue tracking, and error handling verified.
- **Phase 4 gate:** All 16 acceptance criteria passing. Customer portal, PM2, Cloudflare Tunnel, and cold-boot tested.

---

## 8. Risks and Mitigations

### 8.1 Architecture Validation Findings

The following issues were identified during architecture validation and are incorporated into this PRD:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | ARCHITECTURE.md references PostgreSQL, Nginx, 9PM/3AM cron | Must fix | Superseded by this PRD. ARCHITECTURE.md will be updated to match the SQLite/Windows/boot-aware design. |
| 2 | Route push is cron-only, not boot-aware | Must fix | **Resolved:** Boot-time route push added to Phase 3. If PC boots after 5:30 AM, routes are pushed immediately. |
| 3 | Missing .env validation on startup | Must fix | **Resolved:** Phase 3 includes startup validation for BOT_TOKEN, SESSION_SECRET, ADMIN_PASSWORD. |
| 4 | Missing Express error handling middleware | Must fix | **Resolved:** Phase 3 includes centralized error handler and 404 handler. |
| 5 | No rate limiting on admin login | Must fix | **Resolved:** Phase 3 includes in-memory rate limiting on POST /admin/login (5 attempts/minute). |
| 6 | Tailwind CDN dependency (internet required) | Must fix | **Resolved:** Local fallback CSS in `style.css` covers critical layout, sidebar, tables, and badges. Dashboard renders styled without internet. |
| 7 | bcrypt native compilation on Windows | Should fix | **Resolved:** Using bcryptjs (pure JS) instead of bcrypt. |
| 8 | No Helmet security headers | Should fix | **Resolved:** Helmet added to Phase 3 package list. |
| 9 | Token in server logs | Should fix | **Resolved:** Logging middleware sanitizes URLs containing tokens. Documented in code. |
| 10 | Missing errors/404.ejs and errors/500.ejs | Should fix | **Resolved:** Added to Phase 3 view templates. |

### 8.2 Implementation Plan Findings

The following issues were identified during implementation plan review and are incorporated:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Positional `/done N` causes renumbering bug | Medium | **Resolved:** All commands use customer code (`/done C001`), not positional index. |
| 2 | Missing SQLite WAL mode | Medium | **Resolved:** WAL mode enabled in db.js initialization. |
| 3 | No boot-time route push fallback | Low | **Resolved:** Boot-time route push added to Phase 3. |
| 4 | No duplicate-mark detection | Low | **Resolved:** If delivery is already delivered, reply "Already marked delivered at HH:MM" -- no silent overwrite. |
| 5 | Missing ADMIN_TELEGRAM_CHAT_ID | Medium | **Resolved:** Added to .env template. Phase 3 setup includes a /admin-register command or manual config step. |
| 6 | No seed data for delivery boys | Low | **Resolved:** db.js includes INSERT OR IGNORE for 5 seed delivery boys. |
| 7 | Missing session TTL configuration | Low | **Resolved:** Session maxAge set to 4 hours. |
| 8 | No Cloudflare Tunnel phase | Medium | **Resolved:** Phase 4 includes deployment steps for PM2 and Cloudflare Tunnel. |
| 9 | Missing explicit health endpoint | Low | **Resolved:** Health endpoint added to Phase 3 server.js. |

### 8.3 Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PC boots after 5:30 AM, misses route push | Medium | Low | Boot-time route push added as fallback. Boy can still send `/route` manually. |
| Delivery boy marks wrong customer due to positional numbering | Eliminated | -- | Using customer code (`/done C001`) instead of positional index. |
| Duplicate Telegram commands from network retry | Low | Low | Check status before update. Reply "Already marked" if duplicate. |
| SQLite write lock blocks Telegram reads | Low | Low | WAL mode enabled for concurrent read/write. |
| Admin session persists across days | Low | Low | 4-hour session maxAge configured. |
| Tailwind CDN unavailable during delivery window | Medium | Medium | Local fallback CSS covers core layout. Admin dashboard renders styled without CDN. |
| Telegram bot polling stops silently | Low | High | Health endpoint reports polling status. PM2 restarts process on crash. |
| SQLite file corruption | Low | High | Daily fs.copyFileSync backup. 30-day rotation. Worst case: lose 1 day. |
| 5:30 AM route push fails (internet down) | Medium | Medium | Boy sends `/route` manually. Paper backup exists. |
| Admin computer restarts during 5-7 AM | Low | High | PM2 auto-start on Windows login. Worst case: 2-3 minute downtime. |
| Delivery boy sends wrong format command | Medium | Low | Bot replies with error showing correct format. `/help` lists all commands. |
| Customer token link shared to wrong person | Low | Medium | Portal only shows name + delivery status. No PII beyond name. Admin can regenerate token. |
| BOT_TOKEN leaked | Low | Critical | `.env` is gitignored. If leaked: regenerate from BotFather, update .env, restart PM2. |
| Computer runs out of disk space | Low | Medium | Backups auto-clean after 30 days. DB is <1MB. 30 backups <30MB. Negligible. |
| Delivery boy changes phone number | Low | Medium | Re-register with `/start`. Admin updates phone in delivery_boys. |
| Customer token link shared, non-customer accesses portal | Low | Low | Portal only shows name + basic status. No payment/PII data exposed. Token is 64-char unguessable. |

### 8.4 Operational Runbook

**Daily startup (4:30 AM):**
1. Admin boots PC (Windows login)
2. PM2 automatically starts server.js (configured via `pm2 startup`)
3. Server console shows: "[Boot] Generating today's dispatch..." or "[Boot] Dispatch already exists, skipping"
4. Admin opens `http://localhost:3000/admin` -- dashboard shows today's dispatch ready
5. 5:30 AM: Routes pushed to all delivery boys via Telegram (or on boot if after 5:30)
6. 5-7 AM: Delivery boys send commands, dashboard updates in real time
7. 7:30 AM: End-of-route summary sent to admin
8. Admin may shut down PC after delivery window

**Recovery procedures:**
- **Server crash:** PM2 auto-restarts within 2 seconds. Dispatch and backup are idempotent -- no duplicates.
- **Database corruption:** Copy `backup/dharma-farms-YYYY-MM-DD.db` to `data/dharma-farms.db`. Restart server.
- **Bot token compromised:** Regenerate from BotFather, update `.env`, `pm2 restart dharma-farms`.
- **Delivery boy loses phone:** Re-register with `/start` on new phone. Admin updates phone number in dashboard.
- **Customer loses token link:** Admin copies token from customer edit page and resends it.

---

## Appendix A: Document Discrepancies Resolved

The following documents contain stale references from the v1 design (PostgreSQL-based) that should be updated to match this PRD:

| Document | Stale Content | Correct Value |
|----------|--------------|---------------|
| ARCHITECTURE.md | PostgreSQL reference in diagram | SQLite (data/dharma-farms.db) |
| ARCHITECTURE.md | Session stored in PostgreSQL (connect-pg-simple) | Session stored in SQLite (connect-sqlite3) |
| ARCHITECTURE.md | Nginx reverse proxy | Cloudflare Tunnel directly to Express |
| ARCHITECTURE.md | 9PM/3AM cron jobs | Boot-aware scheduling (on server start) |
| ARCHITECTURE.md | "10 production packages" | 9 packages (bcryptjs replaced bcrypt, removed connect-pg-simple) |
| SRD-v2.md | Section 6.1 lists pg, telegraf, helmet, express-rate-limit | Correct packages: express, ejs, better-sqlite3, node-telegram-bot-api, node-cron, express-session, bcryptjs, dotenv, connect-sqlite3 |
| SRD-v2.md | Section 6.4 file structure with src/ directory | Flat structure: server.js, routes/, services/, views/ |
| SRD-v2.md | Section 5: "Daily automated pg_dump" | Daily fs.copyFileSync backup |
| SRD-v2.md | Section 6.3: "Raw pg" as ORM decision | better-sqlite3 (synchronous, single connection) |

This PRD (DHARMA-FARMS-PRD.md) is the single source of truth for all future development work.