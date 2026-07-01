/**
 * routes/telegram.js — Telegram bot command handlers.
 *
 * Sets up message handlers on a Telegram bot instance for polling mode.
 * Commands: /start, /route, /done, /skip, /issue, /arriving, /finish, /help
 *
 * Dependencies: services/telegram.js (formatting), services/dispatch.js (route queries), db.js (database)
 */

const { formatRouteMessage, buildDeliverySummary } = require('../services/telegram');
const { getTodaysRouteForBoy } = require('../services/dispatch');

const CUSTOMER_CODE_RE = /^(C\d{3})$/i;

/**
 * Registers message handlers on the bot instance.
 * @param {import('node-telegram-bot-api')} bot
 * @param {function} getDb - Function that returns the database instance
 */
function setupTelegramBot(bot, getDb) {
  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim();

      // Ignore non-command messages
      if (!text.startsWith('/')) return;

      const parts = text.split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      const db = getDb();
      if (!db) {
        await bot.sendMessage(chatId, 'System is not ready. Please try again later.');
        return;
      }

      // Commands that don't require a registered delivery boy
      if (command === '/start') {
        return handleStart(bot, chatId, db, args);
      }
      if (command === '/help') {
        return handleHelp(bot, chatId);
      }

      // All other commands require a registered delivery boy
      const boy = db.prepare(
        'SELECT * FROM delivery_boys WHERE telegram_chat_id = ?'
      ).get(chatId);

      if (!boy) {
        return bot.sendMessage(
          chatId,
          'Please register first using /start followed by your registered phone number.'
        );
      }

      switch (command) {
        case '/route':
          return handleRoute(bot, chatId, db, boy);
        case '/done':
          return handleDone(bot, chatId, db, boy, args);
        case '/skip':
          return handleSkip(bot, chatId, db, boy, args);
        case '/issue':
          return handleIssue(bot, chatId, db, boy, args);
        case '/arriving':
          return handleArriving(bot, chatId, db, boy, args);
        case '/finish':
          return handleFinish(bot, chatId, db, boy);
        default:
          return bot.sendMessage(chatId, 'Unknown command. Use /help to see available commands.');
      }
    } catch (err) {
      console.error('Telegram handler error:', err);
    }
  });
}

/**
 * /start [phone] — Register a delivery boy by phone number and link their Telegram chat_id.
 */
async function handleStart(bot, chatId, db, args) {
  const phone = args[0];

  if (!phone) {
    return bot.sendMessage(
      chatId,
      'Please provide your registered phone number.\nUsage: /start <phone_number>'
    );
  }

  // Check if this chat_id is already registered
  const existingBoy = db.prepare(
    'SELECT * FROM delivery_boys WHERE telegram_chat_id = ?'
  ).get(chatId);

  if (existingBoy) {
    return bot.sendMessage(
      chatId,
      `You are already registered as ${existingBoy.name}. Use /help to see available commands.`
    );
  }

  // Look up delivery boy by phone number
  const boy = db.prepare(
    'SELECT * FROM delivery_boys WHERE phone = ?'
  ).get(phone);

  if (!boy) {
    return bot.sendMessage(
      chatId,
      `No delivery boy found with phone number ${phone}. Please check and try again.`
    );
  }

  // Link the chat_id to the delivery boy
  db.prepare(
    'UPDATE delivery_boys SET telegram_chat_id = ? WHERE id = ?'
  ).run(chatId, boy.id);

  return bot.sendMessage(
    chatId,
    `Welcome ${boy.name}! You have been registered successfully. Use /help to see available commands.`
  );
}

/**
 * /route — Show today's deliveries for the registered delivery boy.
 */
async function handleRoute(bot, chatId, db, boy) {
  const deliveries = getTodaysRouteForBoy(db, boy.id);
  const message = formatRouteMessage(deliveries, boy.name);
  return bot.sendMessage(chatId, message);
}

/**
 * /done <code> — Mark a delivery as delivered, decrement remaining_days.
 * Duplicate: "Already marked as <status> at HH:MM"
 */
async function handleDone(bot, chatId, db, boy, args) {
  const code = args[0];
  if (!code || !CUSTOMER_CODE_RE.test(code)) {
    return bot.sendMessage(
      chatId,
      'Please provide a valid customer code. Usage: /done C001'
    );
  }

  const delivery = db.prepare(`
    SELECT d.id, d.status, d.marked_at, c.id AS customer_id, c.code, c.name
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE c.code = ? AND d.delivery_date = date('now') AND c.delivery_boy_id = ?
  `).get(code, boy.id);

  if (!delivery) {
    return bot.sendMessage(
      chatId,
      `Customer ${code} not found in today's route. Please check the code and try again.`
    );
  }

  // Check if already marked
  if (delivery.status !== 'pending') {
    const time = delivery.marked_at || 'unknown';
    return bot.sendMessage(
      chatId,
      `Already marked as "${delivery.status}" at ${time}.`
    );
  }

  const timeStr = nowTimeString();

  db.prepare(`
    UPDATE deliveries SET status = 'delivered', marked_at = ? WHERE id = ?
  `).run(timeStr, delivery.id);

  // Decrement remaining_days
  db.prepare(`
    UPDATE subscriptions SET remaining_days = remaining_days - 1
    WHERE customer_id = ? AND status = 'active'
  `).run(delivery.customer_id);

  return bot.sendMessage(
    chatId,
    `✅ ${code} — ${delivery.name} marked as delivered at ${timeStr}.`
  );
}

/**
 * /skip <code> — Mark a delivery as skipped, increment remaining_days.
 */
async function handleSkip(bot, chatId, db, boy, args) {
  const code = args[0];
  if (!code || !CUSTOMER_CODE_RE.test(code)) {
    return bot.sendMessage(
      chatId,
      'Please provide a valid customer code. Usage: /skip C001'
    );
  }

  const delivery = db.prepare(`
    SELECT d.id, d.status, c.id AS customer_id, c.code, c.name
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE c.code = ? AND d.delivery_date = date('now') AND c.delivery_boy_id = ?
  `).get(code, boy.id);

  if (!delivery) {
    return bot.sendMessage(
      chatId,
      `Customer ${code} not found in today's route. Please check the code and try again.`
    );
  }

  if (delivery.status !== 'pending') {
    return bot.sendMessage(
      chatId,
      `Customer ${code} has already been marked as "${delivery.status}". Cannot skip.`
    );
  }

  const timeStr = nowTimeString();

  db.prepare(`
    UPDATE deliveries SET status = 'skipped', marked_at = ? WHERE id = ?
  `).run(timeStr, delivery.id);

  // Increment remaining_days (skip preserves the day for later)
  db.prepare(`
    UPDATE subscriptions SET remaining_days = remaining_days + 1
    WHERE customer_id = ? AND status = 'active'
  `).run(delivery.customer_id);

  return bot.sendMessage(
    chatId,
    `⏭️ ${code} — ${delivery.name} marked as skipped at ${timeStr}.`
  );
}

/**
 * /issue <code> <reason> — Record a delivery issue with a reason.
 * Missing reason: "Please include a reason"
 */
async function handleIssue(bot, chatId, db, boy, args) {
  const code = args[0];
  if (!code || !CUSTOMER_CODE_RE.test(code)) {
    return bot.sendMessage(
      chatId,
      'Please provide a valid customer code. Usage: /issue C001 <reason>'
    );
  }

  const reason = args.slice(1).join(' ').trim();
  if (!reason) {
    return bot.sendMessage(
      chatId,
      'Please include a reason. Usage: /issue C001 <reason>'
    );
  }

  const delivery = db.prepare(`
    SELECT d.id, d.status, c.id AS customer_id, c.code, c.name
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE c.code = ? AND d.delivery_date = date('now') AND c.delivery_boy_id = ?
  `).get(code, boy.id);

  if (!delivery) {
    return bot.sendMessage(
      chatId,
      `Customer ${code} not found in today's route. Please check the code and try again.`
    );
  }

  const timeStr = nowTimeString();

  db.prepare(`
    UPDATE deliveries SET status = 'issue', issue_reason = ?, marked_at = ? WHERE id = ?
  `).run(reason, timeStr, delivery.id);

  return bot.sendMessage(
    chatId,
    `⚠️ ${code} — ${delivery.name} issue recorded: ${reason}`
  );
}

/**
 * /arriving <code> — Mark a delivery as arriving.
 */
async function handleArriving(bot, chatId, db, boy, args) {
  const code = args[0];
  if (!code || !CUSTOMER_CODE_RE.test(code)) {
    return bot.sendMessage(
      chatId,
      'Please provide a valid customer code. Usage: /arriving C001'
    );
  }

  const delivery = db.prepare(`
    SELECT d.id, d.status, c.id AS customer_id, c.code, c.name
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE c.code = ? AND d.delivery_date = date('now') AND c.delivery_boy_id = ?
  `).get(code, boy.id);

  if (!delivery) {
    return bot.sendMessage(
      chatId,
      `Customer ${code} not found in today's route. Please check the code and try again.`
    );
  }

  const timeStr = nowTimeString();

  db.prepare(`
    UPDATE deliveries SET status = 'arriving', marked_at = ? WHERE id = ?
  `).run(timeStr, delivery.id);

  return bot.sendMessage(
    chatId,
    `🚚 ${code} — ${delivery.name} marked as arriving at ${timeStr}.`
  );
}

/**
 * /finish — End-of-route summary with status counts.
 */
async function handleFinish(bot, chatId, db, boy) {
  const deliveries = getTodaysRouteForBoy(db, boy.id);

  if (!deliveries || deliveries.length === 0) {
    return bot.sendMessage(chatId, 'No deliveries scheduled for you today.');
  }

  const summary = buildDeliverySummary(deliveries);
  return bot.sendMessage(chatId, summary.summary);
}

/**
 * /help — List all available commands.
 */
async function handleHelp(bot, chatId) {
  const helpText = [
    'Available commands:',
    '',
    '/start <phone> — Register your Telegram account',
    '/route — Show today\'s delivery route',
    '/done <code> — Mark delivery as delivered',
    '/skip <code> — Mark delivery as skipped',
    '/issue <code> <reason> — Report an issue',
    '/arriving <code> — Mark as arriving',
    '/finish — End of route summary',
    '/help — Show this help message',
  ].join('\n');

  return bot.sendMessage(chatId, helpText);
}

/**
 * Returns the current time as HH:MM in 24-hour format.
 * @returns {string}
 */
function nowTimeString() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

module.exports = { setupTelegramBot };