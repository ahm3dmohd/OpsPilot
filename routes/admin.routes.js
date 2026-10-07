const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, requireRole, asyncHandler } = require('../middleware/auth');
const assistant = require('../lib/assistant');
const { runEvaluation } = require('../lib/evaluation');
const { slaFor } = require('../lib/sla');
const { toCsv } = require('../lib/csv');
const { logAction } = require('../lib/activity');

// ---- Audit log (managers only) ----
router.get('/audit', requireRole('manager'), asyncHandler(async (req, res) => {
  const [entries, integrity] = await Promise.all([store.listAudit(200), store.verifyAudit()]);
  res.render('audit', { entries, integrity });
}));

// ---- AI-vs-baseline evaluation (managers only) ----
// Same computation as `npm run evaluate`, on the fixed seed + held-out
// sets, so supervisors can see the measured result without a terminal.
router.get('/evaluation', requireRole('manager'), asyncHandler(async (req, res) => {
  res.render('evaluation', { r: await runEvaluation() });
}));

// ---- CSV export of all tickets (managers only) ----
const hoursBetween = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 3600000) * 10) / 10 : '');

router.get('/reports/tickets.csv', requireRole('manager'), asyncHandler(async (req, res) => {
  const tickets = await store.listTickets({});
  const now = new Date();
  const headers = [
    'ticketId', 'title', 'description', 'category', 'priority', 'status',
    'requesterName', 'requesterEmail', 'assigneeName', 'assigneeEmail',
    'createdAt', 'updatedAt', 'firstResponseAt', 'resolvedAt',
    'hoursToFirstResponse', 'hoursToResolve', 'slaFirstResponse', 'slaResolution', 'slaOverall',
    'comments', 'aiStatus', 'aiMatches', 'baselineMatches',
    'categorySuggested', 'categorySuggestionMethod', 'categorySuggestionAccepted',
  ];
  const rows = tickets.map((t) => {
    const sla = slaFor(t, now);
    const d = t.duplicates;
    const s = t.categorySuggestion;
    const list = (r) => (r && r.status === 'ok' ? r.matches.map((m) => `${m.ticketId} (${m.score})`).join('; ') : '');
    return [
      t.ticketId, t.title, t.description, t.category, t.priority, t.status,
      t.requesterName, t.requesterEmail, t.assigneeName, t.assigneeEmail,
      t.createdAt, t.updatedAt, t.firstResponseAt, t.resolvedAt,
      hoursBetween(t.createdAt, t.firstResponseAt), hoursBetween(t.createdAt, t.resolvedAt),
      sla.firstResponse.state, sla.resolution.state, sla.overall,
      (t.comments || []).length, d ? d.ai.status : 'not checked', list(d && d.ai), list(d && d.baseline),
      s ? s.suggested : '', s ? s.method : '', s ? s.accepted : '',
    ];
  });
  const stamp = now.toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="opspilot-tickets-${stamp}.csv"`);
  await logAction(req.session.user, 'report.export', { rows: rows.length });
  res.send(toCsv(headers, rows));
}));

// ---- Self-service help assistant ----
// Page version (works without JavaScript)...
router.get('/help', requireLogin, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString();
  const result = q ? await assistant.ask(q, req.session.user) : null;
  res.render('help', { q, result });
}));

// ...and JSON version for the chat widget.
router.post('/help/ask', requireLogin, asyncHandler(async (req, res) => {
  const result = await assistant.ask((req.body.question || '').toString(), req.session.user);
  res.json(result);
}));

module.exports = router;
