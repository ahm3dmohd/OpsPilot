const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, requirePermission, asyncHandler } = require('../middleware/auth');
const { STATUSES, PRIORITIES, CATEGORIES, STATUS_TRANSITIONS, TICKET_TYPES, TYPE_LABELS, canTransition } = require('../lib/constants');
const { can } = require('../lib/permissions');
const { detectDuplicates, aiThreshold, baselineThreshold } = require('../lib/duplicates');
const { suggestCategory, suggestAssignee, agentWorkloads } = require('../lib/categorize');
const { slaFor, timeInStatus } = require('../lib/sla');
const assistant = require('../lib/assistant');
const { logAction } = require('../lib/activity');
const notify = require('../lib/notify');
const filtering = require('../lib/ticketFilters');
const decisions = require('../lib/duplicateDecisions');
const approvals = require('../lib/approvals');

const MAX_TITLE = 150;
const MAX_DESCRIPTION = 5000;
const MAX_COMMENT = 5000;
const MAX_JUSTIFICATION = 1000;
const MAX_NOTE = 5000;

const isStaff = (user) => can(user, 'ticket.view_all');

// Staff, the requester, and anyone who is (or was) an approver on it.
async function canView(ticket, user) {
  if (isStaff(user) || ticket.requesterEmail === user.email) return true;
  return (await store.countApprovalSteps({ ticketId: ticket.ticketId, approverEmail: user.email })) > 0;
}

// Loads :id and checks the current user may see it; renders 404/403 and
// returns null otherwise.
async function loadTicket(req, res) {
  const ticket = await store.getTicketById(String(req.params.id));
  if (!ticket) {
    res.status(404).render('404', { url: req.originalUrl });
    return null;
  }
  if (!(await canView(ticket, req.session.user))) {
    res.status(403).render('403', { title: 'Access denied' });
    return null;
  }
  return ticket;
}

// Without a valid type the page shows the "Incident or Service request?"
// choice first; with one it shows the form for that type.
async function renderNew(res, { status = 200, error = null, errors = {}, form = {}, suggestion = null, help = null } = {}) {
  const departments = await store.listDepartments();
  res.status(status).render('ticket-new', { error, errors, form, suggestion, help, departments, CATEGORIES, PRIORITIES });
}

function readForm(body) {
  const type = TICKET_TYPES.includes(body.type) ? body.type : '';
  const neededBy = /^\d{4}-\d{2}-\d{2}$/.test(String(body.neededBy || '')) ? String(body.neededBy) : '';
  return {
    type,
    title: String(body.title || '').trim().slice(0, MAX_TITLE),
    description: String(body.description || '').trim().slice(0, MAX_DESCRIPTION),
    category: CATEGORIES.includes(body.category) ? body.category : '',
    priority: PRIORITIES.includes(body.priority) ? body.priority : 'Medium',
    department: String(body.department || ''),
    // Service requests only.
    justification: type === 'service_request' ? String(body.justification || '').trim().slice(0, MAX_JUSTIFICATION) : '',
    neededBy: type === 'service_request' ? neededBy : '',
  };
}

// Field-by-field messages, shown next to each field.
async function validateForm(form) {
  const errors = {};
  if (!form.title) errors.title = form.type === 'service_request' ? 'Say what you need in a few words.' : "Say what's wrong in a few words.";
  if (!form.description) errors.description = 'Add a description so the team knows what to do.';
  if (!(await store.getDepartment(form.department))) errors.department = 'Choose the department that should handle this.';
  if (form.type === 'service_request' && !form.justification) errors.justification = 'Explain why it is needed. Your approvers read this.';
  if (form.neededBy && new Date(`${form.neededBy}T23:59:59`) < new Date()) errors.neededBy = 'The date has already passed.';
  return errors;
}

// ---- Filtered ticket list (agents + managers) ----
// Every number on the manager dashboard links here with its filters in
// the query string, e.g. /tickets?state=active&sla=breached.
const SLA_RANK = { breached: 0, at_risk: 1, ok: 2, met: 3, waiting: 4 };
const SORTS = {
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  sla: (a, b) => SLA_RANK[a.sla.overall] - SLA_RANK[b.sla.overall],
  priority: (a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority),
};

router.get('/', requirePermission('ticket.view_all'), asyncHandler(async (req, res) => {
  const filters = filtering.parseFilters(req.query);
  const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
  const [all, agents, departments] = await Promise.all([store.listTickets({}), store.listUsers({ role: 'agent' }), store.listDepartments()]);
  const tickets = filtering.applyFilters(filtering.withSla(all), filters).sort(SORTS[sort]);
  const nameOf = (email) => (agents.find((a) => a.email === email) || {}).name || email;
  const deptName = (code) => (departments.find((d) => d.code === code) || {}).name || code;
  res.render('tickets-list', {
    tickets,
    total: all.length,
    filters,
    sort,
    chips: filtering.chips(filters, { nameOf, deptName }),
    query: filtering.toQuery(filters),
    agents,
    departments,
    TYPE_LABELS,
    STATUSES,
    PRIORITIES,
    CATEGORIES,
    SLA_LABELS: filtering.SLA_LABELS,
    DUP_LABELS: filtering.DUP_LABELS,
    SUGGESTION_LABELS: filtering.SUGGESTION_LABELS,
  });
}));

// ---- Create (end users only - managers have no creation UI by design) ----
router.get('/new', requirePermission('ticket.create'), asyncHandler(async (req, res) => {
  const type = TICKET_TYPES.includes(req.query.type) ? req.query.type : '';
  await renderNew(res, { form: { type, department: 'IT' } });
}));

// "Suggest category" button: re-renders the form with the AI suggestion
// pre-selected (still editable) and any knowledge-base articles that might
// solve the problem without a ticket.
router.post('/new/suggest', requirePermission('ticket.create'), asyncHandler(async (req, res) => {
  const form = readForm(req.body);
  if (!form.type) return renderNew(res, { status: 400, error: 'Choose Incident or Service request first.', form });
  if (!form.title && !form.description) {
    return renderNew(res, { status: 400, error: 'Type a title or description first.', form });
  }
  const suggestion = await suggestCategory(form);
  if (suggestion) form.category = suggestion.category;
  // Quick-fix articles only make sense when something is broken.
  const help = form.type === 'incident' ? await assistant.ask(`${form.title}\n${form.description}`, req.session.user) : null;
  await renderNew(res, { form, suggestion, help });
}));

router.post('/', requirePermission('ticket.create'), asyncHandler(async (req, res) => {
  const form = readForm(req.body);
  if (!form.type) return renderNew(res, { status: 400, error: 'Choose Incident or Service request first.', form });
  const errors = await validateForm(form);
  if (Object.keys(errors).length) {
    return renderNew(res, { status: 400, error: 'Please fix the highlighted fields.', errors, form });
  }
  const user = req.session.user;
  // Record what the suggester proposed (if it was used), so the report can
  // measure how often people kept or changed the suggestion.
  let categorySuggestion = null;
  if (req.body.suggestedCategory && CATEGORIES.includes(req.body.suggestedCategory)) {
    categorySuggestion = {
      suggested: req.body.suggestedCategory,
      method: req.body.suggestionMethod === 'ai' ? 'ai' : 'keyword',
      accepted: req.body.suggestedCategory === (form.category || 'General'),
    };
  }
  const isRequest = form.type === 'service_request';
  let ticket = await store.createTicket({
    status: isRequest ? 'Pending Approval' : 'Open',
    approvalState: isRequest ? 'pending' : 'not_required',
    type: form.type,
    title: form.title,
    description: form.description,
    department: form.department,
    justification: form.justification || null,
    neededBy: form.neededBy ? new Date(`${form.neededBy}T00:00:00`) : null,
    category: form.category || 'General',
    priority: form.priority,
    requesterEmail: user.email,
    requesterName: user.name,
    categorySuggestion,
  });
  await logAction(user, 'ticket.create', { ticketId: ticket.ticketId, type: ticket.type, department: ticket.department, category: ticket.category, priority: ticket.priority });
  if (isRequest) {
    const started = await approvals.start(ticket, user);
    ticket = started.ticket || ticket;
    await logAction(user, 'approval.start', { ticketId: ticket.ticketId, autoApproved: !!started.autoApproved });
  }
  // Urgent alerts only for tickets that are actually in a queue.
  if (ticket.status === 'Open') await notify.ticketCreated(ticket, user);

  // Duplicate detection runs before redirecting so staff see results on
  // the first page load. It never throws, and its embeddings call has a
  // 10s timeout, so it can't block or break ticket creation.
  try {
    const dup = await detectDuplicates(ticket.ticketId);
    if (dup) {
      await logAction(user, 'ticket.duplicates', {
        ticketId: ticket.ticketId,
        ai: dup.ai.status === 'ok' ? dup.ai.matches.map((m) => m.ticketId) : dup.ai.status,
        baseline: dup.baseline.matches.map((m) => m.ticketId),
      });
    }
  } catch (err) {
    console.error('Duplicate detection failed:', err.message);
  }
  res.redirect(`/tickets/${ticket.ticketId}`);
}));

// ---- View ----
router.get('/:id', requireLogin, asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const user = req.session.user;
  const staff = isStaff(user);
  res.render('ticket-show', {
    ticket,
    STATUSES,
    nextStatuses: STATUS_TRANSITIONS[ticket.status] || [],
    sla: slaFor(ticket),
    timeInStatus: timeInStatus(ticket),
    // Duplicate results, assignee suggestion and workloads are staff-only:
    // they reveal other people's tickets.
    showDuplicates: staff,
    liveThresholds: { ai: aiThreshold(), baseline: baselineThreshold() },
    // Internal notes are only ever loaded for staff - the requester's page
    // never has them in hand, so no template mistake can leak them.
    internalNotes: can(user, 'note.manage') ? await store.listInternalNotes(ticket.ticketId) : [],
    // Tickets merged into this one (their IDs are other people's tickets).
    mergedChildren: staff ? await store.listTickets({ mergedInto: ticket.ticketId }) : [],
    cannedResponses: can(user, 'canned.use') ? await store.listCannedResponses() : [],
    department: await store.getDepartment(ticket.department || 'IT'),
    approval: await approvalView(ticket, user),
    departments: can(user, 'ticket.work') ? await store.listDepartments() : [],
    suggestedAssignee: staff && !ticket.assigneeEmail ? await suggestAssignee() : null,
    agents: can(user, 'ticket.assign') && !ticket.assigneeEmail ? await agentWorkloads() : [],
    flash: req.query.msg ? String(req.query.msg) : null,
    mergedFrom: /^T-\d+$/.test(String(req.query.from || '')) ? String(req.query.from) : null,
  });
}));

// Steps with names, for the approval panel on the ticket page.
async function approvalView(ticket, user) {
  if ((ticket.type || 'incident') !== 'service_request') return null;
  const [steps, users] = await Promise.all([store.listApprovalSteps({ ticketId: ticket.ticketId }), store.listUsers()]);
  const nameOf = (email) => (users.find((u) => u.email === email) || {}).name || email;
  return {
    steps: steps.map((s) => ({ ...s, approverName: s.approverEmail ? nameOf(s.approverEmail) : null, label: approvals.KIND_LABELS[s.kind] })),
    mine: steps.find((s) => s.status === 'pending' && s.approverEmail === user.email) || null,
  };
}

// Only tickets in a queue can be worked on.
const NOT_IN_QUEUE = ['Pending Approval', 'Rejected'];

// ---- Agent / manager actions ----
router.post('/:id/claim', requirePermission('ticket.claim'), asyncHandler(async (req, res) => {
  const user = req.session.user;
  const pending = await store.getTicketById(String(req.params.id));
  if (pending && NOT_IN_QUEUE.includes(pending.status)) return res.redirect(`/tickets/${pending.ticketId}?msg=not_approved`);
  const { ticket, reason } = await store.claimTicket(req.params.id, user);
  if (reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (reason === 'already_claimed') {
    return res.redirect(`/tickets/${req.params.id}?msg=already_claimed`);
  }
  await logAction(user, 'ticket.claim', { ticketId: ticket.ticketId });
  await notify.ticketClaimed(ticket, user);
  res.redirect(`/tickets/${ticket.ticketId}`);
}));

// Managers can hand an unassigned ticket to a specific agent (e.g. the
// lowest-workload suggestion).
router.post('/:id/assign', requirePermission('ticket.assign'), asyncHandler(async (req, res) => {
  const user = req.session.user;
  const agent = await store.findUserByEmail(String(req.body.agentEmail || ''));
  if (!agent || agent.role !== 'agent') return res.status(400).send('Unknown agent');
  const pending = await store.getTicketById(String(req.params.id));
  if (pending && NOT_IN_QUEUE.includes(pending.status)) return res.redirect(`/tickets/${pending.ticketId}?msg=not_approved`);
  const { ticket, reason } = await store.claimTicket(req.params.id, agent);
  if (reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (reason === 'already_claimed') {
    return res.redirect(`/tickets/${req.params.id}?msg=already_claimed`);
  }
  await logAction(user, 'ticket.assign', { ticketId: ticket.ticketId, agentEmail: agent.email });
  await notify.ticketAssigned(ticket, user);
  res.redirect(`/tickets/${ticket.ticketId}`);
}));

router.post('/:id/status', requirePermission('ticket.work'), asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).send('Invalid status');
  const existing = await store.getTicketById(req.params.id);
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  if (!canTransition(existing.status, status)) {
    return res.redirect(`/tickets/${existing.ticketId}?msg=bad_transition`);
  }
  const user = req.session.user;
  const now = new Date();
  const set = { status };
  if (!existing.firstResponseAt) set.firstResponseAt = now;
  if (status === 'Resolved') set.resolvedAt = now;
  if (status === 'In Progress' && existing.status === 'Resolved') set.resolvedAt = null; // re-opened
  // Conditional on the status we checked, so two people changing it at
  // once can't skip a step.
  const ticket = await store.updateTicket(existing.ticketId, {
    set,
    push: { statusHistory: { status, at: now, byEmail: user.email } },
    where: { status: existing.status },
  });
  if (!ticket) return res.redirect(`/tickets/${existing.ticketId}?msg=changed`);
  await logAction(user, 'ticket.status', { ticketId: ticket.ticketId, from: existing.status, to: status });
  await notify.statusChanged(ticket, user, existing.status);
  res.redirect(`/tickets/${ticket.ticketId}`);
}));

// Re-route a ticket to another department (agents + managers).
router.post('/:id/department', requirePermission('ticket.work'), asyncHandler(async (req, res) => {
  const existing = await store.getTicketById(String(req.params.id));
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  const dept = await store.getDepartment(String(req.body.department || ''));
  if (!dept) return res.status(400).send('Unknown department');
  const from = existing.department || 'IT';
  if (dept.code !== from) {
    await store.updateTicket(existing.ticketId, { set: { department: dept.code } });
    await logAction(req.session.user, 'ticket.department', { ticketId: existing.ticketId, from, to: dept.code });
  }
  res.redirect(`/tickets/${existing.ticketId}?msg=rerouted`);
}));

// Re-runs both duplicate methods (e.g. for seed tickets, which have no
// stored results, or after the threshold changed).
router.post('/:id/duplicates', requirePermission('duplicate.decide'), asyncHandler(async (req, res) => {
  const existing = await store.getTicketById(req.params.id);
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  await detectDuplicates(existing.ticketId);
  await logAction(req.session.user, 'ticket.duplicates.rerun', { ticketId: existing.ticketId });
  res.redirect(`/tickets/${existing.ticketId}#duplicates`);
}));

// Confirm / reject one suggested duplicate (see lib/duplicateDecisions.js).
// Confirm merges the newer ticket of the pair into the older one.
const DECISION_FLASH = { not_suggested: 'not_suggested', already_decided: 'already_decided', already_merged: 'already_merged' };

router.post('/:id/duplicates/:otherId/confirm', requirePermission('duplicate.decide'), asyncHandler(async (req, res) => {
  const user = req.session.user;
  const id = String(req.params.id);
  const result = await decisions.confirm(id, String(req.params.otherId), user);
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (result.reason) return res.redirect(`/tickets/${id}?msg=${DECISION_FLASH[result.reason]}#duplicates`);
  await logAction(user, 'duplicate.confirm', { ticketId: id, candidateId: String(req.params.otherId), primaryId: result.primary.ticketId, mergedId: result.merged.ticketId });
  res.redirect(`/tickets/${result.primary.ticketId}?msg=merged&from=${encodeURIComponent(result.merged.ticketId)}#notes`);
}));

router.post('/:id/duplicates/:otherId/reject', requirePermission('duplicate.decide'), asyncHandler(async (req, res) => {
  const user = req.session.user;
  const id = String(req.params.id);
  const result = await decisions.reject(id, String(req.params.otherId), user);
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (result.reason) return res.redirect(`/tickets/${id}?msg=${DECISION_FLASH[result.reason]}#duplicates`);
  await logAction(user, 'duplicate.reject', { ticketId: id, candidateId: String(req.params.otherId), flaggedBy: result.decision.flaggedBy });
  res.redirect(`/tickets/${id}?msg=rejected#duplicates`);
}));

// ---- Comments (requester, any agent, any manager) ----
router.post('/:id/comment', requireLogin, asyncHandler(async (req, res) => {
  const existing = await loadTicket(req, res);
  if (!existing) return;
  const body = (req.body.body || '').trim().slice(0, MAX_COMMENT);
  if (!body) return res.redirect(`/tickets/${existing.ticketId}`);
  const user = req.session.user;
  const now = new Date();
  const set = {};
  if (can(user, 'ticket.work') && !existing.firstResponseAt) set.firstResponseAt = now;
  const ticket = await store.updateTicket(existing.ticketId, {
    set,
    push: { comments: { authorEmail: user.email, authorName: user.name, authorRole: user.role, body, createdAt: now } },
  });
  await logAction(user, 'ticket.comment', { ticketId: ticket.ticketId });
  await notify.commented(ticket, user);
  res.redirect(`/tickets/${ticket.ticketId}#activity`);
}));

// ---- Internal notes (agents + managers only) ----
// Never shown to the requester and never notified to anyone: staff read
// them on the ticket page. The audit log records that a note was added,
// not what it says.
router.post('/:id/notes', requirePermission('note.manage'), asyncHandler(async (req, res) => {
  const existing = await store.getTicketById(String(req.params.id));
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  const body = String(req.body.body || '').trim().slice(0, MAX_NOTE);
  if (!body) return res.redirect(`/tickets/${existing.ticketId}#notes`);
  const user = req.session.user;
  await store.addInternalNote({ ticketId: existing.ticketId, authorEmail: user.email, authorName: user.name, authorRole: user.role, body });
  await logAction(user, 'ticket.note', { ticketId: existing.ticketId });
  res.redirect(`/tickets/${existing.ticketId}#notes`);
}));

module.exports = router;
