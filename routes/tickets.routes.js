const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const AuditLog = require('../models/AuditLog');
const { requireLogin, requireRole } = require('../middleware/auth');
const TicketModel = require('../models/Ticket');
const STATUSES = TicketModel.STATUSES;
const PRIORITIES = TicketModel.PRIORITIES;

function canView(ticket, user) {
  if (user.role === 'manager' || user.role === 'agent') return true;
  return ticket.requesterEmail === user.email;
}

async function logAction(user, action, detail) {
  // Audit logging needs MongoDB. Checking the connection state first
  // (rather than just try/catching) matters: Mongoose buffers calls made
  // while disconnected and only rejects after its buffer timeout (~10s
  // by default), which would otherwise make every action feel hung in
  // mock mode instead of failing fast.
  if (!store.isDbConnected()) return;
  try {
    await AuditLog.append(user.email, action, detail);
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

router.get('/new', requireRole('end_user'), (req, res) => {
  res.render('ticket-new', { error: null });
});

router.post('/', requireRole('end_user'), async (req, res) => {
  const { title, description, category, priority } = req.body;
  if (!title || !description) {
    return res.status(400).render('ticket-new', { error: 'Title and description are required.' });
  }
  const user = req.session.user;
  const ticket = await store.createTicket({
    title,
    description,
    category: category || 'General',
    priority: PRIORITIES.includes(priority) ? priority : 'Medium',
    requesterEmail: user.email,
    requesterName: user.name,
  });
  await logAction(user, 'ticket.create', { ticketId: ticket.ticketId });
  res.redirect(`/tickets/${ticket.ticketId}`);
});

router.get('/:id', requireLogin, async (req, res) => {
  const ticket = await store.getTicketById(req.params.id);
  if (!ticket) return res.status(404).render('404', { url: req.originalUrl });
  if (!canView(ticket, req.session.user)) {
    return res.status(403).render('403', { title: 'Access denied' });
  }
  res.render('ticket-show', { ticket, STATUSES, PRIORITIES });
});

router.post('/:id/claim', requireRole('agent'), async (req, res) => {
  const user = req.session.user;
  const ticket = await store.updateTicket(req.params.id, {
    assigneeEmail: user.email,
    assigneeName: user.name,
    status: 'In Progress',
  });
  if (!ticket) return res.status(404).render('404', { url: req.originalUrl });
  await logAction(user, 'ticket.claim', { ticketId: ticket.ticketId });
  res.redirect(`/tickets/${ticket.ticketId}`);
});

router.post('/:id/status', requireRole('agent', 'manager'), async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).send('Invalid status');
  }
  const user = req.session.user;
  const ticket = await store.updateTicket(req.params.id, { status });
  if (!ticket) return res.status(404).render('404', { url: req.originalUrl });
  await logAction(user, 'ticket.status', { ticketId: ticket.ticketId, status });
  res.redirect(`/tickets/${ticket.ticketId}`);
});

router.post('/:id/comment', requireLogin, async (req, res) => {
  const { body } = req.body;
  const user = req.session.user;
  const existing = await store.getTicketById(req.params.id);
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  if (!canView(existing, user)) {
    return res.status(403).render('403', { title: 'Access denied' });
  }
  if (!body || !body.trim()) {
    return res.redirect(`/tickets/${req.params.id}`);
  }
  const ticket = await store.addComment(req.params.id, {
    authorEmail: user.email,
    authorName: user.name,
    body: body.trim(),
  });
  await logAction(user, 'ticket.comment', { ticketId: ticket.ticketId });
  res.redirect(`/tickets/${ticket.ticketId}`);
});

module.exports = router;
