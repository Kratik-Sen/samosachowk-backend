const mongoose = require('mongoose');

const deliverySchema = mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    delivery_boy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['Assigned', 'Picked Up', 'In Transit', 'Delivered', 'Failed', 'Rejected'],
      default: 'Assigned',
    },
    payment_collected: {
      type: Boolean,
      default: false,
    },
    amount_collected: {
      type: Number,
      default: 0,
    },
    notes: String,
    current_location: {
      lat: Number,
      lng: Number,
      updated_at: Date
    }
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Delivery', deliverySchema);
