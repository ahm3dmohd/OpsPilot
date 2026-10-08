const mongoose = require('mongoose');

// One step of a Service Request's approval chain - the full audit trail:
// who had to approve, what they decided, their comment and when. Steps
// that were skipped are stored too, with the reason (see lib/approvals.js).
//
// status: waiting (not reached yet) -> pending (the approver can act) ->
// approved | rejected; or skipped.
const approvalStepSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, index: true },
  order: { type: Number, required: true }, // 1, 2, 3
  kind: { type: String, enum: ['line_manager', 'requester_head', 'target_head'], required: true },
  department: { type: String, default: null }, // for head steps: whose head
  approverEmail: { type: String, default: null, index: true }, // null = unassigned, an admin must choose
  status: { type: String, enum: ['waiting', 'pending', 'approved', 'rejected', 'skipped'], default: 'waiting' },
  comment: { type: String, default: null }, // approval comment, rejection reason or why it was skipped
  decidedByEmail: { type: String, default: null },
  decidedAt: { type: Date, default: null },
  // Admin reassignments: { at, byEmail, from, to }.
  reassignments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ApprovalStep', approvalStepSchema);
