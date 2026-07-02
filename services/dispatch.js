/**
 * services/dispatch.js — Dispatch generation and route queries.
 *
 * Handles the daily delivery dispatch: generating rows for all active customers
 * with active subscriptions, idempotently, in a transaction.
 */

/**
 * Checks whether a dispatch already exists for today.
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
function dispatchExistsForToday(db) {
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM deliveries WHERE delivery_date = date(\'now\')'
  ).get();
  return row.count > 0;
}

/**
 * Generates today's dispatch idempotently.
 *
 * Only includes:
 * - Customers with status = 'active'
 * - Customers who have an active subscription (status = 'active')
 *
 * Runs inside a transaction so partial failures are impossible.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ generated: boolean, count: number }}
 */
function generateDispatch(db) {
  if (dispatchExistsForToday(db)) {
    return { generated: false, count: 0 };
  }

  const insertDelivery = db.prepare(`
    INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
    SELECT c.id, c.delivery_boy_id, date('now'), 'pending'
    FROM customers c
    INNER JOIN subscriptions s ON s.customer_id = c.id
    WHERE c.status = 'active'
      AND s.status = 'active'
      AND (s.paused_until IS NULL OR s.paused_until <= date('now'))
      AND (s.end_date IS NULL OR s.end_date >= date('now'))
  `);

  const doInsert = db.transaction(() => {
    const info = insertDelivery.run();
    return info.changes;
  });

  const count = doInsert();
  return { generated: true, count };
}

/**
 * Gets today's deliveries for a specific delivery boy, joined with customer info.
 * @param {import('better-sqlite3').Database} db
 * @param {number} deliveryBoyId
 * @returns {Array<object>}
 */
function getTodaysRouteForBoy(db, deliveryBoyId) {
  return db.prepare(`
    SELECT
      d.id,
      d.customer_id,
      d.delivery_boy_id,
      d.delivery_date,
      d.status,
      d.issue_reason,
      d.marked_at,
      c.code AS customer_code,
      c.name AS customer_name,
      c.address,
      c.phone AS customer_phone
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.delivery_date = date('now')
      AND d.delivery_boy_id = ?
    ORDER BY c.code ASC
  `).all(deliveryBoyId);
}

/**
 * Regenerates today's dispatch: deletes all existing deliveries for today
 * and re-inserts based on current customer/subscription data.
 *
 * Runs inside a transaction so partial failures are impossible.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ generated: boolean, count: number }}
 */
function regenerateDispatch(db) {
  const deleteToday = db.prepare(
    "DELETE FROM deliveries WHERE delivery_date = date('now')"
  );

  const insertDelivery = db.prepare(`
    INSERT INTO deliveries (customer_id, delivery_boy_id, delivery_date, status)
    SELECT c.id, c.delivery_boy_id, date('now'), 'pending'
    FROM customers c
    INNER JOIN subscriptions s ON s.customer_id = c.id
    WHERE c.status = 'active'
      AND s.status = 'active'
      AND (s.paused_until IS NULL OR s.paused_until <= date('now'))
      AND (s.end_date IS NULL OR s.end_date >= date('now'))
  `);

  const doRegenerate = db.transaction(() => {
    deleteToday.run();
    const info = insertDelivery.run();
    return info.changes;
  });

  const count = doRegenerate();
  return { generated: true, count };
}

module.exports = {
  dispatchExistsForToday,
  generateDispatch,
  regenerateDispatch,
  getTodaysRouteForBoy,
};