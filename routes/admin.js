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
const REDEEM_MIN_POINTS = 3000;

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

const addIdToSet = (set, value) => {
  const id = value?._id || value;

  if (id) {
    set.add(id.toString());
  }
};

const isWithinRange = (value, start, end) => {
  const date = new Date(value);

  return !Number.isNaN(date.getTime()) && date >= start && date < end;
};

const getPeriodAnalytics = async (start, end) => {
  const orders = await Order.find({
    createdAt: { $gte: start, $lt: end },
  })
    .select('user delivery_boy final_amount payment_status status_updates')
    .lean();
  const activeSets = {
    vendor: new Set(),
    sales: new Set(),
    production: new Set(),
    delivery: new Set(),
  };
  const summary = orders.reduce(
    (acc, order) => {
      acc.totalOrders += 1;
      acc.revenue += Number(order.final_amount || 0);
      if (order.payment_status === 'completed') {
        acc.paidRevenue += Number(order.final_amount || 0);
      } else {
        acc.pendingPayments += Number(order.final_amount || 0);
      }

      addIdToSet(activeSets.vendor, order.user);
      addIdToSet(activeSets.delivery, order.delivery_boy);

      (order.status_updates || []).forEach((update) => {
        if (!isWithinRange(update.updated_at, start, end)) {
          return;
        }

        if (update.status === 'Verified') {
          addIdToSet(activeSets.sales, update.updated_by);
        }

        if (['In Production', 'Ready'].includes(update.status)) {
          addIdToSet(activeSets.production, update.updated_by);
        }
      });

      return acc;
    },
    { totalOrders: 0, revenue: 0, paidRevenue: 0, pendingPayments: 0 }
  );

  return {
    ...summary,
    activeCounts: {
      vendor: activeSets.vendor.size,
      sales: activeSets.sales.size,
      production: activeSets.production.size,
      delivery: activeSets.delivery.size,
    },
  };
};

const getRevenuePeriods = async () => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [today, monthly] = await Promise.all([
    getPeriodAnalytics(todayStart, now),
    getPeriodAnalytics(monthStart, now),
  ]);

  return {
    today,
    monthly,
  };
};

const serializeRewardRequest = (wallet, request) => ({
  _id: request._id,
  walletId: wallet._id,
  user: wallet.user,
  points: request.points,
  status: request.status,
  notes: request.notes,
  reward_note: request.reward_note,
  requestedAt: request.requestedAt,
  reviewedAt: request.reviewedAt,
  reviewedBy: request.reviewedBy,
  currentRewardPoints: wallet.reward_points,
});

const getRewardRequests = async () => {
  const wallets = await Wallet.find({ 'reward_redemptions.0': { $exists: true } })
    .populate('user', 'name email phone role')
    .sort('-updatedAt');
  const requests = wallets.flatMap((wallet) =>
    (wallet.reward_redemptions || []).map((request) => serializeRewardRequest(wallet, request))
  );

  return requests.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
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
      revenuePeriods,
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
      getRevenuePeriods(),
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
      revenuePeriods,
      recentOrders,
      recentUsers: recentUsers.map(serializePublicUser),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/admin/rewards
// @desc    Reward redeem requests for admin review
// @access  Private (Admin)
router.get('/rewards', ...adminOnly, async (req, res) => {
  try {
    res.json(await getRewardRequests());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/admin/rewards/:requestId
// @desc    Verify or unverify a reward redeem request
// @access  Private (Admin)
router.put('/rewards/:requestId', ...adminOnly, async (req, res) => {
  try {
    const nextStatus = req.body.status === 'verified' ? 'verified' : req.body.status === 'rejected' ? 'rejected' : '';

    if (!nextStatus) {
      return res.status(400).json({ message: 'Use verified or rejected status' });
    }

    const wallet = await Wallet.findOne({ 'reward_redemptions._id': req.params.requestId }).populate(
      'user',
      'name email phone role'
    );

    if (!wallet) {
      return res.status(404).json({ message: 'Reward request not found' });
    }

    const request = wallet.reward_redemptions.id(req.params.requestId);

    if (!request) {
      return res.status(404).json({ message: 'Reward request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'This reward request has already been reviewed' });
    }

    if (nextStatus === 'verified' && wallet.reward_points < request.points) {
      return res.status(400).json({ message: 'Vendor no longer has enough points for this redemption' });
    }

    request.status = nextStatus;
    request.reviewedAt = new Date();
    request.reward_note = req.body.reward_note || req.body.notes || '';
    if (req.user.id !== 'env-admin') {
      request.reviewedBy = req.user.id;
    }

    if (nextStatus === 'verified') {
      wallet.reward_points -= request.points;
      wallet.transactions.unshift({
        title: 'Admin verified redeem points',
        type: 'redemption',
        points: request.points,
        status: 'completed',
        notes: request.reward_note || 'Admin verified redeem points.',
      });
    } else {
      wallet.transactions.unshift({
        title: 'Reward redeem request unverified',
        type: 'redemption',
        points: request.points,
        status: 'failed',
        notes: request.reward_note || 'Admin did not verify this redeem request.',
      });
    }

    await wallet.save();
    res.json(serializeRewardRequest(wallet, request));
    emitResourceChanged(req, {
      domains: ['wallet', 'vendors', 'admin', 'rewards'],
      action: nextStatus === 'verified' ? 'redeem-verified' : 'redeem-rejected',
      entity: 'reward-redemption',
      entityId: request._id,
      audienceUsers: [wallet.user?._id || wallet.user],
      audienceRoles: ['admin'],
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
