const mongoose = require('mongoose');

// A department tickets can be routed to. `code` is the short ID stored on
// tickets and users (e.g. "IT", "FIN"); headEmail is the department head,
// who approves Service Requests (see lib/approvals.js).
const departmentSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  headEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Department', departmentSchema);
