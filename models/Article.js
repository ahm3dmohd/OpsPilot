const mongoose = require('mongoose');

// Knowledge-base article. views / helpful / notHelpful are the usage data
// the report can use to judge which self-service content works.
const articleSchema = new mongoose.Schema({
  articleId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  category: { type: String, default: 'General' },
  views: { type: Number, default: 0 },
  helpful: { type: Number, default: 0 },
  notHelpful: { type: Number, default: 0 },
  authorEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Article', articleSchema);
