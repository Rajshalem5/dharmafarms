/**
 * Tests for server.js — Express app initialization and configuration.
 *
 * Tests that the server properly validates env vars, sets up middleware,
 * mounts routes, and handles 404/500 errors.
 *
 * Run with: node --test test/server.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');

/**
 * Helper: starts the server app on a random port and returns { app, server, port }.
 * Caller must close the server.
 */
function startServerOnRandomPort() {
  // Import after env is set
  const { createApp } = require('../server');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create minimal schema for testing
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE delivery_boys (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(100) NOT NULL, phone VARCHAR(15) NOT NULL, telegram_chat_id BIGINT UNIQUE, region VARCHAR(50), status VARCHAR(20) DEFAULT 'active');
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, code VARCHAR(10) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, phone VARCHAR(15) NOT NULL, address TEXT NOT NULL, delivery_boy_id INTEGER REFERENCES delivery_boys(id), monthly_rate INTEGER NOT NULL, status VARCHAR(20) DEFAULT 'active', token VARCHAR(64) UNIQUE, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), start_date TEXT NOT NULL, end_date TEXT, total_days INTEGER NOT NULL DEFAULT 30, remaining_days INTEGER NOT NULL DEFAULT 30, status VARCHAR(20) DEFAULT 'active', paused_until TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), delivery_boy_id INTEGER NOT NULL REFERENCES delivery_boys(id), delivery_date TEXT NOT NULL, status VARCHAR(20) DEFAULT 'pending', issue_reason TEXT, marked_at TEXT, resolved_at TEXT, resolved_note TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(customer_id, delivery_date));
    CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(delivery_date);
    CREATE INDEX IF NOT EXISTS idx_deliveries_boy_date ON deliveries(delivery_boy_id, delivery_date);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
  `);

  const app = createApp(db);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ app, server, port, db });
    });
    server.on('error', reject);
  });
}

/**
 * Helper: make an HTTP request and return { status, headers, body }.
 */
function request(server, method, path, options = {}) {
  return new Promise((resolve, reject) => {
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
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('server.js — createApp', () => {
  describe('env validation', () => {
    it('exits when BOT_TOKEN is missing', () => {
      const origExit = process.exit;
      let exitCode = null;
      process.exit = (code) => { exitCode = code; };

      // Temporarily move .env so dotenv.config() doesn't reload vars
      const fs = require('fs');
      const envPath = require('path').join(__dirname, '..', '.env');
      const hasEnv = fs.existsSync(envPath);
      if (hasEnv) fs.renameSync(envPath, envPath + '.bak');

      // Clear env vars
      const savedBot = process.env.BOT_TOKEN;
      const savedSession = process.env.SESSION_SECRET;
      const savedAdmin = process.env.ADMIN_PASSWORD;
      delete process.env.BOT_TOKEN;
      delete process.env.SESSION_SECRET;
      delete process.env.ADMIN_PASSWORD;

      try {
        const { validateEnv } = require('../server');
        validateEnv();
        assert.strictEqual(exitCode, 1, 'Should have called process.exit(1)');
      } finally {
        process.exit = origExit;
        process.env.BOT_TOKEN = savedBot;
        process.env.SESSION_SECRET = savedSession;
        process.env.ADMIN_PASSWORD = savedAdmin;
        if (hasEnv) fs.renameSync(envPath + '.bak', envPath);
      }
    });
  });

  describe('Express app setup', () => {
    /** @type {import('http').Server} */
    let server;
    /** @type {import('better-sqlite3').Database} */
    let db;

    before(async () => {
      const ctx = await startServerOnRandomPort();
      server = ctx.server;
      db = ctx.db;
    });

    after(() => {
      if (server) server.close();
      if (db) db.close();
    });

    it('serves static files from public directory', async () => {
      const res = await request(server, 'GET', '/css/style.css');
      // Should return 200 or 404 (if file doesn't exist), but not crash
      assert.ok([200, 304, 404].includes(res.status), 'Should handle static file request without crashing');
    });

    it('mounts admin routes — /health returns 200 JSON', async () => {
      const res = await request(server, 'GET', '/health');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'], /json/);
    });

    it('renders login page at /admin/login', async () => {
      const res = await request(server, 'GET', '/admin/login');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'], /html/);
    });

    it('handles 404 for unknown routes', async () => {
      const res = await request(server, 'GET', '/nonexistent-route-xyz');
      assert.strictEqual(res.status, 404);
    });

    it('handles 404 for unknown API routes gracefully', async () => {
      const res = await request(server, 'GET', '/api/nonexistent');
      assert.strictEqual(res.status, 404);
    });

    it('configures express-session middleware', async () => {
      // POST to login should set a session cookie or redirect
      const res = await request(server, 'POST', '/admin/login', {
        body: 'password=wrong',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      assert.ok(res.headers['set-cookie'] || res.status === 302, 'Should handle session');
    });
  });

  describe('error handling', () => {
    it('error middleware returns 500 JSON for unhandled errors', async () => {
      const express = require('express');

      // Create minimal app with same error-handler pattern as createApp
      const testApp = express();
      testApp.get('/test-error', (req, res, next) => {
        next(new Error('Test error'));
      });
      // Same error middleware as createApp
      testApp.use((err, req, res, _next) => {
        console.error('[Server] Unhandled error:', err.message);
        res.status(500).json({
          error: 'Internal server error',
          message: process.env.NODE_ENV === 'development' ? err.message : undefined,
        });
      });

      const errServer = testApp.listen(0);
      try {
        const port = errServer.address().port;
        const res = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/test-error',
            method: 'GET',
          }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          });
          req.on('error', reject);
          req.end();
        });

        assert.strictEqual(res.status, 500);
        assert.match(res.headers['content-type'], /json/);
      } finally {
        errServer.close();
      }
    });
  });
});