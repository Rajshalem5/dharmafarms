/**
 * Tests for services/scheduler.js — route push scheduling and admin summary.
 *
 * Uses an in-memory SQLite database for isolation.
 * Run with: node --test test/scheduler.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Import will fail until services/scheduler.js exists (RED)
const {
  hasEventRunToday,
  routesPushedForToday,
  pushRoutesToAllBoys,
  sendDailySummaryToAdmin,
} = require('../services/scheduler');

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

    CREATE TABLE scheduler_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      log_date TEXT NOT NULL,
      executed_at TEXT DEFAULT (datetime('now')),
      details TEXT,
      UNIQUE(type, log_date)
    );

    CREATE INDEX idx_deliveries_date ON deliveries(delivery_date);
    CREATE INDEX idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
    CREATE INDEX idx_deliveries_status ON deliveries(status);
  `);

  return db;
}

function seedTestData(db) {
  // Insert delivery boys — 3 with telegram_chat_id, 1 without, 1 inactive
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(1, 'Raju', '9876543210', 123456001, 'North', 'active');
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(2, 'Vijay', '9876543211', 123456002, 'South', 'active');
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(3, 'Priya', '9876543212', 123456003, 'East', 'active');
  // Boy 4: active but no telegram_chat_id
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, region, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(4, 'Arun', '9876543213', 'West', 'active');
  // Boy 5: inactive with telegram_chat_id
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(5, 'Suresh', '9876543214', 123456005, 'Central', 'inactive');

  // Insert customers — boy 1: 2, boy 2: 2, boy 3: 1, all active
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
  ).run(3, 'C003', 'Gita', '9000000003', '789 Pine Rd', 2, 300000, 'active');
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(4, 'C004', 'Sita', '9000000004', '321 Elm St', 2, 300000, 'active');
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(5, 'C005', 'Mohan', '9000000005', '654 Birch Ln', 3, 300000, 'active');

  // Active subscriptions for all customers
  for (let i = 1; i <= 5; i++) {
    db.prepare(
      `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
       VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
    ).run(i);
  }

  // Generate today's deliveries (simulating dispatch)
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), ?)`
  ).run(1, 1, 'delivered');   // Boy 1 — delivered
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), ?)`
  ).run(2, 1, 'pending');     // Boy 1 — pending
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), ?)`
  ).run(3, 2, 'delivered');   // Boy 2 — delivered
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), ?)`
  ).run(4, 2, 'skipped');     // Boy 2 — skipped
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), ?)`
  ).run(5, 3, 'issue');       // Boy 3 — issue
}

function createMockBot() {
  const sentMessages = [];
  return {
    sendMessage: async (chatId, text) => {
      sentMessages.push({ chatId, text });
      return {};
    },
    getSentMessages: () => sentMessages,
    resetMessages: () => { sentMessages.length = 0; },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('hasEventRunToday', () => {
  let db;

  before(() => {
    db = createTestDb();
  });

  after(() => {
    db.close();
  });

  it('returns false when no event logged for today', () => {
    const result = hasEventRunToday(db, 'route_push');
    assert.strictEqual(result, false);
  });

  it('returns true after event is logged', () => {
    db.prepare(
      `INSERT INTO scheduler_log (type, log_date) VALUES (?, date('now'))`
    ).run('route_push');

    const result = hasEventRunToday(db, 'route_push');
    assert.strictEqual(result, true);
  });

  it('returns false for a different type', () => {
    const result = hasEventRunToday(db, 'admin_summary');
    assert.strictEqual(result, false);
  });
});

describe('routesPushedForToday', () => {
  let db;

  before(() => {
    db = createTestDb();
  });

  after(() => {
    db.close();
  });

  it('returns false when no route_push logged today', () => {
    const result = routesPushedForToday(db);
    assert.strictEqual(result, false);
  });

  it('returns true after route_push is logged', () => {
    db.prepare(
      `INSERT INTO scheduler_log (type, log_date) VALUES (?, date('now'))`
    ).run('route_push');

    const result = routesPushedForToday(db);
    assert.strictEqual(result, true);
  });
});

describe('pushRoutesToAllBoys', () => {
  let db;
  let bot;

  before(() => {
    db = createTestDb();
    seedTestData(db);
    bot = createMockBot();
  });

  after(() => {
    db.close();
  });

  it('sends route message to active boys with telegram_chat_id', async () => {
    const result = await pushRoutesToAllBoys(db, bot);

    assert.strictEqual(result.sent, 3); // 3 active boys with chat_id
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.pushed, true);
    assert.deepStrictEqual(result.errors, []);

    // Verify messages sent to correct chat IDs
    const messages = bot.getSentMessages();
    assert.strictEqual(messages.length, 3);

    const chatIds = messages.map(m => m.chatId).sort();
    assert.deepStrictEqual(chatIds, [123456001, 123456002, 123456003]);
  });

  it('is idempotent — second call does not push again', async () => {
    bot.resetMessages();

    const result = await pushRoutesToAllBoys(db, bot);

    assert.strictEqual(result.pushed, false);
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.failed, 0);

    const messages = bot.getSentMessages();
    assert.strictEqual(messages.length, 0);
  });

  it('sends messages containing /route command', async () => {
    // Clear scheduler_log to test again
    db.prepare('DELETE FROM scheduler_log').run();
    bot.resetMessages();

    const result = await pushRoutesToAllBoys(db, bot);
    assert.strictEqual(result.pushed, true);

    const messages = bot.getSentMessages();
    for (const msg of messages) {
      assert.ok(msg.text.includes('/route'), 'Message should contain /route');
    }
  });

  it('includes customer details in route message', async () => {
    db.prepare('DELETE FROM scheduler_log').run();
    bot.resetMessages();

    const result = await pushRoutesToAllBoys(db, bot);
    assert.strictEqual(result.pushed, true);

    const messages = bot.getSentMessages();
    // Boy 1 has 2 customers (Ram, Shyam)
    const boy1Msg = messages.find(m => m.chatId === 123456001);
    assert.ok(boy1Msg, 'Should have message for boy 1');
    assert.ok(boy1Msg.text.includes('Ram'), 'Should include Ram');
    assert.ok(boy1Msg.text.includes('Shyam'), 'Should include Shyam');
  });

  it('handles bot sendMessage failure gracefully', async () => {
    db.prepare('DELETE FROM scheduler_log').run();
    bot.resetMessages();

    // Replace sendMessage with one that fails for one chat ID
    const originalSend = bot.sendMessage;
    bot.sendMessage = async (chatId, text) => {
      if (chatId === 123456001) {
        throw new Error('Network error');
      }
      return originalSend.call(bot, chatId, text);
    };

    const result = await pushRoutesToAllBoys(db, bot);
    assert.strictEqual(result.sent, 2); // 2 succeeded
    assert.strictEqual(result.failed, 1); // 1 failed
    assert.strictEqual(result.pushed, true);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Network error'));

    // Restore original
    bot.sendMessage = originalSend;
  });
});

describe('sendDailySummaryToAdmin', () => {
  let db;
  let bot;
  const originalAdminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;

  before(() => {
    db = createTestDb();
    seedTestData(db);
    bot = createMockBot();
    process.env.ADMIN_TELEGRAM_CHAT_ID = '999999999';
  });

  after(() => {
    db.close();
    if (originalAdminChatId === undefined) {
      delete process.env.ADMIN_TELEGRAM_CHAT_ID;
    } else {
      process.env.ADMIN_TELEGRAM_CHAT_ID = originalAdminChatId;
    }
  });

  it('sends summary with correct total deliveries', async () => {
    const result = await sendDailySummaryToAdmin(db, bot);

    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.total, 5); // 5 deliveries today
  });

  it('includes status breakdown in message', async () => {
    const messages = bot.getSentMessages();
    const summaryMsg = messages.find(m => String(m.chatId) === '999999999');
    assert.ok(summaryMsg, 'Should have a message to admin');

    // Should mention status counts (case-insensitive)
    assert.ok(summaryMsg.text.toLowerCase().includes('delivered'), 'Should mention delivered');
    assert.ok(summaryMsg.text.toLowerCase().includes('pending'), 'Should mention pending');
    assert.ok(summaryMsg.text.toLowerCase().includes('issue'), 'Should mention issues');
    assert.ok(summaryMsg.text.toLowerCase().includes('skipped'), 'Should mention skipped');
  });

  it('is idempotent — second call does not send again', async () => {
    bot.resetMessages();

    const result = await sendDailySummaryToAdmin(db, bot);

    assert.strictEqual(result.sent, false);
    const messages = bot.getSentMessages();
    assert.strictEqual(messages.length, 0);
  });

  it('handles missing ADMIN_TELEGRAM_CHAT_ID gracefully', async () => {
    delete process.env.ADMIN_TELEGRAM_CHAT_ID;
    db.prepare('DELETE FROM scheduler_log').run();
    bot.resetMessages();

    const result = await sendDailySummaryToAdmin(db, bot);

    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.total, 5);

    const messages = bot.getSentMessages();
    assert.strictEqual(messages.length, 0);
  });
});