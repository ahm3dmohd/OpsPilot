const mongoose = require('mongoose');
const { STATUSES, PRIORITIES, TICKET_TYPES } = require('../lib/constants');

const commentSchema = new mongoose.Schema(
  {
    authorEmail: { type: String, required: true },
    authorName: { type: String, required: true },
    authorRole: { type: String },
    body: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: STATUSES, required: true },
    at: { type: Date, default: Date.now },
    byEmail: { type: String },
    reason: { type: String }, // e.g. "Merged into T-1001"
  },
  { _id: false }
);

const ticketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  type: { type: String, enum: TICKET_TYPES, default: 'incident' },
  // Service requests only: why it's needed (for the approvers) and an
  // optional date it's needed by.
  justification: { type: String, default: null },
  neededBy: { type: Date, default: null },
  category: { type: String, default: 'General' },
  department: { type: String, default: 'IT' }, // department code the ticket is routed to
  priority: { type: String, enum: PRIORITIES, default: 'Medium' },
  status: { type: String, enum: STATUSES, default: 'Open' },
  requesterEmail: { type: String, required: true },
  requesterName: { type: String, required: true },
  assigneeEmail: { type: String, default: null },
  assigneeName: { type: String, default: null },
  comments: { type: [commentSchema], default: [] },
  // Every status change with its timestamp - drives time-in-status and SLA.
  statusHistory: { type: [statusHistorySchema], default: [] },
  firstResponseAt: { type: Date, default: null }, // first claim/comment/status change by staff
  resolvedAt: { type: Date, default: null },
  // AI duplicate detection: the ticket's own embedding (and which model
  // produced it, so vectors from different models are never compared)...
  embedding: { type: [Number], default: [] },
  embeddingModel: { type: String, default: null },
  // ...and the stored results of BOTH methods, kept side by side:
  // { ai: {...}, baseline: {...} } - see lib/duplicates.js for the shape.
  duplicates: { type: mongoose.Schema.Types.Mixed, default: null },
  // What auto-categorization suggested at creation, kept so the report can
  // measure how often users accepted it.
  categorySuggestion: { type: mongoose.Schema.Types.Mixed, default: null },
  // Set when an agent confirmed this ticket as a duplicate of an older one:
  // it is closed and points at the ticket that carries on (see
  // lib/duplicateDecisions.js). Nothing on it is deleted.
  mergedInto: { type: String, default: null },
  mergedAt: { type: Date, default: null },
  mergedByEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Ticket', ticketSchema);
