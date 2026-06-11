const mongoose = require('mongoose');

const vendorSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    store_name: {
      type: String,
      required: true,
    },
    owner_name: {
      type: String,
      required: true,
    },
    gst_number: {
      type: String,
    },
    location: {
      address: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      zip: { type: String },
      lat: { type: Number },
      lng: { type: Number },
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', // Admin or Sales Team who approved
    },
    referral_code: {
      type: String,
      unique: true,
    },
    auto_approved: {
      type: Boolean,
      default: true,
    },
    reward_points: {
      type: Number,
      default: 0,
    },
    wallet_balance: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Geo-spatial index for location-based queries
vendorSchema.index({ 'location.lat': 1, 'location.lng': 1 });

module.exports = mongoose.model('Vendor', vendorSchema);
