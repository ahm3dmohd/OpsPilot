// Loads demo users and the synthetic ticket set into MongoDB. Run with:
//   npm run seed
// Requires MONGODB_URI to be set in .env - this script is for real-DB
// mode. Mock mode (no MONGODB_URI) seeds itself in memory on server start
// and needs no script.
//
// WARNING: wipes the existing users, tickets, counters and audit log first.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Ticket = require('../models/Ticket');
const Counter = require('../models/Counter');
const AuditLog = require('../models/AuditLog');
const { demoUsers, seedTickets, DEMO_PASSWORD } = require('../lib/seedData');

async function seed() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in .env - nothing to seed against.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('Connected. Seeding...');

  const users = demoUsers();
  await User.deleteMany({});
  await User.insertMany(users);
  console.log(`Seeded ${users.length} demo users (password: ${DEMO_PASSWORD}).`);

  const tickets = seedTickets();
  await Ticket.deleteMany({});
  await Ticket.insertMany(tickets);
  await Counter.deleteMany({});
  await Counter.create({ _id: 'ticket', seq: tickets.length });
  await AuditLog.deleteMany({});
  console.log(`Seeded ${tickets.length} tickets. Embeddings and duplicate checks run when the server starts.`);

  await mongoose.disconnect();
  console.log('Done.');
}

seed().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
