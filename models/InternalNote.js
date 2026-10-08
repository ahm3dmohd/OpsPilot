const mongoose = require('mongoose');

// Staff-only note on a ticket. Kept in its own collection (not inside the
// ticket like comments) so loading a ticket never brings the notes along:
// they are only read by routes that have already checked the user is staff.
const internalNoteSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, index: true },
  authorEmail: { type: String, required: true },
  authorName: { type: String, required: true },
  authorRole: { type: String },
  body: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('InternalNote', internalNoteSchema);
