const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const Wallet = require('../models/Wallet');
const Delivery = require('../models/Delivery');
const { emitResourceChanged, emitVendorLocation } = require('../realtime');

const ACTIVE_ORDER_STATUSES = ['Pending', 'Verified', 'In Production', 'Ready', 'Out for Delivery'];

const formatCoordinate = (value) => Number(value).toFixed(5);

const normalizeLocationPayload = (body) => {
  const source = body?.location && typeof body.location === 'object' ? body.location : body;
  const lat = Number(source?.lat);
  const lng = Number(source?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return {
    location: source.location || source.address || `Current location (${formatCoordinate(lat)}, ${formatCoordinate(lng)})`,
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
// @access  Private (Vendor)
router.get('/dashboard', protect, authorize('vendor'), async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id, status: { $in: ACTIVE_ORDER_STATUSES } })
      .sort('-createdAt')
      .limit(5);
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
// @access  Private (Vendor)
router.get('/orders', protect, authorize('vendor'), async (req, res) => {
  try {
    const filter = { user: req.user.id };

    if (req.query.scope === 'active') {
      filter.status = { $in: ACTIVE_ORDER_STATUSES };
    }

    const orders = await Order.find(filter)
      .sort('-createdAt')
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
// @access  Private (Vendor)
router.put('/orders/:id/location', protect, authorize('vendor'), async (req, res) => {
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
      domains: ['vendors', 'orders', 'deliveries', 'sales', 'admin'],
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

module.exports = router;
