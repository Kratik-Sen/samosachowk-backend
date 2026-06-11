const mongoose = require('mongoose');

const productionSchema = mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity_planned: {
      type: Number,
      required: true,
    },
    quantity_produced: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['Planned', 'In Progress', 'Completed'],
      default: 'Planned',
    },
    assigned_to: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // Production team members
      }
    ],
    notes: String,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Production', productionSchema);
