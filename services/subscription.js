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

module.exports = {
  autoExpireSubscriptions,
  getBalance,
  getPaymentLedger,
  recordPayment,
  getPaymentModes,
};