const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, asyncHandler } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const { logAction } = require('../lib/activity');

// "My approvals": steps waiting for the logged-in user, whatever their
// role - line managers and department heads are org links, not roles.
router.get('/', requireLogin, asyncHandler(async (req, res) => {
  const me = req.session.user.email;
  const [mine, tickets] = await Promise.all([store.listApprovalSteps({ approverEmail: me }), store.listTickets({})]);
  const byId = new Map(tickets.map((t) => [t.ticketId, t]));
  const withTicket = mine.filter((s) => byId.has(s.ticketId)).map((s) => ({ ...s, ticket: byId.get(s.ticketId), label: approvals.KIND_LABELS[s.kind] }));
  res.render('approvals', {
    pending: withTicket.filter((s) => s.status === 'pending'),
    decided: withTicket.filter((s) => s.status === 'approved' || s.status === 'rejected')
      .sort((a, b) => new Date(b.decidedAt) - new Date(a.decidedAt)).slice(0, 20),
    flash: req.query.msg ? String(req.query.msg) : null,
  });
}));

// Only the step's designated approver can decide it: lib/approvals.js
// checks that and returns not_approver (403) for anyone else.
function decisionRoute(decision) {
  return asyncHandler(async (req, res) => {
    const user = req.session.user;
    const result = await approvals.decide(String(req.params.id), user, decision, req.body.comment);
    if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
    if (result.reason === 'not_approver' || result.reason === 'own_request') return res.status(403).render('403', { title: 'Access denied' });
    const step = result.step || (await store.getApprovalStep(String(req.params.id)));
    const back = (msg) => (req.body.returnTo === 'list' ? `/approvals?msg=${msg}` : `/tickets/${step.ticketId}?msg=${msg}#approval`);
    if (result.reason) return res.redirect(back(result.reason));
    await logAction(user, `approval.${decision}`, { ticketId: step.ticketId, step: step.order, kind: step.kind, finished: result.finished });
    res.redirect(back(decision === 'approve' ? 'approved' : 'request_rejected'));
  });
}

router.post('/:id/approve', requireLogin, decisionRoute('approve'));
router.post('/:id/reject', requireLogin, decisionRoute('reject'));

module.exports = router;
