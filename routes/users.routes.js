const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireRole, asyncHandler } = require('../middleware/auth');
const { ROLES } = require('../lib/constants');
const { changeRole } = require('../lib/roles');
const { logAction } = require('../lib/activity');

// ---- User & role management (admins only, mounted at /admin) ----
router.get('/users', requireRole('admin'), asyncHandler(async (req, res) => {
  const msg = req.query.msg ? String(req.query.msg) : null;
  const who = req.query.who ? String(req.query.who) : null;
  res.render('admin-users', { users: await store.listUsers(), ROLES, flash: msg, who });
}));

router.post('/users/role', requireRole('admin'), asyncHandler(async (req, res) => {
  const actor = req.session.user;
  const email = String(req.body.email || '');
  const result = await changeRole(actor, email, req.body.role);
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (result.reason === 'invalid_role') return res.status(400).send('Invalid role');
  const who = encodeURIComponent(email);
  if (result.reason) return res.redirect(`/admin/users?msg=${result.reason}&who=${who}`);
  // Who, whom, old role, new role; the audit entry carries the timestamp.
  await logAction(actor, 'user.role', { email: result.user.email, from: result.from, to: result.user.role });
  res.redirect(`/admin/users?msg=role_changed&who=${who}`);
}));

module.exports = router;
