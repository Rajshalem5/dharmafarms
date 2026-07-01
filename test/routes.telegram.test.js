/**
 * Tests for routes/telegram.js — Telegram bot command handlers.
 *
 * Uses a mock bot and in-memory SQLite database for isolation.
 * Run with: node --test test/routes.telegram.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// ─── Mock bot factory ─────────────────────────────────────────────

function createMockBot() {
  const handlers = {};
  const sentMessages = [];

  return {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: (chatId, text, options) => {
      sentMessages.push({ chatId, text, options });
      return Promise.resolve(true);
    },
    /** Simulate a text message from a user */
    simulateMessage: (text, chatId = 1001) => {
      const msg = {
        chat: { id: chatId },
        text: text,
        from: { id: chatId, first_name: 'Test', username: 'testuser' },
        date: Math.floor(Date.now() / 1000),
      };
      return handlers.message(msg);
    },
    getMessages: () => sentMessages,
    lastMessage: () => (sentMessages.length > 0 ? sentMessages[sentMessages.length - 1] : null),
    clearMessages: () => { sentMessages.length = 0; },
  };
}

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

function seedTestData(db) {
  // Boy 1: Raju — already registered (has telegram_chat_id), 2 customers
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region) VALUES (?, ?, ?, ?, ?)`
  ).run(1, 'Raju', '9876543210', 1001, 'North');

  // Boy 2: Vijay — NOT registered (no telegram_chat_id), no customers in this test
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region) VALUES (?, ?, ?, ?, ?)`
  ).run(2, 'Vijay', '9876543211', null, 'South');

  // Boy 3: Priya — registered, 1 customer
  db.prepare(
    `INSERT INTO delivery_boys (id, name, phone, telegram_chat_id, region) VALUES (?, ?, ?, ?, ?)`
  ).run(3, 'Priya', '9876543212', 1003, 'East');

  // Customers for Boy 1 (Raju) — 2 active
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, 'C001', 'Ram', '9000000001', '123 Main St', 1, 300000, 'active');
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(2, 'C002', 'Shyam', '9000000002', '456 Oak Ave', 1, 300000, 'active');

  // Customer for Boy 3 (Priya) — 1 active
  db.prepare(
    `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(3, 'C003', 'Gita', '9000000003', '789 Pine Rd', 3, 300000, 'active');

  // Active subscriptions
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

  // Today's deliveries (pending)
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), 'pending')`
  ).run(1, 1); // C001 → Raju
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), 'pending')`
  ).run(2, 1); // C002 → Raju
  db.prepare(
    `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
     VALUES (?, ?, date('now'), 'pending')`
  ).run(3, 3); // C003 → Priya
}

// ─── Tests ────────────────────────────────────────────────────────

describe('routes/telegram.js — setupTelegramBot', () => {
  let bot;
  let testDb;
  let getDb;

  before(() => {
    testDb = createTestDb();
    seedTestData(testDb);
    getDb = () => testDb;

    // This require will fail until routes/telegram.js exists (RED phase)
    const { setupTelegramBot } = require('../routes/telegram');
    bot = createMockBot();
    setupTelegramBot(bot, getDb);
  });

  after(() => {
    testDb.close();
  });

  // ── /start ────────────────────────────────────────────────────────

  describe('/start — register delivery boy', () => {
    it('registers an unregistered boy by phone number', async () => {
      bot.clearMessages();
      // Vijay (boy 2) has no telegram_chat_id, phone=9876543211
      await bot.simulateMessage('/start 9876543211', 2001);

      // Check DB: Vijay's telegram_chat_id should be updated
      const boy = testDb.prepare('SELECT * FROM delivery_boys WHERE id = 2').get();
      assert.strictEqual(boy.telegram_chat_id, 2001, 'telegram_chat_id should be linked');

      // Check response
      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /registered|welcome|success|Raju|Vijay/i, 'Should confirm registration');
    });

    it('rejects if no phone number provided', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/start', 3001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /phone|provide|number/i, 'Should ask for phone number');
    });

    it('rejects unknown phone number', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/start 9999999999', 4001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /not found|no delivery boy|unregistered|invalid/i, 'Should reject unknown phone');
    });

    it('tells already-registered boy they are registered', async () => {
      bot.clearMessages();
      // Raju (boy 1) is already registered with chat_id=1001
      await bot.simulateMessage('/start 9876543210', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /already|registered/i, 'Should indicate already registered');
    });
  });

  // ── /route ────────────────────────────────────────────────────────

  describe('/route — show today\'s route', () => {
    it('returns route for a registered boy with deliveries', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/route', 1001); // Raju

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /Good morning Raju|route/i, 'Should greet the boy');
      assert.match(last.text, /C001.*Ram|C002.*Shyam|C001|C002/, 'Should list customer codes');
      assert.match(last.text, /2 deliveries|2 delivery/i, 'Should show count');
    });

    it('returns route for another registered boy', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/route', 1003); // Priya

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /Good morning Priya|route/i, 'Should greet Priya');
      assert.match(last.text, /C003/, 'Should list C003');
      assert.match(last.text, /1 delivery|1 deliver/i, 'Should show count');
    });

    it('rejects unregistered chat_id', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/route', 9999);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /register|start|unregistered/i, 'Should ask to register first');
    });
  });

  // ── /done ────────────────────────────────────────────────────────

  describe('/done — mark delivery as delivered', () => {
    it('marks a pending delivery as delivered', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/done C001', 1001); // Raju marks C001

      // Check DB
      const delivery = testDb.prepare(`
        SELECT d.*, c.code FROM deliveries d
        JOIN customers c ON c.id = d.customer_id
        WHERE c.code = 'C001' AND d.delivery_date = date('now')
      `).get();
      assert.strictEqual(delivery.status, 'delivered');
      assert.ok(delivery.marked_at, 'Should have marked_at time');

      // Check remaining_days decreased
      const sub = testDb.prepare(
        'SELECT remaining_days FROM subscriptions WHERE customer_id = 1'
      ).get();
      assert.strictEqual(sub.remaining_days, 24, 'remaining_days should decrease by 1');

      // Check response
      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /C001|delivered|✅|Ram/i, 'Should confirm delivery');
    });

    it('rejects duplicate /done with "Already marked delivered at HH:MM"', async () => {
      bot.clearMessages();
      // C001 is already delivered from previous test
      await bot.simulateMessage('/done C001', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /already|marked|delivered/i, 'Should indicate already delivered');
      assert.match(last.text, /\d{2}:\d{2}/, 'Should include time like HH:MM');
    });

    it('rejects /done without customer code', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/done', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /customer code|code|C\d{3}|invalid/i, 'Should ask for customer code');
    });

    it('rejects /done with invalid customer code', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/done C999', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /not found|invalid|doesn't exist/i, 'Should reject unknown code');
    });
  });

  // ── /skip ────────────────────────────────────────────────────────

  describe('/skip — mark delivery as skipped', () => {
    it('marks a pending delivery as skipped', async () => {
      bot.clearMessages();
      // C002 is still pending for Raju
      await bot.simulateMessage('/skip C002', 1001);

      // Check DB
      const delivery = testDb.prepare(`
        SELECT d.*, c.code FROM deliveries d
        JOIN customers c ON c.id = d.customer_id
        WHERE c.code = 'C002' AND d.delivery_date = date('now')
      `).get();
      assert.strictEqual(delivery.status, 'skipped');

      // Check remaining_days increased
      const sub = testDb.prepare(
        'SELECT remaining_days FROM subscriptions WHERE customer_id = 2'
      ).get();
      assert.strictEqual(sub.remaining_days, 26, 'remaining_days should increase by 1');

      // Check response
      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /C002|skipped|⏭️|Shyam/i, 'Should confirm skip');
    });

    it('rejects /skip without customer code', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/skip', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /customer code|code|C\d{3}/i, 'Should ask for customer code');
    });
  });

  // ── /issue ───────────────────────────────────────────────────────

  describe('/issue — record delivery issue', () => {
    it('records an issue with a reason', async () => {
      bot.clearMessages();
      // C003 is pending for Priya (boy 3, chat_id=1003)
      await bot.simulateMessage('/issue C003 No milk required today', 1003);

      // Check DB
      const delivery = testDb.prepare(`
        SELECT d.*, c.code FROM deliveries d
        JOIN customers c ON c.id = d.customer_id
        WHERE c.code = 'C003' AND d.delivery_date = date('now')
      `).get();
      assert.strictEqual(delivery.status, 'issue');
      assert.match(delivery.issue_reason, /No milk required/i, 'Should store reason');

      // Check response
      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /C003|issue|⚠️|Gita/i, 'Should confirm issue');
    });

    it('asks for a reason when /issue is sent without a reason', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/issue C003', 1003);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /reason|include/i, 'Should ask for a reason');
    });
  });

  // ── /arriving ────────────────────────────────────────────────────

  describe('/arriving — mark delivery as arriving', () => {
    it('marks a delivery as arriving', async () => {
      bot.clearMessages();
      // Add a fresh pending delivery for Raju to test /arriving on
      // We'll use a new customer to avoid conflicts with previous tests
      testDb.prepare(
        `INSERT INTO customers (id, code, name, phone, address, delivery_boy_id, monthly_rate, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(4, 'C004', 'TestUser', '9000000004', '999 Test St', 1, 300000, 'active');
      testDb.prepare(
        `INSERT INTO subscriptions (customer_id, start_date, end_date, total_days, remaining_days, status)
         VALUES (?, date('now', '-5 days'), date('now', '+25 days'), 30, 25, 'active')`
      ).run(4);
      testDb.prepare(
        `INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
         VALUES (?, ?, date('now'), 'pending')`
      ).run(4, 1);

      await bot.simulateMessage('/arriving C004', 1001);

      const delivery = testDb.prepare(`
        SELECT d.*, c.code FROM deliveries d
        JOIN customers c ON c.id = d.customer_id
        WHERE c.code = 'C004' AND d.delivery_date = date('now')
      `).get();
      assert.strictEqual(delivery.status, 'arriving');

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /C004|arriving|🚚|TestUser/i, 'Should confirm arriving');
    });

    it('rejects /arriving without customer code', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/arriving', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /customer code|code|C\d{3}/i, 'Should ask for customer code');
    });
  });

  // ── /finish ──────────────────────────────────────────────────────

  describe('/finish — route summary', () => {
    it('returns a summary of today\'s route with counts', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/finish', 1001); // Raju

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /route|summary|complete|finish/i, 'Should indicate route summary');
      // Raju had deliveries: C001=delivered, C002=skipped, C004=arriving
      assert.match(last.text, /1 delivered|1 skipped|1 arriving/i, 'Should show status counts');
    });
  });

  // ── /help ────────────────────────────────────────────────────────

  describe('/help — list commands', () => {
    it('returns a list of available commands', async () => {
      bot.clearMessages();
      await bot.simulateMessage('/help', 1001);

      const last = bot.lastMessage();
      assert.ok(last, 'Should have sent a message');
      assert.match(last.text, /start|route|done|skip|issue|arriving|finish|help/i, 'Should list commands');
    });
  });
});