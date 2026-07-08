const mongoose = require('mongoose');

const pushTokenSchema = mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    user_id: {
      type: String,
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['customer', 'vendor', 'sales', 'production', 'delivery', 'admin'],
      required: true,
      index: true,
    },
    platform: {
      type: String,
      default: '',
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    last_registered_at: {
      type: Date,
      default: Date.now,
    },
    last_sent_at: Date,
    last_error: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('PushToken', pushTokenSchema);
