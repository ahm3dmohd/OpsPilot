const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireLogin, requirePermission, asyncHandler } = require('../middleware/auth');
const { CATEGORIES } = require('../lib/constants');
const { tokenize, jaccardSimilarity } = require('../lib/similarity');
const { logAction } = require('../lib/activity');

const MAX_TITLE = 150;
const MAX_BODY = 10000;

function readForm(body) {
  return {
    title: (body.title || '').trim().slice(0, MAX_TITLE),
    body: (body.body || '').trim().slice(0, MAX_BODY),
    category: CATEGORIES.includes(body.category) ? body.category : 'General',
  };
}

// List + search (everyone logged in). Search is plain keyword matching so
// it's instant; the AI matching lives in the help assistant.
router.get('/', requireLogin, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString().trim().slice(0, 200);
  let articles = await store.listArticles();
  if (q) {
    const qt = tokenize(q);
    articles = articles
      .map((a) => ({ ...a, score: jaccardSimilarity(qt, tokenize(`${a.title} ${a.body} ${a.category}`)) }))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score);
  }
  res.render('kb-list', { articles, q, flash: req.query.msg || null });
}));

router.get('/new', requirePermission('kb.edit'), (req, res) => {
  res.render('kb-form', { article: null, form: { category: 'General' }, error: null, CATEGORIES });
});

router.post('/', requirePermission('kb.edit'), asyncHandler(async (req, res) => {
  const form = readForm(req.body);
  if (!form.title || !form.body) {
    return res.status(400).render('kb-form', { article: null, form, error: 'Title and body are required.', CATEGORIES });
  }
  const article = await store.createArticle({ ...form, authorEmail: req.session.user.email });
  await logAction(req.session.user, 'kb.create', { articleId: article.articleId });
  res.redirect(`/kb/${article.articleId}`);
}));

router.get('/:id', requireLogin, asyncHandler(async (req, res) => {
  // Count a view once per session, so refreshing doesn't inflate it.
  const seen = (req.session.kbViewed = req.session.kbViewed || []);
  let article;
  if (seen.includes(req.params.id)) {
    article = await store.getArticle(req.params.id);
  } else {
    article = await store.incrementArticle(req.params.id, 'views');
    if (article) seen.push(article.articleId);
  }
  if (!article) return res.status(404).render('404', { url: req.originalUrl });
  const voted = (req.session.kbVoted || []).includes(article.articleId);
  res.render('kb-show', { article, voted, flash: req.query.msg || null });
}));

// "Was this helpful?" - one vote per article per session.
router.post('/:id/vote', requireLogin, asyncHandler(async (req, res) => {
  const voted = (req.session.kbVoted = req.session.kbVoted || []);
  const id = req.params.id;
  if (voted.includes(id)) return res.redirect(`/kb/${id}`);
  const field = req.body.helpful === 'yes' ? 'helpful' : 'notHelpful';
  const article = await store.incrementArticle(id, field);
  if (!article) return res.status(404).render('404', { url: req.originalUrl });
  voted.push(id);
  res.redirect(`/kb/${id}?msg=thanks`);
}));

router.get('/:id/edit', requirePermission('kb.edit'), asyncHandler(async (req, res) => {
  const article = await store.getArticle(req.params.id);
  if (!article) return res.status(404).render('404', { url: req.originalUrl });
  res.render('kb-form', { article, form: article, error: null, CATEGORIES });
}));

router.post('/:id', requirePermission('kb.edit'), asyncHandler(async (req, res) => {
  const existing = await store.getArticle(req.params.id);
  if (!existing) return res.status(404).render('404', { url: req.originalUrl });
  const form = readForm(req.body);
  if (!form.title || !form.body) {
    return res.status(400).render('kb-form', { article: existing, form, error: 'Title and body are required.', CATEGORIES });
  }
  await store.updateArticle(existing.articleId, form);
  await logAction(req.session.user, 'kb.update', { articleId: existing.articleId });
  res.redirect(`/kb/${existing.articleId}`);
}));

router.post('/:id/delete', requirePermission('kb.delete'), asyncHandler(async (req, res) => {
  const deleted = await store.deleteArticle(req.params.id);
  if (!deleted) return res.status(404).render('404', { url: req.originalUrl });
  await logAction(req.session.user, 'kb.delete', { articleId: req.params.id });
  res.redirect('/kb?msg=deleted');
}));

module.exports = router;
