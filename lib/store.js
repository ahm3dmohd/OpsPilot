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
const Notification = require('../models/Notification');
const Article = require('../models/Article');
const InternalNote = require('../models/InternalNote');
const { demoUsers, seedTickets, seedArticles } = require('./seedData');
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
  if (mock.articles.length === 0) {
    mock.articles = seedArticles();
    mock.nextArticleNum = mock.articles.length + 1;
  }
}

function getMode() {
  return mode;
}

function isDb() {
  return mode === 'db';
}

// ---- Mock store (in-memory) ----
// Every mock read/write returns a deep COPY, never the stored object -
// the same as MongoDB, which always hands back fresh objects. Without
// this, a route holding the "before" version of a ticket would see it
// change underneath it when the ticket is updated (e.g. a status change
// logged as "from Resolved to Resolved").
const copy = (x) => (x == null ? null : structuredClone(x));

const mock = {
  users: [],
  tickets: [],
  audit: [],
  notifications: [],
  articles: [],
  notes: [],
  nextTicketNum: FIRST_TICKET_NUMBER,
  nextArticleNum: 1,
  nextNotificationId: 1,
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
  return copy(mock.users.find((u) => u.email === normalized));
}

async function listUsers(filter = {}) {
  if (isDb()) return User.find(filter).sort({ name: 1 }).lean();
  return copy(mock.users.filter((u) => matchesFilter(u, filter)));
}

async function createUser({ name, email, password, role }) {
  const user = { name, email: normalizeEmail(email), passwordHash: bcrypt.hashSync(password, 10), role };
  if (isDb()) return (await User.create(user)).toObject();
  mock.users.push(user);
  return copy(user);
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
  return copy(mock.tickets.filter((t) => matchesFilter(t, filter)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function getTicketById(ticketId) {
  if (isDb()) return Ticket.findOne({ ticketId }).lean();
  return copy(mock.tickets.find((t) => t.ticketId === ticketId));
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

// Makes sure the DB counters are past every existing ID (e.g. after
// seeding, or a database created before counters existed).
async function syncCounters() {
  if (!isDb()) return;
  const tickets = await Ticket.find({}, { ticketId: 1 }).lean();
  const highest = tickets.reduce((max, t) => Math.max(max, parseInt(t.ticketId.slice(2), 10) || 0), 0);
  const minSeq = Math.max(0, highest - (FIRST_TICKET_NUMBER - 1));
  await Counter.updateOne({ _id: 'ticket' }, { $max: { seq: minSeq } }, { upsert: true });
  const articles = await Article.find({}, { articleId: 1 }).lean();
  const highestArticle = articles.reduce((max, a) => Math.max(max, parseInt(a.articleId.slice(3), 10) || 0), 0);
  await Counter.updateOne({ _id: 'article' }, { $max: { seq: highestArticle } }, { upsert: true });
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
  mock.tickets.unshift(copy(ticket));
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
  Object.assign(ticket, copy(set), { updatedAt: now });
  Object.entries(push).forEach(([key, value]) => {
    ticket[key] = [...(ticket[key] || []), copy(value)];
  });
  return copy(ticket);
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
  if (ticket) Object.assign(ticket, { embedding: copy(embedding), embeddingModel });
  return copy(ticket);
}

async function saveDuplicates(ticketId, duplicates) {
  if (isDb()) return Ticket.updateOne({ ticketId }, { $set: { duplicates } });
  const ticket = mock.tickets.find((t) => t.ticketId === ticketId);
  if (ticket) ticket.duplicates = copy(duplicates);
  return copy(ticket);
}

// ---- Internal notes (staff only) ----
// Callers must check the user is staff BEFORE calling these: the store
// has no idea who is asking.
async function addInternalNote({ ticketId, authorEmail, authorName, authorRole, body }) {
  const note = { ticketId: String(ticketId), authorEmail, authorName, authorRole, body: String(body), createdAt: new Date() };
  if (isDb()) return (await InternalNote.create(note)).toObject();
  mock.notes.push(copy(note));
  return note;
}

// Oldest first, like comments.
async function listInternalNotes(ticketId) {
  if (isDb()) return InternalNote.find({ ticketId: String(ticketId) }).sort({ createdAt: 1 }).lean();
  return copy(mock.notes.filter((n) => n.ticketId === String(ticketId)));
}

// ---- Notifications ----
async function createNotifications(list) {
  if (list.length === 0) return;
  const now = new Date();
  const docs = list.map((n) => ({ ...n, read: false, createdAt: now }));
  if (isDb()) {
    await Notification.insertMany(docs);
    return;
  }
  docs.forEach((d) => mock.notifications.push({ ...copy(d), id: String(mock.nextNotificationId++) }));
}

// Newest first. Returned objects always carry a string `id`.
async function listNotifications(userEmail, limit = 50) {
  if (isDb()) {
    const rows = await Notification.find({ userEmail }).sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map((r) => ({ ...r, id: String(r._id) }));
  }
  return copy(mock.notifications.filter((n) => n.userEmail === userEmail).reverse().slice(0, limit));
}

async function countUnreadNotifications(userEmail) {
  if (isDb()) return Notification.countDocuments({ userEmail, read: false });
  return mock.notifications.filter((n) => n.userEmail === userEmail && !n.read).length;
}

// Marks one notification read - only if it belongs to userEmail, so nobody
// can open someone else's. Returns it, or null.
async function markNotificationRead(id, userEmail) {
  if (isDb()) {
    if (!/^[a-f0-9]{24}$/.test(id)) return null;
    const row = await Notification.findOneAndUpdate({ _id: id, userEmail }, { $set: { read: true } }, { new: true }).lean();
    return row ? { ...row, id: String(row._id) } : null;
  }
  const n = mock.notifications.find((x) => x.id === id && x.userEmail === userEmail);
  if (n) n.read = true;
  return copy(n);
}

async function markAllNotificationsRead(userEmail) {
  if (isDb()) return Notification.updateMany({ userEmail, read: false }, { $set: { read: true } });
  mock.notifications.forEach((n) => {
    if (n.userEmail === userEmail) n.read = true;
  });
}

// ---- Knowledge base ----
async function listArticles() {
  if (isDb()) return Article.find().sort({ articleId: 1 }).lean();
  return copy(mock.articles).sort((a, b) => a.articleId.localeCompare(b.articleId));
}

async function getArticle(articleId) {
  if (isDb()) return Article.findOne({ articleId }).lean();
  return copy(mock.articles.find((a) => a.articleId === articleId));
}

async function createArticle({ title, body, category, authorEmail }) {
  const now = new Date();
  let num;
  if (isDb()) {
    const counter = await Counter.findOneAndUpdate({ _id: 'article' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    num = counter.seq;
  } else {
    num = mock.nextArticleNum++;
  }
  const article = {
    articleId: `KB-${String(num).padStart(2, '0')}`,
    title,
    body,
    category,
    views: 0,
    helpful: 0,
    notHelpful: 0,
    authorEmail,
    createdAt: now,
    updatedAt: now,
  };
  if (isDb()) return (await Article.create(article)).toObject();
  mock.articles.push(article);
  return copy(article);
}

async function updateArticle(articleId, { title, body, category }) {
  const set = { title, body, category, updatedAt: new Date() };
  if (isDb()) return Article.findOneAndUpdate({ articleId }, { $set: set }, { new: true }).lean();
  const a = mock.articles.find((x) => x.articleId === articleId);
  if (a) Object.assign(a, set);
  return copy(a);
}

async function deleteArticle(articleId) {
  if (isDb()) return (await Article.deleteOne({ articleId })).deletedCount > 0;
  const before = mock.articles.length;
  mock.articles = mock.articles.filter((a) => a.articleId !== articleId);
  return mock.articles.length < before;
}

// field: 'views' | 'helpful' | 'notHelpful'
async function incrementArticle(articleId, field) {
  if (!['views', 'helpful', 'notHelpful'].includes(field)) return null;
  if (isDb()) return Article.findOneAndUpdate({ articleId }, { $inc: { [field]: 1 } }, { new: true }).lean();
  const a = mock.articles.find((x) => x.articleId === articleId);
  if (a) a[field] += 1;
  return copy(a);
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
    return copy(entry);
  };
  const result = auditQueue.then(run);
  auditQueue = result.catch(() => {});
  return result;
}

// Newest first.
async function listAudit(limit = 200) {
  if (isDb()) return AuditLog.find().sort({ seq: -1 }).limit(limit).lean();
  return copy(mock.audit.slice(-limit).reverse());
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
  syncCounters,
  saveEmbedding,
  saveDuplicates,
  addInternalNote,
  listInternalNotes,
  createNotifications,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
  incrementArticle,
  appendAudit,
  listAudit,
  verifyAudit,
};
