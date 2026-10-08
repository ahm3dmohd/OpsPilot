const mongoose = require('mongoose');

// One agent decision on a suggested duplicate pair: the data for measuring
// how often each method's suggestions turn out to be real duplicates.
// pairKey is the two ticket IDs sorted ("T-1001|T-1023"), unique, so a pair
// can only be decided once - two agents clicking at the same moment can't
// both record a decision.
const duplicateDecisionSchema = new mongoose.Schema({
  pairKey: { type: String, required: true, unique: true },
  ticketId: { type: String, required: true }, // the ticket the suggestion was shown on
  candidateId: { type: String, required: true }, // the suggested ticket
  decision: { type: String, enum: ['confirmed', 'rejected'], required: true },
  // Which method(s) suggested the pair, with their scores at the time
  // (null = that method did not flag it) and the thresholds in force.
  flaggedBy: { type: String, enum: ['ai', 'baseline', 'both'], required: true },
  aiScore: { type: Number, default: null },
  baselineScore: { type: Number, default: null },
  aiThreshold: { type: Number, default: null },
  baselineThreshold: { type: Number, default: null },
  aiModel: { type: String, default: null },
  // Confirmed pairs only: the older ticket stays open, the newer is merged.
  primaryId: { type: String, default: null },
  mergedId: { type: String, default: null },
  byEmail: { type: String, required: true },
  byName: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('DuplicateDecision', duplicateDecisionSchema);
