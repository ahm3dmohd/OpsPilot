const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, requirePermission, asyncHandler } = require('../middleware/auth');
const assistant = require('../lib/assistant');
const { runEvaluation } = require('../lib/evaluation');
const { toCsv } = require('../lib/csv');
const { logAction } = require('../lib/activity');
const filtering = require('../lib/ticketFilters');
const decisions = require('../lib/duplicateDecisions');

// ---- Audit log (managers only) ----
router.get('/audit', requirePermission('audit.view'), asyncHandler(async (req, res) => {
  const [entries, integrity] = await Promise.all([store.listAudit(200), store.verifyAudit()]);
  res.render('audit', { entries, integrity });
}));

// ---- AI-vs-baseline evaluation (managers only) ----
// Same computation as `npm run evaluate`, on the fixed seed + held-out
// sets, so supervisors can see the measured result without a terminal.
router.get('/evaluation', requirePermission('report.view'), asyncHandler(async (req, res) => {
  res.render('evaluation', { r: await runEvaluation() });
}));

// ---- CSV export (managers only) ----
// Takes the same filters as the /tickets list, so "Export these" on a
// filtered list downloads exactly those rows. No filters = all tickets.
const hoursBetween = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 3600000) * 10) / 10 : '');

router.get('/reports/tickets.csv', requirePermission('report.export'), asyncHandler(async (req, res) => {
  const now = new Date();
  const filters = filtering.parseFilters(req.query);
  const tickets = filtering.applyFilters(filtering.withSla(await store.listTickets({}), now), filters);
  const headers = [
    'ticketId', 'type', 'title', 'description', 'department', 'category', 'priority', 'status',
    'requesterName', 'requesterEmail', 'assigneeName', 'assigneeEmail',
    'createdAt', 'updatedAt', 'firstResponseAt', 'resolvedAt',
    'hoursToFirstResponse', 'hoursToResolve', 'slaFirstResponse', 'slaResolution', 'slaOverall',
    'comments', 'aiStatus', 'aiMatches', 'baselineMatches',
    'categorySuggested', 'categorySuggestionMethod', 'categorySuggestionAccepted',
    'mergedInto',
  ];
  const rows = tickets.map((t) => {
    const { sla } = t;
    const d = t.duplicates;
    const s = t.categorySuggestion;
    const list = (r) => (r && r.status === 'ok' ? r.matches.map((m) => `${m.ticketId} (${m.score})`).join('; ') : '');
    return [
      t.ticketId, t.type || 'incident', t.title, t.description, t.department || 'IT', t.category, t.priority, t.status,
      t.requesterName, t.requesterEmail, t.assigneeName, t.assigneeEmail,
      t.createdAt, t.updatedAt, t.firstResponseAt, t.resolvedAt,
      hoursBetween(t.createdAt, t.firstResponseAt), hoursBetween(t.createdAt, t.resolvedAt),
      sla.firstResponse.state, sla.resolution.state, sla.overall,
      (t.comments || []).length, d ? d.ai.status : 'not checked', list(d && d.ai), list(d && d.baseline),
      s ? s.suggested : '', s ? s.method : '', s ? s.accepted : '',
      t.mergedInto || '',
    ];
  });
  const stamp = now.toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="opspilot-tickets-${stamp}.csv"`);
  await logAction(req.session.user, 'report.export', { rows: rows.length, filters });
  res.send(toCsv(headers, rows));
}));

// ---- Duplicate decisions: how often agents confirmed each method's
// suggestions (managers only). Page + one-row-per-decision CSV. ----
router.get('/admin/duplicate-stats', requirePermission('report.view'), asyncHandler(async (req, res) => {
  res.render('duplicate-stats', await decisions.stats());
}));

router.get('/admin/duplicate-stats.csv', requirePermission('report.export'), asyncHandler(async (req, res) => {
  const { rows: summary, decisions: list } = await decisions.stats();
  const headers = [
    'decidedAt', 'ticketId', 'candidateId', 'decision', 'flaggedBy',
    'aiScore', 'baselineScore', 'aiThreshold', 'baselineThreshold', 'aiModel',
    'primaryId', 'mergedId', 'agentName', 'agentEmail',
  ];
  const rows = list.map((d) => [
    d.createdAt, d.ticketId, d.candidateId, d.decision, d.flaggedBy,
    d.aiScore, d.baselineScore, d.aiThreshold, d.baselineThreshold, d.aiModel,
    d.primaryId, d.mergedId, d.byName, d.byEmail,
  ]);
  const all = summary[0];
  await logAction(req.session.user, 'report.duplicate_decisions', { rows: rows.length, confirmed: all.confirmed, rejected: all.rejected });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="opspilot-duplicate-decisions-${new Date().toISOString().slice(0, 10)}.csv"`);
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
