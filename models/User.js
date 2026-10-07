const mongoose = require('mongoose');

const ROLES = ['end_user', 'agent', 'manager'];

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true, default: 'end_user' },
  createdAt: { type: Date, default: Date.now },
});

userSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('User', userSchema);
