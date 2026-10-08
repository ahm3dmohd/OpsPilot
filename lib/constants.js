// Shared enums, so models, routes and views all agree on the same values.
// manager = service-desk manager. admin = system administrator: everything
// a manager can do, plus user/role management (see middleware/auth.js).
const ROLES = ['end_user', 'agent', 'manager', 'admin'];
const ROLE_LABELS = { end_user: 'End user', agent: 'Agent', manager: 'Service desk manager', admin: 'Admin' };
// Roles with the service-desk manager's rights.
const MANAGER_ROLES = ['manager', 'admin'];
const hasManagerRights = (user) => !!user && MANAGER_ROLES.includes(user.role);
const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
// Incident = something is broken. Service request = asking for something
// new (access, equipment, an app). Only service requests need approval.
const TICKET_TYPES = ['incident', 'service_request'];
const TYPE_LABELS = { incident: 'Incident', service_request: 'Service request' };
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

module.exports = { TICKET_TYPES, TYPE_LABELS, ROLES, ROLE_LABELS, MANAGER_ROLES, hasManagerRights, STATUSES, PRIORITIES, CATEGORIES, STATUS_TRANSITIONS, canTransition };
