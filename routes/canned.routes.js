const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requirePermission, asyncHandler } = require('../middleware/auth');
const { logAction } = require('../lib/activity');

// Canned responses: saved replies staff insert into a comment. Same rights
// as the knowledge base: agents and managers create and edit, managers
// delete. End users never see them.
const MAX_TITLE = 100;
const MAX_BODY = 5000; // same as a comment, so an inserted reply always fits

function readForm(body) {
  return {
    title: String(body.title || '').trim().slice(0, MAX_TITLE),
    body: String(body.body || '').trim().slice(0, MAX_BODY),
  };
}

async function renderList(res, { status = 200, form = {}, error = null, flash = null } = {}) {
  res.status(status).render('canned-list', { responses: await store.listCannedResponses(), form, error, flash });
}

router.get('/', requirePermission('canned.use'), asyncHandler(async (req, res) => {
  await renderList(res, { flash: req.query.msg ? String(req.query.msg) : null });
}));

router.post('/', requirePermission('canned.use'), asyncHandler(async (req, res) => {
  const form = readForm(req.body);
  if (!form.title || !form.body) return renderList(res, { status: 400, form, error: 'Title and text are required.' });
  const created = await store.createCannedResponse({ ...form, authorEmail: req.session.user.email });
  await logAction(req.session.user, 'canned.create', { id: created.id });
  res.redirect('/canned?msg=created');
}));

router.get('/:id/edit', requirePermission('canned.use'), asyncHandler(async (req, res) => {
  const response = await store.getCannedResponse(String(req.params.id));
  if (!response) return res.status(404).render('404', { url: req.originalUrl });
  res.render('canned-form', { response, form: response, error: null });
}));

router.post('/:id', requirePermission('canned.use'), asyncHandler(async (req, res) => {
  const existing = await store.getCannedResponse(String(req.params.id));
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  const form = readForm(req.body);
  if (!form.title || !form.body) {
    return res.status(400).render('canned-form', { response: existing, form, error: 'Title and text are required.' });
  }
  await store.updateCannedResponse(existing.id, form);
  await logAction(req.session.user, 'canned.update', { id: existing.id });
  res.redirect('/canned?msg=saved');
}));

router.post('/:id/delete', requirePermission('canned.delete'), asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!(await store.deleteCannedResponse(id))) return res.status(404).render('404', { url: req.originalUrl });
  await logAction(req.session.user, 'canned.delete', { id });
  res.redirect('/canned?msg=deleted');
}));

module.exports = router;
