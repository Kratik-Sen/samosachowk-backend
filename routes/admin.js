const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Wallet = require('../models/Wallet');
const Delivery = require('../models/Delivery');
const { protect, authorize } = require('../middleware/auth');
const { emitResourceChanged } = require('../realtime');

const adminOnly = [protect, authorize('admin')];
const manageableRoles = ['vendor', 'sales', 'production', 'delivery'];
const allRoles = [...manageableRoles, 'admin'];

const publicUserFields = '-password';

const serializePublicUser = (user) => {
  const data = user.toObject ? user.toObject() : { ...user };
  const passwordResetRequested = Boolean(
    data.resetPasswordRequestedAt || data.resetPasswordToken || data.resetPasswordExpire
  );

  delete data.password;
  delete data.resetPasswordToken;
  delete data.resetPasswordExpire;

  return {
    ...data,
    passwordResetRequested,
  };
};

const getTeamCounts = async () => {
  const counts = await User.aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ]);

  return allRoles.reduce((acc, role) => {
    if (role === 'admin') {
      acc.admin = process.env.ADMIN_EMAIL ? 1 : 0;
      return acc;
    }

    acc[role] = counts.find((item) => item._id === role)?.count || 0;
    return acc;
  }, {});
};

const getOrderStats = async () => {
  const [summary] = await Order.aggregate([
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        revenue: { $sum: '$final_amount' },
        paidRevenue: {
          $sum: {
            $cond: [{ $eq: ['$payment_status', 'completed'] }, '$final_amount', 0],
          },
        },
        pendingPayments: {
          $sum: {
            $cond: [{ $ne: ['$payment_status', 'completed'] }, '$final_amount', 0],
          },
        },
      },
    },
  ]);

  return summary || {
    totalOrders: 0,
    revenue: 0,
    paidRevenue: 0,
    pendingPayments: 0,
  };
};

// @route   GET /api/admin/overview
// @desc    Complete business overview for web/mobile admin panel
// @access  Private (Admin)
router.get('/overview', ...adminOnly, async (req, res) => {
  try {
    const [
      teamCounts,
      orderStats,
      vendorCount,
      productCount,
      activeProducts,
      activeDeliveries,
      walletStats,
      recentOrders,
      recentUsers,
    ] = await Promise.all([
      getTeamCounts(),
      getOrderStats(),
      Vendor.countDocuments(),
      Product.countDocuments(),
      Product.countDocuments({ status: 'Active' }),
      Delivery.countDocuments({ status: { $in: ['Assigned', 'Picked Up', 'In Transit'] } }),
      Wallet.aggregate([
        {
          $group: {
            _id: null,
            walletBalance: { $sum: '$balance' },
            rewardPoints: { $sum: '$reward_points' },
          },
        },
      ]),
      Order.find({}).sort('-createdAt').limit(8).populate('user', 'name email role'),
      User.find({ role: { $ne: 'admin' } }).sort('-createdAt').limit(8).select(publicUserFields),
    ]);

    res.json({
      teamCounts,
      orderStats,
      vendorCount,
      productCount,
      activeProducts,
      activeDeliveries,
      walletBalance: walletStats[0]?.walletBalance || 0,
      rewardPoints: walletStats[0]?.rewardPoints || 0,
      recentOrders,
      recentUsers: recentUsers.map(serializePublicUser),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/admin/users
// @desc    User and access management
// @access  Private (Admin)
router.get('/users', ...adminOnly, async (req, res) => {
  try {
    const filter = req.query.role ? { role: req.query.role } : { role: { $ne: 'admin' } };
    const users = await User.find(filter).sort('-createdAt').select(publicUserFields);
    res.json(users.map(serializePublicUser));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/admin/users
// @desc    Admin creates vendor credentials
// @access  Private (Admin)
router.post('/users', ...adminOnly, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      role,
      status,
      store_name,
      owner_name,
      gst_number,
      location,
    } = req.body;

    if (role !== 'vendor') {
      return res.status(400).json({ message: 'Admin can create vendor accounts only. Sales, production, and delivery users must request signup.' });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const user = await User.create({
      name,
      email,
      phone,
      password,
      role,
      status: status || 'active',
      availability_status: 'inactive',
      ...(req.user.id !== 'env-admin' ? { createdBy: req.user.id } : {}),
    });

    if (role === 'vendor') {
      const storeName = store_name || `${name}'s Outlet`;
      const referralCode = `${storeName.replace(/[^a-z0-9]/gi, '').substring(0, 4).toUpperCase()}${Math.floor(1000 + Math.random() * 9000)}`;

      await Vendor.create({
        user: user._id,
        store_name: storeName,
        owner_name: owner_name || name,
        gst_number,
        location: {
          address: location?.address || 'Not provided',
          city: location?.city || 'Not provided',
          state: location?.state || 'Not provided',
          zip: location?.zip || '',
          lat: location?.lat,
          lng: location?.lng,
        },
        referral_code: referralCode,
        auto_approved: true,
      });

      await Wallet.create({
        user: user._id,
        transactions: [
          {
            title: 'Vendor account activated',
            type: 'reward',
            points: 100,
            notes: 'Admin-created vendor credential',
          },
        ],
        reward_points: 100,
      });
    }

    res.status(201).json({
      _id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
    });
    emitResourceChanged(req, {
      domains: ['users', 'admin', ...(user.role === 'vendor' ? ['vendors', 'wallet'] : []), ...(user.role === 'delivery' ? ['deliveries', 'sales'] : [])],
      action: 'created',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/admin/users/:id
// @desc    Admin updates user credential and vendor outlet details
// @access  Private (Admin)
router.put('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      status,
      availability_status,
      store_name,
      owner_name,
      gst_number,
      location,
    } = req.body;

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (email && email.toLowerCase() !== user.email.toLowerCase()) {
      const duplicate = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });

      if (duplicate) {
        return res.status(400).json({ message: 'Email is already used by another credential' });
      }

      user.email = email.toLowerCase();
    }

    user.name = name || user.name;
    user.phone = phone !== undefined ? phone : user.phone;
    user.status = status || user.status;

    if (user.role === 'delivery' && availability_status) {
      user.availability_status = availability_status;
    }

    await user.save();

    if (user.role === 'vendor') {
      const vendor = await Vendor.findOne({ user: user._id });

      if (vendor) {
        vendor.store_name = store_name || vendor.store_name;
        vendor.owner_name = owner_name || name || vendor.owner_name;
        vendor.gst_number = gst_number !== undefined ? gst_number : vendor.gst_number;

        if (location) {
          vendor.location = {
            address: location.address || vendor.location?.address || 'Not provided',
            city: location.city || vendor.location?.city || 'Not provided',
            state: location.state || vendor.location?.state || 'Not provided',
            zip: location.zip !== undefined ? location.zip : vendor.location?.zip,
            lat: location.lat !== undefined ? location.lat : vendor.location?.lat,
            lng: location.lng !== undefined ? location.lng : vendor.location?.lng,
          };
        }

        await vendor.save();
      }
    }

    res.json({
      _id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      availability_status: user.availability_status || 'inactive',
    });
    emitResourceChanged(req, {
      domains: ['users', 'admin', ...(user.role === 'vendor' ? ['vendors'] : []), ...(user.role === 'delivery' ? ['deliveries', 'sales'] : [])],
      action: 'updated',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/admin/users/:id/status
// @desc    Activate/suspend credentials and vendor approvals
// @access  Private (Admin)
router.put('/users/:id/status', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.status = req.body.status || user.status;
    const updatedUser = await user.save();

    res.json({
      _id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      phone: updatedUser.phone,
      role: updatedUser.role,
      status: updatedUser.status,
    });
    emitResourceChanged(req, {
      domains: ['users', 'admin', ...(updatedUser.role === 'vendor' ? ['vendors'] : []), ...(updatedUser.role === 'delivery' ? ['deliveries', 'sales'] : [])],
      action: 'status-updated',
      entity: 'user',
      entityId: updatedUser._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/admin/users/:id/password
// @desc    Admin password reset
// @access  Private (Admin)
router.put('/users/:id/password', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('+password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    user.resetPasswordRequestedAt = undefined;
    await user.save();

    res.json({ message: 'Password updated' });
    emitResourceChanged(req, {
      domains: ['users', 'admin'],
      action: 'password-updated',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/admin/users/:id
// @desc    Delete team member credential
// @access  Private (Admin)
router.delete('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.role === 'vendor') {
      const orderIds = await Order.find({ user: user._id }).distinct('_id');

      await Delivery.deleteMany({ order: { $in: orderIds } });
      await Order.deleteMany({ user: user._id });
      await Vendor.deleteOne({ user: user._id });
      await Wallet.deleteOne({ user: user._id });
    }

    await User.deleteOne({ _id: user._id });

    res.json({ message: 'Credential deleted' });
    emitResourceChanged(req, {
      domains: ['users', 'admin', 'vendors', 'orders', 'deliveries', 'wallet', 'sales', 'production'],
      action: 'deleted',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/admin/outlets
// @desc    Outlet monitoring
// @access  Private (Admin)
router.get('/outlets', ...adminOnly, async (req, res) => {
  try {
    const outlets = await Vendor.find({})
      .populate('user', 'name email phone status availability_status lastLoginAt')
      .sort('-createdAt');
    res.json(outlets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
