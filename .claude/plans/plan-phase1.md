# Dharma Farms — Phase 1 Implementation Plan

**Date:** July 1, 2026
**Source of truth:** DHARMA-FARMS-PRD.md

---

## What Phase 1 Covers

Phase 1 is the **core delivery loop** — 14 features from the PRD Must-Have list (F-01 through F-14):

| Feature | Description |
|---------|-------------|
| F-01 | Customer database (admin CRUD) |
| F-02 | Subscription tracking (one active subscription per customer) |
| F-03 | Dispatch generation (one-click, idempotent) |
| F-04 | Telegram bot registration via `/start` |
| F-05 | Route display via `/route` |
| F-06 | Mark delivered via `/done C001` |
| F-07 | Mark skipped via `/skip C001` (extends subscription +1 day) |
| F-08 | Report issue via `/issue C001 <reason>` |
| F-09 | Arriving notification via `/arriving C001` |
| F-10 | End-of-route summary via `/finish` |
| F-11 | Admin dashboard with live counts |
| F-12 | Duplicate command detection (no silent overwrites) |
| F-13 | Admin authentication (bcryptjs + sessions) |
| F-14 | SQLite with WAL mode, migration tracking, seed data |

**Out of scope for Phase 1:** Payments, scheduling (node-cron), customer portal, reports, CSV export, Cloudflare Tunnel.

---

## Total Files: 14

```
dharma-farms/
├── package.json
├── .env
├── server.js
├── db.js
├── routes/
│   ├── admin.js
│   └── telegram.js
├── services/
│   ├── dispatch.js
│   └── telegram.js
├── views/
│   ├── login.ejs
│   └── admin/
│       ├── layout.ejs
│       ├── dashboard.ejs
│       ├── customers.ejs
│       └── dispatch.ejs
└── public/
    └── css/
        └── style.css
```

No `data/` or `backup/` directories needed — they are created at runtime and gitignored.

---

## Step-by-Step File Specifications

### Step 1: `package.json` (~25 lines)

**Dependencies:** none (foundation file)
**Risk:** Low

Contents:
- `name: "dharma-farms"`, `version: "1.0.0"`, `private: true`
- `main: "server.js"`
- Scripts: `"start": "node server.js"`, `"dev": "node --watch server.js"`
- 9 production dependencies: express ^4.21, ejs ^3.1, better-sqlite3 ^11.x, node-telegram-bot-api ^0.66, node-cron ^3.0, express-session ^1.18, bcryptjs ^2.4, dotenv ^16.4, connect-sqlite3 ^0.9.x
- `engines: { node: ">=20.0.0" }`

**Note:** node-cron is installed in Phase 1 for future use but not wired up yet.

---

### Step 2: `.env` (~5 lines)

**Dependencies:** none
**Risk:** Low (must gitignore)

```
BOT_TOKEN=your_telegram_bot_token_here
SESSION_SECRET=generate_a_random_64_char_hex_string
ADMIN_PASSWORD=change_this_password
PORT=3000
```

---

### Step 3: `db.js` (~150 lines)

**Dependencies:** better-sqlite3 from package.json
**Risk:** Low

**Exports:**
- `getDb()` — returns singleton better-sqlite3 instance
- `initializeDatabase()` — opens DB, WAL mode, migrations, seed data

**`initializeDatabase()` logic:**
1. `fs.mkdirSync('data/', { recursive: true })`
2. `new Database('data/dharma-farms.db')`
3. `db.pragma('journal_mode = WAL')`
4. `db.pragma('foreign_keys = ON')`
5. Create `_migrations` table: `(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT DEFAULT (datetime('now')))`
6. `SELECT COALESCE(MAX(version), 0) FROM _migrations` — determine current version
7. If version < 1, apply migration v1 with all 5 tables + indexes
8. Seed 5 delivery boys via INSERT OR IGNORE
9. Return the `db` instance

**Migration v1 tables:**

```sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  address TEXT NOT NULL,
  delivery_boy_id INTEGER REFERENCES delivery_boys(id),
  monthly_rate INTEGER NOT NULL,            -- in paise
  status VARCHAR(20) DEFAULT 'active',
  token VARCHAR(64) UNIQUE,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE delivery_boys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  telegram_chat_id BIGINT UNIQUE,
  region VARCHAR(50),
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  total_days INTEGER NOT NULL DEFAULT 30,
  remaining_days INTEGER NOT NULL DEFAULT 30,
  status VARCHAR(20) DEFAULT 'active',
  paused_until TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  delivery_boy_id INTEGER NOT NULL REFERENCES delivery_boys(id),
  delivery_date TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  issue_reason TEXT,
  marked_at TEXT,
  resolved_at TEXT,
  resolved_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(customer_id, delivery_date)
);

CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);
```

**Seed data (5 delivery boys):**
| id | name | phone | region |
|----|------|-------|--------|
| 1 | Raju | 9876543210 | North |
| 2 | Vijay | 9876543211 | South |
| 3 | Priya | 9876543212 | East |
| 4 | Arun | 9876543213 | West |
| 5 | Suresh | 9876543214 | Central |

---

### Step 4: `services/telegram.js` (~60 lines)

**Dependencies:** none (pure formatting functions)
**Risk:** Low

**Exports:**
- `formatRouteMessage(deliveries, boyName)` — builds Telegram route message
- `buildDeliverySummary(deliveries)` — counts by status
- `formatStatusLine(delivery)` — single delivery status text

**Key behaviors:**
- Empty route: "No deliveries scheduled for you today."
- Normal route: "Good morning {boyName}! Your route ({count} deliveries):" followed by numbered items with status suffixes
- Summary: "Route complete! 10 delivered, 2 skipped, 1 issue, 0 pending."

---

### Step 5: `services/dispatch.js` (~80 lines)

**Dependencies:** db.js
**Risk:** Low

**Exports:**
- `dispatchExistsForToday(db)` — boolean check
- `generateDispatch(db)` — idempotent generation in a transaction
- `getTodaysRouteForBoy(db, deliveryBoyId)` — array of delivery objects

**Key behaviors:**
- Checks `dispatchExistsForToday()` before generating — returns `{ generated: false, count: 0 }` if already exists
- Only includes active customers with active subscriptions (not paused, not expired)
- Groups by delivery_boy_id in the INSERT
- Returns `{ generated: true, count: N }` on success

---

### Step 6: `routes/telegram.js` (~300 lines)

**Dependencies:** db.js, services/telegram.js, services/dispatch.js
**Risk:** Medium (Telegram API edge cases)

**Exports:**
- `initTelegramBot(bot, db)` — registers all command listeners

**Command handlers:**

| Command | Pattern | Action | Edge Cases |
|---------|---------|--------|------------|
| `/start` | exact | Register phone → link chat ID | Unknown phone → "Contact admin" |
| `/route` | exact | Show today's deliveries | Unregistered → "Send /start first" |
| `/done C001` | `/^\/done\s+(C\d{3})$/i` | Mark delivered, -1 day | Already done → warn; not found → "No delivery" |
| `/skip C001` | `/^\/skip\s+(C\d{3})$/i` | Mark skipped, +1 day | Same edge cases as /done |
| `/issue C001 <reason>` | `/^\/issue\s+(C\d{3})\s+(.+)$/is` | Record issue | No reason → "Please include a reason" |
| `/arriving C001` | `/^\/arriving\s+(C\d{3})$/i` | Mark arriving | Same edge cases as /done |
| `/finish` | exact | End-of-route summary | Unregistered → "Send /start first" |
| `/help` | exact | List all commands | — |

**Error handling pattern:**
```javascript
try { /* handler logic */ }
catch (err) {
  console.error(`Error handling /${command}:`, err.message);
  bot.sendMessage(chatId, 'Something went wrong. Please try again.');
}
```

**Bot initialization includes:**
- `polling: true` mode (works behind NAT)
- `polling_error` listener (logged, auto-recovers)
- `setMyCommands()` for bot menu

---

### Step 7: `routes/admin.js` (~280 lines)

**Dependencies:** db.js, services/dispatch.js
**Risk:** Medium (form validation, session edge cases)

**Exports:**
- `setupAdminRoutes(app, db)` — registers all admin routes

**Auth middleware:**
```javascript
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}
```

**Route table:**

| Method | Path | Description |
|--------|------|-------------|
| GET | /admin/login | Render login page |
| POST | /admin/login | bcryptjs.compare, set session |
| GET | /admin/logout | Destroy session |
| GET | /admin | Redirect to /admin/dashboard |
| GET | /admin/dashboard | Dashboard with live delivery counts |
| GET | /admin/customers | Customer list |
| POST | /admin/customers | Add customer + create subscription |
| GET | /admin/customers/:id | Return JSON for edit |
| POST | /admin/customers/:id/edit | Update customer |
| POST | /admin/customers/:id/regenerate-token | New random token |
| GET | /admin/dispatch | Dispatch board |
| POST | /admin/dispatch/generate | Generate today's dispatch |
| GET | /health | JSON health check (no auth) |

**Key validation rules:**
- Customer code auto-generated: `C001`, `C002`, etc.
- Phone: must match `/^\d{10,15}$/`
- monthly_rate: positive integer (converted to paise: `* 100`)
- delivery_boy_id: must exist in delivery_boys table
- Token: `crypto.randomBytes(32).toString('hex')`

**Dashboard queries (separate statements, not a single join):**
- Total, delivered, skipped, issue, pending, arriving counts for today
- Active customer count

---

### Step 8: `server.js` (~100 lines)

**Dependencies:** ALL previous files
**Risk:** Medium (middleware ordering, session config)

**Structure:**
1. `require('dotenv').config()`
2. Validate env vars (exit with message if missing)
3. Warn if ADMIN_PASSWORD is default
4. `initializeDatabase()` → get db instance
5. Create Express app
6. Middleware pipeline:
   - `express.urlencoded({ extended: true })`
   - `express.static(path.join(__dirname, 'public'))`
   - Request logger
   - Session (connect-sqlite3 store, 4 hour maxAge)
7. View engine: EJS
8. Admin routes
9. Telegram bot init + polling
10. Boot check: auto-generate dispatch if needed
11. 404 handler + error middleware
12. Listen on PORT
13. Graceful shutdown (SIGINT + uncaughtException)

---

### Step 9: `views/login.ejs` (~40 lines)

**Dependencies:** routes/admin.js renders it
**Risk:** Low

Self-contained HTML (no layout wrapper):
- Centered form card, max-width 400px
- "Dharma Farms" header (green)
- Password-only input (no username)
- Error message displayed on `?error=1`
- Mobile-friendly

---

### Step 10: `views/admin/layout.ejs` (~70 lines)

**Dependencies:** used by all admin views
**Risk:** Low

HTML shell with sidebar layout:
- Sidebar (240px, dark green): brand, nav links, logout
- Active page indicator (white left border)
- Main content area (light green background)
- `<%- body %>` for child content
- Includes Tailwind CDN + `/css/style.css`
- `activePage` variable for nav highlighting

---

### Step 11: `views/admin/dashboard.ejs` (~70 lines)

**Dependencies:** layout.ejs
**Risk:** Low

Stats grid (CSS grid, auto-fill minmax(180px, 1fr)):
- Total | Delivered (green) | Skipped (amber) | Issues (red) | Pending (gray) | Arriving | Active customers
- Each card: large count, label, left color border
- Quick action links
- Empty state when no deliveries exist

---

### Step 12: `views/admin/customers.ejs` (~160 lines)

**Dependencies:** layout.ejs
**Risk:** Low

Customer management page:
- Header with "Add Customer" button
- Flash messages for add/update success
- Table: Code, Name, Phone, Address, Boy, Rate, Status, Actions
- Status badges (colored)
- Inline add form (toggle via vanilla JS)
- Inline edit form per row
- Empty state: "No customers yet"

---

### Step 13: `views/admin/dispatch.ejs` (~90 lines)

**Dependencies:** layout.ejs
**Risk:** Low

Today's dispatch board:
- Header with date
- Flash messages
- No dispatch → "Generate Today's Dispatch" button
- Dispatch exists → sections grouped by delivery boy
- Per-boy tables: Code, Customer, Address, Status (colored badge), Marked At
- Totals summary line
- Empty state when no deliveries

---

### Step 14: `public/css/style.css` (~60 lines)

**Dependencies:** none (static file)
**Risk:** Low

Design tokens and utility classes:
- CSS custom properties for palette, sidebar width
- `.app-layout`, `.sidebar`, `.main-content` — flex layout
- `.data-table` — full-width, striped, green header
- `.badge-*` — colored pill badges per status
- `.stats-grid`, `.stat-card` — dashboard grid
- `.btn`, `.btn-primary`, `.btn-danger` — button styles
- Responsive breakpoints: 768px (sidebar→top), 480px (stats→single column)

---

## Implementation Order (by dependency)

| Order | File | Depends On | Est. Lines |
|-------|------|------------|------------|
| 1 | package.json | nothing | 25 |
| 2 | .env | nothing | 5 |
| 3 | db.js | package.json (better-sqlite3) | 150 |
| 4 | services/telegram.js | nothing (pure functions) | 60 |
| 5 | services/dispatch.js | db.js | 80 |
| 6 | routes/telegram.js | db.js, services/* | 300 |
| 7 | routes/admin.js | db.js, services/dispatch.js | 280 |
| 8 | server.js | ALL above | 100 |
| 9 | views/login.ejs | routes/admin.js renders it | 40 |
| 10 | views/admin/layout.ejs | routes/admin.js uses it | 70 |
| 11 | views/admin/dashboard.ejs | layout.ejs | 70 |
| 12 | views/admin/customers.ejs | layout.ejs | 160 |
| 13 | views/admin/dispatch.ejs | layout.ejs | 90 |
| 14 | public/css/style.css | independent | 60 |
| | **Total** | | **~1490** |

---

## Key Design Decisions

1. **Customer codes are stable identifiers** (`/done C001`) — positional indexes break when routes are reordered
2. **Idempotent dispatch** — `generateDispatch()` checks existence first; multiple server starts don't duplicate
3. **WAL mode on SQLite** — concurrent reads during writes for live dashboard
4. **bcryptjs NOT bcrypt** — pure JS, no native compilation on Windows
5. **Local CSS fallback** — works without Tailwind CDN (internet outages)
6. **connect-sqlite3 for sessions** — same SQLite file, no Redis needed; 4-hour expiry covers delivery window
7. **Subscription remaining_days:** `/done` decrements, `/skip` increments (extends prepaid plan)

---

## Edge Case Matrix

| Scenario | Where Handled | Behavior |
|----------|--------------|----------|
| Unregistered boy sends command | Every Telegram handler | "Please send /start first" |
| Invalid code format | /done, /skip, /issue, /arriving | "Usage: /done C001" |
| Code not in today's route | /done, /skip, /issue, /arriving | "No delivery found for {code} today" |
| Duplicate /done | /done handler | "Already marked delivered at HH:MM" |
| /issue without reason | /issue handler | "Please include a reason" |
| Empty dispatch | /route handler | "No deliveries scheduled today" |
| Missing password field | POST /admin/login | Redirect with error |
| Wrong password | POST /admin/login | Redirect with error (no info leak) |
| Expired session | requireAuth middleware | Redirect to /admin/login |
| No customers in DB | customers.ejs | "No customers yet" empty state |
| No dispatch generated | dispatch.ejs | "Generate Today's Dispatch" prompt |
| Server restart mid-day | server.js boot check | Dispatch idempotent, no duplicates |
| .env vars missing | server.js startup | Process.exit with clear error message |
| Telegram API down | bot.on('polling_error') | Logged, auto-recovers |

---

## Testing Strategy (Phase 1 — Manual)

No test framework (no devDependencies in Phase 1). Manual acceptance checklist:

1. `npm install` completes without native compilation errors
2. `npm start` boots without errors, DB created at `data/dharma-farms.db`
3. `http://localhost:3000/health` returns JSON
4. Login page renders at `/admin/login`
5. Login succeeds with ADMIN_PASSWORD
6. Add 3 customers with different delivery boys
7. Generate dispatch — verify rows created
8. Dashboard shows correct counts
9. Send `/start` to Telegram bot from seed phone number
10. Send `/route` — verify correct deliveries shown
11. Send `/done`, `/skip`, `/issue` — verify DB updates
12. Send duplicate `/done` — verify warning message
13. Send `/finish` — verify summary
14. Open dashboard — verify counts change in real time

---

## Risk Register (Phase 1 Specific)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| better-sqlite3 native build fails on Windows | Low | High | Node 20+ includes prebuild support; falls back to prebuilt binary |
| Windows path separator issues | Low | Medium | Use `path.join()` everywhere, not string concatenation |
| Port 3000 blocked | Low | Low | Document PORT override in .env |
| Admin forgets to set BOT_TOKEN | Low | High | Startup validation exits with clear message |
| Telegram polling silently stops | Low | Medium | Logged; Phase 3 adds health monitoring |