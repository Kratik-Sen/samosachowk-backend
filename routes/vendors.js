const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const Order = require('../models/Order');
const Wallet = require('../models/Wallet');
const Delivery = require('../models/Delivery');
const { emitResourceChanged, emitVendorLocation } = require('../realtime');

const ACTIVE_ORDER_STATUSES = ['Pending', 'Verified', 'In Production', 'Ready', 'Out for Delivery'];

const requiredProfileFields = ['name', 'email', 'phone', 'store_name', 'address', 'gst_number'];

const cleanText = (value) => String(value || '').trim();

const normalizeProfilePayload = (body) => {
  const location = body?.location && typeof body.location === 'object' ? body.location : {};

  return {
    name: cleanText(body?.name),
    email: cleanText(body?.email).toLowerCase(),
    phone: cleanText(body?.phone),
    store_name: cleanText(body?.store_name),
    owner_name: cleanText(body?.owner_name || body?.name),
    gst_number: cleanText(body?.gst_number),
    location: {
      address: cleanText(location.address),
      city: cleanText(location.city),
      state: cleanText(location.state),
      zip: cleanText(location.zip),
      lat: location.lat === '' || location.lat === undefined ? undefined : Number(location.lat),
      lng: location.lng === '' || location.lng === undefined ? undefined : Number(location.lng),
    },
  };
};

const getMissingRequiredProfileFields = (profile) =>
  requiredProfileFields.filter((field) => {
    if (field === 'address' || field === 'city' || field === 'state' || field === 'zip') {
      return !cleanText(profile.location?.[field]);
    }

    return !cleanText(profile[field]);
  });

const normalizeLocationPayload = (body) => {
  const source = body?.location && typeof body.location === 'object' ? body.location : body;
  const lat = Number(source?.lat);
  const lng = Number(source?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return {
    location: source.location || source.address || 'Current location',
    lat,
    lng,
  };
};

// @route   POST /api/vendors/register
// @desc    Register vendor profile (Step 2 after user auth registration)
// @access  Private (Vendor)
router.post('/register', protect, authorize('vendor'), async (req, res) => {
  try {
    const { store_name, owner_name, gst_number, location } = req.body;

    const existingVendor = await Vendor.findOne({ user: req.user.id });
    if (existingVendor) {
      return res.status(400).json({ message: 'Vendor profile already exists' });
    }

    const referral_code = store_name.substring(0, 4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);

    const vendor = await Vendor.create({
      user: req.user.id,
      store_name,
      owner_name,
      gst_number,
      location,
      referral_code,
    });

    res.status(201).json(vendor);
    emitResourceChanged(req, {
      domains: ['vendors', 'users', 'admin', 'sales'],
      action: 'registered',
      entity: 'vendor',
      entityId: vendor._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/vendors/dashboard
// @desc    Get vendor dashboard stats
// @access  Private (Vendor/Customer)
router.get('/dashboard', protect, authorize('vendor', 'customer'), async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id, status: { $in: ACTIVE_ORDER_STATUSES } })
      .sort('-createdAt')
      .limit(5)
      .populate('items.product', 'name category image price status packages reward_coins');
    const wallet = await Wallet.findOne({ user: req.user.id });
    
    // Calculate total spent
    const allOrders = await Order.find({ user: req.user.id });
    const totalSpent = allOrders
      .filter((order) => order.payment_status === 'completed')
      .reduce((acc, curr) => acc + curr.final_amount, 0);
    const pendingOrders = allOrders.filter((order) => ['Pending', 'Verified', 'In Production', 'Ready', 'Out for Delivery'].includes(order.status)).length;

    res.json({
      recentOrders: orders,
      totalOrders: allOrders.length,
      totalSpent,
      pendingOrders,
      walletBalance: wallet?.balance || 0,
      rewardPoints: wallet?.reward_points || 0,
      transactions: wallet?.transactions || [],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/vendors/orders
// @desc    Get all vendor orders
// @access  Private (Vendor/Customer)
router.get('/orders', protect, authorize('vendor', 'customer'), async (req, res) => {
  try {
    const filter = { user: req.user.id };

    if (req.query.scope === 'active') {
      filter.status = { $in: ACTIVE_ORDER_STATUSES };
    }

    const orders = await Order.find(filter)
      .sort('-createdAt')
      .populate('items.product', 'name category image price status packages reward_coins')
      .populate('delivery_boy', 'name phone status');
    const deliveries = await Delivery.find({ order: { $in: orders.map((order) => order._id) } });
    const deliveryByOrder = deliveries.reduce((acc, delivery) => {
      acc[delivery.order.toString()] = delivery.toObject();
      return acc;
    }, {});

    res.json(
      orders.map((order) => ({
        ...order.toObject(),
        delivery: deliveryByOrder[order._id.toString()],
      }))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/vendors/orders/:id/location
// @desc    Update vendor current location for an active order
// @access  Private (Vendor/Customer)
router.put('/orders/:id/location', protect, authorize('vendor', 'customer'), async (req, res) => {
  try {
    const nextLocation = normalizeLocationPayload(req.body);

    if (!nextLocation) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }

    const order = await Order.findOne({ _id: req.params.id, user: req.user.id });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (['Delivered', 'Cancelled'].includes(order.status)) {
      return res.status(400).json({ message: 'Completed orders cannot update vendor location' });
    }

    order.delivery_address = nextLocation;
    await order.save();

    const delivery = await Delivery.findOne({ order: order._id }).populate('order', 'user delivery_address status');
    emitVendorLocation(req, delivery);

    res.json(nextLocation);
    emitResourceChanged(req, {
      domains: ['vendors', 'orders', 'deliveries', 'sales', 'production', 'admin'],
      action: 'vendor-location-updated',
      entity: 'order',
      entityId: order._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/vendors/profile
// @desc    Get vendor outlet profile
// @access  Private (Vendor)
router.get('/profile', protect, authorize('vendor'), async (req, res) => {
  try {
    const vendor = await Vendor.findOne({ user: req.user.id }).populate('user', 'name email phone status');
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/vendors/profile
// @desc    Let a vendor complete or update their own outlet profile
// @access  Private (Vendor)
router.put('/profile', protect, authorize('vendor'), async (req, res) => {
  try {
    const profile = normalizeProfilePayload(req.body);
    const missingFields = getMissingRequiredProfileFields(profile);

    if (missingFields.length) {
      return res.status(400).json({
        message: 'Complete all vendor profile details.',
        missingFields,
      });
    }

    if (
      profile.location.lat !== undefined &&
      (!Number.isFinite(profile.location.lat) || Math.abs(profile.location.lat) > 90)
    ) {
      return res.status(400).json({ message: 'Valid latitude is required when location latitude is provided' });
    }

    if (
      profile.location.lng !== undefined &&
      (!Number.isFinite(profile.location.lng) || Math.abs(profile.location.lng) > 180)
    ) {
      return res.status(400).json({ message: 'Valid longitude is required when location longitude is provided' });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Vendor user not found' });
    }

    const vendor = await Vendor.findOne({ user: req.user.id });

    if (!vendor) {
      return res.status(404).json({ message: 'Vendor outlet profile not found. Verify the account again or contact admin.' });
    }

    user.name = profile.name;
    user.phone = profile.phone;

    if (profile.email && profile.email !== user.email) {
      const duplicate = await User.findOne({ email: profile.email, _id: { $ne: user._id } });

      if (duplicate) {
        return res.status(400).json({ message: 'This email is already registered' });
      }

      user.email = profile.email;
    }

    await user.save();

    vendor.store_name = profile.store_name;
    vendor.owner_name = profile.owner_name;
    vendor.gst_number = profile.gst_number;
    vendor.location = profile.location;
    await vendor.save();

    const updatedVendor = await Vendor.findOne({ user: req.user.id }).populate('user', 'name email phone status');

    res.json(updatedVendor);
    emitResourceChanged(req, {
      domains: ['vendors', 'users', 'admin', 'sales'],
      action: 'profile-updated',
      entity: 'vendor',
      entityId: vendor._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
