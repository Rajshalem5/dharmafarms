/**
 * Tests for services/backup.js — boot-time backup and 30-day rotation.
 *
 * Uses real temp directories and real SQLite files.
 * Run with: node --test test/backup.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import will fail until services/backup.js exists (RED)
const {
  todayBackupExists,
  backupDatabase,
  cleanupOldBackups,
  performCompleteBackupCycle,
} = require('../services/backup');

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Creates an empty backup file with the given date string in the
 * format expected by the backup service (dharma-farms-YYYY-MM-DD.db).
 * Also sets the file's mtime to the given date for sorting tests.
 */
function createBackupFile(dir, dateStr, mtimeDate) {
  const filePath = path.join(dir, 'dharma-farms-' + dateStr + '.db');
  fs.writeFileSync(filePath, '');
  if (mtimeDate) {
    const mtime = new Date(mtimeDate);
    fs.utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

/**
 * Builds today's backup filename string: dharma-farms-YYYY-MM-DD.db
 */
function todayFilename() {
  const datePart = new Date().toISOString().slice(0, 10);
  return 'dharma-farms-' + datePart + '.db';
}

// ─── todayBackupExists ──────────────────────────────────────────

describe('todayBackupExists', () => {
  let tmpDir;
  let backupDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-test-'));
    backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no backup file exists for today', () => {
    // Clean backup dir — no files
    const result = todayBackupExists(backupDir);
    assert.strictEqual(result, false);
  });

  it('returns true when a backup file exists for today', () => {
    const filename = todayFilename();
    fs.writeFileSync(path.join(backupDir, filename), 'dummy content');
    const result = todayBackupExists(backupDir);
    assert.strictEqual(result, true);
  });

  it('returns false when backup directory does not exist', () => {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');
    const result = todayBackupExists(nonExistentDir);
    assert.strictEqual(result, false);
  });
});

// ─── backupDatabase ─────────────────────────────────────────────

describe('backupDatabase', () => {
  let tmpDir;
  let backupDir;
  let srcPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-test-'));
    backupDir = path.join(tmpDir, 'backup');
    srcPath = path.join(tmpDir, 'source.db');
    fs.writeFileSync(srcPath, 'real-sqlite-content');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the backup directory and copies the file', () => {
    const destPath = path.join(backupDir, 'test-copy.db');
    const result = backupDatabase(srcPath, destPath);

    assert.strictEqual(result, true);
    assert.strictEqual(fs.existsSync(destPath), true);
    assert.strictEqual(fs.readFileSync(destPath, 'utf8'), 'real-sqlite-content');
  });

  it('returns false when source file is missing', () => {
    const missingPath = path.join(tmpDir, 'nonexistent.db');
    const destPath = path.join(backupDir, 'should-not-exist.db');
    const result = backupDatabase(missingPath, destPath);

    assert.strictEqual(result, false);
    assert.strictEqual(fs.existsSync(destPath), false);
  });

  it('returns true when dest already exists (overwrites)', () => {
    const destPath = path.join(backupDir, 'overwrite-test.db');
    // Create an existing file with different content
    fs.writeFileSync(destPath, 'old-content');

    const result = backupDatabase(srcPath, destPath);

    assert.strictEqual(result, true);
    assert.strictEqual(fs.readFileSync(destPath, 'utf8'), 'real-sqlite-content');
  });

  it('creates nested directories in the dest path', () => {
    const nestedDir = path.join(backupDir, 'sub', 'nested');
    const destPath = path.join(nestedDir, 'nested-copy.db');

    const result = backupDatabase(srcPath, destPath);

    assert.strictEqual(result, true);
    assert.strictEqual(fs.existsSync(destPath), true);
    assert.strictEqual(fs.readFileSync(destPath, 'utf8'), 'real-sqlite-content');
  });
});

// ─── cleanupOldBackups ──────────────────────────────────────────

describe('cleanupOldBackups', () => {
  let tmpDir;
  let backupDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-test-'));
    backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 when there are fewer files than maxBackups', () => {
    createBackupFile(backupDir, '2026-06-01', '2026-06-01T00:00:00Z');
    createBackupFile(backupDir, '2026-06-02', '2026-06-02T00:00:00Z');
    // 2 files < 30
    const result = cleanupOldBackups(backupDir, 30);
    assert.strictEqual(result, 0);
  });

  it('returns 0 when file count exactly equals maxBackups', () => {
    // Fresh directory for exact match test
    const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-exact-'));
    for (let i = 1; i <= 30; i++) {
      const day = String(i).padStart(2, '0');
      createBackupFile(exactDir, '2026-05-' + day, '2026-05-' + day + 'T00:00:00Z');
    }
    const result = cleanupOldBackups(exactDir, 30);
    assert.strictEqual(result, 0);

    // Verify all 30 files still exist
    const files = fs.readdirSync(exactDir).filter(f => f.endsWith('.db'));
    assert.strictEqual(files.length, 30);
    fs.rmSync(exactDir, { recursive: true, force: true });
  });

  it('deletes the oldest 5 of 35 files, keeping 30', () => {
    // Fresh directory for rotation test
    const rotateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-rotate-'));
    // Create 35 files, oldest first
    for (let i = 1; i <= 35; i++) {
      const day = String(i).padStart(2, '0');
      createBackupFile(rotateDir, '2026-05-' + day, '2026-05-' + day + 'T00:00:00Z');
    }
    const result = cleanupOldBackups(rotateDir, 30);
    assert.strictEqual(result, 5);

    // Verify exactly 30 files remain
    const remaining = fs.readdirSync(rotateDir).filter(f => f.endsWith('.db'));
    assert.strictEqual(remaining.length, 30);

    // Verify the oldest 5 are gone (dates 2026-05-01 through 2026-05-05)
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, '0');
      assert.strictEqual(
        fs.existsSync(path.join(rotateDir, 'dharma-farms-2026-05-' + day + '.db')),
        false,
        'file for 2026-05-' + day + ' should have been deleted'
      );
    }

    // Verify the newest 30 still exist (dates 2026-05-06 through 2026-05-35)
    for (let i = 6; i <= 35; i++) {
      const day = String(i).padStart(2, '0');
      assert.strictEqual(
        fs.existsSync(path.join(rotateDir, 'dharma-farms-2026-05-' + day + '.db')),
        true,
        'file for 2026-05-' + day + ' should still exist'
      );
    }
    fs.rmSync(rotateDir, { recursive: true, force: true });
  });

  it('deletes exactly (count - maxBackups) files when over limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-excess-'));
    for (let i = 1; i <= 40; i++) {
      const day = String(i).padStart(2, '0');
      createBackupFile(dir, '2026-04-' + day, '2026-04-' + day + 'T00:00:00Z');
    }
    const result = cleanupOldBackups(dir, 25);
    assert.strictEqual(result, 15); // 40 - 25 = 15

    const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
    assert.strictEqual(remaining.length, 25);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-db files in the backup directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-nondb-'));
    // Create 5 backup files and some non-db files
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, '0');
      createBackupFile(dir, '2026-06-' + day, '2026-06-' + day + 'T00:00:00Z');
    }
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'notes');
    fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b,c');
    fs.writeFileSync(path.join(dir, 'not-a-backup.db'), 'something');

    // 5 backup files + 1 non-pattern .db file = 6 db files total
    // But cleanup only counts pattern-matching .db files, so 5 < 30
    const result = cleanupOldBackups(dir, 30);
    assert.strictEqual(result, 0);

    // All files should remain (under limit)
    assert.strictEqual(fs.existsSync(path.join(dir, 'readme.txt')), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'data.csv')), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'not-a-backup.db')), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── performCompleteBackupCycle ─────────────────────────────────

describe('performCompleteBackupCycle', () => {
  let tmpDir;
  let backupDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-test-'));
    backupDir = path.join(tmpDir, 'backup');
    dbPath = path.join(tmpDir, 'dharma-farms.db');
    fs.writeFileSync(dbPath, 'real-database-content');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a backup when no backup exists for today', () => {
    const result = performCompleteBackupCycle({ dbPath, backupDir, maxBackups: 30 });

    assert.strictEqual(result.backedUp, true);
    assert.strictEqual(typeof result.deleted, 'number');

    // Verify the backup file was created
    const filename = todayFilename();
    assert.strictEqual(fs.existsSync(path.join(backupDir, filename)), true);
  });

  it('skips backup when one already exists for today (idempotent)', () => {
    const result = performCompleteBackupCycle({ dbPath, backupDir, maxBackups: 30 });

    assert.strictEqual(result.backedUp, false);
    assert.strictEqual(result.deleted, 0);
  });

  it('returns deleted count when cleanup removes old files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-cycle-'));
    const srcPath = path.join(dir, 'dharma-farms.db');
    fs.writeFileSync(srcPath, 'content');
    const backDir = path.join(dir, 'backups');
    fs.mkdirSync(backDir, { recursive: true });

    // Create 32 old backup files + let the cycle create 1 more = 33 total
    for (let i = 1; i <= 32; i++) {
      const day = String(i).padStart(2, '0');
      createBackupFile(backDir, '2026-03-' + day, '2026-03-' + day + 'T00:00:00Z');
    }

    const result = performCompleteBackupCycle({
      dbPath: srcPath,
      backupDir: backDir,
      maxBackups: 30,
    });

    assert.strictEqual(result.backedUp, true);
    // 32 old + 1 new = 33 total, maxBackups=30 → delete 3
    assert.strictEqual(result.deleted, 3);

    const remaining = fs.readdirSync(backDir).filter(f => f.endsWith('.db'));
    assert.strictEqual(remaining.length, 30);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not crash when source database is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-missing-'));
    const missingPath = path.join(dir, 'nonexistent.db');

    // Should not throw, should return gracefully
    assert.doesNotThrow(() => {
      const result = performCompleteBackupCycle({
        dbPath: missingPath,
        backupDir: path.join(dir, 'backup'),
        maxBackups: 30,
      });
      assert.strictEqual(result.backedUp, false);
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});