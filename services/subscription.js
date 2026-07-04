/**
 * services/subscription.js — Payment ledger and balance logic.
 *
 * Handles payment recording (append-only, no edit/delete),
 * payment ledger with running totals, and balance calculations.
 */

const VALID_MODES = ['cash', 'upi', 'bank_transfer'];

/**
 * Auto-expires subscriptions whose end_date has passed.
 *
 * Updates status from 'active' to 'expired' for all subscriptions
 * where end_date is before today.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} — number of rows updated
 */
function autoExpireSubscriptions(db) {
  const info = db.prepare(`
    UPDATE subscriptions SET status = 'expired'
    WHERE status = 'active' AND end_date IS NOT NULL AND end_date < date('now')
  `).run();
  return info.changes;
}

/**
 * Returns the valid payment modes for dropdown rendering.
 * @returns {string[]}
 */
function getPaymentModes() {
  return [...VALID_MODES];
}

/**
 * Validates and records a single payment inside a transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} data
 * @param {number} data.customerId
 * @param {number} data.amount - in paise, must be > 0
 * @param {string} data.mode - one of 'cash', 'upi', 'bank_transfer'
 * @param {string} data.paymentDate - YYYY-MM-DD
 * @param {string} [data.notes] - optional, defaults to ''
 * @param {string} [data.recordedBy] - optional, defaults to 'Admin'
 * @returns {{ id: number }}
 */
function recordPayment(db, data) {
  const { customerId, amount, mode, paymentDate, notes, recordedBy } = data;

  // Validation
  if (!customerId || customerId <= 0) {
    throw new Error('Valid customer is required');
  }
  if (!amount || amount <= 0) {
    throw new Error('Payment amount must be greater than 0');
  }
  if (!VALID_MODES.includes(mode)) {
    throw new Error('Invalid payment mode. Must be cash, upi, or bank_transfer');
  }
  if (!paymentDate) {
    throw new Error('Payment date is required');
  }

  const insert = db.prepare(`
    INSERT INTO payments (customer_id, amount, mode, payment_date, notes, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const doInsert = db.transaction(() => {
    const info = insert.run(
      customerId,
      amount,
      mode,
      paymentDate,
      notes || '',
      recordedBy || 'Admin'
    );
    return { id: Number(info.lastInsertRowid) };
  });

  return doInsert();
}

/**
 * Returns chronological list of payments for a customer with running totals.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} customerId
 * @returns {Array<object>}
 */
function getPaymentLedger(db, customerId) {
  const rows = db.prepare(`
    SELECT * FROM payments WHERE customer_id = ? ORDER BY payment_date ASC, created_at ASC
  `).all(customerId);

  let runningTotal = 0;
  return rows.map(row => {
    runningTotal += row.amount;
    return {
      ...row,
      amount_rupees: (row.amount / 100).toFixed(2),
      runningTotalPaise: runningTotal,
      runningTotalRupees: (runningTotal / 100).toFixed(2),
    };
  });
}

/**
 * Calculates the customer's effective remaining days by comparing total payments
 * against delivered days.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} customerId
 * @returns {{ paidDays: number, consumedDays: number, balanceDays: number, subscriptionRemaining: number|null, isOverdue: boolean }}
 */
function getBalance(db, customerId) {
  // 1. Get customer's monthly rate
  const customer = db.prepare(
    'SELECT monthly_rate FROM customers WHERE id = ?'
  ).get(customerId);

  if (!customer) {
    return { paidDays: 0, consumedDays: 0, balanceDays: 0, subscriptionRemaining: null, isOverdue: false };
  }

  const monthlyRate = customer.monthly_rate;

  // 2. Get total payments
  const paymentRow = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE customer_id = ?'
  ).get(customerId);

  // 3. Get delivered count
  const deliveryRow = db.prepare(
    "SELECT COUNT(*) AS delivered_count FROM deliveries WHERE customer_id = ? AND status = 'delivered'"
  ).get(customerId);

  // 4. Get active subscription
  const sub = db.prepare(
    "SELECT remaining_days, total_days, status FROM subscriptions WHERE customer_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
  ).get(customerId);

  // Computation
  const totalPaid = paymentRow.total_paid;
  const deliveredCount = deliveryRow.delivered_count;

  let paidDays = 0;
  if (monthlyRate > 0) {
    paidDays = Math.floor(totalPaid / monthlyRate * 30);
  }

  const consumedDays = deliveredCount;
  const balanceDays = paidDays - consumedDays;
  const isOverdue = balanceDays < 0 && !!sub && sub.status === 'active';

  return {
    paidDays,
    consumedDays,
    balanceDays,
    subscriptionRemaining: sub ? sub.remaining_days : null,
    isOverdue,
  };
}

/**
 * Validates that a date string matches YYYY-MM-DD format.
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(dateStr).getTime());
}

/**
 * Pauses an active subscription from startDate to endDate (inclusive).
 *
 * Simplified: pause stays pause. No days shift. remaining_days is unchanged.
 *
 * Validation (in order):
 * - Customer must exist
 * - Customer must have an active subscription (status = 'active')
 * - Subscription must NOT already be paused (paused_until IS NULL)
 * - startDate must be >= tomorrow
 * - endDate must be > startDate
 * - Dates must match YYYY-MM-DD format
 *
 * Also deletes any pending deliveries within the pause range.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} customerId
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {{ paused: boolean, pausedUntil: string }}
 */
function pauseSubscription(db, customerId, startDate, endDate) {
  // Validate YYYY-MM-DD format
  if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
    throw new Error('Dates must be in YYYY-MM-DD format');
  }

  // Validate startDate >= tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  if (startDate < tomorrowStr) {
    throw new Error('Start date must be tomorrow or later');
  }

  // Validate endDate > startDate
  if (endDate <= startDate) {
    throw new Error('End date must be after start date');
  }

  // Validate customer exists
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
  if (!customer) {
    throw new Error('Customer not found');
  }

  // Validate active subscription exists and is not already paused
  const sub = db.prepare(
    "SELECT id, status, paused_until, remaining_days FROM subscriptions WHERE customer_id = ? AND status = 'active' AND paused_until IS NULL ORDER BY id DESC LIMIT 1"
  ).get(customerId);

  if (!sub) {
    throw new Error('No active subscription found');
  }

  const doPause = db.transaction(() => {
    // Update subscription: set status to paused, no remaining_days change
    db.prepare(`
      UPDATE subscriptions
      SET status = 'paused',
          paused_until = ?,
          paused_from = ?
      WHERE customer_id = ? AND status = 'active' AND paused_until IS NULL
    `).run(endDate, startDate, customerId);

    // Delete pending deliveries within the pause range
    db.prepare(`
      DELETE FROM deliveries
      WHERE customer_id = ? AND delivery_date >= ? AND delivery_date <= ? AND status = 'pending'
    `).run(customerId, startDate, endDate);
  });

  doPause();

  return { paused: true, pausedUntil: endDate };
}

/**
 * Resumes a paused subscription.
 *
 * Simplified: no remaining_days adjustment. Status is set back to active,
 * and paused_until / paused_from are cleared.
 *
 * Validation:
 * - Customer must exist
 * - Customer must have a subscription
 * - Subscription must be paused (paused_until IS NOT NULL)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} customerId
 * @returns {{ resumed: boolean }}
 */
function resumeSubscription(db, customerId) {
  // Validate customer exists
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
  if (!customer) {
    throw new Error('Customer not found');
  }

  // Validate a paused subscription exists
  const sub = db.prepare(
    "SELECT id FROM subscriptions WHERE customer_id = ? AND paused_until IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get(customerId);

  if (!sub) {
    throw new Error('Subscription is not paused');
  }

  // Update subscription: set status to active, clear pause fields, no remaining_days change
  db.prepare(`
    UPDATE subscriptions
    SET status = 'active',
        paused_until = NULL,
        paused_from = NULL
    WHERE customer_id = ? AND paused_until IS NOT NULL
  `).run(customerId);

  return { resumed: true };
}

module.exports = {
  autoExpireSubscriptions,
  getBalance,
  getPaymentLedger,
  recordPayment,
  getPaymentModes,
  pauseSubscription,
  resumeSubscription,
};