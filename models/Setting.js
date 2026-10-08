const mongoose = require('mongoose');

// App settings changed by admins at runtime (e.g. the live duplicate
// thresholds). One document per key; see lib/settings.js.
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  updatedByEmail: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Setting', settingSchema);
