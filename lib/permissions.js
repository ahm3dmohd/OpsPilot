// Who can do what: the ONE place that maps roles to abilities.
//
// Routes check a permission (requirePermission('report.export')) and views
// ask can('report.export'); nothing else compares role names. To change
// what a role can do, edit its list here. There is no hidden inheritance:
// admin's list spells out every manager ability it has.
//
// Approving a service request is deliberately NOT a permission: it depends
// on being the designated approver of that step (line manager or
// department head), checked in lib/approvals.js.

const DESCRIPTIONS = {
  'ticket.create': 'Report incidents and make service requests',
  'ticket.view_all': "See every ticket, the ticket list, search and duplicate results",
  'ticket.work': 'Change status, re-route to a department, reply as IT staff',
  'ticket.claim': 'Claim an unassigned ticket for yourself',
  'ticket.assign': 'Assign a ticket to an agent',
  'note.manage': 'Read and write internal (staff-only) notes',
  'duplicate.decide': 'Re-run duplicate checks, confirm (merge) or reject suggestions',
  'canned.use': 'Use, add and edit canned responses',
  'canned.delete': 'Delete canned responses',
  'kb.edit': 'Write and edit knowledge-base articles, see their usage stats',
  'kb.delete': 'Delete knowledge-base articles',
  'report.view': 'Manager dashboard, AI evaluation, duplicate-decision stats',
  'report.export': 'Download CSV exports',
  'audit.view': 'Read the audit log',
  'user.manage': 'Change roles, departments and line managers',
  'department.manage': 'Add departments and set their heads',
  'approval.reassign': 'Reassign open approval steps',
  'settings.edit': 'Change live duplicate-detection thresholds',
};

const STAFF = ['ticket.view_all', 'ticket.work', 'note.manage', 'duplicate.decide', 'canned.use', 'kb.edit'];
const MANAGEMENT = ['ticket.assign', 'canned.delete', 'kb.delete', 'report.view', 'report.export', 'audit.view'];
const ADMINISTRATION = ['user.manage', 'department.manage', 'approval.reassign', 'settings.edit'];

const PERMISSIONS = {
  end_user: ['ticket.create'],
  agent: [...STAFF, 'ticket.claim'],
  manager: [...STAFF, ...MANAGEMENT],
  admin: [...STAFF, ...MANAGEMENT, ...ADMINISTRATION],
};

const ALL = Object.keys(DESCRIPTIONS);
const { ROLES } = require('./constants');

ROLES.forEach((role) => {
  if (!PERMISSIONS[role]) throw new Error(`Role "${role}" has no permission list in lib/permissions.js`);
});

// Fail at startup, not with a silent 403, if a name is misspelled.
function assertKnown(permission) {
  if (!ALL.includes(permission)) throw new Error(`Unknown permission "${permission}" (see lib/permissions.js)`);
}
Object.values(PERMISSIONS).flat().forEach(assertKnown);

function can(user, permission) {
  assertKnown(permission);
  return !!user && (PERMISSIONS[user.role] || []).includes(permission);
}

module.exports = { PERMISSIONS, DESCRIPTIONS, ALL, can, assertKnown };
