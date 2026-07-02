/**
 * Tests for services/subscription.js — Payment ledger and balance logic.
 *
 * Uses an in-memory SQLite database for isolation.
 * Run with: node --test test/subscription.test.js
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// This import will fail until services/subscription.js exists (RED)
const {
  getBalance,
  getPaymentLedger,
  recordPayment,
  getPaymentModes,
} = require('../services/subscription');

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

function seedSimpleData(db) {
  // Insert a delivery boy
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, region) VALUES (?, ?, ?, ?)`
  ).run(1, 'Raju', '9876543210', 'North');

  // Insert a customer with monthly_rate = 30000 paise (Rs 300)
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'C001', 'Ram', '9000000001', '123 Main St', 1, 30000, 'active');

  // Active subscription
  db.prepare(
    `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
     VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
  ).run(1);
}

// ─── Tests ──────────────────────────────────────────────────────

describe('getPaymentModes', () => {
  it('returns array of valid payment modes', () => {
    const modes = getPaymentModes();
    assert.deepStrictEqual(modes, ['cash', 'upi', 'bank_transfer']);
  });

  it('is a pure function — always returns same array', () => {
    const modes1 = getPaymentModes();
    const modes2 = getPaymentModes();
    assert.deepStrictEqual(modes1, modes2);
    assert.strictEqual(modes1.length, 3);
  });
});

describe('recordPayment', () => {
  let db;

  before(() => {
    db = createTestDb();
    seedSimpleData(db);
  });

  after(() => {
    db.close();
  });

  it('inserts a payment and returns the new row id', () => {
    const result = recordPayment(db, {
      customerId: 1,
      amount: 30000,  // Rs 300 in paise
      mode: 'cash',
      paymentDate: '2026-07-02',
      notes: 'Monthly payment',
      recordedBy: 'Admin',
    });

    assert.ok(result.id, 'Should return an id');
    assert.strictEqual(typeof result.id, 'number');

    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(result.id);
    assert.ok(row);
    assert.strictEqual(row.amount, 30000);
    assert.strictEqual(row.mode, 'cash');
    assert.strictEqual(row.notes, 'Monthly payment');
    assert.strictEqual(row.recorded_by, 'Admin');
  });

  it('rejects zero amount', () => {
    assert.throws(() => {
      recordPayment(db, {
        customerId: 1,
        amount: 0,
        mode: 'cash',
        paymentDate: '2026-07-02',
      });
    }, /amount must be greater than 0/i);
  });

  it('rejects negative amount', () => {
    assert.throws(() => {
      recordPayment(db, {
        customerId: 1,
        amount: -100,
        mode: 'cash',
        paymentDate: '2026-07-02',
      });
    }, /amount must be greater than 0/i);
  });

  it('rejects invalid payment mode', () => {
    assert.throws(() => {
      recordPayment(db, {
        customerId: 1,
        amount: 30000,
        mode: 'credit_card',
        paymentDate: '2026-07-02',
      });
    }, /invalid payment mode/i);
  });

  it('rejects missing customerId', () => {
    assert.throws(() => {
      recordPayment(db, {
        amount: 30000,
        mode: 'cash',
        paymentDate: '2026-07-02',
      });
    }, /customer/i);
  });

  it('rejects missing paymentDate', () => {
    assert.throws(() => {
      recordPayment(db, {
        customerId: 1,
        amount: 30000,
        mode: 'cash',
      });
    }, /payment date/i);
  });

  it('uses defaults for optional fields', () => {
    const result = recordPayment(db, {
      customerId: 1,
      amount: 15000,
      mode: 'upi',
      paymentDate: '2026-07-02',
    });

    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(result.id);
    assert.strictEqual(row.notes, '');
    assert.strictEqual(row.recorded_by, 'Admin');
  });
});

describe('getPaymentLedger', () => {
  let db;

  before(() => {
    db = createTestDb();
    seedSimpleData(db);

    // Insert 3 payments for customer 1
    const insertPayment = db.prepare(
      `INSERT INTO payments (customer_id, amount, mode, payment_date, notes, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    insertPayment.run(1, 10000, 'cash', '2026-07-01', 'First payment', 'Admin');
    insertPayment.run(1, 15000, 'upi', '2026-07-05', 'Second payment', 'Admin');
    insertPayment.run(1, 5000, 'bank_transfer', '2026-07-10', 'Third payment', 'Admin');
  });

  after(() => {
    db.close();
  });

  it('returns payments in chronological order with running totals', () => {
    const ledger = getPaymentLedger(db, 1);

    assert.strictEqual(ledger.length, 3);
    assert.strictEqual(ledger[0].amount, 10000);
    assert.strictEqual(ledger[0].runningTotalPaise, 10000);
    assert.strictEqual(ledger[0].runningTotalRupees, '100.00');

    assert.strictEqual(ledger[1].amount, 15000);
    assert.strictEqual(ledger[1].runningTotalPaise, 25000);
    assert.strictEqual(ledger[1].runningTotalRupees, '250.00');

    assert.strictEqual(ledger[2].amount, 5000);
    assert.strictEqual(ledger[2].runningTotalPaise, 30000);
    assert.strictEqual(ledger[2].runningTotalRupees, '300.00');
  });

  it('returns empty array when customer has no payments', () => {
    const ledger = getPaymentLedger(db, 999);
    assert.deepStrictEqual(ledger, []);
  });

  it('includes amount_rupees field on each row', () => {
    const ledger = getPaymentLedger(db, 1);
    assert.strictEqual(ledger[0].amount_rupees, '100.00');
    assert.strictEqual(ledger[1].amount_rupees, '150.00');
    assert.strictEqual(ledger[2].amount_rupees, '50.00');
  });
});

describe('getBalance', () => {
  let db;

  afterEach(() => {
    if (db) db.close();
  });

  it('returns zero for all fields when no payments and no deliveries exist', () => {
    db = createTestDb();
    seedSimpleData(db);

    const balance = getBalance(db, 1);
    assert.strictEqual(balance.paidDays, 0);
    assert.strictEqual(balance.consumedDays, 0);
    assert.strictEqual(balance.balanceDays, 0);
    assert.strictEqual(balance.isOverdue, false);
  });

  it('calculates positive balance when payment exceeds consumption', () => {
    db = createTestDb();
    seedSimpleData(db);

    // Pay Rs 300 (30000 paise) — equals 30 days at Rs 300/month rate
    db.prepare(
      `INSERT INTO payments (customer_id, amount, mode, payment_date, recorded_by)
       VALUES (?, ?, ?, date('now'), ?)`
    ).run(1, 30000, 'cash', 'Admin');

    // 10 delivered days
    for (let i = 1; i <= 10; i++) {
      db.prepare(
        `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
         VALUES (?, ?, date('now', '-' || ? || ' days'), 'delivered', time('now'))`
      ).run(1, 1, i);
    }

    const balance = getBalance(db, 1);
    assert.strictEqual(balance.paidDays, 30);   // 30000/30000 * 30
    assert.strictEqual(balance.consumedDays, 10);
    assert.strictEqual(balance.balanceDays, 20);
    assert.strictEqual(balance.isOverdue, false);
  });

  it('detects overdue when balance is negative and subscription is active', () => {
    db = createTestDb();
    seedSimpleData(db);

    // Pay only Rs 100 (10000 paise) — ~10 days
    db.prepare(
      `INSERT INTO payments (customer_id, amount, mode, payment_date, recorded_by)
       VALUES (?, ?, ?, date('now'), ?)`
    ).run(1, 10000, 'cash', 'Admin');

    // 15 delivered days
    for (let i = 1; i <= 15; i++) {
      db.prepare(
        `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
         VALUES (?, ?, date('now', '-' || ? || ' days'), 'delivered', time('now'))`
      ).run(1, 1, i);
    }

    const balance = getBalance(db, 1);
    assert.strictEqual(balance.paidDays, 10);    // 10000/30000 * 30 = 10
    assert.strictEqual(balance.consumedDays, 15);
    assert.strictEqual(balance.balanceDays, -5);
    assert.strictEqual(balance.isOverdue, true);
  });

  it('returns isOverdue false when subscription is not active', () => {
    db = createTestDb();
    seedSimpleData(db);

    // Change subscription to inactive
    db.prepare("UPDATE subscriptions SET status = 'paused' WHERE customer_id = 1").run();

    // Pay only Rs 100 (10000 paise) — ~10 days
    db.prepare(
      `INSERT INTO payments (customer_id, amount, mode, payment_date, recorded_by)
       VALUES (?, ?, ?, date('now'), ?)`
    ).run(1, 10000, 'cash', 'Admin');

    // 15 delivered days
    for (let i = 1; i <= 15; i++) {
      db.prepare(
        `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status, marked_at)
         VALUES (?, ?, date('now', '-' || ? || ' days'), 'delivered', time('now'))`
      ).run(1, 1, i);
    }

    const balance = getBalance(db, 1);
    assert.strictEqual(balance.balanceDays, -5);
    assert.strictEqual(balance.isOverdue, false);
  });

  it('returns 0 paidDays when monthly_rate is 0', () => {
    db = createTestDb();
    seedSimpleData(db);

    // Set rate to 0
    db.prepare("UPDATE customers SET monthly_rate = 0 WHERE id = 1").run();

    db.prepare(
      `INSERT INTO payments (customer_id, amount, mode, payment_date, recorded_by)
       VALUES (?, ?, ?, date('now'), ?)`
    ).run(1, 30000, 'cash', 'Admin');

    const balance = getBalance(db, 1);
    assert.strictEqual(balance.paidDays, 0);
  });

  it('returns null subscriptionRemaining when no subscription exists', () => {
    db = createTestDb();
    seedSimpleData(db);

    // Delete the subscription
    db.prepare("DELETE FROM subscriptions WHERE customer_id = 1").run();

    const balance = getBalance(db, 1);
    assert.strictEqual(balance.subscriptionRemaining, null);
    assert.strictEqual(balance.isOverdue, false);
  });
});