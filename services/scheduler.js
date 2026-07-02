/**
 * services/scheduler.js — Route push scheduling and admin summary.
 *
 * Manages daily route push to delivery boys (via Telegram) and end-of-route
 * admin summary. Idempotency is enforced via the scheduler_log table.
 */
const { getTodaysRouteForBoy } = require('./dispatch');

/**
 * Checks whether a scheduler event type has already been logged today.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} type - event type (e.g. 'route_push', 'admin_summary')
 * @returns {boolean}
 */
function hasEventRunToday(db, type) {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM scheduler_log WHERE type = ? AND log_date = date('now')"
  ).get(type);
  return row.count > 0;
}

/**
 * Convenience wrapper: checks whether routes have been pushed today.
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
function routesPushedForToday(db) {
  return hasEventRunToday(db, 'route_push');
}

/**
 * Logs a scheduler event in the scheduler_log table (idempotent insert).
 *
 * Uses INSERT OR IGNORE so duplicate (type, log_date) pairs are silently skipped.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} type
 * @param {string} [details]
 * @returns {boolean} whether a new row was inserted
 */
function logEvent(db, type, details) {
  const info = db.prepare(
    `INSERT OR IGNORE INTO scheduler_log (type, log_date, details)
     VALUES (?, date('now'), ?)`
  ).run(type, details || null);
  return info.changes > 0;
}

/**
 * Formats a route message for a single delivery boy.
 *
 * @param {Array<object>} deliveries - result of getTodaysRouteForBoy()
 * @param {string} boyName
 * @returns {string}
 */
function formatRouteMessage(deliveries, boyName) {
  const lines = [`/route — Today's Route for ${boyName}`];
  lines.push('━'.repeat(24));

  if (deliveries.length === 0) {
    lines.push('No deliveries today.');
  } else {
    deliveries.forEach((d, i) => {
      const statusIcon =
        d.status === 'delivered' ? '✅' :
        d.status === 'pending'   ? '⏳' :
        d.status === 'skipped'   ? '⏭️' :
        d.status === 'issue'     ? '⚠️' : '❓';
      lines.push(`${i + 1}. ${d.customer_code} — ${d.customer_name}`);
      lines.push(`   ${d.address}`);
      lines.push(`   ${statusIcon} ${d.status}`);
    });
  }

  lines.push('━'.repeat(24));
  lines.push(`Total: ${deliveries.length} deliveries`);
  lines.push('Use /done, /skip, or /issue to update status.');

  return lines.join('\n');
}

/**
 * Pushes today's route to all active delivery boys with a telegram_chat_id.
 *
 * Idempotent: checks routesPushedForToday() before sending.
 * Partial failure: logs event even if some sends fail.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} bot - Telegram bot instance with sendMessage(chatId, text)
 * @returns {Promise<{ pushed: boolean, sent: number, failed: number, errors: string[] }>}
 */
async function pushRoutesToAllBoys(db, bot) {
  if (routesPushedForToday(db)) {
    return { pushed: false, sent: 0, failed: 0, errors: [] };
  }

  // Get active delivery boys with telegram_chat_id
  const boys = db.prepare(
    "SELECT id, name, telegram_chat_id FROM delivery_boys WHERE status = 'active' AND telegram_chat_id IS NOT NULL"
  ).all();

  if (boys.length === 0) {
    logEvent(db, 'route_push', 'No active boys with chat_id found');
    return { pushed: true, sent: 0, failed: 0, errors: [] };
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const boy of boys) {
    try {
      const deliveries = getTodaysRouteForBoy(db, boy.id);
      const message = formatRouteMessage(deliveries, boy.name);
      await bot.sendMessage(boy.telegram_chat_id, message);
      sent++;
    } catch (err) {
      failed++;
      errors.push(`Boy ${boy.name} (chat ${boy.telegram_chat_id}): ${err.message}`);
    }
  }

  logEvent(db, 'route_push', `Sent: ${sent}, Failed: ${failed}`);
  return { pushed: true, sent, failed, errors };
}

/**
 * Aggregates today's delivery stats and sends a summary to the admin's Telegram chat.
 *
 * Idempotent: checks hasEventRunToday('admin_summary') before sending.
 * Gracefully handles missing ADMIN_TELEGRAM_CHAT_ID env var.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} bot - Telegram bot instance with sendMessage(chatId, text)
 * @returns {{ sent: boolean, total: number }}
 */
async function sendDailySummaryToAdmin(db, bot) {
  const totalRow = db.prepare(
    "SELECT COUNT(*) AS count FROM deliveries WHERE delivery_date = date('now')"
  ).get();
  const total = totalRow.count;

  const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!adminChatId) {
    console.warn('[Scheduler] ADMIN_TELEGRAM_CHAT_ID not set, skipping summary');
    return { sent: false, total };
  }

  if (hasEventRunToday(db, 'admin_summary')) {
    return { sent: false, total };
  }

  // Get status breakdown
  const statusBreakdown = db.prepare(
    "SELECT status, COUNT(*) AS count FROM deliveries WHERE delivery_date = date('now') GROUP BY status"
  ).all();

  // Get per-boy breakdown
  const perBoy = db.prepare(`
    SELECT db.name, COUNT(*) AS count
    FROM deliveries d
    JOIN delivery_boys db ON db.id = d.delivery_boy_id
    WHERE d.delivery_date = date('now')
    GROUP BY db.id, db.name
    ORDER BY db.name
  `).all();

  // Build summary message
  const statusMap = {};
  for (const s of statusBreakdown) {
    statusMap[s.status] = s.count;
  }

  const lines = ['📊 Daily Delivery Summary'];
  lines.push('━'.repeat(24));
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Total: ${total} deliveries`);
  lines.push('');
  lines.push('Status Breakdown:');
  lines.push(`  ✅ Delivered: ${statusMap['delivered'] || 0}`);
  lines.push(`  ⏳ Pending:   ${statusMap['pending'] || 0}`);
  lines.push(`  ⏭️ Skipped:   ${statusMap['skipped'] || 0}`);
  lines.push(`  ⚠️ Issues:    ${statusMap['issue'] || 0}`);
  lines.push('');

  if (perBoy.length > 0) {
    lines.push('Per Delivery Boy:');
    for (const boy of perBoy) {
      lines.push(`  👤 ${boy.name}: ${boy.count} deliveries`);
    }
  }

  const message = lines.join('\n');

  try {
    await bot.sendMessage(adminChatId, message);
    logEvent(db, 'admin_summary', `Sent: ${total} deliveries`);
    return { sent: true, total };
  } catch (err) {
    console.error('[Scheduler] Failed to send admin summary:', err.message);
    return { sent: false, total };
  }
}

module.exports = {
  hasEventRunToday,
  routesPushedForToday,
  pushRoutesToAllBoys,
  sendDailySummaryToAdmin,
};