const mongoose = require('mongoose');

// Hash-chained audit log: each entry's hash covers the previous entry's
// hash, so editing or deleting an old entry breaks every hash after it.
// The hashing itself lives in lib/audit.js (shared with mock mode).
const auditLogSchema = new mongoose.Schema({
  seq: { type: Number, required: true, unique: true },
  actorEmail: { type: String, required: true },
  action: { type: String, required: true }, // e.g. 'ticket.create', 'ticket.status', 'ticket.comment'
  detail: { type: mongoose.Schema.Types.Mixed },
  prevHash: { type: String, required: true },
  hash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { minimize: false }); // keep the stored detail exactly as hashed

module.exports = mongoose.model('AuditLog', auditLogSchema);
