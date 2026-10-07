// Shared enums, so models, routes and views all agree on the same values.
const ROLES = ['end_user', 'agent', 'manager'];
const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const CATEGORIES = ['Network', 'Hardware', 'Software', 'Account', 'Email', 'General'];

// Allowed status moves: forward one step at a time, plus re-opening a
// resolved ticket (back to In Progress) if the fix didn't hold. Closed is
// final.
const STATUS_TRANSITIONS = {
  Open: ['In Progress'],
  'In Progress': ['Resolved'],
  Resolved: ['Closed', 'In Progress'],
  Closed: [],
};

function canTransition(from, to) {
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

module.exports = { ROLES, STATUSES, PRIORITIES, CATEGORIES, STATUS_TRANSITIONS, canTransition };
