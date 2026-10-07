// Audit logging for routes. Never throws and never blocks a user action
// for long: if the write fails (e.g. the database just dropped), the
// action itself has already succeeded, so we log the failure and move on.
// mongoose's bufferCommands is off (server.js), so a dead connection
// fails immediately instead of hanging for 10 seconds.
const store = require('./store');

async function logAction(user, action, detail) {
  try {
    await store.appendAudit(user.email, action, detail);
  } catch (err) {
    console.error(`Audit log write failed (${action}):`, err.message);
  }
}

module.exports = { logAction };
