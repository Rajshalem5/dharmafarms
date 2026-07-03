/**
 * services/telegram.js — Pure formatting functions for Telegram messages.
 *
 * These functions take data and return formatted strings/objects.
 * No side effects, no I/O, no dependencies on db.js.
 */

const STATUS_ICONS = {
  pending: '⏳',
  delivered: '✅',
  skipped: '⏭️',
  issue: '⚠️',
  arriving: '🚚',
};

/**
 * Formats a single delivery line with status icon and details.
 * @param {object} delivery - Delivery object with customer_code, customer_name, status, etc.
 * @returns {string} Formatted status line
 */
function formatStatusLine(delivery) {
  const icon = STATUS_ICONS[delivery.status] || '❓';
  const code = delivery.customer_code;
  const name = delivery.customer_name;
  const phone = delivery.customer_phone ? ` - ${delivery.customer_phone}` : '';
  const time = delivery.marked_at ? ` (${delivery.marked_at})` : '';
  const reason = delivery.issue_reason ? ` — ${delivery.issue_reason}` : '';

  return `${icon} ${code} - ${name}${phone}${time}${reason}`;
}

/**
 * Builds a route message for a delivery boy.
 * @param {Array<object>} deliveries
 * @param {string} boyName
 * @returns {string} Formatted route message
 */
function formatRouteMessage(deliveries, boyName) {
  if (!deliveries || deliveries.length === 0) {
    return 'No deliveries scheduled for you today.';
  }

  const label = deliveries.length === 1 ? 'delivery' : 'deliveries';
  const lines = deliveries.map((d, i) => `${i + 1}. ${formatStatusLine(d)}`);

  return [
    `Good morning ${boyName}! Your route (${deliveries.length} ${label}):`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Builds a delivery summary with counts by status and a human-readable string.
 * @param {Array<object>} deliveries
 * @returns {{ delivered: number, skipped: number, issue: number, pending: number, arriving: number, summary: string }}
 */
function buildDeliverySummary(deliveries) {
  const counts = { delivered: 0, skipped: 0, issue: 0, pending: 0, arriving: 0 };

  for (const d of deliveries) {
    if (counts.hasOwnProperty(d.status)) {
      counts[d.status]++;
    }
  }

  const parts = [];
  for (const [status, count] of Object.entries(counts)) {
    parts.push(`${count} ${status}`);
  }

  counts.summary = `Route complete! ${parts.join(', ')}.`;

  return counts;
}

module.exports = {
  formatRouteMessage,
  buildDeliverySummary,
  formatStatusLine,
};