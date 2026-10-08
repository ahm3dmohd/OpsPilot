// Changing a user's role (admins only - the route checks that). Two
// safeguards, both enforced here on the server:
//   - nobody can change their OWN role (so an admin can't demote
//     themselves by accident);
//   - the last remaining admin can't be demoted, so the app always has
//     someone who can manage users.
// Returns { user, from } or { reason }.
const store = require('./store');
const { ROLES } = require('./constants');

async function changeRole(actor, email, role) {
  const target = String(email || '');
  const newRole = String(role || '');
  if (!ROLES.includes(newRole)) return { reason: 'invalid_role' };
  const user = await store.findUserByEmail(target);
  if (!user) return { reason: 'not_found' };
  if (user.email === actor.email) return { reason: 'self' };
  if (user.role === newRole) return { reason: 'unchanged' };
  if (user.role === 'admin' && (await store.countUsers({ role: 'admin' })) <= 1) return { reason: 'last_admin' };

  const updated = await store.updateUserRole(user.email, newRole);
  // Two admins demoting each other at the same moment could both pass the
  // check above. Re-count afterwards and undo if that left no admin.
  if (user.role === 'admin' && (await store.countUsers({ role: 'admin' })) === 0) {
    await store.updateUserRole(user.email, 'admin');
    return { reason: 'last_admin' };
  }
  return { user: updated, from: user.role };
}

module.exports = { changeRole };
