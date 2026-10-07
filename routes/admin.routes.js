const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, requireRole, asyncHandler } = require('../middleware/auth');
const assistant = require('../lib/assistant');

// ---- Audit log (managers only) ----
router.get('/audit', requireRole('manager'), asyncHandler(async (req, res) => {
  const [entries, integrity] = await Promise.all([store.listAudit(200), store.verifyAudit()]);
  res.render('audit', { entries, integrity });
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
