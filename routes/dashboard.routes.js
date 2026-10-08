const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, asyncHandler } = require('../middleware/auth');
const { STATUSES, PRIORITIES, CATEGORIES, hasManagerRights } = require('../lib/constants');
const { withSla, applyFilters, stat } = require('../lib/ticketFilters');

const SLA_ORDER = { breached: 0, at_risk: 1, ok: 2, met: 3, waiting: 4 };

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

  if (hasManagerRights(user)) {
    const all = withSla(await store.listTickets({}));
    // Every number on the dashboard is { count, href }: the count is the
    // length of exactly the list its link opens (see lib/ticketFilters.js).
    const s = (filters) => stat(all, filters);
    const agents = await store.listUsers({ role: 'agent' });
    const atRisk = applyFilters(all, { state: 'active' })
      .filter((t) => t.sla.overall === 'at_risk' || t.sla.overall === 'breached')
      .sort((a, b) => SLA_ORDER[a.sla.overall] - SLA_ORDER[b.sla.overall]);
    return res.render('dashboard-manager', {
      total: s({}),
      byStatus: STATUSES.map((v) => ({ label: v, ...s({ status: v }) })),
      unassigned: s({ state: 'active', assignee: 'unassigned' }),
      slaCards: ['breached', 'at_risk', 'ok'].map((v) => ({ key: v, ...s({ state: 'active', sla: v }) })),
      byCategory: CATEGORIES.map((v) => ({ label: v, ...s({ category: v }) })),
      byPriority: PRIORITIES.map((v) => ({ label: v, ...s({ priority: v }) })),
      // Workload = In Progress tickets, the same definition the assignee
      // suggestion uses; lightest first.
      workloads: agents
        .map((a) => ({ label: a.name, ...s({ assignee: a.email, status: 'In Progress' }) }))
        .sort((a, b) => a.count - b.count || a.label.localeCompare(b.label)),
      atRisk,
      dupStats: [
        ['Tickets checked for duplicates', 'checked'],
        ['\u2026 flagged by AI method', 'ai'],
        ['\u2026 flagged by keyword baseline', 'baseline'],
        ['\u2026 flagged by both', 'both'],
        ['\u2026 AI only (baseline missed)', 'ai_only'],
        ['\u2026 baseline only (AI missed)', 'baseline_only'],
        ['\u2026 AI method skipped/failed', 'ai_skipped'],
      ].map(([label, v]) => ({ label, ...s({ dup: v }) })),
      suggestionStats: { accepted: s({ suggestion: 'accepted' }), total: s({ suggestion: 'any' }) },
      // Most-viewed articles first.
      kbStats: (await store.listArticles()).sort((a, b) => b.views - a.views || a.articleId.localeCompare(b.articleId)).slice(0, 5),
      tickets: all,
      mode: store.getMode(),
    });
  }

  res.status(403).render('403', { title: 'Access denied' });
}));

module.exports = router;
