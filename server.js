/**
 * server.js — Express app initialization and entry point for Dharma Farms.
 *
 * Usage:
 *   node server.js              # Starts the full server (direct execution)
 *   const { createApp } = require('./server');  # For testing
 *
 * Environment variables (from .env):
 *   BOT_TOKEN              Telegram bot token from BotFather
 *   SESSION_SECRET         Secret for Express session (64+ chars recommended)
 *   ADMIN_PASSWORD         Password for admin login
 *   ADMIN_TELEGRAM_CHAT_ID Telegram chat ID for admin (get from @userinfobot)
 *   PORT                   HTTP listen port (default 3000)
 */

// ─── Module dependencies ─────────────────────────────────────────────

const dotenv = require('dotenv');
const express = require('express');
const path = require('path');
const session = require('express-session');
const { TelegramBot } = require('node-telegram-bot-api');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initializeDatabase, getDb, getAdminPasswordHash } = require('./db');
const { setupAdminRoutes } = require('./routes/admin');
const { setupTelegramBot } = require('./routes/telegram');
const { dispatchExistsForToday, generateDispatch } = require('./services/dispatch');
const { performCompleteBackupCycle } = require('./services/backup');
const {
  routesPushedForToday,
  pushRoutesToAllBoys,
  sendDailySummaryToAdmin,
} = require('./services/scheduler');
const cron = require('node-cron');

// ─── Env validation ─────────────────────────────────────────────────

/**
 * Validates that required environment variables are set.
 * Exits the process with code 1 and a clear message if any are missing.
 */
function validateEnv() {
  // Load .env so missing-check works when called standalone
  dotenv.config();

  const required = [
    ['BOT_TOKEN', 'Telegram bot token from BotFather'],
    ['SESSION_SECRET', 'Secret for session encryption (64+ chars)'],
    ['ADMIN_PASSWORD', 'Password for admin dashboard login'],
    ['ADMIN_TELEGRAM_CHAT_ID', 'Telegram chat ID for admin (get from @userinfobot)'],
  ];

  const missing = required.filter(([name]) => !process.env[name]);

  if (missing.length > 0) {
    console.error('ERROR: Missing required environment variables:');
    for (const [name, desc] of missing) {
      console.error(`  - ${name}: ${desc}`);
    }
    console.error('\nCreate a .env file in the project root with these variables.');
    console.error('See .env.example for reference.\n');
    process.exit(1);
  }
}

// ─── Cron handler functions (extracted for readability) ────────────────

/**
 * Handles the 3 AM daily database backup cycle.
 */
function handleDailyBackup() {
  console.log('[Cron] Running scheduled 3 AM backup...');
  try {
    const result = performCompleteBackupCycle({
      dbPath: path.join(__dirname, 'data', 'dharma-farms.db'),
      backupDir: path.join(__dirname, 'backup'),
      maxBackups: 30,
    });
    if (result.backedUp) {
      console.log('[Cron] Database backed up, cleaned up ' + result.deleted + ' old backups');
    }
  } catch (err) {
    console.error('[Cron] Warning: Backup cycle failed —', err.message);
  }
}

/**
 * Pushes today's delivery routes to all active delivery boys via Telegram.
 * Called by the 5:30 AM cron job.
 * @param {import('better-sqlite3').Database} db
 * @param {import('node-telegram-bot-api').TelegramBot} bot
 */
async function handleRoutePush(db, bot) {
  console.log('[Cron] Running 5:30 AM route push...');
  try {
    const result = await pushRoutesToAllBoys(db, bot);
    if (result.pushed) {
      console.log('[Cron] Routes pushed to ' + result.sent + ' delivery boys');
    } else {
      console.log('[Cron] Routes already pushed today, skipping');
    }
  } catch (err) {
    console.error('[Cron] Warning: Route push failed —', err.message);
  }
}

/**
 * Sends the end-of-route delivery summary to the admin via Telegram.
 * Called by the 7:30 AM cron job.
 * @param {import('better-sqlite3').Database} db
 * @param {import('node-telegram-bot-api').TelegramBot} bot
 */
async function handleAdminSummary(db, bot) {
  console.log('[Cron] Running 7:30 AM admin summary...');
  try {
    const result = await sendDailySummaryToAdmin(db, bot);
    if (result.sent) {
      console.log('[Cron] Admin summary sent (' + result.total + ' deliveries)');
    } else {
      console.log('[Cron] Admin summary skipped (already sent or no chat ID)');
    }
  } catch (err) {
    console.error('[Cron] Warning: Admin summary failed —', err.message);
  }
}

/**
 * Stops all scheduled cron tasks. Used during graceful shutdown.
 */
function stopCronTasks() {
  for (const task of cron.getTasks().values()) {
    task.stop();
  }
  cron.getTasks().clear();
}

// ─── App factory (for testing) ──────────────────────────────────────

/**
 * Creates and configures the Express application with middleware and routes.
 * Does NOT start listening — use startServer() or app.listen() directly.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @returns {import('express').Application}
 */
function createApp(db) {
  const app = express();

  // ── Security headers (Helmet) ──────────────────────────────────────
  // Must be the first middleware so headers are set before any route processing.

  app.use(helmet());

  // ── Log sanitization ──────────────────────────────────────────────
  /**
   * Replaces /my-account/<64-char-hex> with /my-account/[REDACTED]
   * so customer tokens never appear in server logs or error output.
   * Route handlers must read the token from req.params, not req.originalUrl.
   */
  app.use((req, res, next) => {
    if (req.originalUrl && /\/my-account\/[a-f0-9]{64}/i.test(req.originalUrl)) {
      req.originalUrl = req.originalUrl.replace(
        /(\/my-account\/)[a-f0-9]{64}/gi,
        '$1[REDACTED]'
      );
      req.url = req.originalUrl;
    }
    next();
  });

  // ── Body parsing ──────────────────────────────────────────────────

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // ── Static files ──────────────────────────────────────────────────

  app.use(express.static(path.join(__dirname, 'public')));

  // ── EJS view engine ───────────────────────────────────────────────

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // ── Session (SQLite-backed) ───────────────────────────────────────

  const SQLiteStore = require('connect-sqlite3')(session);

  app.use(session({
    store: new SQLiteStore({
      db: 'sessions.db',
      dir: path.join(__dirname, 'data'),
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 4 * 60 * 60 * 1000, // 4 hours
      httpOnly: true,
      sameSite: 'lax',
    },
  }));

  // ── Rate limiting ──────────────────────────────────────────────────
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute window
    max: 5,                // 5 attempts per window per IP
    standardHeaders: true, // Return rate limit info in RateLimit-* headers
    legacyHeaders: false,  // Disable X-RateLimit-* headers
    message: { error: 'Too many login attempts. Try again in a minute.' },
  });
  app.locals.loginLimiter = loginLimiter;

  // ── Expose password hash to routes ────────────────────────────────

  app.locals.adminPasswordHash = getAdminPasswordHash();

  // ── Mount admin routes ────────────────────────────────────────────

  setupAdminRoutes(app, db);

  // ── 404 handler ───────────────────────────────────────────────────

  app.use((req, res) => {
    if (req.accepts('html')) {
      res.status(404).render('404', { url: req.originalUrl });
    } else {
      res.status(404).json({ error: 'Not found', url: req.originalUrl });
    }
  });

  // ── Error middleware ──────────────────────────────────────────────

  app.use((err, req, res, _next) => {
    console.error('[Server] Unhandled error:', err.message);
    console.error(err.stack);

    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  return app;
}

// ─── Server startup ─────────────────────────────────────────────────

/**
 * Starts the full server: validates env, initializes DB, creates the Express app,
 * starts Telegram bot polling, runs boot-time checks, and begins listening.
 *
 * Called automatically when this module is executed directly.
 */
function startServer() {
  // Load environment variables from .env
  dotenv.config();

  // 1. Validate environment variables
  validateEnv();

  // 2. Initialize database (creates tables, runs migrations, seeds data)
  const db = initializeDatabase();
  console.log('[Server] Database initialized');

  // 3. Create Express app
  const app = createApp(db);

  // 4. Initialize Telegram bot (polling mode)
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  setupTelegramBot(bot, () => getDb());

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.message);
  });

  console.log('[Telegram] Bot polling started');

  // 5. Boot check: generate today's dispatch if it doesn't exist yet
  if (!dispatchExistsForToday(db)) {
    const result = generateDispatch(db);
    console.log(`[Boot] Generated today's dispatch: ${result.count} deliveries`);
  } else {
    console.log('[Boot] Today\'s dispatch already exists, skipping');
  }

  // 6. Boot-time database backup (once per day, idempotent)
  try {
    const dbPath = path.join(__dirname, 'data', 'dharma-farms.db');
    const backupDir = path.join(__dirname, 'backup');
    const backupResult = performCompleteBackupCycle({ dbPath, backupDir, maxBackups: 30 });
    if (backupResult.backedUp) {
      console.log('[Boot] Database backed up to backup/' + backupResult.filename);
    } else {
      console.log('[Boot] Database backup already exists for today, skipping');
    }
  } catch (err) {
    console.error('[Boot] Warning: Backup failed —', err.message);
  }

  // 7. Boot-time route push (once per day, idempotent)
  (async () => {
    try {
      if (!routesPushedForToday(db)) {
        const result = await pushRoutesToAllBoys(db, bot);
        console.log('[Boot] Routes pushed to ' + result.sent + ' delivery boys' +
          (result.failed > 0 ? ', ' + result.failed + ' failed' : ''));
      } else {
        console.log('[Boot] Routes already pushed today, skipping');
      }
    } catch (err) {
      console.error('[Boot] Warning: Route push failed —', err.message);
    }
  })();

  // 8. Schedule 3 AM daily backup (fallback if server stays up across midnight)
  cron.schedule('0 3 * * *', handleDailyBackup);
  console.log('[Cron] Scheduled 3 AM daily backup');

  // 9. Schedule 5:30 AM route push (delivery boys get their routes)
  cron.schedule('30 5 * * *', () => handleRoutePush(db, bot));
  console.log('[Cron] Scheduled 5:30 AM route push');

  // 10. Schedule 7:30 AM admin summary (end-of-route report)
  cron.schedule('30 7 * * *', () => handleAdminSummary(db, bot));
  console.log('[Cron] Scheduled 7:30 AM admin summary');

  // 11. Start listening
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`[Server] Dharma Farms listening on port ${PORT}`);
  });

  // 12. Graceful shutdown (SIGINT = Ctrl+C)
  process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down gracefully...');
    stopCronTasks();
    bot.stopPolling();
    db.close();
    server.close(() => {
      process.exit(0);
    });
  });

  return { app, server, bot, db };
}

// ─── Direct execution ───────────────────────────────────────────────

if (require.main === module) {
  startServer();
}

// ─── Exports (for testing) ─────────────────────────────────────────

module.exports = { createApp, validateEnv, startServer, stopCronTasks };