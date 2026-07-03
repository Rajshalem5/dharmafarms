# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Dharma Farms

Daily milk delivery operations system — ~100 customers, 5 delivery boys, 5-7 AM window, monthly prepaid. Delivery boys use a Telegram bot. Admin and customers use browser-based web pages. No app installs, no paid APIs.

**Current state:** Pre-implementation — specification and architecture documents only. No source code has been written yet.

## Architecture Docs (read these first)

- `ARCHITECTURE.md` — Complete architecture with ADRs (why Telegram over WhatsApp, SSR over SPA, raw pg over ORM, etc.), database schema, data flows, file structure, deployment plan, risk mitigations
- `DHARMA-FARMS-SRD-v2.md` — Final approved Software Requirements Document (v2, Telegram-based)
- `DOC-20260628-WA0000..md` — v1 SRD (WhatsApp-first, draft — historical reference only)
- `gan-harness/spec.md` — Product spec for GAN-based development harness
- `gan-harness/eval-rubric.md` — Evaluation rubric for the GAN harness

## Planned Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+ — Express 4.x |
| Database | SQLite via better-sqlite3 — single file, zero config |
| Templates | EJS — server-side rendered HTML |
| Telegram | node-telegram-bot-api — polling mode |
| Scheduling | node-cron |
| Styling | Tailwind CSS v4 via CDN (no build step) |
| Auth | express-session + bcrypt (admin), crypto.randomBytes token (customer) |
| Process mgmt | PM2 |
| Tunnel | Cloudflare Tunnel (cloudflared) — expose customer portal only |

**No TypeScript. No React. No build step. No Docker. No ORM. No VPS.**

## Planned File Structure

```
dharma-farms/
├── package.json              # 10 prod deps, 0 devDeps
├── .env                      # BOT_TOKEN, SESSION_SECRET, ADMIN_PASSWORD, PORT
├── server.js                 # Entry: Express init, routes, cron, Telegram poll
├── db.js                     # SQLite init + schema creation (better-sqlite3)
├── routes/
│   ├── admin.js              # GET/POST for admin dashboard
│   ├── customer.js           # GET/POST for customer self-service
│   └── telegram.js           # Telegram command handlers
├── services/
│   ├── dispatch.js           # Generate daily deliveries
│   ├── subscription.js       # Pause/resume/balance logic
│   └── telegram.js           # Format + send Telegram messages
├── views/
│   ├── admin/
│   │   ├── layout.ejs        # Admin HTML shell
│   │   ├── dashboard.ejs     # Today's overview
│   │   ├── customers.ejs     # Customer list + add/edit
│   │   ├── dispatch.ejs      # Today's delivery board
│   │   ├── payments.ejs      # Payment recording + ledger
│   │   └── reports.ejs       # Reports + CSV export
│   ├── customer/
│   │   └── portal.ejs        # Self-service page
│   └── login.ejs             # Admin login page
├── public/
│   └── css/
│       └── style.css         # ~50 lines of overrides for Tailwind
└── data/
    └── dharma-farms.db       # SQLite database file (auto-created, gitignored)
```

## Planned npm Packages (10 production, 0 build tools)

express, ejs, better-sqlite3, node-telegram-bot-api, node-cron, express-session, bcrypt, dotenv, connect-sqlite3

## Database: 5 Tables

- **customers** — Core entity (name, phone, address, rate, delivery_boy_id, status, token)
- **delivery_boys** — Staff info (name, phone, telegram_chat_id, region, status)
- **subscriptions** — One active at a time, history preserved (start/end date, total/remaining days, status, paused_until)
- **deliveries** — One row per customer per day (status: pending/delivered/skipped/issue/arriving, unique on customer_id + delivery_date)
- **payments** — Append-only ledger (amount in paise, mode: cash/upi/bank_transfer)

## Plan Files

All implementation plans MUST be saved to `.claude/plans/` — never to the project root. This includes `.claude/plans/plan-post-test-fixes.md`, `.claude/plans/plan-phase2.md`, `.claude/plans/plan-delivery-boys.md`, `.claude/plans/plan-backup.md`, `.claude/plans/plan-scheduler.md`, `.claude/plans/plan-security.md`, and any future plans.

## Key Architecture Decisions (from ARCHITECTURE.md)

- **Telegram over WhatsApp Business API** — saves ₹18,000-36,000/year
- **SSR (EJS) over SPA (React)** — zero build step, one code path for 3 pages
- **SQLite over PostgreSQL** — single file, zero install, no server process. Backup = copy the file
- **Cloudflare Tunnel over VPS** — runs on admin's Windows computer. No monthly bill. Tunnel exposes only customer portal
- **Polling over webhook** — works behind NAT, no SSL needed for Telegram, auto-recovers
- **Raw SQL over ORM** — 5 tables, simple queries via better-sqlite3
- **No TypeScript** — < 500 lines of backend logic, marginal benefit
- **Sessions in SQLite** — no need for Redis at this scale

## Operations

### Daily routine: Admin boots PC before 5 AM
```
PC boots → PM2 starts server.js automatically
         → Dispatch auto-generates for today (idempotent)
         → SQLite backup auto-creates (once per day)
         → Telegram polling starts
         → 5:30 AM: routes pushed to delivery boys
         → 5-7 AM: /done, /skip, /issue commands processed
         → 7:30 AM: end-of-route summary
         → Admin can shut down PC after delivery
```

### Commands

```bash
# Start development server
npm start

# Run with PM2 (production)
pm2 start server.js
pm2 save                     # auto-start on Windows login
pm2 startup                  # configure PM2 to launch on boot

# Backup SQLite database (done automatically on boot, or manually)
copy data\dharma-farms.db backup\dharma-farms-YYYY-MM-DD.db

# Restore SQLite database
copy backup\dharma-farms-2026-07-01.db data\dharma-farms.db
```

## Key Data Flows

1. **Delivery boy flow:** Telegram bot (polling) → `/done`/`/skip`/`/issue` commands → server updates deliveries table → admin dashboard reflects in real-time
2. **Customer flow:** Browser → token-based page → pause/resume → updates subscription → dispatch excludes/includes
3. **Admin flow:** Browser → session-auth dashboard → manage customers, payments, view dispatch board, issue tracking, reports
4. **Scheduled jobs (node-cron):** 9PM dispatch generation, 5AM delivery route push, 3AM daily DB backup

## Risks & Mitigations (from ARCHITECTURE.md)

- **Admin forgets to boot PC** → delivery boys use paper backup (existing manual process). System resumes when PC boots next
- **Admin boots PC late (after 5:30 AM)** → dispatch auto-generates on boot whenever it happens. Idempotent — won't duplicate
- **Admin boots PC multiple times in one day** → dispatch and backup both check idempotency before running
- **PC crash during 5-7 AM** → PM2 auto-restarts. If restart takes >10s, delivery boys use phone fallback
- **Telegram blocked** → phone call fallback (existing behavior)
- **DB corruption** → daily `.db` backup on boot, worst case lose 1 day
- **No internet** → Telegram bot won't poll, admin dashboard works locally, delivery boys use phone fallback
- **Customer token compromised** → regenerate from admin panel