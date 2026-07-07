const mongoose = require('mongoose');

const missingValues = new Set(['', 'not provided']);

const normalizeProfileValue = (value) => String(value || '').trim();

const isDefaultOutletName = (storeName, ownerName) => {
  const normalizedStoreName = normalizeProfileValue(storeName).toLowerCase();
  const normalizedOwnerName = normalizeProfileValue(ownerName).toLowerCase();

  return Boolean(normalizedOwnerName && normalizedStoreName === `${normalizedOwnerName}'s outlet`);
};

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
      city: { type: String, default: '' },
      state: { type: String, default: '' },
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
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

vendorSchema.methods.getMissingProfileFields = function () {
  const location = this.location || {};
  const fields = [
    ['store_name', this.store_name],
    ['owner_name', this.owner_name],
    ['gst_number', this.gst_number],
    ['address', location.address],
  ];

  return fields
    .filter(([field, value]) => {
      if (field === 'store_name' && isDefaultOutletName(value, this.owner_name)) {
        return true;
      }

      return missingValues.has(normalizeProfileValue(value).toLowerCase());
    })
    .map(([field]) => field);
};

vendorSchema.virtual('profile_complete').get(function () {
  return this.getMissingProfileFields().length === 0;
});

vendorSchema.virtual('missing_profile_fields').get(function () {
  return this.getMissingProfileFields();
});

// Geo-spatial index for location-based queries
vendorSchema.index({ 'location.lat': 1, 'location.lng': 1 });

module.exports = mongoose.model('Vendor', vendorSchema);
