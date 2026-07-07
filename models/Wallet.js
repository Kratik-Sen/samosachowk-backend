const mongoose = require('mongoose');

const walletSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    balance: {
      type: Number,
      default: 0,
    },
    reward_points: {
      type: Number,
      default: 0,
    },
    reward_order_total: {
      type: Number,
      default: 0,
    },
    reward_thresholds_awarded: {
      type: Number,
      default: 0,
    },
    reward_redemptions: [
      {
        points: { type: Number, required: true },
        status: {
          type: String,
          enum: ['pending', 'verified', 'rejected'],
          default: 'pending',
        },
        notes: String,
        reward_note: String,
        requestedAt: { type: Date, default: Date.now },
        reviewedAt: Date,
        reviewedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      },
    ],
    transactions: [
      {
        title: { type: String, required: true },
        type: {
          type: String,
          enum: ['credit', 'debit', 'reward', 'redemption'],
          required: true,
        },
        amount: { type: Number, default: 0 },
        points: { type: Number, default: 0 },
        order: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Order',
        },
        status: {
          type: String,
          enum: ['pending', 'completed', 'failed'],
          default: 'completed',
        },
        notes: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Wallet', walletSchema);
