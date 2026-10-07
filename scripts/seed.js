// Loads demo users and the synthetic ticket set into MongoDB. Run with:
//   npm run seed
// Requires MONGODB_URI to be set in .env - this script is for real-DB
// mode. Mock mode (no MONGODB_URI) seeds itself in memory on server start
// and needs no script.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Ticket = require('../models/Ticket');

async function seed() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in .env - nothing to seed against.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected. Seeding...');

  // Demo users
  await User.deleteMany({});
  const demoPasswordHash = bcrypt.hashSync('password123', 10);
  await User.insertMany([
    { name: 'Erin Carter', email: 'enduser@opspilot.test', passwordHash: demoPasswordHash, role: 'end_user' },
    { name: 'Adel Haddad', email: 'agent@opspilot.test', passwordHash: demoPasswordHash, role: 'agent' },
    { name: 'Mona Saleh', email: 'manager@opspilot.test', passwordHash: demoPasswordHash, role: 'manager' },
  ]);
  console.log('Seeded 3 demo users (password: password123).');

  // Tickets
  const tickets = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/tickets.json'), 'utf8')
  );
  await Ticket.deleteMany({});
  await Ticket.insertMany(tickets);
  console.log(`Seeded ${tickets.length} tickets.`);

  await mongoose.disconnect();
  console.log('Done.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
