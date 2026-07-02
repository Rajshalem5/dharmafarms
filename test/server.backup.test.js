/**
 * Tests for server.js backup integration — boot-time backup and 3 AM cron.
 *
 * Verifies that server.js imports the backup service and node-cron.
 * Run with: node --test test/server.backup.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('server.js backup integration', () => {
  let savedEnv;

  before(() => {
    // Save env so we can restore after
    savedEnv = { ...process.env };

    // Set minimal env so module-level requires don't blow up
    process.env.BOT_TOKEN = '123456:test-token-abcdef123456';
    process.env.SESSION_SECRET = 'x'.repeat(64);
    process.env.ADMIN_PASSWORD = 'test-password';
  });

  after(() => {
    // Restore env
    Object.keys(process.env).forEach(k => delete process.env[k]);
    Object.assign(process.env, savedEnv);

    // Clear server-related module cache so other tests aren't affected
    Object.keys(require.cache).forEach(key => {
      if (key.includes('dharma') || key.includes('mini project') ||
          key.includes('server.js') || key.includes('backup.js')) {
        delete require.cache[key];
      }
    });
  });

  it('imports performCompleteBackupCycle from the backup service', () => {
    // This will fail (RED) until server.js adds the backup import
    const server = require('../server');

    assert.strictEqual(typeof server.startServer, 'function',
      'server module should export startServer');

    // Verify the backup service module was loaded by the require chain
    // Match our services/backup.js specifically (not better-sqlite3's backup.js)
    const backupCacheKeys = Object.keys(require.cache)
      .filter(k => k.includes('services') && k.includes('backup') && k.endsWith('.js'));
    assert.ok(backupCacheKeys.length > 0,
      'backup service should be required by server.js');
  });

  it('imports node-cron for 3 AM scheduled backup', () => {
    // Clear and re-require so we check a fresh load
    Object.keys(require.cache).forEach(key => {
      if (key.includes('dharma') || key.includes('mini project') ||
          key.includes('server.js') || key.includes('backup.js')) {
        delete require.cache[key];
      }
    });

    const server = require('../server');
    assert.strictEqual(typeof server.startServer, 'function');

    // Verify node-cron was loaded
    const cronCacheKeys = Object.keys(require.cache)
      .filter(k => k.includes('node-cron'));
    assert.ok(cronCacheKeys.length > 0,
      'node-cron should be required by server.js');
  });
});