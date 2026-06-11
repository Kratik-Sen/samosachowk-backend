const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const User = require('../models/User');

// @route   GET /api/sales/dashboard
// @desc    Get sales dashboard metrics
// @access  Private (Sales/Admin)
router.get('/dashboard', protect, authorize('sales', 'admin'), async (req, res) => {
  try {
    const totalVendors = await User.countDocuments({ role: 'vendor' });
    const pendingVendors = await User.countDocuments({ role: 'vendor', status: 'pending' });
    const pendingOrders = await Order.countDocuments({ status: 'Pending' });
    const readyOrders = await Order.countDocuments({ status: 'Ready' });
    const activeDeliveryBoys = await User.countDocuments({
      role: 'delivery',
      status: 'active',
      availability_status: 'active',
    });

    res.json({
      totalVendors,
      pendingVendors,
      pendingOrders,
      readyOrders,
      activeDeliveryBoys,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sales/vendors
// @desc    Get all vendors for monitoring
// @access  Private (Sales/Admin)
router.get('/vendors', protect, authorize('sales', 'admin'), async (req, res) => {
  try {
    const vendors = await Vendor.find({}).populate('user', 'name email phone status');
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sales/delivery-boys
// @desc    Get active delivery boys for dispatch assignment
// @access  Private (Sales/Admin)
router.get('/delivery-boys', protect, authorize('sales', 'admin'), async (req, res) => {
  try {
    const deliveryBoys = await User.find({
      role: 'delivery',
      status: 'active',
      availability_status: 'active',
    })
      .sort('name')
      .select('name email phone status availability_status');

    res.json(deliveryBoys);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
