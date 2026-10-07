const mongoose = require('mongoose');

// Atomic sequence numbers (used for ticket IDs). Counting documents
// instead would hand out the same ID twice if two tickets were created at
// once, or after a ticket was deleted.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);
