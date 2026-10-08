const mongoose = require('mongoose');

// Saved reply that staff can insert into a comment (then edit before
// posting). Plain text, like comments.
const cannedResponseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  authorEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CannedResponse', cannedResponseSchema);
