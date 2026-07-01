/**
 * db.js — Database initialization and access for Dharma Farms
 *
 * Uses better-sqlite3 with WAL mode, migration tracking, and seed data.
 * Singleton pattern: getDb() returns the shared instance.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

/** @type {import('better-sqlite3').Database|null} */
let db = null;

/** @type {string|null} */
let adminPasswordHash = null;

/**
 * Returns the singleton database instance.
 * Returns null if initializeDatabase() has not been called yet.
 * @returns {import('better-sqlite3').Database|null}
 */
function getDb() {
  return db;
}

/**
 * Returns the hashed admin password for login comparison.
 * Returns null if initializeDatabase() has not been called yet.
 * @returns {string|null}
 */
function getAdminPasswordHash() {
  return adminPasswordHash;
}

/**
 * Initializes the database: creates the data directory, opens the SQLite file,
 * enables WAL mode and foreign keys, runs pending migrations, and seeds data.
 *
 * Safe to call multiple times — migrations and seeds are idempotent.
 *
 * @returns {import('better-sqlite3').Database}
 */
function initializeDatabase() {
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'dharma-farms.db');
  db = new Database(dbPath);

  // Performance and safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create migration tracking table (always first)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Determine current migration version
  const currentVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM _migrations'
  ).get().version;

  // --- Migration v1: Core tables ---
  if (currentVersion < 1) {
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

    db.prepare(
      'INSERT INTO _migrations (version, name) VALUES (?, ?)'
    ).run(1, 'v1_create_core_tables');
  }

  // --- Seed delivery boys ---
  const seedBoy = db.prepare(
    'INSERT OR IGNORE INTO delivery_boys (id, name, phone, region) VALUES (?, ?, ?, ?)'
  );

  const seedDeliveryBoys = db.transaction(() => {
    const boys = [
      [1, 'Raju', '9876543210', 'North'],
      [2, 'Vijay', '9876543211', 'South'],
      [3, 'Priya', '9876543212', 'East'],
      [4, 'Arun', '9876543213', 'West'],
      [5, 'Suresh', '9876543214', 'Central'],
    ];
    for (const boy of boys) {
      seedBoy.run(...boy);
    }
  });

  seedDeliveryBoys();

  // --- Hash admin password from environment ---
  if (process.env.ADMIN_PASSWORD) {
    adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
  }

  return db;
}

module.exports = {
  getDb,
  initializeDatabase,
  getAdminPasswordHash,
};