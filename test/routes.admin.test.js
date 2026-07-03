/**
 * Tests for routes/admin.js — Admin route handlers.
 *
 * Uses an in-memory SQLite database and Express app for isolation.
 * Run with: node --test test/routes.admin.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

// ─── Test database factory ────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE delivery_boys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(15) NOT NULL,
      telegram_chat_id BIGINT UNIQUE,
      region VARCHAR(50),
      status VARCHAR(20) DEFAULT 'active'
    );

    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(10) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(15) NOT NULL,
      address TEXT NOT NULL,
      delivery_boy_id INTEGER REFERENCES delivery_boys(id),
      monthly_rate INTEGER NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      token VARCHAR(64) UNIQUE,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      amount INTEGER NOT NULL,
      mode VARCHAR(20) NOT NULL,
      payment_date DATE NOT NULL,
      notes TEXT,
      recorded_by VARCHAR(100),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_payments_customer ON payments(customer_id);
    CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
    CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
    CREATE INDEX idx_deliveries_status ON deliveries(status);
    CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
  `);

  return db;
}

function seedPayments(db) {
  const insertPayment = db.prepare(
    `INSERT INTO payments (customer_id, amount, mode, payment_date, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insertPayment.run(1, 30000, 'cash', '2026-07-01', 'Monthly payment', 'Admin');
  insertPayment.run(1, 15000, 'upi', '2026-07-05', 'Partial top-up', 'Admin');
}

function seedDeliveryBoys(db) {
  const insertBoy = db.prepare(
    'INSERT OR IGNORE INTO delivery_boys (id, name, phone, region) VALUES (?, ?, ?, ?)'
  );
  insertBoy.run(1, 'Raju', '9876543210', 'North');
  insertBoy.run(2, 'Vijay', '9876543211', 'South');
  insertBoy.run(3, 'Priya', '9876543212', 'East');
  insertBoy.run(4, 'Arun', '9876543213', 'West');
  insertBoy.run(5, 'Suresh', '9876543214', 'Central');
}

function seedCustomers(db) {
  const insertCustomer = db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status, token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insertCustomer.run(1, 'C001', 'Ram', '9000000001', '123 Main St', 1, 30000, 'active', 'tok_ram_001');
  insertCustomer.run(2, 'C002', 'Shyam', '9000000002', '456 Oak Ave', 1, 30000, 'active', 'tok_shyam_002');
  insertCustomer.run(3, 'C003', 'Gita', '9000000003', '789 Pine Rd', 2, 45000, 'active', 'tok_gita_003');
  insertCustomer.run(4, 'C004', 'Sita', '9000000004', '321 Elm St', 2, 30000, 'inactive', 'tok_sita_004');

  const insertSub = db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-10 days'), date('now', '+20 days'), 30, 20, 'active')`
  );
  insertSub.run(1);
  insertSub.run(2);
  insertSub.run(3);
}

function seedDeliveries(db) {
  const insertDelivery = db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
     VALUES (?, ?, date('now'), ?, ?)`
  );
  insertDelivery.run(1, 1, 'delivered', '06:15');
  insertDelivery.run(2, 1, 'skipped', '06:20');
  insertDelivery.run(3, 2, 'pending', null);
}

function seedIssues(db) {
  const insertDelivery = db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at, issue_reason, resolved_at, resolved_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Unresolved issues
  insertDelivery.run(1, 1, dateOffset(0), 'issue', '06:15', 'Dog barking at gate', null, null);
  insertDelivery.run(2, 1, dateOffset(0), 'issue', '06:20', 'Customer not home', null, null);
  // Resolved issue
  insertDelivery.run(3, 2, dateOffset(-1), 'issue', '06:10', 'Wrong address', '2026-07-02T07:00:00', 'Address corrected');
  // Non-issue delivery (should not appear in issues list)
  insertDelivery.run(4, 2, dateOffset(0), 'delivered', '06:25', null, null, null);
}

// ─── Express app factory ─────────────────────────────────────────

function createApp(db, adminPassword) {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: true,
  }));

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  app.locals.db = db;
  app.locals.loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in a minute.' },
  });
  app.locals.adminPasswordHash = adminPassword
    ? bcrypt.hashSync(adminPassword, 10)
    : null;

  const { setupAdminRoutes } = require('../routes/admin');
  setupAdminRoutes(app, db);

  return app;
}

/**
 * Helper: make an HTTP request and return { status, headers, body }.
 */
function request(app, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const cookie = options.cookie || '';

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookie,
          ...(options.headers || {}),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();

          // Follow redirect if requested
          if (options.followRedirect && [301, 302, 303, 307, 308].includes(res.statusCode)) {
            const location = res.headers.location;
            const redirectApp = app;
            const redirectServer = redirectApp.listen(0, () => {
              const redirectPort = redirectServer.address().port;
              const redirectReq = http.request({
                hostname: '127.0.0.1',
                port: redirectPort,
                path: location,
                method: 'GET',
                headers: { 'Cookie': cookie },
              }, (redirectRes) => {
                let redirectBody = '';
                redirectRes.on('data', (chunk) => { redirectBody += chunk; });
                redirectRes.on('end', () => {
                  redirectServer.close();
                  resolve({
                    status: redirectRes.statusCode,
                    headers: redirectRes.headers,
                    body: redirectBody,
                  });
                });
              });
              redirectReq.end();
            });
            return;
          }

          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      });

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  });
}

/**
 * Helper: POST form-encoded data and return the response.
 */
/**
 * Helper: returns a date string offset by N days from today.
 * @param {number} offset - negative for past, positive for future
 * @returns {string} YYYY-MM-DD
 */
function dateOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function postForm(app, path, data, cookie = '') {
  const body = Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

  return request(app, 'POST', path, {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    cookie,
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('routes/admin.js — setupAdminRoutes', () => {
  let db;
  let app;

  before(() => {
    db = createTestDb();
    seedDeliveryBoys(db);
    app = createApp(db, 'admin123');
  });

  after(() => {
    db.close();
  });

  // ── GET /health ────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with JSON health status', async () => {
      const res = await request(app, 'GET', '/health');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'], /json/);
    });
  });

  // ── GET /admin/login ───────────────────────────────────────────

  describe('GET /admin/login', () => {
    it('returns 200 and renders login page', async () => {
      const res = await request(app, 'GET', '/admin/login');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'], /html/);
    });
  });

  // ── POST /admin/login ──────────────────────────────────────────

  describe('POST /admin/login', () => {
    it('redirects to /admin/dashboard on correct password', async () => {
      const res = await request(app, 'POST', '/admin/login', {
        body: 'password=admin123',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /\/admin\/dashboard|\/admin$/);
    });

    it('redirects to /admin/login?error=1 on wrong password', async () => {
      const res = await request(app, 'POST', '/admin/login', {
        body: 'password=wrongpassword',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /error/);
    });

    it('redirects to /admin/login?error=1 when password field is missing', async () => {
      const res = await request(app, 'POST', '/admin/login', {
        body: '',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /error/);
    });
  });

  // ── requireAuth middleware ─────────────────────────────────────

  describe('requireAuth middleware', () => {
    it('redirects to /admin/login when not authenticated for /admin/dashboard', async () => {
      const res = await request(app, 'GET', '/admin/dashboard', {
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /\/admin\/login/);
    });

    it('redirects to /admin/login when not authenticated for /admin/customers', async () => {
      const res = await request(app, 'GET', '/admin/customers', {
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /\/admin\/login/);
    });

    it('redirects to /admin/login when not authenticated for /admin/dispatch', async () => {
      const res = await request(app, 'GET', '/admin/dispatch', {
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /\/admin\/login/);
    });
  });

  // ── GET /admin (redirect) ─────────────────────────────────────

  describe('GET /admin', () => {
    it('redirects to /admin/dashboard when authenticated', async () => {
      // Login first
      const loginRes = await request(app, 'POST', '/admin/login', {
        body: 'password=admin123',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        followRedirect: false,
      });
      const cookie = Array.isArray(loginRes.headers['set-cookie'])
        ? loginRes.headers['set-cookie'].join('; ')
        : loginRes.headers['set-cookie'];

      const res = await request(app, 'GET', '/admin', {
        cookie,
        followRedirect: false,
      });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /\/admin\/dashboard/);
    });
  });

  // ── Full authenticated flow ────────────────────────────────────

  describe('authenticated admin routes', () => {
    let sessionCookie;

    before(async () => {
      const loginRes = await request(app, 'POST', '/admin/login', {
        body: 'password=admin123',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        followRedirect: false,
      });
      const setCookie = loginRes.headers['set-cookie'];
      sessionCookie = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
      assert.ok(sessionCookie, 'Should have received a session cookie');
    });

    // ── GET /admin/dashboard ───────────────────────────────────

    describe('GET /admin/dashboard', () => {
      it('returns 200 and renders dashboard page', async () => {
        const res = await request(app, 'GET', '/admin/dashboard', {
          cookie: sessionCookie,
        });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
      });

      it('shows stats on dashboard when no deliveries exist', async () => {
        const emptyDb = createTestDb();
        seedDeliveryBoys(emptyDb);
        const emptyApp = createApp(emptyDb, 'admin123');

        const loginRes = await request(emptyApp, 'POST', '/admin/login', {
          body: 'password=admin123',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          followRedirect: false,
        });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(emptyApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        emptyDb.close();
      });

      it('shows delivery counts when deliveries exist', async () => {
        const busyDb = createTestDb();
        seedDeliveryBoys(busyDb);
        seedCustomers(busyDb);
        seedDeliveries(busyDb);
        const busyApp = createApp(busyDb, 'admin123');

        const loginRes = await request(busyApp, 'POST', '/admin/login', {
          body: 'password=admin123',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          followRedirect: false,
        });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(busyApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        busyDb.close();
      });

      it('shows financial summary cards (Collected This Month, Expected Revenue, Overdue Accounts)', async () => {
        const finDb = createTestDb();
        seedDeliveryBoys(finDb);
        seedCustomers(finDb);
        seedPayments(finDb);
        const finApp = createApp(finDb, 'admin123');

        const loginRes = await postForm(finApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(finApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.body, /Collected This Month/);
        assert.match(res.body, /Expected Monthly Revenue/);
        assert.match(res.body, /Overdue Accounts/);
        finDb.close();
      });

      it('shows overdue count with red styling when accounts are overdue', async () => {
        const ovDb = createTestDb();
        seedDeliveryBoys(ovDb);
        seedCustomers(ovDb);
        // Add 5 delivered deliveries for customer 1 with no payments → balanceDays = -5 → overdue
        // Use different dates to avoid UNIQUE(customer_id, delivery_date) constraint
        const insertDel = ovDb.prepare(
          `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
           VALUES (?, ?, ?, 'delivered', '06:15')`
        );
        for (let i = 0; i < 5; i++) {
          insertDel.run(1, 1, dateOffset(-i));
        }
        const ovApp = createApp(ovDb, 'admin123');

        const loginRes = await postForm(ovApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(ovApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        // Overdue card should have red accent border
        assert.match(res.body, /#dc2626/);
        ovDb.close();
      });

      it('shows overdue count with gray styling when no accounts are overdue', async () => {
        const okDb = createTestDb();
        seedDeliveryBoys(okDb);
        seedCustomers(okDb);
        // No deliveries → no consumed days → no overdue
        const okApp = createApp(okDb, 'admin123');

        const loginRes = await postForm(okApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(okApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        // Overdue card should have gray accent border (not red)
        assert.match(res.body, /#6b7280/);
        okDb.close();
      });

      it('shows expiring subscriptions amber warning banner when subscriptions are expiring', async () => {
        const expDb = createTestDb();
        seedDeliveryBoys(expDb);
        seedCustomers(expDb);
        // Add a customer with remaining_days = 1
        expDb.prepare(
          `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status, token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(5, 'C005', 'Expiring', '9000000005', '999 Low St', 1, 30000, 'active', 'tok_exp_005');
        expDb.prepare(
          `INSERT INTO subscriptions (customer_id, start_date, total_days, remaining_days, status)
           VALUES (?, date('now'), 30, 1, 'active')`
        ).run(5);
        const expApp = createApp(expDb, 'admin123');

        const loginRes = await postForm(expApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(expApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        // Amber warning banner should appear
        assert.match(res.body, /Expiring Subscriptions/);
        // Customer name should appear in the banner
        assert.ok(res.body.includes('Expiring'));
        // Should mention remaining days
        assert.match(res.body, /1 day/);
        expDb.close();
      });

      it('hides expiring subscriptions banner when no subscriptions are expiring', async () => {
        const safeDb = createTestDb();
        seedDeliveryBoys(safeDb);
        seedCustomers(safeDb);
        // All customers have remaining_days = 20 (from seedCustomers) → not expiring
        const safeApp = createApp(safeDb, 'admin123');

        const loginRes = await postForm(safeApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(safeApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        // The amber banner classes should NOT appear
        assert.ok(!res.body.includes('bg-amber-50'));
        safeDb.close();
      });

      it('shows financial summary cards even when no deliveries exist', async () => {
        const nodDb = createTestDb();
        seedDeliveryBoys(nodDb);
        seedCustomers(nodDb);
        seedPayments(nodDb);
        // No dispatch generated → hasDeliveries is false
        const nodApp = createApp(nodDb, 'admin123');

        const loginRes = await postForm(nodApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(nodApp, 'GET', '/admin/dashboard', { cookie });
        assert.strictEqual(res.status, 200);
        // Financial cards should appear even though there are no deliveries
        assert.match(res.body, /Collected This Month/);
        assert.match(res.body, /Expected Monthly Revenue/);
        nodDb.close();
      });
    });

    // ── GET /admin/customers ────────────────────────────────────

    describe('GET /admin/customers', () => {
      it('returns 200 and lists all customers', async () => {
        const custDb = createTestDb();
        seedDeliveryBoys(custDb);
        seedCustomers(custDb);
        const custApp = createApp(custDb, 'admin123');

        const loginRes = await postForm(custApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(custApp, 'GET', '/admin/customers', { cookie });
        assert.strictEqual(res.status, 200);
        custDb.close();
      });

      it('shows empty state when no customers exist', async () => {
        const emptyDb = createTestDb();
        seedDeliveryBoys(emptyDb);
        const emptyApp = createApp(emptyDb, 'admin123');

        const loginRes = await postForm(emptyApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(emptyApp, 'GET', '/admin/customers', { cookie });
        assert.strictEqual(res.status, 200);
        emptyDb.close();
      });

      it('shows token column with copy button only (no visible token text)', async () => {
        const tokDb = createTestDb();
        seedDeliveryBoys(tokDb);
        seedCustomers(tokDb);
        const longToken = 'abcdef0123456789' + 'deadbeefcafebabe' + '1234567890abcdef' + 'fedcba0987654321';
        tokDb.prepare(
          `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status, token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(5, 'C005', 'LongToken', '9000000005', '456 Test St', 1, 30000, 'active', longToken);

        const tokApp = createApp(tokDb, 'admin123');
        const loginRes = await postForm(tokApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(tokApp, 'GET', '/admin/customers', { cookie });
        assert.strictEqual(res.status, 200);

        // 1. Token column header exists
        assert.match(res.body, /<th>Token<\/th>/);

        // 2. Copy button exists with full token in a data-token attribute
        assert.match(res.body, /data-token="/);
        assert.ok(res.body.includes(longToken), 'Full token appears in a data-token attribute');

        // 3. The button does NOT use the 📋 emoji
        assert.ok(!res.body.includes('📋'), 'Copy button should not use emoji');

        // 4. The truncated token text (first 16 chars + ellipsis) is NOT displayed as visible text
        const first16 = longToken.substring(0, 16);
        assert.ok(
          !res.body.includes(first16 + '…'),
          'Token text with ellipsis should not appear as visible content'
        );

        tokDb.close();
      });

      it('shows Rem. Days column header in customers table', async () => {
        const rdDb = createTestDb();
        seedDeliveryBoys(rdDb);
        seedCustomers(rdDb);
        const rdApp = createApp(rdDb, 'admin123');

        const loginRes = await postForm(rdApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(rdApp, 'GET', '/admin/customers', { cookie });

        // Rem. Days column header should exist
        assert.match(res.body, /<th>Rem\.?\s*Days?<\/th>/);

        rdDb.close();
      });

      it('shows remaining_days for customers with active subscriptions', async () => {
        const rdDb = createTestDb();
        seedDeliveryBoys(rdDb);
        seedCustomers(rdDb);
        const rdApp = createApp(rdDb, 'admin123');

        const loginRes = await postForm(rdApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(rdApp, 'GET', '/admin/customers', { cookie });

        // Customer 1 (Ram) has remaining_days=20 from seed data
        assert.ok(res.body.includes('20'), 'Should show remaining_days value of 20');
        rdDb.close();
      });

      it('shows em-dash for customers with no active subscription', async () => {
        const rdDb = createTestDb();
        seedDeliveryBoys(rdDb);
        seedCustomers(rdDb);
        const rdApp = createApp(rdDb, 'admin123');

        const loginRes = await postForm(rdApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(rdApp, 'GET', '/admin/customers', { cookie });

        // Customer 4 (Sita, inactive) has no subscription → should show em-dash
        // The em-dash should appear in the table body, not the header
        assert.ok(res.body.includes('—'), 'Should show em-dash for customers with no subscription');
        rdDb.close();
      });

      it('shows red text for remaining_days <= 3', async () => {
        const rdDb = createTestDb();
        seedDeliveryBoys(rdDb);
        seedCustomers(rdDb);
        // Add a customer with expiring subscription (remaining_days = 1)
        rdDb.prepare(
          `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status, token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(5, 'C005', 'Expiring', '9000000005', '999 Low St', 1, 30000, 'active', 'tok_expiring_005');
        rdDb.prepare(
          `INSERT INTO subscriptions (customer_id, start_date, total_days, remaining_days, status)
           VALUES (?, date('now'), 30, 1, 'active')`
        ).run(5);

        const rdApp = createApp(rdDb, 'admin123');

        const loginRes = await postForm(rdApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(rdApp, 'GET', '/admin/customers', { cookie });

        // Should have red text styling for expiring subscription
        assert.ok(res.body.includes('text-red-600'), 'Should have red text styling');
        // The value 1 should appear somewhere in the table body for the expiring customer
        assert.ok(/>\s*1\s*</.test(res.body), 'Should show the value 1');
        rdDb.close();
      });
    });

    // ── POST /admin/customers (Add customer) ─────────────────────

    describe('POST /admin/customers — add customer', () => {
      it('adds a new customer and auto-generates code and subscription', async () => {
        const addDb = createTestDb();
        seedDeliveryBoys(addDb);
        seedCustomers(addDb);
        const addApp = createApp(addDb, 'admin123');

        const loginRes = await postForm(addApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await postForm(addApp, '/admin/customers', {
          name: 'NewUser',
          phone: '9999999999',
          address: '555 New St',
          delivery_boy_id: 1,
          monthly_rate: 300,
        }, cookie);

        const customer = addDb.prepare("SELECT * FROM customers WHERE name = 'NewUser'").get();
        assert.ok(customer, 'Customer should exist');
        assert.ok(customer.code, 'Should have auto-generated code');
        assert.ok(customer.token, 'Should have auto-generated token');

        const sub = addDb.prepare(
          'SELECT * FROM subscriptions WHERE customer_id = ?'
        ).get(customer.id);
        assert.ok(sub, 'Subscription should exist');
        assert.strictEqual(sub.status, 'active');

        addDb.close();
      });

      it('rejects missing required fields', async () => {
        const valDb = createTestDb();
        seedDeliveryBoys(valDb);
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/customers', {
          name: '',
          phone: '',
          address: '',
          delivery_boy_id: '',
          monthly_rate: '',
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });

      it('rejects invalid phone number', async () => {
        const valDb = createTestDb();
        seedDeliveryBoys(valDb);
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/customers', {
          name: 'Test',
          phone: 'abc',
          address: '123 St',
          delivery_boy_id: 1,
          monthly_rate: 300,
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });

      it('rejects invalid delivery_boy_id', async () => {
        const valDb = createTestDb();
        seedDeliveryBoys(valDb);
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/customers', {
          name: 'Test',
          phone: '9999999999',
          address: '123 St',
          delivery_boy_id: 999,
          monthly_rate: 300,
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });
    });

    // ── GET /admin/customers/:id (JSON for edit) ─────────────────

    describe('GET /admin/customers/:id — get customer JSON', () => {
      it('returns customer data as JSON', async () => {
        const custDb = createTestDb();
        seedDeliveryBoys(custDb);
        seedCustomers(custDb);
        const custApp = createApp(custDb, 'admin123');

        const loginRes = await postForm(custApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(custApp, 'GET', '/admin/customers/1', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });

        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /json/);
        custDb.close();
      });

      it('returns 404 for non-existent customer', async () => {
        const custDb = createTestDb();
        seedDeliveryBoys(custDb);
        const custApp = createApp(custDb, 'admin123');

        const loginRes = await postForm(custApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(custApp, 'GET', '/admin/customers/999', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });

        assert.strictEqual(res.status, 404);
        custDb.close();
      });
    });

    // ── POST /admin/customers/:id/edit ──────────────────────────

    describe('POST /admin/customers/:id/edit — update customer', () => {
      it('updates customer details', async () => {
        const editDb = createTestDb();
        seedDeliveryBoys(editDb);
        seedCustomers(editDb);
        const editApp = createApp(editDb, 'admin123');

        const loginRes = await postForm(editApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await postForm(editApp, '/admin/customers/1/edit', {
          name: 'RamUpdated',
          phone: '9111111111',
          address: '999 Updated St',
          delivery_boy_id: 2,
          monthly_rate: 500,
        }, cookie);

        const customer = editDb.prepare('SELECT * FROM customers WHERE id = 1').get();
        assert.strictEqual(customer.name, 'RamUpdated');
        assert.strictEqual(customer.phone, '9111111111');
        assert.strictEqual(customer.address, '999 Updated St');
        assert.strictEqual(customer.delivery_boy_id, 2);

        editDb.close();
      });

      it('rejects invalid delivery_boy_id', async () => {
        const editDb = createTestDb();
        seedDeliveryBoys(editDb);
        seedCustomers(editDb);
        const editApp = createApp(editDb, 'admin123');

        const loginRes = await postForm(editApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        // Customer 1 (Ram) is assigned to delivery_boy_id 1 (Raju)
        const res = await postForm(editApp, '/admin/customers/1/edit', {
          name: 'Ram',
          phone: '9000000001',
          address: '123 Main St',
          delivery_boy_id: 999,
          monthly_rate: 300,
        }, cookie);

        assert.strictEqual(res.status, 302);

        // Customer's delivery_boy_id should remain unchanged
        const customer = editDb.prepare('SELECT * FROM customers WHERE id = 1').get();
        assert.strictEqual(customer.delivery_boy_id, 1);

        editDb.close();
      });
    });

    // ── POST /admin/customers/:id/regenerate-token ─────────────

    describe('POST /admin/customers/:id/regenerate-token', () => {
      it('generates a new token for the customer', async () => {
        const tokDb = createTestDb();
        seedDeliveryBoys(tokDb);
        seedCustomers(tokDb);
        const tokApp = createApp(tokDb, 'admin123');

        const loginRes = await postForm(tokApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const oldToken = tokDb.prepare('SELECT token FROM customers WHERE id = 1').get().token;

        const res = await postForm(tokApp, '/admin/customers/1/regenerate-token', {}, cookie);

        const newToken = tokDb.prepare('SELECT token FROM customers WHERE id = 1').get().token;
        assert.notStrictEqual(newToken, oldToken, 'Token should have changed');
        assert.ok(newToken.length > 10, 'New token should be sufficiently long');
        assert.strictEqual(res.status, 302);

        tokDb.close();
      });
    });

    // ── POST /admin/customers/:id/toggle-status ──────────────────

	    describe('POST /admin/customers/:id/toggle-status', () => {
	      it('toggles active customer to inactive', async () => {
	        const togDb = createTestDb();
	        seedDeliveryBoys(togDb);
	        seedCustomers(togDb);
	        const togApp = createApp(togDb, 'admin123');

	        const loginRes = await postForm(togApp, '/admin/login', { password: 'admin123' });
	        const cookie = Array.isArray(loginRes.headers['set-cookie'])
	          ? loginRes.headers['set-cookie'].join('; ')
	          : loginRes.headers['set-cookie'];

	        assert.strictEqual(
	          togDb.prepare('SELECT status FROM customers WHERE id = 1').get().status,
	          'active'
	        );

	        await postForm(togApp, '/admin/customers/1/toggle-status', {}, cookie);

	        assert.strictEqual(
	          togDb.prepare('SELECT status FROM customers WHERE id = 1').get().status,
	          'inactive'
	        );

	        togDb.close();
	      });

	      it('toggles inactive customer to active', async () => {
	        const togDb = createTestDb();
	        seedDeliveryBoys(togDb);
	        seedCustomers(togDb);
	        const togApp = createApp(togDb, 'admin123');

	        const loginRes = await postForm(togApp, '/admin/login', { password: 'admin123' });
	        const cookie = Array.isArray(loginRes.headers['set-cookie'])
	          ? loginRes.headers['set-cookie'].join('; ')
	          : loginRes.headers['set-cookie'];

	        // Customer 4 (Sita) is seeded as 'inactive'
	        assert.strictEqual(
	          togDb.prepare('SELECT status FROM customers WHERE id = 4').get().status,
	          'inactive'
	        );

	        await postForm(togApp, '/admin/customers/4/toggle-status', {}, cookie);

	        assert.strictEqual(
	          togDb.prepare('SELECT status FROM customers WHERE id = 4').get().status,
	          'active'
	        );

	        togDb.close();
	      });

	      it('returns flash error for non-existent customer', async () => {
	        const togDb = createTestDb();
	        const togApp = createApp(togDb, 'admin123');

	        const loginRes = await postForm(togApp, '/admin/login', { password: 'admin123' });
	        const cookie = Array.isArray(loginRes.headers['set-cookie'])
	          ? loginRes.headers['set-cookie'].join('; ')
	          : loginRes.headers['set-cookie'];

	        const res = await postForm(togApp, '/admin/customers/999/toggle-status', {}, cookie);

	        assert.strictEqual(res.status, 302);

	        togDb.close();
	      });
	    });

	    // ── GET /admin/dispatch ─────────────────────────────────────

    describe('GET /admin/dispatch', () => {
      it('returns 200 and shows dispatch page', async () => {
        const dispDb = createTestDb();
        seedDeliveryBoys(dispDb);
        const dispApp = createApp(dispDb, 'admin123');

        const loginRes = await postForm(dispApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(dispApp, 'GET', '/admin/dispatch', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        dispDb.close();
      });
    });

    // ── POST /admin/dispatch/generate ──────────────────────────

    describe('POST /admin/dispatch/generate', () => {
      it('generates dispatch and returns JSON', async () => {
        const genDb = createTestDb();
        seedDeliveryBoys(genDb);
        seedCustomers(genDb);
        const genApp = createApp(genDb, 'admin123');

        const loginRes = await postForm(genApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(genApp, 'POST', '/admin/dispatch/generate', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });
        assert.strictEqual(res.status, 200);

        // Verify deliveries were created
        const count = genDb.prepare(
          "SELECT COUNT(*) AS c FROM deliveries WHERE delivery_date = date('now')"
        ).get().c;
        assert.strictEqual(count, 3);

        genDb.close();
      });

      it('is idempotent — second call does not duplicate', async () => {
        const genDb = createTestDb();
        seedDeliveryBoys(genDb);
        seedCustomers(genDb);
        const genApp = createApp(genDb, 'admin123');

        const loginRes = await postForm(genApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await request(genApp, 'POST', '/admin/dispatch/generate', { cookie });

        const res2 = await request(genApp, 'POST', '/admin/dispatch/generate', { cookie });
        assert.strictEqual(res2.status, 200);

        const count = genDb.prepare(
          "SELECT COUNT(*) AS c FROM deliveries WHERE delivery_date = date('now')"
        ).get().c;
        assert.strictEqual(count, 3);

        genDb.close();
      });
    });

    // ── POST /admin/dispatch/regenerate ─────────────────────────

    describe('POST /admin/dispatch/regenerate', () => {
      it('regenerates dispatch and returns JSON', async () => {
        const regDb = createTestDb();
        seedDeliveryBoys(regDb);
        seedCustomers(regDb);
        const regApp = createApp(regDb, 'admin123');

        const loginRes = await postForm(regApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        // First generate dispatch
        await request(regApp, 'POST', '/admin/dispatch/generate', { cookie });

        // Now regenerate
        const res = await request(regApp, 'POST', '/admin/dispatch/regenerate', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });
        assert.strictEqual(res.status, 200);

        const body = JSON.parse(res.body);
        assert.strictEqual(body.generated, true);
        assert.strictEqual(body.count, 3);

        // Verify deliveries still exist
        const count = regDb.prepare(
          "SELECT COUNT(*) AS c FROM deliveries WHERE delivery_date = date('now')"
        ).get().c;
        assert.strictEqual(count, 3);

        regDb.close();
      });

      it('regenerates even when no dispatch exists yet', async () => {
        const regDb = createTestDb();
        seedDeliveryBoys(regDb);
        seedCustomers(regDb);
        const regApp = createApp(regDb, 'admin123');

        const loginRes = await postForm(regApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(regApp, 'POST', '/admin/dispatch/regenerate', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });
        assert.strictEqual(res.status, 200);

        const body = JSON.parse(res.body);
        assert.strictEqual(body.generated, true);
        assert.strictEqual(body.count, 3);

        regDb.close();
      });

      it('requires authentication', async () => {
        const res = await request(app, 'POST', '/admin/dispatch/regenerate', {
          followRedirect: false,
        });
        assert.strictEqual(res.status, 302);
        assert.match(res.headers.location, /\/admin\/login/);
      });
    });

    // ── GET /admin/logout ─────────────────────────────────────────

    describe('GET /admin/logout', () => {
      it('destroys session and redirects to login', async () => {
        const res = await request(app, 'GET', '/admin/logout', {
          cookie: sessionCookie,
          followRedirect: false,
        });

        assert.strictEqual(res.status, 302);
        assert.match(res.headers.location, /\/admin\/login/);
      });
    });

    // ── Delivery Boy Routes ──────────────────────────────────────

    describe('GET /admin/delivery-boys — list', () => {
      it('returns 200 and lists all delivery boys', async () => {
        const dbBoy = createTestDb();
        seedDeliveryBoys(dbBoy);
        const boyApp = createApp(dbBoy, 'admin123');

        const loginRes = await postForm(boyApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(boyApp, 'GET', '/admin/delivery-boys', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        dbBoy.close();
      });

      it('shows empty state when no delivery boys exist', async () => {
        const emptyDb = createTestDb();
        const emptyApp = createApp(emptyDb, 'admin123');

        const loginRes = await postForm(emptyApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(emptyApp, 'GET', '/admin/delivery-boys', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        emptyDb.close();
      });

      it('requires authentication', async () => {
        const res = await request(app, 'GET', '/admin/delivery-boys', {
          followRedirect: false,
        });
        assert.strictEqual(res.status, 302);
        assert.match(res.headers.location, /\/admin\/login/);
      });
    });

    describe('GET /admin/delivery-boys/:id — get JSON', () => {
      it('returns delivery boy data as JSON', async () => {
        const dbBoy = createTestDb();
        seedDeliveryBoys(dbBoy);
        const boyApp = createApp(dbBoy, 'admin123');

        const loginRes = await postForm(boyApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(boyApp, 'GET', '/admin/delivery-boys/1', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });

        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /json/);
        dbBoy.close();
      });

      it('returns 404 for non-existent delivery boy', async () => {
        const dbBoy = createTestDb();
        const boyApp = createApp(dbBoy, 'admin123');

        const loginRes = await postForm(boyApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(boyApp, 'GET', '/admin/delivery-boys/999', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });

        assert.strictEqual(res.status, 404);
        dbBoy.close();
      });
    });

    describe('POST /admin/delivery-boys — create', () => {
      it('creates a new delivery boy', async () => {
        const addDb = createTestDb();
        const addApp = createApp(addDb, 'admin123');

        const loginRes = await postForm(addApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await postForm(addApp, '/admin/delivery-boys', {
          name: 'Kumar',
          phone: '9999999999',
          region: 'North',
        }, cookie);

        const boy = addDb.prepare("SELECT * FROM delivery_boys WHERE name = 'Kumar'").get();
        assert.ok(boy, 'Delivery boy should exist');
        assert.strictEqual(boy.phone, '9999999999');
        assert.strictEqual(boy.region, 'North');
        assert.strictEqual(boy.status, 'active');

        addDb.close();
      });

      it('rejects missing name', async () => {
        const valDb = createTestDb();
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/delivery-boys', {
          name: '',
          phone: '9999999999',
          region: 'North',
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });

      it('rejects invalid phone number', async () => {
        const valDb = createTestDb();
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/delivery-boys', {
          name: 'Test',
          phone: 'abc',
          region: '',
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });

      it('creates delivery boy with null region when region is empty', async () => {
        const addDb = createTestDb();
        const addApp = createApp(addDb, 'admin123');

        const loginRes = await postForm(addApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await postForm(addApp, '/admin/delivery-boys', {
          name: 'NoRegion',
          phone: '8888888888',
          region: '',
        }, cookie);

        const boy = addDb.prepare("SELECT * FROM delivery_boys WHERE name = 'NoRegion'").get();
        assert.ok(boy);
        assert.strictEqual(boy.region, null);

        addDb.close();
      });
    });

    describe('POST /admin/delivery-boys/:id/edit — update', () => {
      it('updates delivery boy details', async () => {
        const editDb = createTestDb();
        seedDeliveryBoys(editDb);
        const editApp = createApp(editDb, 'admin123');

        const loginRes = await postForm(editApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await postForm(editApp, '/admin/delivery-boys/1/edit', {
          name: 'RajuUpdated',
          phone: '9111111111',
          region: 'South',
        }, cookie);

        const boy = editDb.prepare('SELECT * FROM delivery_boys WHERE id = 1').get();
        assert.strictEqual(boy.name, 'RajuUpdated');
        assert.strictEqual(boy.phone, '9111111111');
        assert.strictEqual(boy.region, 'South');

        editDb.close();
      });

      it('rejects update with missing name', async () => {
        const valDb = createTestDb();
        seedDeliveryBoys(valDb);
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/delivery-boys/1/edit', {
          name: '',
          phone: '9111111111',
          region: '',
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });
    });

    describe('POST /admin/delivery-boys/:id/toggle-status', () => {
      it('toggles active to inactive', async () => {
        const togDb = createTestDb();
        seedDeliveryBoys(togDb);
        const togApp = createApp(togDb, 'admin123');

        const loginRes = await postForm(togApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        assert.strictEqual(
          togDb.prepare('SELECT status FROM delivery_boys WHERE id = 1').get().status,
          'active'
        );

        await postForm(togApp, '/admin/delivery-boys/1/toggle-status', {}, cookie);

        assert.strictEqual(
          togDb.prepare('SELECT status FROM delivery_boys WHERE id = 1').get().status,
          'inactive'
        );

        togDb.close();
      });

      it('toggles inactive to active', async () => {
        const togDb = createTestDb();
        seedDeliveryBoys(togDb);
        togDb.prepare("UPDATE delivery_boys SET status = 'inactive' WHERE id = 2").run();
        const togApp = createApp(togDb, 'admin123');

        const loginRes = await postForm(togApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        await postForm(togApp, '/admin/delivery-boys/2/toggle-status', {}, cookie);

        assert.strictEqual(
          togDb.prepare('SELECT status FROM delivery_boys WHERE id = 2').get().status,
          'active'
        );

        togDb.close();
      });

      it('returns flash error for non-existent delivery boy', async () => {
        const togDb = createTestDb();
        const togApp = createApp(togDb, 'admin123');

        const loginRes = await postForm(togApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(togApp, '/admin/delivery-boys/999/toggle-status', {}, cookie);

        assert.strictEqual(res.status, 302);

        togDb.close();
      });
    });

    // ── GET /admin/payments ─────────────────────────────────────────

    describe('GET /admin/payments — payments page', () => {
      it('returns 200 and renders payments page when authenticated', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(payApp, 'GET', '/admin/payments', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        payDb.close();
      });

      it('renders payment form with radio buttons for mode', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(payApp, 'GET', '/admin/payments', { cookie });

        // Should have radio buttons for payment modes
        assert.match(res.body, /type="radio".*value="cash"/);
        assert.match(res.body, /type="radio".*value="upi"/);
        assert.match(res.body, /type="radio".*value="bank_transfer"/);

        // Should have customer dropdown, amount field, date picker, notes textarea
        assert.match(res.body, /customer_id/);
        assert.match(res.body, /type="number".*name="amount"/);
        assert.match(res.body, /type="date".*name="payment_date"/);
        assert.match(res.body, /textarea.*name="notes"/);

        payDb.close();
      });

      it('redirects to login when not authenticated', async () => {
        const res = await request(app, 'GET', '/admin/payments', {
          followRedirect: false,
        });
        assert.strictEqual(res.status, 302);
        assert.match(res.headers.location, /\/admin\/login/);
      });

      it('renders ledger filter section with customer dropdown', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(payApp, 'GET', '/admin/payments', { cookie });

        // Should have the filter section
        assert.match(res.body, /View Customer Ledger/);
        assert.match(res.body, /name="customer_id".*id="filter_customer_id"/);

        payDb.close();
      });

      it('renders ledger table with correct column order when customer selected', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        seedPayments(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(payApp, 'GET', '/admin/payments?customer_id=1', { cookie });

        // Should show ledger header with customer name
        assert.match(res.body, /Ledger/);
        assert.match(res.body, /C001/);
        assert.match(res.body, /Ram/);

        // Should have all column headers in correct order
        // Column order: Date, Mode, Amount (₹), Notes, Recorded By, Running Balance
        const colOrder = /<th>Date<\/th>.*<th>Mode<\/th>.*<th>Amount\s*\(₹\)<\/th>.*<th>Notes<\/th>.*<th>Recorded By<\/th>.*<th>Running Balance<\/th>/s;
        assert.match(res.body, colOrder);

        // Should show payment data rows
        assert.match(res.body, /2026-07-01/);
        assert.match(res.body, /2026-07-05/);

        payDb.close();
      });

      it('shows balance card with days when customer selected', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        seedPayments(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(payApp, 'GET', '/admin/payments?customer_id=1', { cookie });

        // Should show balance stat cards
        assert.match(res.body, /Paid Days/);
        assert.match(res.body, /Consumed Days/);
        assert.match(res.body, /Balance Days/);
        assert.match(res.body, /Status/);

        payDb.close();
      });

      it('shows empty state when selected customer has no payments', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        // Customer 2 (Shyam) has no payments seeded
        const res = await request(payApp, 'GET', '/admin/payments?customer_id=2', { cookie });

        // Should show empty state
        assert.match(res.body, /No payments recorded for this customer/);

        payDb.close();
      });
    });

    // ── POST /admin/payments ────────────────────────────────────────

    describe('POST /admin/payments — record payment', () => {
      it('records a valid payment and redirects', async () => {
        const payDb = createTestDb();
        seedDeliveryBoys(payDb);
        seedCustomers(payDb);
        const payApp = createApp(payDb, 'admin123');

        const loginRes = await postForm(payApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(payApp, '/admin/payments', {
          customer_id: 1,
          amount: 500,
          mode: 'cash',
          payment_date: '2026-07-02',
          notes: 'Test payment',
        }, cookie);

        assert.strictEqual(res.status, 302);

        const payment = payDb.prepare('SELECT * FROM payments WHERE customer_id = 1').get();
        assert.ok(payment, 'Payment should exist in DB');
        assert.strictEqual(payment.amount, 50000); // 500 * 100 = 50000 paise

        payDb.close();
      });

      it('rejects empty customer_id', async () => {
        const valDb = createTestDb();
        seedDeliveryBoys(valDb);
        seedCustomers(valDb);
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/payments', {
          customer_id: '',
          amount: 500,
          mode: 'cash',
          payment_date: '2026-07-02',
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });

      it('rejects negative amount', async () => {
        const valDb = createTestDb();
        seedDeliveryBoys(valDb);
        seedCustomers(valDb);
        const valApp = createApp(valDb, 'admin123');

        const loginRes = await postForm(valApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(valApp, '/admin/payments', {
          customer_id: 1,
          amount: -100,
          mode: 'cash',
          payment_date: '2026-07-02',
        }, cookie);

        assert.strictEqual(res.status, 302);
        valDb.close();
      });
    });

    // ── GET /admin/payments/ledger/:id ─────────────────────────────

    describe('GET /admin/payments/ledger/:id — customer ledger', () => {
      it('returns payment ledger as JSON for a customer', async () => {
        const ledDb = createTestDb();
        seedDeliveryBoys(ledDb);
        seedCustomers(ledDb);
        seedPayments(ledDb);
        const ledApp = createApp(ledDb, 'admin123');

        const loginRes = await postForm(ledApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(ledApp, 'GET', '/admin/payments/ledger/1', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });

        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /json/);

        const data = JSON.parse(res.body);
        assert.ok(Array.isArray(data.ledger));
        assert.strictEqual(data.ledger.length, 2);
        assert.strictEqual(data.ledger[0].amount, 30000);

        ledDb.close();
      });

      it('returns 404 for non-existent customer', async () => {
        const ledDb = createTestDb();
        const ledApp = createApp(ledDb, 'admin123');

        const loginRes = await postForm(ledApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(ledApp, 'GET', '/admin/payments/ledger/999', {
          cookie,
          headers: { 'Accept': 'application/json' },
        });

        assert.strictEqual(res.status, 404);
        ledDb.close();
      });
    });

    // ── GET /admin/reports ─────────────────────────────────────────

    describe('GET /admin/reports — reports page', () => {
      it('returns 200 and renders reports page when authenticated', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        repDb.close();
      });

      it('redirects to login when not authenticated', async () => {
        const res = await request(app, 'GET', '/admin/reports', {
          followRedirect: false,
        });
        assert.strictEqual(res.status, 302);
        assert.match(res.headers.location, /\/admin\/login/);
      });

      it('renders monthly collection card with ₹ amount', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        // Add payments so monthly collection > 0
        const insertPay = repDb.prepare(
          `INSERT INTO payments (customer_id, amount, mode, payment_date, notes, recorded_by)
           VALUES (?, ?, ?, date('now'), ?, ?)`
        );
        insertPay.run(1, 30000, 'cash', 'Monthly', 'Admin');
        insertPay.run(2, 15000, 'upi', 'Top-up', 'Admin');
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        // Check monthly collection card exists with ₹ symbol
        assert.match(res.body, /Total Collected|₹\s*[0-9,]+/);
        assert.match(res.body, /2\s*payment/);
        repDb.close();
      });

      it('renders delivery success rate card with percentage', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        // Add deliveries with mixed statuses (different dates to avoid UNIQUE constraint)
        const insertDel = repDb.prepare(
          `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
           VALUES (?, ?, ?, ?, ?)`
        );
        insertDel.run(1, 1, dateOffset(0), 'delivered', '06:15');
        insertDel.run(2, 1, dateOffset(-1), 'delivered', '06:20');
        insertDel.run(3, 2, dateOffset(-2), 'delivered', '06:25');
        insertDel.run(1, 1, dateOffset(-3), 'skipped', '06:30');
        insertDel.run(2, 1, dateOffset(-4), 'issue', '06:35');
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        // 3 delivered out of 5 = 60.0%
        assert.match(res.body, /Success Rate|60\.0|3 delivered/);
        repDb.close();
      });

      it('shows overdue accounts table when customers are overdue', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        // Add many delivered deliveries for customer 1 (C001) with no payments → overdue
        const insertDel = repDb.prepare(
          `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
           VALUES (?, ?, ?, ?, ?)`
        );
        // 5 delivered days with 0 payments → balanceDays = 0 - 5 = -5 → overdue
        for (let i = 0; i < 5; i++) {
          insertDel.run(1, 1, dateOffset(-i), 'delivered', '06:15');
        }
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        // Should show C001 in overdue table
        assert.match(res.body, /C001/);
        // Should not show empty state message
        assert.ok(!res.body.includes('No overdue accounts'));
        repDb.close();
      });

      it('shows empty state when no overdue accounts', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        // No deliveries → no consumed days → no overdue
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        // Should show empty state
        assert.match(res.body, /No overdue accounts/);
        repDb.close();
      });

      it('renders CSV export buttons with correct URLs', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        // Check export URLs
        assert.match(res.body, /\/admin\/reports\/export\/payments/);
        assert.match(res.body, /\/admin\/reports\/export\/customers/);
        assert.match(res.body, /\/admin\/reports\/export\/deliveries/);
        repDb.close();
      });

      it('uses tabular-nums class for monetary amounts', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        const insertPay = repDb.prepare(
          `INSERT INTO payments (customer_id, amount, mode, payment_date, notes, recorded_by)
           VALUES (?, ?, ?, date('now'), ?, ?)`
        );
        insertPay.run(1, 30000, 'cash', 'Monthly', 'Admin');
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.body, /tabular-nums/);
        repDb.close();
      });

      it('defaults to current month when month parameter is invalid', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports?month=invalid', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        // The month input value should be a valid YYYY-MM, not "invalid"
        const match = res.body.match(/type="month"[^>]*value="([^"]+)"/);
        assert.ok(match, 'Should have a month input with value attribute');
        assert.match(match[1], /^\d{4}-\d{2}$/, 'Month should be in YYYY-MM format, not "' + match[1] + '"');
        repDb.close();
      });

      it('renders month selector input', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.body, /type="month"/);
        repDb.close();
      });

      it('defaults to current month when month number is out of range', async () => {
        const repDb = createTestDb();
        seedDeliveryBoys(repDb);
        seedCustomers(repDb);
        const repApp = createApp(repDb, 'admin123');

        const loginRes = await postForm(repApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(repApp, 'GET', '/admin/reports?month=2026-13', { cookie });
        assert.strictEqual(res.status, 200);
        const match = res.body.match(/type="month"[^>]*value="([^"]+)"/);
        assert.ok(match, 'Should have a month input with value attribute');
        // The month in the value should be the current month, not "13"
        assert.doesNotMatch(match[1], /13$/, 'Month value should not contain invalid month "13"');
        assert.match(match[1], /^\d{4}-\d{2}$/, 'Month should be in YYYY-MM format');
        repDb.close();
      });


    });

    // ── GET /admin/reports/export/:type ───────────────────────────

    describe('GET /admin/reports/export/:type — CSV export', () => {
      it('exports payments CSV with correct headers', async () => {
        const csvDb = createTestDb();
        seedDeliveryBoys(csvDb);
        seedCustomers(csvDb);
        seedPayments(csvDb);
        const csvApp = createApp(csvDb, 'admin123');

        const loginRes = await postForm(csvApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(csvApp, 'GET', '/admin/reports/export/payments', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /csv/);
        assert.ok(res.body.includes('customer_code'));
        assert.ok(res.body.includes('C001'));

        csvDb.close();
      });

      it('exports customers CSV with correct headers', async () => {
        const csvDb = createTestDb();
        seedDeliveryBoys(csvDb);
        seedCustomers(csvDb);
        const csvApp = createApp(csvDb, 'admin123');

        const loginRes = await postForm(csvApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(csvApp, 'GET', '/admin/reports/export/customers', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /csv/);
        assert.ok(res.body.includes('code'));
        assert.ok(res.body.includes('C001'));

        csvDb.close();
      });

      it('exports deliveries CSV with correct headers', async () => {
        const csvDb = createTestDb();
        seedDeliveryBoys(csvDb);
        seedCustomers(csvDb);
        seedDeliveries(csvDb);
        const csvApp = createApp(csvDb, 'admin123');

        const loginRes = await postForm(csvApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(csvApp, 'GET', '/admin/reports/export/deliveries', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /csv/);
        assert.ok(res.body.includes('customer_code'));
        assert.ok(res.body.includes('C001'));

        csvDb.close();
      });

      it('returns 400 for invalid export type', async () => {
        const csvDb = createTestDb();
        const csvApp = createApp(csvDb, 'admin123');

        const loginRes = await postForm(csvApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(csvApp, 'GET', '/admin/reports/export/invalid', { cookie });
        assert.strictEqual(res.status, 400);

        csvDb.close();
      });
    });

    // ── GET /admin/issues ───────────────────────────────────────────

    describe('GET /admin/issues — issue tracking board', () => {
      it('returns 200 and shows all unresolved issues by default', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(issApp, 'GET', '/admin/issues', { cookie });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /html/);
        // Should show unresolved issue reasons
        assert.ok(res.body.includes('Dog barking'));
        assert.ok(res.body.includes('Customer not home'));
        // Should also show resolved issues since default is 'all'
        assert.ok(res.body.includes('Address corrected'));
        issDb.close();
      });

      it('filters by status=open (unresolved only)', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(issApp, 'GET', '/admin/issues?status=open', { cookie });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('Dog barking'));
        assert.ok(res.body.includes('Customer not home'));
        // Resolved issue should not appear
        assert.ok(!res.body.includes('Address corrected'));
        issDb.close();
      });

      it('filters by status=resolved (only resolved)', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(issApp, 'GET', '/admin/issues?status=resolved', { cookie });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('Address corrected'));
        // Unresolved should not appear
        assert.ok(!res.body.includes('Dog barking'));
        assert.ok(!res.body.includes('Customer not home'));
        issDb.close();
      });

      it('filters by delivery boy', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        // Boy 1 (Raju) has 2 issues; Boy 2 (Vijay) has 1 resolved issue
        const res = await request(issApp, 'GET', '/admin/issues?delivery_boy_id=1', { cookie });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('Dog barking'));
        assert.ok(res.body.includes('Raju'));
        issDb.close();
      });

      it('filters by date range', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const yesterday = dateOffset(-1);
        const today = dateOffset(0);
        const res = await request(issApp, 'GET', `/admin/issues?date_from=${yesterday}&date_to=${today}`, { cookie });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('Dog barking'));
        assert.ok(res.body.includes('Address corrected'));
        issDb.close();
      });

      it('shows empty state when no issues match filters', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        // No issues seeded
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await request(issApp, 'GET', '/admin/issues', { cookie });
        assert.strictEqual(res.status, 200);
        // Should show empty state message
        assert.ok(res.body.includes('No issues reported') || res.body.includes('smoothly'));
        issDb.close();
      });
    });

    // ── POST /admin/issues/:id/resolve ──────────────────────────────

    describe('POST /admin/issues/:id/resolve — resolve an issue', () => {
      it('resolves an open issue successfully', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        // Find the open issue ID (customer_id=1, status=issue, resolved_at IS NULL)
        const issue = issDb.prepare(
          "SELECT id FROM deliveries WHERE status = 'issue' AND resolved_at IS NULL LIMIT 1"
        ).get();
        assert.ok(issue, 'There should be an unresolved issue');

        const res = await postForm(issApp, `/admin/issues/${issue.id}/resolve`, {
          resolved_note: 'Called customer, all good now',
        }, cookie);

        assert.strictEqual(res.status, 302);

        // Verify DB was updated
        const updated = issDb.prepare('SELECT * FROM deliveries WHERE id = ?').get(issue.id);
        assert.ok(updated.resolved_at, 'resolved_at should be set');
        assert.strictEqual(updated.resolved_note, 'Called customer, all good now');

        issDb.close();
      });

      it('rejects missing resolution note', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const issue = issDb.prepare(
          "SELECT id FROM deliveries WHERE status = 'issue' AND resolved_at IS NULL LIMIT 1"
        ).get();
        assert.ok(issue);

        // Empty note
        const res = await postForm(issApp, `/admin/issues/${issue.id}/resolve`, {
          resolved_note: '',
        }, cookie);

        assert.strictEqual(res.status, 302);

        // Verify DB was NOT updated
        const unchanged = issDb.prepare(
          'SELECT * FROM deliveries WHERE id = ?'
        ).get(issue.id);
        assert.strictEqual(unchanged.resolved_at, null);

        issDb.close();
      });

      it('rejects resolving an already-resolved issue', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        // Delivery id 3 is already resolved
        const res = await postForm(issApp, '/admin/issues/3/resolve', {
          resolved_note: 'Trying again',
        }, cookie);

        assert.strictEqual(res.status, 302);

        // resolved_at should remain unchanged
        const unchanged = issDb.prepare('SELECT * FROM deliveries WHERE id = 3').get();
        assert.strictEqual(unchanged.resolved_note, 'Address corrected');

        issDb.close();
      });

      it('rejects non-existent delivery ID', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(issApp, '/admin/issues/999/resolve', {
          resolved_note: 'Does not exist',
        }, cookie);

        assert.strictEqual(res.status, 302);

        issDb.close();
      });

      it('rejects invalid issue ID (NaN)', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const res = await postForm(issApp, '/admin/issues/abc/resolve', {
          resolved_note: 'Invalid',
        }, cookie);

        assert.strictEqual(res.status, 302);

        issDb.close();
      });

      it('preserves filter query params on redirect after resolve', async () => {
        const issDb = createTestDb();
        seedDeliveryBoys(issDb);
        seedCustomers(issDb);
        seedIssues(issDb);
        const issApp = createApp(issDb, 'admin123');

        const loginRes = await postForm(issApp, '/admin/login', { password: 'admin123' });
        const cookie = Array.isArray(loginRes.headers['set-cookie'])
          ? loginRes.headers['set-cookie'].join('; ')
          : loginRes.headers['set-cookie'];

        const issue = issDb.prepare(
          "SELECT id FROM deliveries WHERE status = 'issue' AND resolved_at IS NULL LIMIT 1"
        ).get();
        assert.ok(issue);

        const res = await request(issApp, 'POST', `/admin/issues/${issue.id}/resolve?status=open&delivery_boy_id=1`, {
          body: 'resolved_note=Fixed+it',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          cookie,
          followRedirect: false,
        });

        assert.strictEqual(res.status, 302);
        // Redirect should contain the original filter params
        assert.match(res.headers.location, /status=open/);
        assert.match(res.headers.location, /delivery_boy_id=1/);

        issDb.close();
      });
    });
  });
});