# DHARMA FARMS

## Software Requirements Document — v2.0

**Document Type:** Software Requirements Document (SRD)
**Version:** 2.0
**Date:** June 30, 2026
**Status:** Final — Approved
**Classification:** Confidential — Internal Use

> **v2 Changes:** Rewritten from WhatsApp-first architecture to a lean, zero-cost communication
> stack. Telegram bot for delivery operations, web dashboard for admin, customer self-service
> via simple web page. Total monthly infra: ~₹780 (92% below v1 estimate).

---

## 1. EXECUTIVE SUMMARY

Dharma Farms operates a daily milk delivery service (~100 customers, 5 delivery boys).
Current state: manual ledgers, phone calls, and informal WhatsApp — causing operational
inefficiencies, payment gaps, and poor visibility.

**This system solves:** delivery tracking, subscription management, payment recording,
and customer communication — with zero paid APIs, zero app installs for customers,
and a Telegram bot for delivery boys.

### Key Objectives

- Replace manual tracking with digital records
- Real-time delivery status via Telegram bot (DONE/SKIP/ISSUE)
- Subscription pause/resume with automatic day extensions
- Admin dashboard for dispatch, payments, and reports
- Zero app install for customers (browser-based only)
- Total monthly cost under ₹1,000

---

## 2. BUSINESS OVERVIEW

| Parameter | Details |
|-----------|---------|
| Business Name | Dharma Farms |
| Service Model | B2B and B2C Daily Milk Subscription Delivery |
| Customer Base | ~100 active subscribers |
| Delivery Team | 5 delivery boys (region-based) |
| Delivery Window | 5:00 AM — 7:00 AM daily |
| Payment Model | Monthly Prepaid Subscription |
| Target Platform | Telegram (boys) + Web (admin & customers) |

### Current Pain Points

- No centralized customer database
- Manual payment tracking, difficult to identify overdue accounts
- No real-time delivery visibility
- Skip requests handled ad-hoc via phone calls
- No automated customer notifications
- Admin lacks operational dashboard

---

## 3. STAKEHOLDERS & USER ROLES

### 3.1 Admin (Business Owner / Manager)

- Full system access via web dashboard
- Manages customers, subscriptions, payments
- Views live dispatch board and delivery progress
- Receives automated alerts for payment issues and delivery failures
- Generates monthly revenue reports
- Manages delivery boy assignments

### 3.2 Delivery Boy

- Receives daily route list via Telegram bot each morning
- Updates delivery status via simple Telegram commands:
  - `/done C001` — Mark delivered
  - `/skip C001` — Customer not available (+1 day extension)
  - `/issue C001 not home` — Report problem
  - `/arriving C001` — Notify arrival
  - `/finish` — End route, send completion report
- No app installation beyond Telegram
- Receives next customer automatically after each status update

### 3.3 Customer

- Receives delivery confirmations (via SMS/email, opt-in)
- Can pause/resume subscription via simple web page (mobile-friendly)
- Can check subscription balance via web page
- No app installation required — works in any mobile browser
- Access via token link (no login/password needed)

---

## 4. FUNCTIONAL REQUIREMENTS

### 4.1 Customer Management

| ID | Requirement | Priority | Description |
|----|-------------|----------|-------------|
| CM-01 | Unique Customer ID | High | Every customer assigned unique code (C001, C002...) |
| CM-02 | Customer Profile | High | Name, phone, address, region/zone |
| CM-03 | Customer Onboarding | High | Admin adds customer; system sends welcome message |
| CM-04 | Customer Search | Medium | Admin searches by name, phone, or ID |
| CM-05 | Customer Status | High | Active / Paused / Inactive tracking |
| CM-06 | Region Assignment | High | Each customer assigned to a delivery zone and specific boy |

### 4.2 Subscription & Billing

| ID | Requirement | Priority | Description |
|----|-------------|----------|-------------|
| SB-01 | Monthly Prepaid Plans | High | Pay in advance for 30-day subscription cycles |
| SB-02 | Day Extension on Skip | High | Skip a day → subscription extends by +1 day |
| SB-03 | Skip Cutoff Time | High | Skip requests before 5:00 AM for same-day effect |
| SB-04 | Balance Tracking | High | System tracks remaining days in active subscription |
| SB-05 | Payment Recording | High | Admin records cash/UPI payments; system updates ledger |
| SB-06 | Payment Due Alerts | High | Automated notification to admin when renewal is due |
| SB-07 | Subscription History | Medium | Full history of subscriptions, skips, and extensions |

### 4.3 Delivery Operations

| ID | Requirement | Priority | Description |
|----|-------------|----------|-------------|
| DO-01 | Traffic Light Status | High | Green=Delivered, Yellow=Issue, Red=Skipped |
| DO-02 | Daily Route Assignment | High | System auto-assigns customers to boys by region |
| DO-03 | Morning Dispatch | High | Admin receives dispatch summary at 6:00 AM (dashboard) |
| DO-04 | Real-time Status Updates | High | Boys update per customer via Telegram commands |
| DO-05 | Auto Next Customer | Medium | After each update, system replies with next customer |
| DO-06 | Issue Reporting | High | Boys report problems with reason |
| DO-07 | End-of-Route Summary | Medium | Boy sends `/finish` → admin gets completion report |
| DO-08 | Skip Auto-Extension | High | Red status → +1 day subscription extension |

### 4.4 Communication System

**Delivery Boy Commands (Telegram Bot):**

| Command | Action | Status |
|---------|--------|--------|
| `/done C001` | Mark delivered | Green |
| `/skip C001` | Not available, +1 day | Red |
| `/issue C001 reason` | Report problem | Yellow |
| `/arriving C001` | Notify arrival | Yellow |
| `/finish` | End route, summary | — |

**Customer Self-Service (Web Page — v2 of product):**

| Action | How | Details |
|--------|-----|---------|
| PAUSE [N] | Web form | Pause N days, auto-extension |
| PAUSE [date] to [date] | Web form | Date range pause |
| RESUME | Web form | Resume from tomorrow |
| BALANCE | Web page | Check remaining subscription days |
| STATUS | Web page | Check today's delivery status |

> **v1 Note:** Customer self-service web page is deferred to v2 of the product.
> In v1, customers call/text admin for pause/resume (current behavior, unchanged).
> Admin handles these via the dashboard.

**Admin Notifications:**
- Dispatch summary at 6:00 AM (dashboard)
- Real-time delivery completion per boy (dashboard)
- Payment due alerts (dashboard)
- Issue alerts from delivery boys (dashboard + Telegram notification)

### 4.5 Payment Tracking

| ID | Requirement | Priority | Description |
|----|-------------|----------|-------------|
| PT-01 | Payment Recording | High | Admin records each payment with date, amount, mode (Cash/UPI) |
| PT-02 | Customer Ledger | High | Running balance of paid vs. delivered days |
| PT-03 | Due Date Tracking | High | System calculates and alerts when renewal is due |
| PT-04 | Payment History | Medium | Complete payment history per customer |
| PT-05 | Monthly Revenue Report | Medium | Auto-generated monthly collection summary |
| PT-06 | Overdue Alerts | High | Flag customers with expired subscriptions still receiving milk |

---

## 5. NON-FUNCTIONAL REQUIREMENTS

| Category | Requirement | Target |
|----------|-------------|--------|
| Performance | Telegram response time | < 2 seconds |
| Performance | Concurrent users | 5 boys + 100 customers |
| Reliability | Uptime during delivery hours (5-8 AM) | 99% |
| Reliability | Data backup | Daily automated `pg_dump` |
| Usability | Delivery boy training | < 10 minutes |
| Usability | Interface | Telegram + Web dashboard |
| Security | Data protection | Phone numbers and addresses at rest |
| Scalability | Growth ready | Supports 500+ customers without rework |
| Cost | Monthly infra | Under ₹1,000 |

---

## 6. TECHNICAL ARCHITECTURE

### 6.1 Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Backend | Node.js + Express | Fast, lightweight, everyone knows it |
| Templating | EJS | Server-side rendered, zero build step |
| Database | PostgreSQL | Reliable, relational, free |
| Delivery Ops | Telegram Bot API (`telegraf`) | Free, unlimited, polling mode |
| Admin Dashboard | Server-rendered HTML + CSS | No SPA complexity. 3 pages |
| Customer Portal | Single token-based web page | No auth system. Just a link. |
| Hosting | Single VPS (Hetzner CX22 / DigitalOcean) | ~₹750/month, everything on one box |
| Scheduler | `node-cron` | Daily dispatch, backup, reports |
| Process Manager | PM2 | Keeps everything running |

### 6.2 Architecture Overview

```
+------------------+       +------------------+       +------------------+
|  DELIVERY BOYS   |       |   CUSTOMERS      |       |     ADMIN        |
|  (Telegram Bot)  |       |  (Web Browser)   |       |  (Web Dashboard) |
|                  |       |                  |       |                  |
| /done C001       |       | /my-account?     |       | Dispatch board   |
| /skip C002       |       |   token=abc123   |       | Customer mgmt    |
| /issue C003      |       | Pause/Resume     |       | Payments         |
| /arriving C004   |       | Balance check    |       | Reports          |
| /finish          |       | History          |       | CSV export       |
+--------+---------+       +--------+---------+       +--------+---------+
         |                          |                          |
         v                          v                          v
+--------------------------------------------------------------------+
|                   NODE.JS EXPRESS SERVER                            |
|                                                                     |
|  +------------------+   +------------------+   +------------------+ |
|  | Telegram Handler |   | Web Routes       |   | Admin Routes     | |
|  | (telegraf poll)  |   | (EJS templates)  |   | (session-auth)   | |
|  +------------------+   +------------------+   +------------------+ |
|                                                                     |
|  +------------------+   +------------------+   +------------------+ |
|  | Business Logic   |   | Scheduler        |   | Notification     | |
|  | Delivery Svc     |   | (node-cron)      |   | (Email/SMS)      | |
|  | Subscription Svc |   | Dispatch gen     |   |                  | |
|  | Payment Svc      |   | Backup           |   |                  | |
|  +------------------+   +------------------+   +------------------+ |
|                                                                     |
|  +---------------------------------------------------------------+  |
|  | PostgreSQL (5 tables)                                          |  |
|  | customers | delivery_boys | subscriptions | deliveries | payments| |
|  +---------------------------------------------------------------+  |
+--------------------------------------------------------------------+
```

### 6.3 Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| SSR over SPA | EJS templating | 3 admin pages don't need React. Zero build step. |
| Polling over Webhook | Telegram long-poll | Works behind NAT. No SSL cert needed. Auto-recovers. |
| No ORM | Raw `pg` | 5 simple tables. ORM adds complexity, not value. |
| No TypeScript | Plain JS | 5-person team. TS is overhead at this scale. |
| Single VPS | No Docker/K8s | One box. PM2. That's it. |

### 6.4 File Structure

```
dharma-farms/
├── .env
├── package.json
├── src/
│   ├── index.js              # Express + Telegram bot bootstrap
│   ├── config.js             # Env config loader
│   ├── db/
│   │   ├── pool.js           # PG connection pool
│   │   └── schema.sql        # DDL (5 tables)
│   ├── telegram/
│   │   ├── bot.js            # Telegraf bot setup (polling)
│   │   ├── delivery.js       # /done, /skip, /issue, /arriving, /finish
│   │   └── admin.js          # Admin alerts to Telegram group
│   ├── routes/
│   │   ├── admin.js          # Dashboard pages (EJS rendered)
│   │   ├── customer.js       # Customer self-service page
│   │   └── api.js            # REST endpoints for dashboard
│   ├── services/
│   │   ├── delivery.js       # Delivery CRUD
│   │   ├── subscription.js   # Pause/resume, extension logic
│   │   └── payment.js        # Payment recording, due alerts
│   ├── scheduler/
│   │   └── cron.js           # 5:30AM dispatch, 6AM summary, daily backup
│   └── views/                # EJS templates
│       ├── layout.ejs
│       ├── dispatch.ejs
│       ├── customers.ejs
│       ├── payments.ejs
│       └── reports.ejs
└── scripts/
    └── backup.sh             # pg_dump to S3/backup dir
```

---

## 7. DATA MODEL

### Core Entities

**CUSTOMER**
```
customer_id (PK), name, phone, address, region_id,
status (active|paused|inactive), created_at,
telegram_chat_id (nullable), email (nullable)
```

**DELIVERY_BOY**
```
boy_id (PK), name, phone, region_id,
telegram_chat_id (unique), telegram_username,
status (active|inactive)
```

**SUBSCRIPTION**
```
sub_id (PK), customer_id (FK), start_date, end_date,
total_days, remaining_days, status (active|paused|expired)
```

**DELIVERY**
```
delivery_id (PK), customer_id (FK), delivery_date,
status (green|yellow|red), delivery_boy_id (FK),
issue_reason, timestamp
```

**PAYMENT**
```
payment_id (PK), customer_id (FK), amount,
payment_date, mode (cash|upi), subscription_id (FK)
```

---

## 8. KEY WORKFLOWS

### 8.1 Daily Delivery Workflow

1. **5:30 AM** — System generates daily delivery list per region
2. **6:00 AM** — Admin sees dispatch summary on dashboard
3. **6:00 AM** — Each delivery boy receives route via Telegram bot
4. **6:15 AM** — Boys begin routes
5. **Per Customer:**
   - `/done C001` → Log Green → Confirm boy + notify customer
   - `/skip C001` → Log Red → Extend subscription +1 day → Notify customer
   - `/issue C001 reason` → Log Yellow → Alert admin immediately
6. **Route End:** Boy sends `/finish` → Admin gets completion report
7. **8:00 AM** — Daily report generated

### 8.2 Customer Pause Workflow (v2 of product)

1. Customer visits web page via token link
2. Submits "Pause for 3 days" form
3. System validates cutoff time → Processes request
4. Updates subscription: `remaining_days + 3`, status = PAUSED
5. Confirmation shown on page
6. Delivery route auto-excludes customer for paused days

---

## 9. IMPLEMENTATION ROADMAP

### Sprint 1: Foundation (Week 1)

| Day | Deliverable |
|-----|-------------|
| 1 | Server + PostgreSQL setup. Schema created. |
| 2 | Telegram bot online. `/start` route. Admin Telegram group. |
| 3 | Delivery commands: `/done`, `/skip`, `/issue`, `/arriving`, `/finish` |
| 4 | Subscription engine: day extension on skip, cutoff validation |
| 5 | Admin dashboard: dispatch view, customer list |

**Verify:** 5/5 boys can run `/done C001` and see it reflect on admin dashboard.

### Sprint 2: Core Features (Week 2)

| Day | Deliverable |
|-----|-------------|
| 1 | Payment recording + ledger. Due date tracking. |
| 2 | Admin reports page + CSV export |
| 3 | Scheduler: morning dispatch gen, daily backup |
| 4 | Customer self-service web page (v2 prep) |
| 5 | Testing with 2 delivery boys. Bug fixes. |

**Verify:** Admin can record a payment, see it on ledger, export report.

### Sprint 3: Launch (Week 3)

| Day | Deliverable |
|-----|-------------|
| 1 | Full UAT with all 5 delivery boys |
| 2 | Customer onboarding (data migration from ledgers) |
| 3 | Live pilot — paper backup parallel run |
| 4 | Go-live. Paper backup retired. |
| 5 | Monitoring + bug fixes |

**Verify:** All 5 boys using bot daily. 100% delivery status coverage.

**Total: 3 weeks to MVP** (vs 10 weeks in v1 SRD)

---

## 10. BUDGET & COST

### One-Time Setup

| Item | Cost (INR) |
|------|-----------|
| Development (3 weeks) | Owner's own time / internal |
| Domain (.in, 1 year) | ₹800 |
| DLT registration (if SMS needed) | ₹0 (deferred) |
| **Total Setup** | **₹800** |

### Monthly Recurring

| Item | Cost (INR) |
|------|-----------|
| VPS (Hetzner CX22) | ₹750 |
| Domain (amortized) | ₹67 |
| SSL (Let's Encrypt) | ₹0 |
| Telegram API | ₹0 |
| Database (self-hosted) | ₹0 |
| SMS (if used, 100 msgs/mo) | ₹0-150 |
| **Total Monthly** | **~₹817-967** |

**vs v1 SRD estimate: ₹8,800-17,100/month — 92% reduction**

---

## 11. RISK ASSESSMENT

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Delivery Boy Adoption | High | Medium | 10-min training. Ride-along week 1. |
| Internet Connectivity | Medium | High | Telegram queues offline msgs 24h. Phone call fallback. |
| Data Loss | High | Low | Daily `pg_dump`. Cloud backup. |
| Scope Creep | Medium | High | Strict MVP focus. Customer portal = v2. |
| Customer Resistance | Low | Medium | No change to customer experience in v1. |
| Payment Tracking Error | High | Medium | Double-entry: admin records, system confirms. |
| Server Downtime | High | Low | PM2 auto-restart. Monitoring alerts. |

---

## 12. APPENDICES

### Appendix A: Sample Messages

**Telegram Bot — Route Start:**
```
🌅 Good morning Raju!
Today's route: 12 customers
Region: North

1. C001 — Ravi Sharma, 42 Lotus St (2L)
2. C002 — Priya Singh, 15 MG Rd (1L)
3. C003 — Amit Patel, 8B Lake View (2L)

Reply /done C001 when delivered
Reply /skip C001 if unavailable
Reply /issue C001 <reason> for problems
```

**Telegram Bot — Delivery Confirmation:**
```
✅ C001 delivered at 6:47 AM
Next: C002 — Priya Singh, 15 MG Rd
```

**Admin Dashboard — Dispatch Summary:**
```
📋 Today's Dispatch | June 30, 2026
Raju (North): 12 customers
Vijay (South): 10 customers
Priya (East): 8 customers
Total active: 30/35 | Paused: 3 | Inactive: 2
```

### Appendix B: npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | 4.21.x | Web server |
| `pg` | 8.13.x | PostgreSQL client |
| `telegraf` | 4.16.x | Telegram bot |
| `node-cron` | 3.0.x | Scheduler |
| `ejs` | 3.1.x | Template engine |
| `express-session` | 1.18.x | Admin auth sessions |
| `dotenv` | 16.4.x | Env config |
| `helmet` | 8.0.x | Security headers |
| `express-rate-limit` | 7.4.x | Rate limiting |

**Total: 9 packages. No TypeScript. No ORM. No build step.**

### Appendix C: Glossary

| Term | Definition |
|------|-----------|
| MVP | Minimum Viable Product — simplest version that delivers core value |
| Webhook | Automated message from one system to another on event |
| API | Application Programming Interface |
| UAT | User Acceptance Testing — final testing with real users |
| Telegraf | Node.js framework for Telegram Bot API |
| EJS | Embedded JavaScript — server-side HTML templating |

---

> **v2 was simplified from v1 by:**
> - Replacing WhatsApp Business API with Telegram bot (saves ₹1,500-3,000/month)
> - Cutting customer self-service from v1 (deferred to v2 of the product)
> - Using server-rendered EJS instead of React (zero build step)
> - Skipping TypeScript, ORM, Docker — plain Node.js + PostgreSQL
> - Reducing timeline from 10 weeks to 3 weeks
> - Cutting monthly infra from ₹8,800-17,100 to ~₹800
>
> **The result:** A system that's cheaper, faster to build, and easier to maintain
> than the original plan — while still solving the core problem.

---