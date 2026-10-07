const mongoose = require('mongoose');

// In-app notifications ("Adel picked up your ticket T-1003").
const notificationSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, index: true },
  ticketId: { type: String, default: null },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Notification', notificationSchema);
