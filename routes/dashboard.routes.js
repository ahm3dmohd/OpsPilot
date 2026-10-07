const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin } = require('../middleware/auth');
const Ticket = require('../models/Ticket');
const STATUSES = Ticket.STATUSES;

router.get('/', requireLogin, (req, res) => res.redirect('/dashboard'));

router.get('/dashboard', requireLogin, async (req, res) => {
  const user = req.session.user;

  if (user.role === 'end_user') {
    const tickets = await store.listTickets({ requesterEmail: user.email });
    return res.render('dashboard-enduser', { tickets });
  }

  if (user.role === 'agent') {
    const allOpen = await store.listTickets({ status: 'Open' });
    const mine = await store.listTickets({ assigneeEmail: user.email });
    return res.render('dashboard-agent', { queue: allOpen, mine });
  }

  if (user.role === 'manager') {
    const all = await store.listTickets({});
    const byStatus = {};
    STATUSES.forEach((s) => (byStatus[s] = 0));
    const byAgent = {};
    const byCategory = {};
    all.forEach((t) => {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.assigneeEmail) {
        byAgent[t.assigneeName || t.assigneeEmail] = (byAgent[t.assigneeName || t.assigneeEmail] || 0) + 1;
      }
      byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    });
    return res.render('dashboard-manager', { total: all.length, byStatus, byAgent, byCategory, tickets: all });
  }

  res.status(403).render('403', { title: 'Access denied' });
});

module.exports = router;
