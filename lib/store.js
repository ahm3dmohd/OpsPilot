// Unified data access layer: every route calls these functions instead of
// touching Mongoose or the mock arrays directly. When MongoDB is connected,
// everything goes through the real models. When it isn't, the exact same
// functions operate on in-memory arrays seeded with demo users and sample
// tickets - so the whole app (including login) works with zero setup.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Ticket = require('../models/Ticket');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

// ---- Mock store (in-memory) ----
const mock = {
  users: [],
  tickets: [],
  nextTicketNum: 1001,
};

function seedMockUsers() {
  const demoPassword = 'password123';
  const hash = bcrypt.hashSync(demoPassword, 10);
  mock.users = [
    { name: 'Erin Carter', email: 'enduser@opspilot.test', passwordHash: hash, role: 'end_user' },
    { name: 'Adel Haddad', email: 'agent@opspilot.test', passwordHash: hash, role: 'agent' },
    { name: 'Mona Saleh', email: 'manager@opspilot.test', passwordHash: hash, role: 'manager' },
  ];
}

function seedMockTickets() {
  const file = path.join(__dirname, '../data/tickets.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  mock.tickets = raw.map((t) => ({
    ...t,
    comments: [],
    embedding: [],
    similarTicketIds: [],
    assigneeEmail: null,
    assigneeName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  mock.nextTicketNum = 1001 + mock.tickets.length;
}

function initMockData() {
  if (mock.users.length === 0) seedMockUsers();
  if (mock.tickets.length === 0) seedMockTickets();
}

function nextMockTicketId() {
  const id = `T-${mock.nextTicketNum}`;
  mock.nextTicketNum += 1;
  return id;
}

// ---- Users ----
async function findUserByEmail(email) {
  const normalized = (email || '').toLowerCase().trim();
  if (isDbConnected()) {
    return User.findOne({ email: normalized });
  }
  return mock.users.find((u) => u.email === normalized) || null;
}

async function createUser({ name, email, password, role }) {
  const passwordHash = bcrypt.hashSync(password, 10);
  const normalized = email.toLowerCase().trim();
  if (isDbConnected()) {
    return User.create({ name, email: normalized, passwordHash, role });
  }
  const user = { name, email: normalized, passwordHash, role };
  mock.users.push(user);
  return user;
}

async function checkPassword(user, password) {
  return bcrypt.compare(password, user.passwordHash);
}

// ---- Tickets ----
async function listTickets(filter = {}) {
  if (isDbConnected()) {
    return Ticket.find(filter).sort({ createdAt: -1 });
  }
  let results = mock.tickets;
  if (filter.requesterEmail) results = results.filter((t) => t.requesterEmail === filter.requesterEmail);
  if (filter.status) results = results.filter((t) => t.status === filter.status);
  if (filter.assigneeEmail) results = results.filter((t) => t.assigneeEmail === filter.assigneeEmail);
  return [...results].sort((a, b) => b.createdAt - a.createdAt);
}

async function getTicketById(ticketId) {
  if (isDbConnected()) {
    return Ticket.findOne({ ticketId });
  }
  return mock.tickets.find((t) => t.ticketId === ticketId) || null;
}

async function createTicket({ title, description, category, priority, requesterEmail, requesterName }) {
  const base = {
    title,
    description,
    category: category || 'General',
    priority: priority || 'Medium',
    status: 'Open',
    requesterEmail,
    requesterName,
    assigneeEmail: null,
    assigneeName: null,
    comments: [],
    embedding: [],
    similarTicketIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (isDbConnected()) {
    const count = await Ticket.countDocuments();
    base.ticketId = `T-${1001 + count}`;
    return Ticket.create(base);
  }
  base.ticketId = nextMockTicketId();
  mock.tickets.unshift(base);
  return base;
}

async function updateTicket(ticketId, updates) {
  if (isDbConnected()) {
    return Ticket.findOneAndUpdate(
      { ticketId },
      { ...updates, updatedAt: new Date() },
      { new: true }
    );
  }
  const ticket = mock.tickets.find((t) => t.ticketId === ticketId);
  if (!ticket) return null;
  Object.assign(ticket, updates, { updatedAt: new Date() });
  return ticket;
}

async function addComment(ticketId, comment) {
  const entry = { ...comment, createdAt: new Date() };
  if (isDbConnected()) {
    return Ticket.findOneAndUpdate(
      { ticketId },
      { $push: { comments: entry }, $set: { updatedAt: new Date() } },
      { new: true }
    );
  }
  const ticket = mock.tickets.find((t) => t.ticketId === ticketId);
  if (!ticket) return null;
  ticket.comments.push(entry);
  ticket.updatedAt = new Date();
  return ticket;
}

module.exports = {
  isDbConnected,
  initMockData,
  findUserByEmail,
  createUser,
  checkPassword,
  listTickets,
  getTicketById,
  createTicket,
  updateTicket,
  addComment,
};
