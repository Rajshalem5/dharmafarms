/**
 * routes/customer.js — Token-based customer portal route handlers.
 *
 * Three endpoints for customer self-service:
 *   GET  /my-account/:token       — View subscription status
 *   POST /my-account/:token/pause  — Pause deliveries for a date range
 *   POST /my-account/:token/resume — Resume deliveries
 *
 * Security: All failure modes render { error: true } with identical output.
 * No error.message is ever exposed to the template.
 */

const { pauseSubscription, resumeSubscription } = require('../services/subscription');

/**
 * Looks up a customer by token and validates they are active.
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {object|null} — customer row or null
 */
function lookupCustomer(db, token) {
  const customer = db.prepare('SELECT * FROM customers WHERE token = ?').get(token || '');
  if (!customer || customer.status !== 'active') return null;
  return customer;
}

/**
 * Queries all data needed for the customer portal view.
 * @param {import('better-sqlite3').Database} db
 * @param {object} customer
 * @returns {object} — template data
 */
function getPortalData(db, customer) {
  // Get subscription
  const sub = db.prepare(
    "SELECT * FROM subscriptions WHERE customer_id = ? AND status IN ('active', 'paused') ORDER BY id DESC LIMIT 1"
  ).get(customer.id);

  // Get today's delivery
  const todayDelivery = db.prepare(
    "SELECT status FROM deliveries WHERE customer_id = ? AND delivery_date = date('now')"
  ).get(customer.id);

  // Get delivery boy name
  const boy = db.prepare('SELECT name FROM delivery_boys WHERE id = ?').get(customer.delivery_boy_id);

  // Compute tomorrow's date for min date input
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  return {
    error: false,
    customerName: customer.name,
    customerCode: customer.code,
    deliveryBoyName: boy ? boy.name : 'Unknown',
    subscriptionStatus: sub ? sub.status : 'expired',
    remainingDays: sub ? sub.remaining_days : 0,
    pausedUntil: sub ? sub.paused_until : null,
    todayDeliveryStatus: todayDelivery ? todayDelivery.status : null,
    token: customer.token,
    tomorrow: tomorrowStr,
  };
}

/**
 * Renders the customer portal with error:true — identical for all failure modes.
 * @param {import('express').Response} res
 */
function renderError(res) {
  res.status(200).render('customer/portal', { error: true });
}

/**
 * Mounts customer portal routes on the Express app.
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 */
function setupCustomerRoutes(app, db) {
  // ── GET /my-account/:token ────────────────────────────────────────

  app.get('/my-account/:token', (req, res) => {
    try {
      const customer = lookupCustomer(db, req.params.token);
      if (!customer) {
        return renderError(res);
      }

      const data = getPortalData(db, customer);
      res.render('customer/portal', data);
    } catch (err) {
      console.error('[Customer] Error on', req.originalUrl, err.message);
      renderError(res);
    }
  });

  // ── POST /my-account/:token/pause ─────────────────────────────────

  app.post('/my-account/:token/pause', (req, res) => {
    try {
      const customer = lookupCustomer(db, req.params.token);
      if (!customer) {
        return renderError(res);
      }

      const { start_date, end_date } = req.body;

      // Basic validation: both dates required
      if (!start_date || !end_date) {
        const data = getPortalData(db, customer);
        data.pauseError = 'Start and end dates are required';
        return res.render('customer/portal', data);
      }

      const result = pauseSubscription(db, customer.id, start_date, end_date);

      // Reload portal data with success flags
      const data = getPortalData(db, customer);
      data.pauseSuccess = true;
      data.pauseEndDate = result.pausedUntil;
      res.render('customer/portal', data);
    } catch (err) {
      console.error('[Customer] Error on', req.originalUrl, err.message);
      renderError(res);
    }
  });

  // ── POST /my-account/:token/resume ────────────────────────────────

  app.post('/my-account/:token/resume', (req, res) => {
    try {
      const customer = lookupCustomer(db, req.params.token);
      if (!customer) {
        return renderError(res);
      }

      resumeSubscription(db, customer.id);

      // Reload portal data with success flags
      const data = getPortalData(db, customer);
      data.resumeSuccess = true;
      res.render('customer/portal', data);
    } catch (err) {
      console.error('[Customer] Error on', req.originalUrl, err.message);
      renderError(res);
    }
  });
}

module.exports = { setupCustomerRoutes };