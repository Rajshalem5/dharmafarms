# Dharma Farms - Architecture

## Context

~100 customers, 5 delivery boys, daily 5-7 AM milk delivery, monthly prepaid.
Budget: tight. No paid APIs. Must work on basic Indian internet.

## Key Architectural Decisions

### ADR-001: Telegram + Web over WhatsApp Business API

**WhatsApp Business API costs Rs 1,500-3,000/month for this volume.**
Telegram bot (delivery boys) + browser web app (customers) = zero per-message cost.

- Delivery boys: Telegram bot (free, install once). Telegram works well on 2G/3G.
- Customers: Mobile browser web app. No install. Shared via SMS or printed on invoice.
- Admin: Browser web dashboard. Same app, same server.

**Cost eliminated:** Rs 18,000-36,000/year.

### ADR-002: Server-Side Rendering over SPA

React + API server = build step, state management, API contracts, error handling at two layers.
EJS + Express = one code path, zero build, deploy instantly.

For 3 pages (admin dashboard, customer portal, login) with < 10 total views, a frontend framework is
pure ceremony. Server-rendered HTML with Tailwind CDN ships in < 10 KB over the wire.

### ADR-003: SQLite over PostgreSQL

5 tables, 100 customers, ~300 deliveries/day. SQLite handles this with zero tuning and zero
server process. Running PostgreSQL on Windows means installing, configuring, and managing a
database server — SQLite is a single `.db` file in the project folder.

Backup: copy the file. Restore: paste it back. No `pg_dump`, no `psql`, no schema restore.

### ADR-004: Cloudflare Tunnel over Public IP / VPS

Running on the admin's home computer means no static IP and no port forwarding.
Cloudflare Tunnel (`cloudflared`) creates an outbound-only tunnel to expose the customer
self-service portal. The admin dashboard stays on `localhost` only.

Zero open ports on the home network. Free SSL. No VPS cost.

### ADR-005: Telegram Bot Polling over Webhook

Webhooks need a public HTTPS endpoint with a valid certificate. Polling (getUpdates loop) works
immediately behind NAT, survives brief internet drops, and auto-recovers. At 5 delivery boys sending
~50 messages/day total, polling adds negligible overhead.

---

## 1. Tech Stack

```
Backend:          Node.js 20+ — Express 4.x
Database:         SQLite via better-sqlite3 — single file, zero config
Templates:        EJS — server-side rendered HTML
Telegram:         node-telegram-bot-api — polling mode (not webhook)
Scheduling:       node-cron — daily dispatch, backup, reports
Styling:          Tailwind CSS v4 via CDN — no build step
Auth:             express-session + bcrypt (admin)
                  crypto.randomBytes token (customer self-service)
Process mgmt:     PM2 — keeps the app running, restarts on crash
Tunnel:           Cloudflare Tunnel (cloudflared) — expose customer portal
```

### npm packages (exact count: 10 production, 0 build tools)

```
express, ejs, better-sqlite3, node-telegram-bot-api, node-cron,
express-session, bcrypt, dotenv, connect-sqlite3
```

No TypeScript. No React. No build step. No Docker. No ORM.

---

## 2. Database Schema

### Entity-Relationship (text diagram)

```
customers 1---* subscriptions 1---* deliveries
customers 1---* payments
delivery_boys 1---* deliveries
customers *---1 delivery_boys (assigned_to)
```

### Tables

**customers** — the core entity
```sql
CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(10) UNIQUE NOT NULL,       -- C001, C002...
  name          VARCHAR(100) NOT NULL,
  phone         VARCHAR(15) NOT NULL,
  address       TEXT NOT NULL,
  delivery_boy_id INTEGER REFERENCES delivery_boys(id),
  monthly_rate  INTEGER NOT NULL,                  -- in paise (Rs 1000 = 100000)
  status        VARCHAR(20) DEFAULT 'active',      -- active | paused | inactive
  token         VARCHAR(64) UNIQUE,                -- self-service access token
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

**delivery_boys** — simple, flat
```sql
CREATE TABLE delivery_boys (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  phone           VARCHAR(15) NOT NULL,
  telegram_chat_id BIGINT UNIQUE,                  -- set on /start
  region          VARCHAR(50),                      -- North, South, etc.
  status          VARCHAR(20) DEFAULT 'active'
);
```

**subscriptions** — one active at a time, history preserved
```sql
CREATE TABLE subscriptions (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  start_date      DATE NOT NULL,
  end_date        DATE,                              -- NULL = active
  total_days      INTEGER NOT NULL DEFAULT 30,
  remaining_days  INTEGER NOT NULL DEFAULT 30,
  status          VARCHAR(20) DEFAULT 'active',      -- active | paused | expired
  paused_until    DATE,                              -- NULL when not paused
  created_at      TIMESTAMP DEFAULT NOW()
);
```

**deliveries** — one row per customer per day
```sql
CREATE TABLE deliveries (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  delivery_boy_id INTEGER NOT NULL REFERENCES delivery_boys(id),
  delivery_date   DATE NOT NULL,
  status          VARCHAR(20) DEFAULT 'pending',     -- pending | delivered | skipped | issue | arriving
  issue_reason    TEXT,
  marked_at       TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(customer_id, delivery_date)
);
```

**payments** — append-only ledger
```sql
CREATE TABLE payments (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  amount          INTEGER NOT NULL,                  -- in paise
  mode            VARCHAR(20) NOT NULL,              -- cash | upi | bank_transfer
  payment_date    DATE NOT NULL,
  notes           TEXT,
  recorded_by     VARCHAR(100),                      -- admin name
  created_at      TIMESTAMP DEFAULT NOW()
);
```

### Indexes
```sql
CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
```

---

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                              │
└──────┬──────────────┬──────────────────┬────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌──────────┐  ┌──────────────┐  ┌───────────────┐
│ Telegram │  │ Mobile/      │  │ Admin         │
│ (Delivery│  │ Desktop      │  │ Browser       │
│  Boys)   │  │ Browser      │  │               │
│          │  │ (Customers)  │  │               │
└────┬─────┘  └──────┬───────┘  └──────┬────────┘
     │               │                  │
     │   ┌───────────┴──────────────────┴───────┐
     │   │           Nginx (port 443)            │
     │   │   TLS termination, reverse proxy      │
     │   └───────────┬───────────────────────────┘
     │               │
     ▼               ▼
┌──────────────────────────────────────────────┐
│           Node.js + Express                   │
│                                               │
│  /tg-webhook  ← Telegram polling loop         │
│  /admin/*     ← Admin dashboard (EJS)         │
│  /my-account  ← Customer portal (EJS)         │
│  /api/*       ← JSON endpoints (minimal)      │
│                                               │
│  node-cron:                                   │
│    - 9PM: generate next day's dispatch        │
│    - 5AM: send delivery boy routes            │
│    - 3AM: daily DB backup                     │
└──────────────┬────────────────────────────────┘
               │
               ▼
┌──────────────────────────────┐
│    PostgreSQL (same VPS)     │
│                              │
│  customers                   │
│  delivery_boys               │
│  subscriptions               │
│  deliveries                  │
│  payments                    │
└──────────────────────────────┘
```

---

## 4. Data Flows

### 4.1 Delivery Boy Flow (Telegram Bot)

```
[4:55 AM] node-cron: send route to each delivery boy via Telegram
          → "Today's route: 12 customers.
             1. C001 - Ravi Sharma - 42 Lotus St - Buffalo 2L
             2. C002 - Sita Patel - 15 Mango Ln - Cow 1L
             ...
             Reply: /done N, /skip N, /issue N <reason>"

[5:00 AM] Delivery boy starts route
          → /arriving 3  →  Bot: "Noted. C003 - Priya Singh"
          → /done 1      →  Bot: "C001 ✓ Delivered. Next: C002 - Sita Patel"
          → /skip 4      →  Bot: "C004 ✗ Skipped (+1 day added). Next: C005"
          → /issue 6 gate dog
                         →  Bot: "C006 ⚠ Issue recorded: gate dog"
                         →  Admin sees yellow alert on dashboard

[7:00 AM] → /finish     →  Bot: "Route complete. 9 delivered, 2 skipped, 1 issue"
                         →  Admin dashboard updates completion stats
```

**Polling loop on server:** Every 1 second, `bot.polling()` picks up new messages.
No webhook, no public endpoint needed for Telegram.

### 4.2 Customer Flow (Browser Web App)

```
Admin creates customer → generates random 64-char hex token
Token printed on invoice or sent via SMS: "Manage your account: dharma-farms.in/my-account?t=<token>"

[Customer opens link]
  → GET /my-account?t=abc123
  → Server verifies token, loads customer data
  → Renders EJS template with:
      - Name, plan summary
      - Today's delivery status (pending/delivered/skipped)
      - Remaining days on subscription
      - Pause controls (date picker + submit)
      - Resume button (if currently paused)

[Customer pauses]
  → POST /my-account/pause  with: token, start_date, end_date
  → Server validates, updates subscription (paused_until, add remaining_days)
  → Re-renders page with confirmation: "Paused Apr 5-10. Resume Apr 11."

[Customer resumes]
  → POST /my-account/resume with: token
  → Server clears paused_until
  → Shows confirmation

[Customer checks balance]
  → Same page shows remaining_days at top
  → No separate endpoint needed
```

**No login. No password. No OTP.** Token-based access is sufficient for this threat model
(sensitive action = pausing milk delivery). Token is 64 hex chars — unguessable.

### 4.3 Admin Flow (Browser Dashboard)

```
[Admin logs in]
  → GET /admin/login  → POST /admin/login (password + session)
  → Session stored in PostgreSQL (connect-pg-simple)

[Dashboard — GET /admin]
  → Today's progress: X/Y delivered, Z skipped, N issues
  → Active customers count, pending payments sum
  → Recent issues from delivery boys
  → All server-rendered in one page

[Customers — GET /admin/customers]
  → Table: code, name, phone, address, delivery boy, rate, status, balance
  → Search by name/phone/code
  → Add customer form, edit inline

[Payments — GET /admin/payments]
  → Record payment: select customer, enter amount, mode, date
  → Per-customer ledger view

[Daily Dispatch — GET /admin/dispatch]
  → Shows today's deliveries grouped by delivery boy
  → Red/green/amber status indicators
  → "Generate Dispatch" button (or auto-generated by cron)

[Reports — GET /admin/reports]
  → Monthly collection summary
  → Delivery success rate
  → Overdue accounts
  → CSV export button
```

---

## 5. File Structure

```
dharma-farms/
├── package.json               # 10 dependencies, no devDependencies
├── .env                       # BOT_TOKEN, SESSION_SECRET, ADMIN_PASSWORD, PORT
├── server.js                  # Entry: Express init, routes, cron, Telegram poll
├── db.js                      # SQLite init + schema creation (better-sqlite3)
│
├── routes/
│   ├── admin.js               # GET/POST for admin dashboard
│   ├── customer.js            # GET/POST for customer self-service
│   └── telegram.js            # Telegram command handlers
│
├── services/
│   ├── dispatch.js            # Generate daily deliveries
│   ├── subscription.js        # Pause/resume/balance logic
│   └── telegram.js            # Format + send Telegram messages
│
├── views/
│   ├── admin/
│   │   ├── layout.ejs         # Admin HTML shell (nav, header, scripts)
│   │   ├── dashboard.ejs      # Today's overview
│   │   ├── customers.ejs      # Customer list + add/edit
│   │   ├── dispatch.ejs       # Today's delivery board
│   │   ├── payments.ejs       # Payment recording + ledger
│   │   └── reports.ejs        # Reports + CSV export
│   ├── customer/
│   │   └── portal.ejs         # Self-service page
│   └── login.ejs              # Admin login page
│
├── public/
│   └── css/
│       └── style.css          # ~50 lines of overrides for Tailwind
│
└── data/
    └── dharma-farms.db        # SQLite database file (auto-created, gitignored)
```

16 files at launch. Not 50, not 5.

---

## 6. Data Model Summary (4 tables + 1 reference)

| Table | Purpose | Rows/month | Notes |
|-------|---------|-----------|-------|
| customers | Core customer info | 100 total | ~100 rows, ever |
| delivery_boys | Staff info | 5 total | ~5 rows, ever |
| subscriptions | Plan tracking | ~10 new | One per customer per cycle |
| deliveries | Daily tracking | ~3,000 | 100 x 30 days |
| payments | Financial ledger | ~100 | Monthly payments |

The deliveries table is the only one that grows. At 100 customers x 365 days = 36,500 rows/year.
SQLite handles millions of rows on a Raspberry Pi. No indexing tuning needed for years.

---

## 7. Deployment

### Admin's Windows Computer (no VPS needed)

```
Usage:          Admin boots PC before 5 AM for delivery window
                Server auto-starts on boot via PM2 (pm2 startup)
Setup steps:    Install Node.js 20+ LTS from nodejs.org
                git clone, npm install
                pm2 start server.js      # Express + Telegram polling
                pm2 startup              # configure auto-start on Windows login
```

### Startup Order (~4:30 AM)

```
Admin boots PC
  → PM2 launches server.js automatically
  → Express starts, Telegram polling begins
  → Server checks: "Are today's deliveries generated?"
    → No  → generateDispatch() creates rows for all active customers
    → Yes → skip (idempotent)
  → Server checks: "Is there already a backup for today?"
    → No  → backupDatabase() copies .db file to backup/
    → Yes → skip (idempotent)
  → Admin opens http://localhost:3000/admin → sees today's dispatch ready
  → Delivery boys send /route on Telegram → get their lists
  → 5:30 AM: Cron pushes routes proactively to all delivery boys
  → 5-7 AM: Delivery boys send /done, /skip, /issue → server updates DB
  → Admin can shut down PC after delivery window
```

### Why this works

- Node.js + Express is single-process. A 5-year-old laptop handles 5 concurrent requests easily.
- SQLite is a single file in `data/`. No install, no config, no server process.
- PM2 auto-restarts on crash. Configured to launch on Windows login (`pm2 startup`).
- All scheduling is boot-aware: dispatch and backup run on first start of the day, not at fixed night-time hours.
- Backup: `backupDatabase()` on server boot copies `.db` to `backup/`. 30-day rotation.
- Restore: copy the `.db` file back into `data/`. Done.

### Monthly cost breakdown

| Item | Cost (INR) |
|------|-----------|
| VPS | 0 (runs on admin's computer) |
| Domain (.in) amortized | ~30 (optional — only needed for customer portal) |
| Cloudflare Tunnel | 0 (free tier) |
| Telegram API | 0 |
| SMS for initial token delivery | 0 (print on invoice instead) |
| **Total** | **~30/month** (or 0 if no domain needed) |

vs SRD v1 estimate of Rs 8,800-17,100/month. Savings: ~99.7%.

---

## 8. Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Telegram blocked/unreliable | SMS fallback via Twilio-like service IF budget allows. Otherwise, delivery boys call admin directly (existing fallback) |
| Admin computer goes down during 5-7 AM | PM2 auto-restarts. Worst case: delivery boys use paper backup (they already have ledgers). If critical, run on a Raspberry Pi 4 instead |
| Admin computer restarts for updates | PM2 configured to auto-start on login (`pm2 startup`). Windows Task Scheduler launches PM2 on boot |
| Delivery boy loses phone | Re-register Telegram bot with `/start`. Route list re-sent. No data loss |
| Customer token compromised | Regenerate token from admin panel. Old token invalidated on next use |
| DB corruption | Daily `.db` file copy to `backup/` folder. Worst case: lose 1 day of delivery records |
| No internet at admin's home | Telegram bot won't poll. Admin dashboard still works locally. Delivery boys use phone fallback. Service resumes when internet returns |

---

## 9. Why Not...

| Alternative | Rejected because |
|-------------|-----------------|
| WhatsApp Business API | Rs 1,500-3,000/month for ~3000 conversations. No budget |
| React/Angular/Vue | Build step, NPM audit noise, 50+ dependencies, for 3 pages. EJS works |
| Docker/Kubernetes | 100 customers do not need container orchestration. One Node process is enough |
| PostgreSQL | Requires a server process, Windows install, config. SQLite is a single file with zero setup |
| Managed PostgreSQL | Rs 1,000/month extra. SQLite is free and runs locally |
| TypeScript | Compile step, type definitions for 5 tables, marginal benefit for < 500 lines of backend logic |
| ORM (Prisma/TypeORM) | 5 tables, simple queries. Raw SQL via better-sqlite3 is clearer and has zero dependencies |
| Redis | Session store in SQLite (connect-sqlite3). No need for a second data store |
| Queue system (Bull/Bee) | 5 delivery boys sending ~50 messages/day. Synchronous processing is fine |
| WebSocket/Socket.io | Admin dashboard polls every 30s via `setInterval(fetch, 30000)`. Good enough |
| VPS hosting | Admin's computer is always on during delivery hours (5-7 AM). No monthly bill |