// Unified data access layer: every route calls these functions instead of
// touching Mongoose or the mock arrays directly. This file is the ONLY
// place that branches on mock vs. real-DB mode.
//
// The mode is decided once at startup (server.js calls useDatabase() or
// useMockData()) and never changes while the app runs, so a database that
// drops mid-session surfaces as errors instead of silently swapping to
// demo data.
//
// All functions return plain objects in both modes (Mongoose queries use
// .lean()), so routes and views never need to know which mode is active.

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Ticket = require('../models/Ticket');
const Counter = require('../models/Counter');
const AuditLog = require('../models/AuditLog');
const { demoUsers, seedTickets } = require('./seedData');
const audit = require('./audit');

const FIRST_TICKET_NUMBER = 1001;

let mode = null; // 'db' | 'mock'

function useDatabase() {
  mode = 'db';
}

function useMockData() {
  mode = 'mock';
  if (mock.users.length === 0) mock.users = demoUsers();
  if (mock.tickets.length === 0) {
    mock.tickets = seedTickets();
    mock.nextTicketNum = FIRST_TICKET_NUMBER + mock.tickets.length;
  }
}

function getMode() {
  return mode;
}

function isDb() {
  return mode === 'db';
}

// ---- Mock store (in-memory) ----
const mock = {
  users: [],
  tickets: [],
  audit: [],
  nextTicketNum: FIRST_TICKET_NUMBER,
};

function matchesFilter(item, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray(value.$in)) return value.$in.includes(item[key]);
    return item[key] === value;
  });
}

// ---- Users ----
function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

async function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (isDb()) return User.findOne({ email: normalized }).lean();
  return mock.users.find((u) => u.email === normalized) || null;
}

async function listUsers(filter = {}) {
  if (isDb()) return User.find(filter).sort({ name: 1 }).lean();
  return mock.users.filter((u) => matchesFilter(u, filter));
}

async function createUser({ name, email, password, role }) {
  const user = { name, email: normalizeEmail(email), passwordHash: bcrypt.hashSync(password, 10), role };
  if (isDb()) return (await User.create(user)).toObject();
  mock.users.push(user);
  return user;
}

async function checkPassword(user, password) {
  return bcrypt.compare(password || '', user.passwordHash);
}

// ---- Tickets ----
// filter supports exact matches and { field: { $in: [...] } }.
// Embedding vectors (768+ numbers each) are left out of DB results unless
// withEmbeddings is set - dashboards don't need them.
async function listTickets(filter = {}, { withEmbeddings = false } = {}) {
  if (isDb()) {
    const query = Ticket.find(filter).sort({ createdAt: -1 });
    if (!withEmbeddings) query.select('-embedding');
    return query.lean();
  }
  return mock.tickets
    .filter((t) => matchesFilter(t, filter))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function getTicketById(ticketId) {
  if (isDb()) return Ticket.findOne({ ticketId }).lean();
  return mock.tickets.find((t) => t.ticketId === ticketId) || null;
}

async function nextTicketId() {
  if (isDb()) {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'ticket' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    return `T-${FIRST_TICKET_NUMBER - 1 + counter.seq}`;
  }
  const id = `T-${mock.nextTicketNum}`;
  mock.nextTicketNum += 1;
  return id;
}

// Makes sure the DB ticket counter is past every existing ticket ID (e.g.
// after seeding, or a database created before counters existed).
async function syncTicketCounter() {
  if (!isDb()) return;
  const tickets = await Ticket.find({}, { ticketId: 1 }).lean();
  const highest = tickets.reduce((max, t) => Math.max(max, parseInt(t.ticketId.slice(2), 10) || 0), 0);
  const minSeq = Math.max(0, highest - (FIRST_TICKET_NUMBER - 1));
  await Counter.updateOne({ _id: 'ticket' }, { $max: { seq: minSeq } }, { upsert: true });
}

async function createTicket(fields) {
  const now = new Date();
  const ticket = {
    category: 'General',
    priority: 'Medium',
    ...fields,
    ticketId: await nextTicketId(),
    status: 'Open',
    assigneeEmail: null,
    assigneeName: null,
    comments: [],
    statusHistory: [{ status: 'Open', at: now, byEmail: fields.requesterEmail }],
    firstResponseAt: null,
    resolvedAt: null,
    embedding: [],
    embeddingModel: null,
    duplicates: null,
    createdAt: now,
    updatedAt: now,
  };
  if (isDb()) return (await Ticket.create(ticket)).toObject();
  mock.tickets.unshift(ticket);
  return ticket;
}

// Generic update: `set` fields are overwritten, `push` fields are appended
// to arrays (e.g. { comments: entry }). `where` adds extra conditions, so
// an update can be made conditional (see claimTicket). Returns the updated
// ticket, or null if no ticket matched.
async function updateTicket(ticketId, { set = {}, push = {}, where = {} } = {}) {
  const now = new Date();
  if (isDb()) {
    const update = { $set: { ...set, updatedAt: now } };
    if (Object.keys(push).length) update.$push = push;
    return Ticket.findOneAndUpdate({ ticketId, ...where }, update, { new: true }).lean();
  }
  const ticket = mock.tickets.find((t) => t.ticketId === ticketId && matchesFilter(t, where));
  if (!ticket) return null;
  Object.assign(ticket, set, { updatedAt: now });
  Object.entries(push).forEach(([key, value]) => {
    ticket[key] = [...(ticket[key] || []), value];
  });
  return ticket;
}

// Claims only if nobody has claimed it yet - done as a single conditional
// update so two agents clicking at the same moment can't both "win".
async function claimTicket(ticketId, agent) {
  const now = new Date();
  const existing = await getTicketById(ticketId);
  if (!existing) return { ticket: null, reason: 'not_found' };
  const set = { assigneeEmail: agent.email, assigneeName: agent.name };
  const push = {};
  if (existing.status === 'Open') {
    set.status = 'In Progress';
    push.statusHistory = { status: 'In Progress', at: now, byEmail: agent.email };
  }
  if (!existing.firstResponseAt) set.firstResponseAt = now;
  const ticket = await updateTicket(ticketId, { set, push, where: { assigneeEmail: null } });
  return ticket ? { ticket } : { ticket: null, reason: 'already_claimed' };
}

async function saveEmbedding(ticketId, embedding, embeddingModel) {
  // Not using updateTicket: storing an embedding shouldn't bump updatedAt.
  if (isDb()) return Ticket.updateOne({ ticketId }, { $set: { embedding, embeddingModel } });
  const ticket = mock.tickets.find((t) => t.ticketId === ticketId);
  if (ticket) Object.assign(ticket, { embedding, embeddingModel });
  return ticket;
}

async function saveDuplicates(ticketId, duplicates) {
  if (isDb()) return Ticket.updateOne({ ticketId }, { $set: { duplicates } });
  const ticket = mock.tickets.find((t) => t.ticketId === ticketId);
  if (ticket) ticket.duplicates = duplicates;
  return ticket;
}

// ---- Audit log ----
// Appends are queued one at a time so the hash chain can't fork when two
// requests log at the same moment (both would otherwise read the same
// "previous" entry).
let auditQueue = Promise.resolve();

function appendAudit(actorEmail, action, detail) {
  const run = async () => {
    if (isDb()) {
      const prev = await AuditLog.findOne().sort({ seq: -1 }).lean();
      return AuditLog.create(audit.buildEntry(prev, actorEmail, action, detail));
    }
    const entry = audit.buildEntry(mock.audit[mock.audit.length - 1], actorEmail, action, detail);
    mock.audit.push(entry);
    return entry;
  };
  const result = auditQueue.then(run);
  auditQueue = result.catch(() => {});
  return result;
}

// Newest first.
async function listAudit(limit = 200) {
  if (isDb()) return AuditLog.find().sort({ seq: -1 }).limit(limit).lean();
  return mock.audit.slice(-limit).reverse();
}

async function verifyAudit() {
  const all = isDb() ? await AuditLog.find().sort({ seq: 1 }).lean() : mock.audit;
  return audit.verifyChain(all);
}

module.exports = {
  useDatabase,
  useMockData,
  getMode,
  isDb,
  findUserByEmail,
  listUsers,
  createUser,
  checkPassword,
  listTickets,
  getTicketById,
  createTicket,
  updateTicket,
  claimTicket,
  syncTicketCounter,
  saveEmbedding,
  saveDuplicates,
  appendAudit,
  listAudit,
  verifyAudit,
};
