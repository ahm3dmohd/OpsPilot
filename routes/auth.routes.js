const express = require('express');
const router = express.Router();
const store = require('../lib/store');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await store.findUserByEmail(email);
  if (!user) {
    return res.status(401).render('login', { error: 'No account with that email.' });
  }
  const ok = await store.checkPassword(user, password);
  if (!ok) {
    return res.status(401).render('login', { error: 'Incorrect password.' });
  }
  req.session.user = { name: user.name, email: user.email, role: user.role };
  res.redirect('/dashboard');
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { error: null, roles: ['end_user', 'agent', 'manager'] });
});

router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  const roles = ['end_user', 'agent', 'manager'];
  if (!name || !email || !password || !roles.includes(role)) {
    return res.status(400).render('register', { error: 'All fields are required.', roles });
  }
  const existing = await store.findUserByEmail(email);
  if (existing) {
    return res.status(400).render('register', { error: 'An account with that email already exists.', roles });
  }
  const user = await store.createUser({ name, email, password, role });
  req.session.user = { name: user.name, email: user.email, role: user.role };
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
