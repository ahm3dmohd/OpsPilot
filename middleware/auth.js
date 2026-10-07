function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
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

module.exports = { requireLogin, requireRole, asyncHandler };
