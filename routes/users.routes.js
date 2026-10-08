const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireRole, asyncHandler } = require('../middleware/auth');
const { ROLES } = require('../lib/constants');
const { changeRole } = require('../lib/roles');
const org = require('../lib/org');
const { logAction } = require('../lib/activity');

// ---- User & role management (admins only, mounted at /admin) ----
router.get('/users', requireRole('admin'), asyncHandler(async (req, res) => {
  const msg = req.query.msg ? String(req.query.msg) : null;
  const who = req.query.who ? String(req.query.who) : null;
  const [users, departments] = await Promise.all([store.listUsers(), store.listDepartments()]);
  res.render('admin-users', { users, departments, ROLES, flash: msg, who });
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

// Department + line manager for one user.
router.post('/users/org', requireRole('admin'), asyncHandler(async (req, res) => {
  const email = String(req.body.email || '');
  const result = await org.setUserOrg(email, { department: req.body.department, managerEmail: req.body.managerEmail });
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  const who = encodeURIComponent(email);
  if (result.reason) return res.redirect(`/admin/users?msg=${result.reason}&who=${who}`);
  await logAction(req.session.user, 'user.org', {
    email: result.user.email,
    from: result.before,
    to: { department: result.user.department, managerEmail: result.user.managerEmail },
  });
  res.redirect(`/admin/users?msg=org_changed&who=${who}`);
}));

// ---- Departments (admins only) ----
router.get('/departments', requireRole('admin'), asyncHandler(async (req, res) => {
  const [departments, users, tickets] = await Promise.all([store.listDepartments(), store.listUsers(), store.listTickets({})]);
  const counts = {};
  tickets.forEach((t) => {
    const d = t.department || 'IT';
    counts[d] = (counts[d] || 0) + 1;
  });
  const members = {};
  users.forEach((u) => {
    if (u.department) members[u.department] = (members[u.department] || 0) + 1;
  });
  res.render('admin-departments', {
    departments, users, counts, members,
    flash: req.query.msg ? String(req.query.msg) : null,
    form: {},
  });
}));

router.post('/departments', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await org.addDepartment({ code: req.body.code, name: req.body.name });
  if (result.reason) return res.redirect(`/admin/departments?msg=${result.reason}`);
  await logAction(req.session.user, 'department.create', { code: result.dept.code, name: result.dept.name });
  res.redirect('/admin/departments?msg=created');
}));

router.post('/departments/:code/head', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await org.setHead(String(req.params.code), req.body.headEmail);
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (result.reason) return res.redirect(`/admin/departments?msg=${result.reason}`);
  await logAction(req.session.user, 'department.head', { code: result.dept.code, from: result.before, to: result.dept.headEmail });
  res.redirect('/admin/departments?msg=head_changed');
}));

module.exports = router;
