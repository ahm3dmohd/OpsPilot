const mongoose = require('mongoose');
const crypto = require('crypto');

// Hash-chained audit log: each entry's hash includes the previous
// entry's hash, so tampering with an old entry breaks every hash after it.
const auditLogSchema = new mongoose.Schema({
  actorEmail: { type: String, required: true },
  action: { type: String, required: true }, // e.g. 'ticket.create', 'ticket.status', 'ticket.comment'
  detail: { type: mongoose.Schema.Types.Mixed },
  prevHash: { type: String, required: true },
  hash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

auditLogSchema.statics.append = async function (actorEmail, action, detail) {
  const last = await this.findOne().sort({ createdAt: -1 });
  const prevHash = last ? last.hash : '0'.repeat(64);
  const payload = JSON.stringify({ actorEmail, action, detail, prevHash });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return this.create({ actorEmail, action, detail, prevHash, hash });
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
