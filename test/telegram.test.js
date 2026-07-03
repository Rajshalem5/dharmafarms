/**
 * Tests for services/telegram.js — pure formatting functions.
 *
 * Run with: node --test test/telegram.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

// Import will fail until services/telegram.js exists (RED)
const {
  formatRouteMessage,
  buildDeliverySummary,
  formatStatusLine,
} = require('../services/telegram');

// ─── Sample data ────────────────────────────────────────────────

const sampleDeliveries = [
  {
    customer_code: 'C001',
    customer_name: 'Ram',
    customer_phone: '9000000001',
    address: '123 Main St',
    status: 'pending',
  },
  {
    customer_code: 'C002',
    customer_name: 'Shyam',
    customer_phone: '9000000002',
    address: '456 Oak Ave',
    status: 'delivered',
    marked_at: '06:15',
  },
  {
    customer_code: 'C003',
    customer_name: 'Gita',
    customer_phone: '9000000003',
    address: '789 Pine Rd',
    status: 'skipped',
    marked_at: '06:20',
  },
  {
    customer_code: 'C004',
    customer_name: 'Sita',
    customer_phone: '9000000004',
    address: '321 Elm St',
    status: 'issue',
    issue_reason: 'No milk required today',
    marked_at: '06:25',
  },
  {
    customer_code: 'C005',
    customer_name: 'Mohan',
    customer_phone: '9000000005',
    address: '654 Birch Ln',
    status: 'arriving',
    marked_at: '06:28',
  },
];

// ─── formatRouteMessage ─────────────────────────────────────────

describe('formatRouteMessage', () => {
  it('returns empty-route message when deliveries array is empty', () => {
    const result = formatRouteMessage([], 'Raju');
    assert.strictEqual(result, 'No deliveries scheduled for you today.');
  });

  it('returns formatted route message with deliveries', () => {
    const result = formatRouteMessage(sampleDeliveries, 'Raju');

    assert.match(result, /Good morning Raju/);
    assert.match(result, /Your route \(5 deliveries\)/);
    assert.match(result, /C001/);
    assert.match(result, /C002/);
    assert.match(result, /C003/);
    assert.match(result, /C004/);
    assert.match(result, /C005/);
    // Phone numbers should appear in route display
    assert.match(result, /9000000001/);
    assert.match(result, /9000000002/);
  });

  it('includes status indicators for each delivery', () => {
    const result = formatRouteMessage(sampleDeliveries, 'Raju');

    // Each status should have an indicator
    assert.match(result, /⏳|✅|⏭️|⚠️|🚚/);
  });

  it('handles single delivery gracefully', () => {
    const single = [sampleDeliveries[0]];
    const result = formatRouteMessage(single, 'Priya');

    assert.match(result, /Good morning Priya/);
    assert.match(result, /Your route \(1 delivery\)/);
    assert.match(result, /C001/);
  });
});

// ─── buildDeliverySummary ────────────────────────────────────────

describe('buildDeliverySummary', () => {
  it('returns counts grouped by status', () => {
    const result = buildDeliverySummary(sampleDeliveries);

    assert.strictEqual(result.delivered, 1);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.issue, 1);
    assert.strictEqual(result.pending, 1);
    assert.strictEqual(result.arriving, 1);
  });

  it('returns all zeros for empty deliveries', () => {
    const result = buildDeliverySummary([]);

    assert.strictEqual(result.delivered, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.issue, 0);
    assert.strictEqual(result.pending, 0);
    assert.strictEqual(result.arriving, 0);
  });

  it('builds a human-readable summary string', () => {
    const result = buildDeliverySummary(sampleDeliveries);

    assert.match(result.summary, /Route complete/);
    assert.match(result.summary, /1 delivered/);
    assert.match(result.summary, /1 skipped/);
    assert.match(result.summary, /1 issue/);
    assert.match(result.summary, /1 pending/);
  });

  it('handles all-delivered route', () => {
    const allDone = sampleDeliveries.map(d => ({ ...d, status: 'delivered' }));
    const result = buildDeliverySummary(allDone);

    assert.strictEqual(result.delivered, 5);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.issue, 0);
    assert.strictEqual(result.pending, 0);
    assert.strictEqual(result.arriving, 0);
    assert.match(result.summary, /5 delivered/);
  });
});

// ─── formatStatusLine ───────────────────────────────────────────

describe('formatStatusLine', () => {
  it('formats pending delivery', () => {
    const delivery = { customer_code: 'C001', customer_name: 'Ram', customer_phone: '9000000001', status: 'pending' };
    const result = formatStatusLine(delivery);

    assert.match(result, /C001/);
    assert.match(result, /Ram/);
    assert.match(result, /9000000001/);
    assert.match(result, /⏳/);
  });

  it('formats delivered delivery', () => {
    const delivery = { customer_code: 'C001', customer_name: 'Ram', customer_phone: '9000000001', status: 'delivered', marked_at: '06:15' };
    const result = formatStatusLine(delivery);

    assert.match(result, /C001/);
    assert.match(result, /✅/);
    assert.match(result, /9000000001/);
    assert.match(result, /06:15/);
  });

  it('formats skipped delivery', () => {
    const delivery = { customer_code: 'C002', customer_name: 'Shyam', customer_phone: '9000000002', status: 'skipped', marked_at: '06:20' };
    const result = formatStatusLine(delivery);

    assert.match(result, /C002/);
    assert.match(result, /⏭️/);
    assert.match(result, /9000000002/);
  });

  it('formats issue delivery with reason', () => {
    const delivery = {
      customer_code: 'C004', customer_name: 'Sita', customer_phone: '9000000004', status: 'issue',
      issue_reason: 'No milk required today', marked_at: '06:25',
    };
    const result = formatStatusLine(delivery);

    assert.match(result, /C004/);
    assert.match(result, /⚠️/);
    assert.match(result, /9000000004/);
    assert.match(result, /No milk required/);
  });

  it('formats arriving delivery', () => {
    const delivery = { customer_code: 'C005', customer_name: 'Mohan', customer_phone: '9000000005', status: 'arriving', marked_at: '06:28' };
    const result = formatStatusLine(delivery);

    assert.match(result, /C005/);
    assert.match(result, /🚚/);
    assert.match(result, /9000000005/);
  });

  it('formats delivery without phone', () => {
    const delivery = { customer_code: 'C006', customer_name: 'Test', status: 'pending' };
    const result = formatStatusLine(delivery);

    assert.match(result, /C006/);
    assert.match(result, /Test/);
    assert.doesNotMatch(result, /\d{10}/);
  });
});