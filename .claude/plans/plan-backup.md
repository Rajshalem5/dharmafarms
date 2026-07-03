# Implementation Plan: Boot-Time Database Backup and 30-Day Rotation

## Overview

Create a backup service that copies the SQLite database file on server boot (idempotent, once per day) and a scheduled fallback via node-cron at 3 AM. Enforce a 30-file retention policy by deleting the oldest backups beyond the limit.

## Requirements

- **Backup on boot**: When the server starts, check if a backup was already created today (by date). If not, copy `data/dharma-farms.db` to `backup/dharma-farms-YYYY-MM-DD.db`. Skip if it exists.
- **30-day rotation**: After creating a new backup, count backup files. If more than 30 exist, delete the oldest ones beyond 30, keeping exactly the 30 most recent.
- **Dual invocation**: Callable from `server.js` (boot) and from a node-cron 3 AM job (fallback).
- **Idempotent**: Running twice on the same date produces one backup, not two.
- **Graceful error handling**: If the DB file is locked, backup dir missing, or delete fails, log a warning and continue — never crash the server.

## Architecture Changes

| File | Action | Description |
|------|--------|-------------|
| `services/backup.js` | **Create** | Backup service with 4 exported functions |
| `server.js` | **Modify** | Add boot-time backup call and 3 AM cron fallback |
| `test/backup.test.js` | **Create** | Tests for all backup functions using temp directories |
| `.gitignore` | **Check** | Ensure `backup/*.db` is excluded from git tracking |

## Implementation Steps

### Phase 1: Create the backup service (`services/backup.js`)

Four exported functions, following the same pattern as `services/dispatch.js` (JSDoc, parameter injection for testability, try-catch error handling).

**Function 1: `todayBackupExists(backupDir)`**

- Build expected filename: `dharma-farms-YYYY-MM-DD.db` using `new Date().toISOString().slice(0, 10)`.
- Use `fs.existsSync(path.join(backupDir, filename))`.
- Returns `boolean`.
- Default `backupDir` if not provided: `path.join(__dirname, '..', 'backup')`.

**Function 2: `backupDatabase(srcPath, destPath)`**

- `fs.mkdirSync(path.dirname(destPath), { recursive: true })` to ensure backup dir exists.
- `fs.copyFileSync(srcPath, destPath)` for the copy.
- Wrap in try-catch; on failure, console.error a warning and return `false`.
- Returns `boolean` (true = copied, false = skipped/failed).

**Function 3: `cleanupOldBackups(backupDir, maxBackups = 30)`**

- `fs.readdirSync(backupDir)`, filter to `.db` files matching the `dharma-farms-YYYY-MM-DD.db` pattern.
- Map to `{ name, mtime: fs.statSync(path).mtime }`.
- Sort by mtime ascending (oldest first).
- If count <= maxBackups, return 0.
- Delete files at indices 0 through (count - maxBackups - 1) using `fs.unlinkSync()`.
- Per-file try-catch so one failure does not stop others.
- Returns number of files deleted.

**Function 4: `performCompleteBackupCycle({ dbPath, backupDir, maxBackups })`**

- Public entry point. Builds dest filename from today's date.
- Calls `todayBackupExists()` first — if true, logs skip message and returns `{ backedUp: false, deleted: 0 }`.
- Calls `backupDatabase()` — if false, returns early without cleanup.
- Calls `cleanupOldBackups()` with maxBackups.
- Logs summary via console.log.
- Returns `{ backedUp: boolean, deleted: number }`.

### Phase 2: Integrate into server boot (`server.js`)

**Change A — Import (after line 26, alongside the dispatcher import):**

```javascript
const { dispatchExistsForToday, generateDispatch } = require('./services/dispatch');
const { performCompleteBackupCycle } = require('./services/backup');
```

**Change B — Boot-time call (after line 172, the dispatch check block):**

```javascript
// 6. Boot-time database backup (once per day, idempotent)
const dbPath = path.join(__dirname, 'data', 'dharma-farms.db');
const backupDir = path.join(__dirname, 'backup');
const backupResult = performCompleteBackupCycle({ dbPath, backupDir, maxBackups: 30 });
if (backupResult.backedUp) {
  console.log('[Boot] Database backed up');
} else {
  console.log('[Boot] Database backup already exists for today, skipping');
}
```

**Change C — 3 AM cron fallback (after boot backup call, before `app.listen()` at line 177):**

```javascript
// 7. Schedule 3 AM daily backup (fallback if server stays up across midnight)
cron.schedule('0 3 * * *', () => {
  console.log('[Cron] Running scheduled 3 AM backup...');
  const result = performCompleteBackupCycle({
    dbPath: path.join(__dirname, 'data', 'dharma-farms.db'),
    backupDir: path.join(__dirname, 'backup'),
    maxBackups: 30,
  });
  if (result.backedUp) {
    console.log('[Cron] Database backed up, cleaned up ' + result.deleted + ' old backups');
  }
});
console.log('[Cron] Scheduled 3 AM daily backup');
```

### Phase 3: Create test file (`test/backup.test.js`)

Testing approach: do NOT mock `fs`. Use a real temporary directory via `fs.mkdtempSync()` + `os.tmpdir()`, create a real SQLite file with `better-sqlite3`, exercise all functions, then clean up with `fs.rmSync(tmpDir, { recursive: true, force: true })`.

**Setup pattern:**

```javascript
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-backup-test-'));
const backupDir = path.join(tmpDir, 'backup');
const dbPath = path.join(tmpDir, 'test.db');
```

**Test structure (following `test/dispatch.test.js` pattern — `node:test` with `describe`/`it`/`before`/`after`):**

| describe block | Tests |
|----------------|-------|
| `todayBackupExists` | false when no backup today; true when file exists; false when backup dir missing |
| `backupDatabase` | creates backup dir; copies file; returns false on missing source; returns true on success |
| `cleanupOldBackups` | returns 0 when <30 files; returns 0 at exactly 30; deletes oldest 5 of 35; deletes exactly (count - max) |
| `performCompleteBackupCycle` | creates backup when none exists; skips when one exists; returns deleted count; no crash on missing source |

**Helper function for rotation tests:**

```javascript
function createBackupFile(dir, dateStr) {
  fs.writeFileSync(path.join(dir, 'dharma-farms-' + dateStr + '.db'), '');
}
```

Create 35 files with dates spread over 35 days, call `cleanupOldBackups(backupDir, 30)`, assert 5 deleted, assert 30 remain.

**Run tests with:**
```
node --test test/backup.test.js
```

## Testing Strategy

| Type | What | How |
|------|------|-----|
| Unit | `todayBackupExists` | Temp dir, create/missing file |
| Unit | `backupDatabase` | Temp dir, real SQLite file via better-sqlite3 |
| Unit | `cleanupOldBackups` | Temp dir with N empty backup files, count assertions |
| Integration | `performCompleteBackupCycle` | Full flow: check, copy, cleanup, idempotency |

No E2E needed (filesystem operation, not user-facing).

## Error Handling Strategy

| Scenario | Behavior |
|----------|----------|
| `backupDatabase` source file missing | try-catch catches `ENOENT`, logs `[Backup] Warning: Source database not found at ...`, returns false. Server continues. |
| `backupDatabase` file locked | try-catch catches `EBUSY`/`ELOCK`, logs warning, returns false. 3 AM cron has another chance. |
| `backupDatabase` disk full | try-catch catches `ENOSPC`, logs warning, returns false. Cleanup may free space but is skipped if backup failed. |
| `cleanupOldBackups` delete fails per-file | Per-file try-catch, logs `[Backup] Warning: Could not delete ...`, continues to next file. |
| `cleanupOldBackups` directory missing | `readdirSync` throws; outer try-catch in `performCompleteBackupCycle` catches it (or `cleanupOldBackups` itself does). Returns 0. |
| `todayBackupExists` directory missing | `existsSync` returns false for non-existent dir. Returns false (correct — no backup exists because dir doesn't exist). |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| DB locked during backup (better-sqlite3 exclusive write) | copy fails | WAL mode allows concurrent reads. If a write transaction holds an exclusive lock briefly, try-catch handles it. Two chances: boot + 3 AM cron. |
| Windows file locking | unlink/delete fails | Per-file try-catch keeps cleanup going. Logged warning. |
| Date rollover while server stays up across midnight | today's backup exists, tomorrow's not created | 3 AM cron handles this — `todayBackupExists()` checks the new date, finds no match, creates backup. |
| PM2 restarts server multiple times in one day | multiple boot sequences | `todayBackupExists()` returns true after first backup. All subsequent boots skip. |
| Admin changes system clock | backup filename uses wrong date | A future-dated file exists; on the next correct-date boot, a new backup is created for the real date. No data loss, just an extra file. |
| Multiple processes on same backup dir | Process A overwrites Process B's file | Same filename, same data, same date. Overwrite is safe. Cleanup runs identically for both. |

## Edge Cases

- **First-ever boot**: Backup directory does not exist. `backupDatabase` calls `mkdirSync({ recursive: true })` to create it. Cleanup runs on an empty directory and does nothing.
- **Backup directory has non-db files**: `cleanupOldBackups` filters to only `.db` files matching the pattern `dharma-farms-YYYY-MM-DD.db`. Other files are ignored.
- **Backup directory has corrupt db files**: Treated as regular files by cleanup (counted toward the 30 limit). No content inspection.
- **Server boots at 11:59 PM and runs until 12:01 AM**: Boot creates backup for day X. 3 AM cron the same night checks for day X (exists, skip). On the next boot, creates day X+1. If the server stays up through 3 AM of day X+1, the cron creates that backup.
- **Source .db file is deleted or moved between boot and cron**: `backupDatabase` catches `ENOENT`, logs warning, returns false. Admin notified by warning logs.
- **`backup/` is a network drive that disconnects**: Dependent on the OS filesystem behavior. `copyFileSync` and `readdirSync` will throw; try-catch handles them as warnings.

## Success Criteria

- [ ] `services/backup.js` created with four exported functions, each with JSDoc
- [ ] `performCompleteBackupCycle` is idempotent: second call on same date returns `{ backedUp: false, deleted: 0 }`
- [ ] Boot-time backup runs in `server.js` after dispatch generation, logs a clear message
- [ ] 3 AM cron job registered in `server.js`
- [ ] `cleanupOldBackups` deletes exactly `(count - maxBackups)` files when count exceeds limit
- [ ] `cleanupOldBackups` keeps all files when count is at or under limit
- [ ] Errors never crash the server — they are caught, logged as warnings, and the server continues
- [ ] `test/backup.test.js` has tests for all four functions with real temp filesystem operations
- [ ] All tests pass with `node --test test/backup.test.js`

## Out of Scope

- Encryption of backup files (overkill for milk delivery data)
- Cloud backup / offsite replication
- Backup compression (SQLite does not compress well, adds complexity)
- Backup integrity verification via hash check
- Admin UI for backup management
- Configurable retention period via environment variable (the constant 30 is sufficient per spec)