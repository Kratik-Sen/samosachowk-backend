const mongoose = require('mongoose');

const orderSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false, // guest checkout support
    },
    customer_name: { type: String, required: true },
    customer_phone: { type: String, required: true },
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        selectedPack: { type: String },
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product',
        },
      },
    ],
    total_amount: { type: Number, required: true },
    discount_amount: { type: Number, default: 0 },
    gst_rate: { type: Number, default: 0 },
    gst_amount: { type: Number, default: 0 },
    final_amount: { type: Number, required: true },
    order_type: {
      type: String,
      enum: ['Regular', 'Bulk'],
      default: 'Regular',
    },
    bulk_note: String,
    payment_method: {
      type: String,
      enum: ['COD', 'UPI', 'CARD', 'RAZORPAY'],
      required: true,
    },
    payment_status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
    },
    payment_id: String,
    razorpay_order_id: String,
    razorpay_signature: String,
    delivery_mode: {
      type: String,
      enum: ['Delivery', 'Pickup'],
      required: true,
    },
    status: {
      type: String,
      enum: [
        'Pending',        // Initial state
        'Verified',       // Sales team verified
        'In Production',  // Production team picked up
        'Ready',          // Production finished
        'Out for Delivery',// Delivery assigned
        'Delivered',      // Complete
        'Cancelled'
      ],
      default: 'Pending',
    },
    delivery_boy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    delivery_assigned_at: Date,
    delivery_address: {
      location: String,
      lat: Number,
      lng: Number,
    },
    status_updates: [
      {
        status: String,
        note: String,
        updated_by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        updated_at: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Order', orderSchema);
