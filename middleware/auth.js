const { can, assertKnown } = require('../lib/permissions');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Route guard: the logged-in user's role must grant `permission` (see
// lib/permissions.js). The name is checked when the route is defined, so
// a typo stops the server from starting instead of locking everyone out.
function requirePermission(permission) {
  assertKnown(permission);
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (!can(req.session.user, permission)) {
      return res.status(403).render('403', { title: 'Access denied' });
    }
    next();
  };
}

// Express 4 doesn't catch errors thrown by async route handlers - without
// this, a failed DB call leaves the request hanging. Wrap every async
// handler so errors reach the error page in server.js.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { requireLogin, requirePermission, asyncHandler };
