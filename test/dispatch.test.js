/**
 * Tests for services/dispatch.js — dispatch generation and route queries.
 *
 * Uses an in-memory SQLite database for isolation.
 * Run with: node --test test/dispatch.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Import will fail until services/dispatch.js exists (RED)
const {
  dispatchExistsForToday,
  generateDispatch,
  getTodaysRouteForBoy,
} = require('../services/dispatch');

// ─── Helpers ────────────────────────────────────────────────────

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

function seedTestData(db) {
  // Insert delivery boys
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, region) VALUES (?, ?, ?, ?)`
  ).run(1, 'Raju', '9876543210', 'North');
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, region) VALUES (?, ?, ?, ?)`
  ).run(2, 'Vijay', '9876543211', 'South');

  // Insert customers (active + inactive)
  // Boy 1: 3 active customers
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'C001', 'Ram', '9000000001', '123 Main St', 1, 300000, 'active');
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(2, 'C002', 'Shyam', '9000000002', '456 Oak Ave', 1, 300000, 'active');
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(3, 'C003', 'Gita', '9000000003', '789 Pine Rd', 1, 300000, 'active');

  // Boy 2: 2 active customers
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(4, 'C004', 'Sita', '9000000004', '321 Elm St', 2, 300000, 'active');
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(5, 'C005', 'Mohan', '9000000005', '654 Birch Ln', 2, 300000, 'active');

  // Boy 1: 1 inactive customer (should NOT appear in dispatch)
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(6, 'C006', 'InactiveUser', '9000000006', '999 Dead St', 1, 300000, 'inactive');

  // Active subscriptions for all active customers
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
  ).run(1);
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
  ).run(2);
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
  ).run(3);
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
  ).run(4);
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
  ).run(5);
}

// ─── Tests ──────────────────────────────────────────────────────

describe('generateDispatch', () => {
  let db;

  before(() => {
    db = createTestDb();
    seedTestData(db);
  });

  after(() => {
    db.close();
  });

  it('generates dispatch for today when none exists', () => {
    const result = generateDispatch(db);

    assert.strictEqual(result.generated, true);
    assert.strictEqual(result.count, 5); // 5 active customers
  });

  it('is idempotent — second call returns generated: false', () => {
    const result = generateDispatch(db);

    assert.strictEqual(result.generated, false);
    assert.strictEqual(result.count, 0);
  });

  it('creates deliveries with pending status', () => {
    const deliveries = db.prepare(
      'SELECT status, customer_id FROM deliveries WHERE delivery_date = date(\'now\')'
    ).all();

    assert.strictEqual(deliveries.length, 5);
    for (const d of deliveries) {
      assert.strictEqual(d.status, 'pending');
    }
  });

  it('does not include inactive customers', () => {
    const inactiveInDispatch = db.prepare(
      `SELECT d.id FROM deliveries d
       JOIN customers c ON d.customer_id = c.id
       WHERE d.delivery_date = date('now') AND c.status = 'inactive'`
    ).all();

    assert.strictEqual(inactiveInDispatch.length, 0);
  });
});

describe('dispatchExistsForToday', () => {
  let db;

  before(() => {
    db = createTestDb();
    // No seed — empty DB
  });

  after(() => {
    db.close();
  });

  it('returns false when no dispatch exists for today', () => {
    const result = dispatchExistsForToday(db);
    assert.strictEqual(result, false);
  });

  it('returns true after dispatch is generated', () => {
    seedTestData(db);
    generateDispatch(db);
    const result = dispatchExistsForToday(db);
    assert.strictEqual(result, true);
  });
});

describe('getTodaysRouteForBoy', () => {
  let db;

  before(() => {
    db = createTestDb();
    seedTestData(db);
    generateDispatch(db);
  });

  after(() => {
    db.close();
  });

  it('returns deliveries for a specific delivery boy', () => {
    const route = getTodaysRouteForBoy(db, 1);

    assert.strictEqual(route.length, 3); // Boy 1 has 3 active customers
    for (const d of route) {
      assert.strictEqual(d.delivery_boy_id, 1);
    }
  });

  it('returns deliveries for a second delivery boy', () => {
    const route = getTodaysRouteForBoy(db, 2);

    assert.strictEqual(route.length, 2); // Boy 2 has 2 active customers
    for (const d of route) {
      assert.strictEqual(d.delivery_boy_id, 2);
    }
  });

  it('returns empty array for a boy with no deliveries today', () => {
    const route = getTodaysRouteForBoy(db, 999);
    assert.strictEqual(route.length, 0);
  });

  it('returns delivery objects with customer details', () => {
    const route = getTodaysRouteForBoy(db, 1);

    const delivery = route[0];
    // Must include customer info and status
    assert.ok(delivery.customer_code);
    assert.ok(delivery.customer_name);
    assert.ok(delivery.address);
    assert.ok(delivery.status);
    assert.ok(delivery.delivery_date);
  });
});