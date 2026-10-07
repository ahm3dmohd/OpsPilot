// Demo users and the synthetic ticket set, shared by mock mode
// (lib/store.js) and real-DB seeding (scripts/seed.js) so both start from
// exactly the same data.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DEMO_PASSWORD = 'password123';

const DEMO_USERS = [
  { key: 'enduser', name: 'Erin Carter', email: 'enduser@opspilot.test', role: 'end_user' },
  { key: 'agent', name: 'Adel Haddad', email: 'agent@opspilot.test', role: 'agent' },
  { key: 'agent2', name: 'Sara Ali', email: 'agent2@opspilot.test', role: 'agent' },
  { key: 'manager', name: 'Mona Saleh', email: 'manager@opspilot.test', role: 'manager' },
];

function demoUsers() {
  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  return DEMO_USERS.map(({ name, email, role }) => ({ name, email, role, passwordHash }));
}

// Turns data/tickets.json into full ticket records. Ages are stored as
// "createdHoursAgo" so SLA timers look realistic whenever the app starts.
function seedTickets(now = Date.now()) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/tickets.json'), 'utf8'));
  return raw.map((t) => {
    const createdAt = new Date(now - t.createdHoursAgo * 3600 * 1000);
    const assignee = t.assignee ? DEMO_USERS.find((u) => u.key === t.assignee) : null;
    // Rebuild a plausible status history: picked up an hour after creation,
    // resolved/closed later on, so time-in-status has something to show.
    const statusHistory = [{ status: 'Open', at: createdAt }];
    const step = (h) => new Date(createdAt.getTime() + h * 3600 * 1000);
    if (t.status !== 'Open') statusHistory.push({ status: 'In Progress', at: step(1) });
    if (t.status === 'Resolved' || t.status === 'Closed') statusHistory.push({ status: 'Resolved', at: step(t.createdHoursAgo * 0.6) });
    if (t.status === 'Closed') statusHistory.push({ status: 'Closed', at: step(t.createdHoursAgo * 0.8) });
    const resolved = statusHistory.find((h) => h.status === 'Resolved');
    return {
      ticketId: t.ticketId,
      title: t.title,
      description: t.description,
      category: t.category,
      priority: t.priority,
      status: t.status,
      requesterEmail: t.requesterEmail,
      requesterName: t.requesterName,
      assigneeEmail: assignee ? assignee.email : null,
      assigneeName: assignee ? assignee.name : null,
      comments: [],
      statusHistory,
      firstResponseAt: t.status === 'Open' ? null : step(1),
      resolvedAt: resolved ? resolved.at : null,
      embedding: [],
      embeddingModel: null,
      duplicates: null,
      createdAt,
      updatedAt: statusHistory[statusHistory.length - 1].at,
    };
  });
}

function loadKnowledgeBase() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/kb.json'), 'utf8'));
}

module.exports = { DEMO_PASSWORD, DEMO_USERS, demoUsers, seedTickets, loadKnowledgeBase };
