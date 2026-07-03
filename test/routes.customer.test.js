/**
 * Tests for routes/customer.js — Customer portal route handlers.
 *
 * Uses an in-memory SQLite database and Express app for isolation.
 * Run with: node --test test/routes.customer.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

// This import will fail until routes/customer.js exists (RED)
const { setupCustomerRoutes } = require('../routes/customer');

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

    CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
  `);

  return db;
}

function seedFullDataSet(db) {
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, region) VALUES (?, ?, ?, ?)`
  ).run(1, 'Raju', '9876543210', 'North');

  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status, token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'C001', 'Ram', '9000000001', '123 Main St', 1, 30000, 'active', 'tok_ram_001');

  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-10 days'), date('now', '+20 days'), 30, 20, 'active')`
  ).run(1);
}

function seedInactiveCustomer(db) {
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status, token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(2, 'C002', 'Shyam', '9000000002', '456 Oak Ave', 1, 30000, 'inactive', 'tok_shyam_002');
}

function seedPausedSubscription(db) {
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status, paused_until)
     VALUES (?, date('now', '-20 days'), date('now', '+10 days'), 30, 15, 'paused', date('now', '+5 days'))`
  ).run(1);
}

// ─── Express app factory ─────────────────────────────────────────

function createApp(db) {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  setupCustomerRoutes(app, db);

  return app;
}

// ─── HTTP request helper ─────────────────────────────────────────

function request(app, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(options.headers || {}),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body });
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

function postForm(app, path, data) {
  const body = Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

  return request(app, 'POST', path, {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function tomorrowStr() {
  return new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

// ─── Tests ───────────────────────────────────────────────────────

describe('routes/customer.js — setupCustomerRoutes', () => {
  // ── GET /my-account/:token ─────────────────────────────────────

  describe('GET /my-account/:token', () => {
    it('returns 200 and renders portal for a valid token', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await request(app, 'GET', '/my-account/tok_ram_001');

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_ok":true/);
      assert.match(res.body, /"name":"Ram"/);
      assert.match(res.body, /"code":"C001"/);
      assert.match(res.body, /"boy":"Raju"/);
      assert.match(res.body, /"status":"active"/);
      assert.match(res.body, /"remaining":20/);

      db.close();
    });

    it('returns error:true for an invalid token', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await request(app, 'GET', '/my-account/invalid_token_here');

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('returns error:true for an inactive customer', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      seedInactiveCustomer(db);
      const app = createApp(db);

      const res = await request(app, 'GET', '/my-account/tok_shyam_002');

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('shows today delivery status when a delivery exists', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      // Add a delivery for today
      db.prepare(
        `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
         VALUES (?, ?, date('now'), 'delivered')`
      ).run(1, 1);
      const app = createApp(db);

      const res = await request(app, 'GET', '/my-account/tok_ram_001');

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"today":"delivered"/);

      db.close();
    });
  });

  // ── POST /my-account/:token/pause ──────────────────────────────

  describe('POST /my-account/:token/pause', () => {
    it('pauses subscription with valid future dates', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const start = tomorrowStr();
      const end = daysFromNow(3);

      const res = await postForm(app, '/my-account/tok_ram_001/pause', {
        start_date: start,
        end_date: end,
      });

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_ok":true/);
      assert.match(res.body, /"pauseSuccess":true/);
      assert.match(res.body, /"pauseEndDate":"/);

      // Verify DB was updated
      const sub = db.prepare('SELECT * FROM subscriptions WHERE customer_id = 1').get();
      assert.strictEqual(sub.status, 'paused');

      db.close();
    });

    it('returns error:true for invalid token', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await postForm(app, '/my-account/invalid_token/pause', {
        start_date: tomorrowStr(),
        end_date: daysFromNow(3),
      });

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('returns error:true for missing dates', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await postForm(app, '/my-account/tok_ram_001/pause', {});

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('returns error:true for past start_date', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await postForm(app, '/my-account/tok_ram_001/pause', {
        start_date: '2020-01-01',
        end_date: '2020-01-05',
      });

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('returns error:true when end_date is not after start_date', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const start = tomorrowStr();

      const res = await postForm(app, '/my-account/tok_ram_001/pause', {
        start_date: start,
        end_date: start,
      });

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('returns error:true for already paused subscription', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      // Update the active subscription to paused (no separate add)
      db.prepare(
        "UPDATE subscriptions SET status = 'paused', paused_until = date('now', '+5 days') WHERE customer_id = 1"
      ).run();
      const app = createApp(db);

      const res = await postForm(app, '/my-account/tok_ram_001/pause', {
        start_date: tomorrowStr(),
        end_date: daysFromNow(3),
      });

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });
  });

  // ── POST /my-account/:token/resume ─────────────────────────────

  describe('POST /my-account/:token/resume', () => {
    it('resumes a paused subscription', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      seedPausedSubscription(db);
      const app = createApp(db);

      const res = await postForm(app, '/my-account/tok_ram_001/resume', {});

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_ok":true/);
      assert.match(res.body, /"resumeSuccess":true/);

      // Verify DB was updated
      const sub = db.prepare('SELECT * FROM subscriptions WHERE customer_id = 1').get();
      assert.strictEqual(sub.status, 'active');
      assert.strictEqual(sub.paused_until, null);

      db.close();
    });

    it('returns error:true for invalid token', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await postForm(app, '/my-account/invalid_token/resume', {});

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });

    it('returns error:true for active (non-paused) subscription', async () => {
      const db = createTestDb();
      seedFullDataSet(db);
      const app = createApp(db);

      const res = await postForm(app, '/my-account/tok_ram_001/resume', {});

      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"_error":true/);

      db.close();
    });
  });
});