const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requirePermission, asyncHandler } = require('../middleware/auth');
const { ROLES } = require('../lib/constants');
const { changeRole } = require('../lib/roles');
const org = require('../lib/org');
const approvals = require('../lib/approvals');
const settings = require('../lib/settings');
const duplicates = require('../lib/duplicates');
const decisions = require('../lib/duplicateDecisions');
const { logAction } = require('../lib/activity');

// ---- User & role management (admins only, mounted at /admin) ----
router.get('/users', requirePermission('user.manage'), asyncHandler(async (req, res) => {
  const msg = req.query.msg ? String(req.query.msg) : null;
  const who = req.query.who ? String(req.query.who) : null;
  const [users, departments] = await Promise.all([store.listUsers(), store.listDepartments()]);
  res.render('admin-users', { users, departments, ROLES, flash: msg, who });
}));

router.post('/users/role', requirePermission('user.manage'), asyncHandler(async (req, res) => {
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

// Read-only matrix of lib/permissions.js.
router.get('/permissions', requirePermission('user.manage'), (req, res) => {
  const { PERMISSIONS, DESCRIPTIONS, ALL } = require('../lib/permissions');
  res.render('admin-permissions', { ROLES, PERMISSIONS, DESCRIPTIONS, ALL });
});

// Department + line manager for one user.
router.post('/users/org', requirePermission('user.manage'), asyncHandler(async (req, res) => {
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
router.get('/departments', requirePermission('department.manage'), asyncHandler(async (req, res) => {
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

router.post('/departments', requirePermission('department.manage'), asyncHandler(async (req, res) => {
  const result = await org.addDepartment({ code: req.body.code, name: req.body.name });
  if (result.reason) return res.redirect(`/admin/departments?msg=${result.reason}`);
  await logAction(req.session.user, 'department.create', { code: result.dept.code, name: result.dept.name });
  res.redirect('/admin/departments?msg=created');
}));

router.post('/departments/:code/head', requirePermission('department.manage'), asyncHandler(async (req, res) => {
  const result = await org.setHead(String(req.params.code), req.body.headEmail);
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (result.reason) return res.redirect(`/admin/departments?msg=${result.reason}`);
  await logAction(req.session.user, 'department.head', { code: result.dept.code, from: result.before, to: result.dept.headEmail });
  // Approval steps that were waiting for this department to have a head.
  const assigned = await approvals.assignHeadSteps(result.dept.code, result.dept.headEmail, req.session.user);
  if (assigned) await logAction(req.session.user, 'approval.assign_head', { code: result.dept.code, steps: assigned });
  res.redirect('/admin/departments?msg=head_changed');
}));

// ---- Open approval steps: reassign when an approver changed or left ----
router.get('/approvals', requirePermission('approval.reassign'), asyncHandler(async (req, res) => {
  const [steps, users] = await Promise.all([approvals.openSteps(), store.listUsers()]);
  res.render('admin-approvals', {
    steps, users, KIND_LABELS: approvals.KIND_LABELS,
    flash: req.query.msg ? String(req.query.msg) : null,
  });
}));

router.post('/approvals/:id/reassign', requirePermission('approval.reassign'), asyncHandler(async (req, res) => {
  const result = await approvals.reassign(String(req.params.id), req.session.user, req.body.approverEmail);
  if (result.reason === 'not_found') return res.status(404).render('404', { url: req.originalUrl });
  if (result.reason) return res.redirect(`/admin/approvals?msg=${result.reason}`);
  await logAction(req.session.user, 'approval.reassign', {
    ticketId: result.step.ticketId, step: result.step.order, from: result.from, to: result.step.approverEmail,
  });
  res.redirect('/admin/approvals?msg=reassigned');
}));

// ---- Settings: live duplicate-detection thresholds ----
// Changing them affects NEW checks only (and "Re-check active tickets");
// the evaluation page keeps the tuned values, see lib/evaluation.js.
const THRESHOLDS = {
  aiThreshold: { min: 0.5, max: 0.99, tuned: () => duplicates.tunedAiThreshold(), live: () => duplicates.aiThreshold() },
  baselineThreshold: { min: 0.01, max: 0.9, tuned: () => duplicates.tunedBaselineThreshold(), live: () => duplicates.baselineThreshold() },
};

router.get('/settings', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const [stats, users] = await Promise.all([decisions.stats(), store.listUsers()]);
  const nameOf = (email) => (users.find((u) => u.email === email) || {}).name || email;
  const view = Object.fromEntries(Object.entries(THRESHOLDS).map(([key, t]) => {
    const changed = settings.info(key);
    return [key, { ...t, tuned: t.tuned(), live: t.live(), changed: changed ? { ...changed, byName: nameOf(changed.updatedByEmail) } : null }];
  }));
  const rate = (label) => stats.rows.find((r) => r.label === label);
  res.render('admin-settings', {
    t: view,
    feedback: { ai: rate('Flagged by AI'), baseline: rate('Flagged by baseline') },
    aiModel: require('../lib/embeddings').modelLabel(),
    flash: req.query.msg ? String(req.query.msg) : null,
  });
}));

router.post('/settings/thresholds', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const key = String(req.body.key || '');
  const t = THRESHOLDS[key];
  if (!t) return res.status(400).send('Unknown setting');
  const from = t.live();
  if (req.body.reset === '1') {
    await settings.clear(key);
  } else {
    const value = Math.round(parseFloat(req.body.value) * 100) / 100;
    if (Number.isNaN(value) || value < t.min || value > t.max) return res.redirect(`/admin/settings?msg=out_of_range_${key}`);
    await settings.set(key, value, req.session.user);
  }
  await logAction(req.session.user, 'settings.threshold', { key, from, to: t.live() });
  res.redirect(`/admin/settings?msg=saved_${key}`);
}));

// Re-runs both methods on every active ticket with the live thresholds,
// so existing suggestions match a changed setting.
router.post('/settings/recheck', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const active = (await store.listTickets({})).filter((t) => ['Pending Approval', 'Open', 'In Progress'].includes(t.status) && !t.mergedInto);
  for (const t of active) await duplicates.detectDuplicates(t.ticketId);
  await logAction(req.session.user, 'settings.recheck', { tickets: active.length });
  res.redirect(`/admin/settings?msg=rechecked_${active.length}`);
}));

module.exports = router;
