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

    CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
    CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
    CREATE INDEX idx_deliveries_status ON deliveries(status);
    CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
  `);

  return db;
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
  });
});