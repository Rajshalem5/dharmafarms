/**
 * services/backup.js — Boot-time database backup and 30-day rotation.
 *
 * Handles checking for existing backups, copying the SQLite database file,
 * and cleaning up old backups beyond the retention limit.
 * All errors are caught and logged — never crashes the server.
 */

const fs = require('fs');
const path = require('path');

/**
 * Builds today's backup filename in the format dharma-farms-YYYY-MM-DD.db.
 * @returns {string}
 */
function todayBackupFilename() {
  const datePart = new Date().toISOString().slice(0, 10);
  return 'dharma-farms-' + datePart + '.db';
}

/**
 * Checks whether a backup file already exists for today.
 *
 * @param {string} backupDir - Path to the backup directory
 * @returns {boolean} true if today's backup file exists, false otherwise
 */
function todayBackupExists(backupDir) {
  const filename = todayBackupFilename();
  return fs.existsSync(path.join(backupDir, filename));
}

/**
 * Copies the source database file to the destination path.
 * Creates the target directory (and any parent directories) if they don't exist.
 *
 * @param {string} srcPath - Path to the source database file
 * @param {string} destPath - Path where the backup should be written
 * @returns {boolean} true if the backup was created, false on failure
 */
function backupDatabase(srcPath, destPath) {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    return true;
  } catch (err) {
    console.error('[Backup] Warning: Could not create backup —', err.message);
    return false;
  }
}

/**
 * Regex to match backup filenames: dharma-farms-YYYY-MM-DD.db
 * @type {RegExp}
 */
const BACKUP_PATTERN = /^dharma-farms-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Cleans up old backup files, keeping only the most recent maxBackups files.
 * Only considers files matching the pattern dharma-farms-YYYY-MM-DD.db.
 * Sorts by mtime (oldest first), deletes files beyond the retention limit.
 *
 * @param {string} backupDir - Path to the backup directory
 * @param {number} [maxBackups=30] - Maximum number of backup files to keep
 * @returns {number} Number of files deleted
 */
function cleanupOldBackups(backupDir, maxBackups) {
  // Default maxBackups to 30 if not provided
  if (maxBackups === undefined || maxBackups === null) {
    maxBackups = 30;
  }

  let files;
  try {
    files = fs.readdirSync(backupDir);
  } catch (err) {
    // Directory doesn't exist or can't be read — nothing to clean up
    console.error('[Backup] Warning: Could not read backup directory —', err.message);
    return 0;
  }

  // Filter to only pattern-matching backup files, map to { name, mtime }
  const backupFiles = files
    .filter(f => BACKUP_PATTERN.test(f))
    .map(name => {
      const fullPath = path.join(backupDir, name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        // File disappeared between readdir and stat — skip it
        return null;
      }
      return { name, mtime: stat.mtime };
    })
    .filter(Boolean);

  if (backupFiles.length <= maxBackups) {
    return 0;
  }

  // Sort by mtime ascending (oldest first)
  backupFiles.sort((a, b) => a.mtime - b.mtime);

  const toDelete = backupFiles.length - maxBackups;
  let deleted = 0;

  for (let i = 0; i < toDelete; i++) {
    try {
      fs.unlinkSync(path.join(backupDir, backupFiles[i].name));
      deleted++;
    } catch (err) {
      console.error('[Backup] Warning: Could not delete old backup —', err.message);
    }
  }

  return deleted;
}

/**
 * Performs a complete backup cycle: check → copy → cleanup → return summary.
 *
 * 1. Checks if today's backup already exists (idempotency guard)
 * 2. Copies the database file to the backup directory
 * 3. Removes old backups beyond the retention limit
 * 4. Logs a summary and returns a result object
 *
 * @param {object} options
 * @param {string} options.dbPath - Path to the source database file
 * @param {string} options.backupDir - Path to the backup directory
 * @param {number} [options.maxBackups=30] - Maximum number of backup files to keep
 * @returns {{ backedUp: boolean, deleted: number }}
 */
function performCompleteBackupCycle({ dbPath, backupDir, maxBackups }) {
  // Default maxBackups to 30 if not provided
  const max = maxBackups === undefined || maxBackups === null ? 30 : maxBackups;

  // Step 1: Check if today's backup already exists
  if (todayBackupExists(backupDir)) {
    console.log('[Backup] Backup already exists for today, skipping');
    return { backedUp: false, deleted: 0 };
  }

  // Step 2: Build destination path and copy the database
  const destFilename = todayBackupFilename();
  const destPath = path.join(backupDir, destFilename);

  const backedUp = backupDatabase(dbPath, destPath);
  if (!backedUp) {
    return { backedUp: false, deleted: 0 };
  }

  // Step 3: Clean up old backups
  const deleted = cleanupOldBackups(backupDir, max);

  // Step 4: Log summary
  console.log(
    '[Backup] Created ' + destFilename +
    (deleted > 0 ? ', cleaned up ' + deleted + ' old backups' : '')
  );

  return { backedUp: true, deleted };
}

module.exports = {
  todayBackupExists,
  backupDatabase,
  cleanupOldBackups,
  performCompleteBackupCycle,
};