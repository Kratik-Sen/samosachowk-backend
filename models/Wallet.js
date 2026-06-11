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
