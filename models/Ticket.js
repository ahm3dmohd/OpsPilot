const mongoose = require('mongoose');

const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

const commentSchema = new mongoose.Schema(
  {
    authorEmail: { type: String, required: true },
    authorName: { type: String, required: true },
    body: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ticketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, default: 'General' },
  priority: { type: String, enum: PRIORITIES, default: 'Medium' },
  status: { type: String, enum: STATUSES, default: 'Open' },
  requesterEmail: { type: String, required: true },
  requesterName: { type: String, required: true },
  assigneeEmail: { type: String, default: null },
  assigneeName: { type: String, default: null },
  comments: { type: [commentSchema], default: [] },
  embedding: { type: [Number], default: [] }, // filled in once Week 3 embeds it
  similarTicketIds: { type: [String], default: [] }, // flagged by Week 3's detection
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ticketSchema.statics.STATUSES = STATUSES;
ticketSchema.statics.PRIORITIES = PRIORITIES;

module.exports = mongoose.model('Ticket', ticketSchema);
