/**
 * routes/admin.js — Admin route handlers for Dharma Farms.
 *
 * Handles authentication, dashboard, customer management, and dispatch.
 * All admin routes (except /health, /login) require session authentication.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const bcrypt = require('bcryptjs');
const { generateDispatch, regenerateDispatch, dispatchExistsForToday } = require('../services/dispatch');
const { getBalance, getPaymentLedger, recordPayment, getPaymentModes } = require('../services/subscription');

const PHONE_RE = /^\d{10,15}$/;

/**
 * Renders a child view and wraps it in the admin layout.
 * Layout template uses <%- body %> to inject the child content.
 */
function renderView(res, view, data) {
  const viewPath = path.join(res.app.get('views'), view + '.ejs');
  const template = fs.readFileSync(viewPath, 'utf8');
  const body = ejs.render(template, data, { filename: viewPath });
  res.render('admin/layout', { ...data, body });
}

/**
 * Middleware: require an authenticated admin session.
 * Redirects to /admin/login if not authenticated.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  res.redirect('/admin/login');
}

/**
 * Returns the next auto-generated customer code.
 * Finds the highest existing code number and increments.
 * @param {import('better-sqlite3').Database} db
 * @returns {string} e.g. "C005"
 */
function nextCustomerCode(db) {
  const row = db.prepare(
    "SELECT code FROM customers ORDER BY LENGTH(code) DESC, code DESC LIMIT 1"
  ).get();

  if (!row) return 'C001';

  const num = parseInt(row.code.replace('C', ''), 10);
  return `C${String(num + 1).padStart(3, '0')}`;
}

/**
 * Registers all admin routes on the Express app.
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 */
function setupAdminRoutes(app, db) {
  // ── Health check (no auth) ──────────────────────────────────────

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Login ───────────────────────────────────────────────────────

  app.get('/admin/login', (req, res) => {
    const error = req.query.error === '1';
    res.render('login', { error });
  });

  app.post('/admin/login', (req, res) => {
    const { password } = req.body;

    if (!password) {
      return res.redirect('/admin/login?error=1');
    }

    const hash = app.locals.adminPasswordHash;
    if (!hash) {
      return res.redirect('/admin/login?error=1');
    }

    if (bcrypt.compareSync(password, hash)) {
      req.session.admin = true;
      return res.redirect('/admin/dashboard');
    }

    res.redirect('/admin/login?error=1');
  });

  // ── Logout ──────────────────────────────────────────────────────

  app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/admin/login');
    });
  });

  // ── Redirect /admin → /admin/dashboard ──────────────────────────

  app.get('/admin', requireAuth, (req, res) => {
    res.redirect('/admin/dashboard');
  });

  // ── Dashboard ───────────────────────────────────────────────────

  app.get('/admin/dashboard', requireAuth, (req, res) => {
    const today = new Date().toISOString().slice(0, 10);

    // Per-boy delivery counts
    const boyStats = db.prepare(`
      SELECT
        db.id AS boy_id,
        db.name AS boy_name,
        COUNT(d.id) AS total,
        SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN d.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN d.status = 'issue' THEN 1 ELSE 0 END) AS issue,
        SUM(CASE WHEN d.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN d.status = 'arriving' THEN 1 ELSE 0 END) AS arriving
      FROM delivery_boys db
      LEFT JOIN deliveries d ON d.delivery_boy_id = db.id AND d.delivery_date = ?
      WHERE db.status = 'active'
      GROUP BY db.id, db.name
      ORDER BY db.name ASC
    `).all(today);

    // Totals across all boys
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status = 'issue' THEN 1 ELSE 0 END) AS issue,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'arriving' THEN 1 ELSE 0 END) AS arriving
      FROM deliveries
      WHERE delivery_date = ?
    `).get(today);

    const activeCustomers = db.prepare(
      "SELECT COUNT(*) AS count FROM customers WHERE status = 'active'"
    ).get().count;

    const hasDeliveries = totals && totals.total > 0;

    renderView(res, 'admin/dashboard', {
      boyStats: boyStats || [],
      totals: totals || { total: 0, delivered: 0, skipped: 0, issue: 0, pending: 0, arriving: 0 },
      activeCustomers,
      hasDeliveries,
      activePage: 'dashboard',
    });
  });

  // ── Customer list ───────────────────────────────────────────────

  app.get('/admin/customers', requireAuth, (req, res) => {
    const customers = db.prepare(`
      SELECT c.*, db.name AS delivery_boy_name
      FROM customers c
      LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
      ORDER BY c.code ASC
    `).all();

    const deliveryBoys = db.prepare(
      "SELECT * FROM delivery_boys WHERE status = 'active' ORDER BY name ASC"
    ).all();

    const flash = req.session.flash || null;
    req.session.flash = null;

    renderView(res, 'admin/customers', {
      customers: customers || [],
      deliveryBoys: deliveryBoys || [],
      flash,
      activePage: 'customers',
    });
  });

  // ── Add customer ────────────────────────────────────────────────

  app.post('/admin/customers', requireAuth, (req, res) => {
    const { name, phone, address, delivery_boy_id, monthly_rate } = req.body;

    if (!name || !name.trim() || !phone || !address || !monthly_rate) {
      req.session.flash = { type: 'error', message: 'All fields are required.' };
      return res.redirect('/admin/customers');
    }

    if (!PHONE_RE.test(phone)) {
      req.session.flash = { type: 'error', message: 'Invalid phone number. Must be 10-15 digits.' };
      return res.redirect('/admin/customers');
    }

    if (delivery_boy_id) {
      const boy = db.prepare('SELECT id FROM delivery_boys WHERE id = ?').get(delivery_boy_id);
      if (!boy) {
        req.session.flash = { type: 'error', message: 'Invalid delivery boy selected.' };
        return res.redirect('/admin/customers');
      }
    }

    const rateInPaise = Math.round(parseFloat(monthly_rate) * 100);
    if (rateInPaise <= 0) {
      req.session.flash = { type: 'error', message: 'Monthly rate must be a positive number.' };
      return res.redirect('/admin/customers');
    }

    const code = nextCustomerCode(db);
    const token = crypto.randomBytes(32).toString('hex');

    const addCustomer = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO customers (code, name, phone, address, delivery_boy_id, monthly_rate, token)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(code, name.trim(), phone, address.trim(), delivery_boy_id || null, rateInPaise, token);

      db.prepare(`
        INSERT INTO subscriptions (customer_id, start_date, total_days, remaining_days, status)
        VALUES (?, date('now'), 30, 30, 'active')
      `).run(info.lastInsertRowid);
    });

    addCustomer();

    req.session.flash = { type: 'success', message: `Customer ${code} added successfully.` };
    res.redirect('/admin/customers');
  });

  // ── Get customer JSON (for edit modal) ───────────────────────────

  app.get('/admin/customers/:id', requireAuth, (req, res) => {
    const customer = db.prepare(`
      SELECT c.*, db.name AS delivery_boy_name
      FROM customers c
      LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
      WHERE c.id = ?
    `).get(req.params.id);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    customer.monthly_rate_rupees = customer.monthly_rate / 100;
    res.json(customer);
  });

  // ── Update customer ─────────────────────────────────────────────

  app.post('/admin/customers/:id/edit', requireAuth, (req, res) => {
    const { name, phone, address, delivery_boy_id, monthly_rate } = req.body;
    const customerId = req.params.id;

    if (!name || !name.trim() || !phone || !address || !monthly_rate) {
      req.session.flash = { type: 'error', message: 'All fields are required.' };
      return res.redirect('/admin/customers');
    }

    if (!PHONE_RE.test(phone)) {
      req.session.flash = { type: 'error', message: 'Invalid phone number. Must be 10-15 digits.' };
      return res.redirect('/admin/customers');
    }

    const rateInPaise = Math.round(parseFloat(monthly_rate) * 100);
    if (rateInPaise <= 0) {
      req.session.flash = { type: 'error', message: 'Monthly rate must be a positive number.' };
      return res.redirect('/admin/customers');
    }

    if (delivery_boy_id) {
      const boy = db.prepare('SELECT id FROM delivery_boys WHERE id = ?').get(delivery_boy_id);
      if (!boy) {
        req.session.flash = { type: 'error', message: 'Invalid delivery boy selected.' };
        return res.redirect('/admin/customers');
      }
    }

    db.prepare(`
      UPDATE customers
      SET name = ?, phone = ?, address = ?, delivery_boy_id = ?, monthly_rate = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name.trim(), phone, address.trim(), delivery_boy_id || null, rateInPaise, customerId);

    req.session.flash = { type: 'success', message: 'Customer updated successfully.' };
    res.redirect('/admin/customers');
  });

  // ── Regenerate customer token ───────────────────────────────────

  app.post('/admin/customers/:id/regenerate-token', requireAuth, (req, res) => {
    const customerId = req.params.id;
    const newToken = crypto.randomBytes(32).toString('hex');

    const info = db.prepare(
      'UPDATE customers SET token = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(newToken, customerId);

    if (info.changes === 0) {
      req.session.flash = { type: 'error', message: 'Customer not found.' };
    } else {
      req.session.flash = { type: 'success', message: 'Token regenerated successfully.' };
    }

    res.redirect('/admin/customers');
  });

  // ── Toggle customer status ───────────────────────────────────────

  app.post('/admin/customers/:id/toggle-status', requireAuth, (req, res) => {
    const customer = db.prepare(
      'SELECT id, code, name, status FROM customers WHERE id = ?'
    ).get(req.params.id);

    if (!customer) {
      req.session.flash = { type: 'error', message: 'Customer not found.' };
      return res.redirect('/admin/customers');
    }

    const newStatus = customer.status === 'active' ? 'inactive' : 'active';

    db.prepare("UPDATE customers SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newStatus, customer.id);

    req.session.flash = {
      type: 'success',
      message: `${customer.code} — ${customer.name} is now ${newStatus}.`,
    };

    res.redirect('/admin/customers');
  });

  // ── Dispatch board ──────────────────────────────────────────────

  app.get('/admin/dispatch', requireAuth, (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const hasDispatch = dispatchExistsForToday(db);

    let deliveriesByBoy = [];
    let totalCount = 0;

    if (hasDispatch) {
      const rows = db.prepare(`
        SELECT
          d.id,
          d.status,
          d.marked_at,
          d.issue_reason,
          c.code AS customer_code,
          c.name AS customer_name,
          c.address,
          db.name AS boy_name,
          db.id AS boy_id
        FROM deliveries d
        JOIN customers c ON c.id = d.customer_id
        JOIN delivery_boys db ON db.id = d.delivery_boy_id
        WHERE d.delivery_date = ?
        ORDER BY db.name ASC, c.code ASC
      `).all(today);

      const boyMap = new Map();
      for (const row of rows) {
        if (!boyMap.has(row.boy_id)) {
          boyMap.set(row.boy_id, {
            boy_id: row.boy_id,
            boy_name: row.boy_name,
            deliveries: [],
          });
        }
        boyMap.get(row.boy_id).deliveries.push(row);
      }

      deliveriesByBoy = Array.from(boyMap.values());
      totalCount = rows.length;
    }

    const flash = req.session.flash || null;
    req.session.flash = null;

    renderView(res, 'admin/dispatch', {
      hasDispatch,
      deliveriesByBoy,
      totalCount,
      today,
      flash,
      activePage: 'dispatch',
    });
  });

  // ── Generate dispatch ───────────────────────────────────────────

  app.post('/admin/dispatch/generate', requireAuth, (req, res) => {
    const result = generateDispatch(db);
    res.json(result);
  });

  // ── Regenerate dispatch ──────────────────────────────────────────

  app.post('/admin/dispatch/regenerate', requireAuth, (req, res) => {
    const result = regenerateDispatch(db);
    res.json(result);
  });

  // ── Delivery boy list ────────────────────────────────────────────

  app.get('/admin/delivery-boys', requireAuth, (req, res) => {
    const deliveryBoys = db.prepare(
      "SELECT * FROM delivery_boys ORDER BY name ASC"
    ).all();

    const flash = req.session.flash || null;
    req.session.flash = null;

    renderView(res, 'admin/delivery-boys', {
      deliveryBoys: deliveryBoys || [],
      flash,
      activePage: 'delivery-boys',
    });
  });

  // ── Get delivery boy JSON (for edit modal) ───────────────────────

  app.get('/admin/delivery-boys/:id', requireAuth, (req, res) => {
    const boy = db.prepare(
      'SELECT * FROM delivery_boys WHERE id = ?'
    ).get(req.params.id);

    if (!boy) {
      return res.status(404).json({ error: 'Delivery boy not found' });
    }

    res.json(boy);
  });

  // ── Add delivery boy ─────────────────────────────────────────────

  app.post('/admin/delivery-boys', requireAuth, (req, res) => {
    const { name, phone, region } = req.body;

    if (!name || !name.trim()) {
      req.session.flash = { type: 'error', message: 'Name is required.' };
      return res.redirect('/admin/delivery-boys');
    }

    if (!PHONE_RE.test(phone)) {
      req.session.flash = { type: 'error', message: 'Invalid phone number. Must be 10-15 digits.' };
      return res.redirect('/admin/delivery-boys');
    }

    db.prepare(
      'INSERT INTO delivery_boys (name, phone, region) VALUES (?, ?, ?)'
    ).run(name.trim(), phone, region && region.trim() ? region.trim() : null);

    req.session.flash = { type: 'success', message: `Delivery boy ${name.trim()} added successfully.` };
    res.redirect('/admin/delivery-boys');
  });

  // ── Update delivery boy ──────────────────────────────────────────

  app.post('/admin/delivery-boys/:id/edit', requireAuth, (req, res) => {
    const { name, phone, region } = req.body;
    const boyId = req.params.id;

    if (!name || !name.trim()) {
      req.session.flash = { type: 'error', message: 'Name is required.' };
      return res.redirect('/admin/delivery-boys');
    }

    if (!PHONE_RE.test(phone)) {
      req.session.flash = { type: 'error', message: 'Invalid phone number. Must be 10-15 digits.' };
      return res.redirect('/admin/delivery-boys');
    }

    const info = db.prepare(
      'UPDATE delivery_boys SET name = ?, phone = ?, region = ? WHERE id = ?'
    ).run(name.trim(), phone, region && region.trim() ? region.trim() : null, boyId);

    if (info.changes === 0) {
      req.session.flash = { type: 'error', message: 'Delivery boy not found.' };
    } else {
      req.session.flash = { type: 'success', message: 'Delivery boy updated successfully.' };
    }

    res.redirect('/admin/delivery-boys');
  });

  // ── Toggle delivery boy status ───────────────────────────────────

  app.post('/admin/delivery-boys/:id/toggle-status', requireAuth, (req, res) => {
    const boy = db.prepare(
      'SELECT id, name, status FROM delivery_boys WHERE id = ?'
    ).get(req.params.id);

    if (!boy) {
      req.session.flash = { type: 'error', message: 'Delivery boy not found.' };
      return res.redirect('/admin/delivery-boys');
    }

    const newStatus = boy.status === 'active' ? 'inactive' : 'active';

    db.prepare('UPDATE delivery_boys SET status = ? WHERE id = ?')
      .run(newStatus, boy.id);

    req.session.flash = {
      type: 'success',
      message: `${boy.name} is now ${newStatus}.`,
    };

    res.redirect('/admin/delivery-boys');
  });

  // ── Payments page ─────────────────────────────────────────────────

  app.get('/admin/payments', requireAuth, (req, res) => {
    const customers = db.prepare(`
      SELECT c.id, c.code, c.name, c.monthly_rate, c.status, db.name AS delivery_boy_name
      FROM customers c
      LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
      ORDER BY c.code ASC
    `).all();

    let ledger = null;
    const customerId = parseInt(req.query.customer_id, 10);

    if (customerId) {
      const customer = db.prepare(
        'SELECT id, code, name FROM customers WHERE id = ?'
      ).get(customerId);

      if (customer) {
        const ledgerRows = getPaymentLedger(db, customerId);
        const balance = getBalance(db, customerId);
        ledger = {
          rows: ledgerRows,
          customerName: customer.name,
          customerCode: customer.code,
          balance,
        };
      }
    }

    const flash = req.session.flash || null;
    req.session.flash = null;

    renderView(res, 'admin/payments', {
      customers: customers || [],
      paymentModes: getPaymentModes(),
      ledger,
      flash,
      activePage: 'payments',
    });
  });

  // ── Record payment ────────────────────────────────────────────────

  app.post('/admin/payments', requireAuth, (req, res) => {
    const { customer_id, amount, mode, payment_date, notes } = req.body;

    if (!customer_id) {
      req.session.flash = { type: 'error', message: 'Please select a customer.' };
      return res.redirect('/admin/payments');
    }

    if (!amount || parseFloat(amount) <= 0) {
      req.session.flash = { type: 'error', message: 'Amount must be a positive number.' };
      return res.redirect('/admin/payments');
    }

    if (!['cash', 'upi', 'bank_transfer'].includes(mode)) {
      req.session.flash = { type: 'error', message: 'Invalid payment mode.' };
      return res.redirect('/admin/payments');
    }

    // Validate payment date format (YYYY-MM-DD)
    if (!payment_date || !/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) {
      req.session.flash = { type: 'error', message: 'Invalid payment date format.' };
      return res.redirect('/admin/payments');
    }

    // Verify customer exists
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
    if (!customer) {
      req.session.flash = { type: 'error', message: 'Customer not found.' };
      return res.redirect('/admin/payments');
    }

    const amountInPaise = Math.round(parseFloat(amount) * 100);

    try {
      recordPayment(db, {
        customerId: parseInt(customer_id, 10),
        amount: amountInPaise,
        mode,
        paymentDate: payment_date,
        notes: notes || '',
        recordedBy: 'Admin',
      });

      req.session.flash = { type: 'success', message: 'Payment recorded successfully.' };
    } catch (err) {
      req.session.flash = { type: 'error', message: err.message };
    }

    res.redirect('/admin/payments');
  });

  // ── Payment ledger JSON ───────────────────────────────────────────

  app.get('/admin/payments/ledger/:id', requireAuth, (req, res) => {
    const customerId = parseInt(req.params.id, 10);

    const customer = db.prepare(
      'SELECT id, code, name FROM customers WHERE id = ?'
    ).get(customerId);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const ledger = getPaymentLedger(db, customerId);
    const balance = getBalance(db, customerId);

    res.json({ ledger, balance, customer });
  });

  // ── Reports page ──────────────────────────────────────────────────

  app.get('/admin/reports', requireAuth, (req, res) => {
    const today = new Date();
    let reportMonth = req.query.month || today.toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(reportMonth)) {
      reportMonth = today.toISOString().slice(0, 7);
    } else {
      const parsedMonth = parseInt(reportMonth.slice(5, 7), 10);
      if (parsedMonth < 1 || parsedMonth > 12) {
        reportMonth = today.toISOString().slice(0, 7);
      }
    }
    const monthStart = reportMonth + '-01';

    // Calculate month end
    const year = parseInt(reportMonth.slice(0, 4), 10);
    const month = parseInt(reportMonth.slice(5, 7), 10);
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = reportMonth + '-' + String(lastDay).padStart(2, '0');

    // Monthly collection
    const collectionRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total_paise, COUNT(*) AS payment_count
      FROM payments
      WHERE payment_date >= ? AND payment_date <= ?
    `).get(monthStart, monthEnd);

    const monthlyCollection = {
      totalPaise: collectionRow.total_paise,
      totalRupees: (collectionRow.total_paise / 100).toFixed(2),
      paymentCount: collectionRow.payment_count,
    };

    // Delivery stats for the month
    const deliveryRow = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status = 'issue' THEN 1 ELSE 0 END) AS issue,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM deliveries
      WHERE delivery_date >= ? AND delivery_date <= ?
    `).get(monthStart, monthEnd);

    const total = deliveryRow.total || 0;
    const delivered = deliveryRow.delivered || 0;
    const deliveryStats = {
      total,
      delivered,
      skipped: deliveryRow.skipped || 0,
      issue: deliveryRow.issue || 0,
      pending: deliveryRow.pending || 0,
      successRate: total > 0 ? (delivered / total * 100).toFixed(1) : '0.0',
    };

    // Overdue accounts
    const activeCustomers = db.prepare(`
      SELECT c.id, c.code, c.name, c.phone, c.monthly_rate
      FROM customers c
      INNER JOIN subscriptions s ON s.customer_id = c.id
      WHERE c.status = 'active' AND s.status = 'active'
      GROUP BY c.id
      ORDER BY c.code ASC
    `).all();

    const overdueAccounts = [];
    for (const c of activeCustomers) {
      const balance = getBalance(db, c.id);
      if (balance.isOverdue) {
        overdueAccounts.push({
          id: c.id,
          code: c.code,
          name: c.name,
          phone: c.phone,
          balanceDays: balance.balanceDays,
          monthly_rate: c.monthly_rate,
        });
      }
    }

    const flash = req.session.flash || null;
    req.session.flash = null;

    renderView(res, 'admin/reports', {
      monthlyCollection,
      deliveryStats,
      overdueAccounts,
      reportMonth,
      flash,
      activePage: 'reports',
    });
  });

  // ── CSV Export ────────────────────────────────────────────────────

  app.get('/admin/reports/export/:type', requireAuth, (req, res) => {
    const type = req.params.type;

    const csvExports = {
      payments: () => {
        const rows = db.prepare(`
          SELECT p.id, c.code AS customer_code, c.name AS customer_name,
                 p.amount, p.mode, p.payment_date, p.notes, p.recorded_by, p.created_at
          FROM payments p
          JOIN customers c ON c.id = p.customer_id
          ORDER BY p.payment_date DESC, p.created_at DESC
        `).all();

        const header = 'id,customer_code,customer_name,amount_paise,mode,payment_date,notes,recorded_by,created_at';
        const csv = [header, ...rows.map(r =>
          `${r.id},${escapeCsv(r.customer_code)},${escapeCsv(r.customer_name)},${r.amount},${r.mode},${r.payment_date},${escapeCsv(r.notes || '')},${escapeCsv(r.recorded_by || '')},${r.created_at}`
        )].join('\n');
        return { csv, filename: 'payments.csv' };
      },

      customers: () => {
        const rows = db.prepare(`
          SELECT c.id, c.code, c.name, c.phone, c.address, c.monthly_rate, c.status,
                 db.name AS delivery_boy_name, c.created_at
          FROM customers c
          LEFT JOIN delivery_boys db ON db.id = c.delivery_boy_id
          ORDER BY c.code ASC
        `).all();

        const header = 'id,code,name,phone,address,monthly_rate_paise,status,delivery_boy,created_at';
        const csv = [header, ...rows.map(r =>
          `${r.id},${escapeCsv(r.code)},${escapeCsv(r.name)},${escapeCsv(r.phone)},${escapeCsv(r.address)},${r.monthly_rate},${r.status},${escapeCsv(r.delivery_boy_name || '')},${r.created_at}`
        )].join('\n');
        return { csv, filename: 'customers.csv' };
      },

      deliveries: () => {
        const rows = db.prepare(`
          SELECT d.id, c.code AS customer_code, c.name AS customer_name,
                 db.name AS delivery_boy_name, d.delivery_date, d.status, d.issue_reason, d.marked_at
          FROM deliveries d
          JOIN customers c ON c.id = d.customer_id
          JOIN delivery_boys db ON db.id = d.delivery_boy_id
          ORDER BY d.delivery_date DESC, c.code ASC
        `).all();

        const header = 'id,customer_code,customer_name,delivery_boy,delivery_date,status,issue_reason,marked_at';
        const csv = [header, ...rows.map(r =>
          `${r.id},${escapeCsv(r.customer_code)},${escapeCsv(r.customer_name)},${escapeCsv(r.delivery_boy_name)},${r.delivery_date},${r.status},${escapeCsv(r.issue_reason || '')},${r.marked_at || ''}`
        )].join('\n');
        return { csv, filename: 'deliveries.csv' };
      },
    };

    if (!csvExports[type]) {
      return res.status(400).json({ error: 'Invalid export type. Use: payments, customers, deliveries' });
    }

    const { csv, filename } = csvExports[type]();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Prepend BOM for Excel UTF-8 handling
    res.send('﻿' + csv);
  });
}

/**
 * Escapes a CSV field to prevent injection and handle commas/quotes.
 * Prefixes = + - @ with single quote to prevent CSV formula injection.
 */
function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Strip leading whitespace, then check for formula-injection chars
  if (/^\s*[=+\-@]/.test(str)) {
    return "'" + str;
  }
  if (/,|"|\n/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

module.exports = { setupAdminRoutes };