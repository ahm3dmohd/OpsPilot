// Makes an existing user an admin, for databases created before the admin
// role existed (the seed includes admin@opspilot.test, but a seed WIPES
// the database). The user must already exist; this never creates one.
//
//   npm run make-admin -- someone@example.com
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function main() {
  const email = String(process.argv[2] || '').toLowerCase().trim();
  if (!email) throw new Error('Usage: npm run make-admin -- <email>');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const user = await User.findOneAndUpdate({ email }, { $set: { role: 'admin' } }, { new: true }).lean();
  await mongoose.disconnect();
  if (!user) throw new Error(`No user with email ${email}. Register first, then run this again.`);
  console.log(`${user.name} <${user.email}> is now an admin.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
