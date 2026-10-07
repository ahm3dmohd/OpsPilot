const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, asyncHandler } = require('../middleware/auth');
const { STATUSES, PRIORITIES, CATEGORIES } = require('../lib/constants');
const { slaFor } = require('../lib/sla');
const { agentWorkloads } = require('../lib/categorize');

const SLA_ORDER = { breached: 0, at_risk: 1, ok: 2, met: 3 };

function countBy(tickets, key, keys) {
  const counts = Object.fromEntries((keys || []).map((k) => [k, 0]));
  tickets.forEach((t) => {
    counts[t[key]] = (counts[t[key]] || 0) + 1;
  });
  return counts;
}

// Attach SLA state to each ticket for the tables.
function withSla(tickets, now = new Date()) {
  return tickets.map((t) => ({ ...t, sla: slaFor(t, now) }));
}

router.get('/', requireLogin, (req, res) => res.redirect('/dashboard'));

router.get('/dashboard', requireLogin, asyncHandler(async (req, res) => {
  const user = req.session.user;

  if (user.role === 'end_user') {
    const tickets = await store.listTickets({ requesterEmail: user.email });
    return res.render('dashboard-enduser', { tickets });
  }

  if (user.role === 'agent') {
    // Open queue, most urgent SLA first.
    const queue = withSla(await store.listTickets({ status: 'Open' })).sort(
      (a, b) => SLA_ORDER[a.sla.overall] - SLA_ORDER[b.sla.overall] || a.sla.firstResponse.remainingHours - b.sla.firstResponse.remainingHours
    );
    const mine = withSla(await store.listTickets({ assigneeEmail: user.email }));
    return res.render('dashboard-agent', { queue, mine });
  }

  if (user.role === 'manager') {
    const all = withSla(await store.listTickets({}));
    const active = all.filter((t) => t.status === 'Open' || t.status === 'In Progress');
    const atRisk = active
      .filter((t) => t.sla.overall === 'at_risk' || t.sla.overall === 'breached')
      .sort((a, b) => SLA_ORDER[a.sla.overall] - SLA_ORDER[b.sla.overall]);
    const withDupResults = all.filter((t) => t.duplicates);
    const suggested = all.filter((t) => t.categorySuggestion);
    return res.render('dashboard-manager', {
      total: all.length,
      byStatus: countBy(all, 'status', STATUSES),
      byPriority: countBy(all, 'priority', PRIORITIES),
      byCategory: countBy(all, 'category', CATEGORIES),
      workloads: await agentWorkloads(),
      unassigned: active.filter((t) => !t.assigneeEmail).length,
      atRisk,
      slaCounts: countBy(active.map((t) => ({ s: t.sla.overall })), 's', ['breached', 'at_risk', 'ok']),
      dupStats: {
        checked: withDupResults.length,
        aiFlagged: withDupResults.filter((t) => t.duplicates.ai.matches.length).length,
        aiSkipped: withDupResults.filter((t) => t.duplicates.ai.status !== 'ok').length,
        baselineFlagged: withDupResults.filter((t) => t.duplicates.baseline.matches.length).length,
      },
      suggestionStats: {
        total: suggested.length,
        accepted: suggested.filter((t) => t.categorySuggestion.accepted).length,
      },
      tickets: all,
      mode: store.getMode(),
    });
  }

  res.status(403).render('403', { title: 'Access denied' });
}));

module.exports = router;
