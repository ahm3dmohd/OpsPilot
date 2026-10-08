const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { ROLES } = require('../lib/constants');
const { asyncHandler } = require('../middleware/auth');
const { logAction } = require('../lib/activity');

// Public sign-up creates End User accounts only - otherwise anyone could
// make themselves a manager. Set ALLOW_ROLE_SELECT_ON_REGISTER=true to
// bring back the role picker for demos.
function selectableRoles() {
  // Never admin, even in demo mode: admins are made by another admin or
  // with `npm run make-admin`.
  return process.env.ALLOW_ROLE_SELECT_ON_REGISTER === 'true' ? ROLES.filter((r) => r !== 'admin') : ['end_user'];
}

// Swap in a fresh session ID on login/sign-up, so a session ID planted
// before login (session fixation) can't be used to ride the new login.
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = { name: user.name, email: user.email, role: user.role };
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, email: '' });
});

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await store.findUserByEmail(email);
  // Same message whether the email or the password is wrong, so the form
  // can't be used to find out which emails have accounts.
  if (!user || !(await store.checkPassword(user, password))) {
    return res.status(401).render('login', { error: 'Incorrect email or password.', email: email || '' });
  }
  await startSession(req, user);
  await logAction(user, 'user.login', {});
  res.redirect('/dashboard');
}));

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { error: null, roles: selectableRoles() });
});

router.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const roles = selectableRoles();
  const role = roles.includes(req.body.role) ? req.body.role : 'end_user';
  const fail = (error) => res.status(400).render('register', { error, roles });
  if (!name || !name.trim() || !email || !password) return fail('All fields are required.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (await store.findUserByEmail(email)) return fail('An account with that email already exists.');
  const user = await store.createUser({ name: name.trim(), email, password, role });
  await startSession(req, user);
  await logAction(user, 'user.register', { role });
  res.redirect('/dashboard');
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
