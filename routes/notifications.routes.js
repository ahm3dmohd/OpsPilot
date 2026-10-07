const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, asyncHandler } = require('../middleware/auth');

router.get('/', requireLogin, asyncHandler(async (req, res) => {
  const notifications = await store.listNotifications(req.session.user.email, 100);
  res.render('notifications', { notifications });
}));

// Opening a notification marks it read, then goes to its ticket.
router.post('/:id/open', requireLogin, asyncHandler(async (req, res) => {
  const n = await store.markNotificationRead(req.params.id, req.session.user.email);
  if (!n) return res.status(404).render('404', { url: req.originalUrl });
  res.redirect(n.ticketId ? `/tickets/${n.ticketId}` : '/notifications');
}));

router.post('/read-all', requireLogin, asyncHandler(async (req, res) => {
  await store.markAllNotificationsRead(req.session.user.email);
  res.redirect('/notifications');
}));

module.exports = router;
