// Stretch feature 2: SLA tracking and breach prediction.
//
// Two targets per priority: FIRST RESPONSE (an agent/manager claims,
// comments on or moves the ticket) and RESOLUTION (status reaches
// Resolved). Clocks run in wall-clock hours (no business-hours calendar).
//
// "Prediction" here is deliberately simple and explainable: a running
// clock that has used AT_RISK_FRACTION (75%) or more of its target is
// flagged "at risk" BEFORE it breaches, so someone can act in time. It is
// a rule, not a trained model - see README.

const { STATUSES } = require('./constants');

const SLA_TARGETS_HOURS = {
  Urgent: { firstResponse: 1, resolution: 4 },
  High: { firstResponse: 4, resolution: 24 },
  Medium: { firstResponse: 8, resolution: 72 },
  Low: { firstResponse: 24, resolution: 120 },
};
const AT_RISK_FRACTION = 0.75;
const HOUR = 3600 * 1000;

// state: 'met' | 'breached' (clock stopped) or 'ok' | 'at_risk' |
// 'breached' (clock still running).
function clock(start, stop, targetHours, now) {
  const end = stop ? new Date(stop) : now;
  const elapsedHours = (end - new Date(start)) / HOUR;
  const used = elapsedHours / targetHours;
  let state;
  if (stop) state = used <= 1 ? 'met' : 'breached';
  else if (used > 1) state = 'breached';
  else if (used >= AT_RISK_FRACTION) state = 'at_risk';
  else state = 'ok';
  return {
    targetHours,
    elapsedHours: Math.round(elapsedHours * 10) / 10,
    remainingHours: stop ? null : Math.round((targetHours - elapsedHours) * 10) / 10,
    used: Math.round(used * 100) / 100,
    running: !stop,
    state,
  };
}

const SEVERITY = { breached: 3, at_risk: 2, ok: 1, met: 0 };

function slaFor(ticket, now = new Date()) {
  const target = SLA_TARGETS_HOURS[ticket.priority] || SLA_TARGETS_HOURS.Medium;
  const firstResponse = clock(ticket.createdAt, ticket.firstResponseAt, target.firstResponse, now);
  const resolution = clock(ticket.createdAt, ticket.resolvedAt, target.resolution, now);
  // Overall = the worst of the two, so one flag summarises the ticket.
  const overall = SEVERITY[firstResponse.state] >= SEVERITY[resolution.state] ? firstResponse.state : resolution.state;
  return { firstResponse, resolution, overall };
}

// Hours spent in each status, from the ticket's status history.
function timeInStatus(ticket, now = new Date()) {
  const totals = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const history = ticket.statusHistory || [];
  history.forEach((h, i) => {
    const end = history[i + 1] ? new Date(history[i + 1].at) : now;
    totals[h.status] += (end - new Date(h.at)) / HOUR;
  });
  Object.keys(totals).forEach((s) => (totals[s] = Math.round(totals[s] * 10) / 10));
  return totals;
}

module.exports = { slaFor, timeInStatus, SLA_TARGETS_HOURS, AT_RISK_FRACTION };
