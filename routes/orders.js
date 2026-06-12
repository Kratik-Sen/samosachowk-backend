const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const router = express.Router();
const { protect, optionalAuth, authorize } = require('../middleware/auth');
const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const User = require('../models/User');
const { emitDeliveryAssigned, emitResourceChanged } = require('../realtime');

const normalizePaymentMethod = (method) => {
  const value = String(method || 'COD').toUpperCase();

  if (value === 'RAZORPAY') {
    return 'RAZORPAY';
  }

  return value;
};

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const addStatusUpdate = (order, status, note, userId) => {
  order.status_updates.push({
    status,
    note,
    updated_by: userId && userId !== 'env-admin' ? userId : undefined,
  });
};

const populateOrder = (query) =>
  query
    .populate('user', 'name email phone')
    .populate('delivery_boy', 'name phone status availability_status');

const HISTORY_ORDER_STATUSES = ['Delivered', 'Cancelled'];
const HISTORY_RETENTION_DAYS = 20;
const HISTORY_DEFAULT_LIMIT = 8;
const HISTORY_MAX_LIMIT = 20;

const getHistoryCutoffDate = () =>
  new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const cleanupExpiredOrderHistory = async () => {
  const cutoffDate = getHistoryCutoffDate();
  const expiredOrders = await Order.find({
    status: { $in: HISTORY_ORDER_STATUSES },
    updatedAt: { $lt: cutoffDate },
  }).select('_id');
  const expiredOrderIds = expiredOrders.map((order) => order._id);

  if (!expiredOrderIds.length) {
    return 0;
  }

  await Delivery.deleteMany({ order: { $in: expiredOrderIds } });
  await Order.deleteMany({ _id: { $in: expiredOrderIds } });
  return expiredOrderIds.length;
};

const getHistoryFilterForUser = (user) => {
  const filter = {
    status: { $in: HISTORY_ORDER_STATUSES },
    updatedAt: { $gte: getHistoryCutoffDate() },
  };

  if (user.role === 'vendor') {
    filter.user = user.id;
  }

  if (user.role === 'delivery') {
    filter.delivery_boy = user.id;
  }

  if (user.role === 'production') {
    filter['status_updates.status'] = { $in: ['In Production', 'Ready'] };
  }

  return filter;
};

const getRazorpayClient = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay key id and secret are not configured on the server');
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

const verifyRazorpaySignature = ({ razorpay_order_id, payment_id, razorpay_signature }) => {
  if (!razorpay_order_id || !payment_id || !razorpay_signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_order_id}|${payment_id}`)
    .digest('hex');

  return expectedSignature === razorpay_signature;
};

// @route   POST /api/orders/razorpay
// @desc    Create Razorpay order using server .env credentials
// @access  Private
router.post('/razorpay', protect, async (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);

    if (amount <= 0) {
      return res.status(400).json({ message: 'Valid amount is required' });
    }

    const razorpay = getRazorpayClient();
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `sc_${Date.now()}`,
      notes: {
        user: req.user.id,
        source: 'samosa-chowk-mobile',
      },
    });

    res.json({
      key: process.env.RAZORPAY_KEY_ID,
      orderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders
// @desc    Place a new order (Vendor/Customer)
// @access  Public / Private
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { 
      customer_name, 
      customer_phone, 
      items, 
      total_amount, 
      discount_amount, 
      gst_rate,
      gst_amount,
      final_amount, 
      payment_method, 
      payment_status,
      payment_id,
      razorpay_order_id,
      razorpay_signature,
      delivery_mode, 
      delivery_address,
      order_type,
      bulk_note,
    } = req.body;

    const normalizedPaymentMethod = normalizePaymentMethod(payment_method);

    if (
      normalizedPaymentMethod === 'RAZORPAY' &&
      !verifyRazorpaySignature({ razorpay_order_id, payment_id, razorpay_signature })
    ) {
      return res.status(400).json({ message: 'Razorpay payment verification failed' });
    }

    const normalizedPaymentStatus =
      normalizedPaymentMethod === 'RAZORPAY' && payment_id
        ? 'completed'
        : payment_status || 'pending';
    const normalizedTotalAmount = roundMoney(total_amount);
    const normalizedDiscountAmount = roundMoney(discount_amount);
    const normalizedGstRate = Number(gst_rate || 0);
    const normalizedGstAmount = roundMoney(gst_amount);
    const normalizedFinalAmount = roundMoney(
      final_amount || normalizedTotalAmount + normalizedGstAmount - normalizedDiscountAmount
    );

    const order = await Order.create({
      user: req.user ? req.user.id : null,
      customer_name,
      customer_phone,
      items,
      total_amount: normalizedTotalAmount,
      discount_amount: normalizedDiscountAmount,
      gst_rate: normalizedGstRate,
      gst_amount: normalizedGstAmount,
      final_amount: normalizedFinalAmount,
      payment_method: normalizedPaymentMethod,
      payment_status: normalizedPaymentStatus,
      payment_id,
      razorpay_order_id,
      razorpay_signature,
      delivery_mode,
      delivery_address,
      order_type: order_type === 'Bulk' ? 'Bulk' : 'Regular',
      bulk_note,
      status: 'Pending',
      status_updates: [
        {
          status: 'Pending',
          note:
            normalizedPaymentMethod === 'RAZORPAY'
              ? 'Vendor paid online and order was sent to sales.'
              : 'Vendor selected COD and order was sent to sales.',
          updated_by: req.user && req.user.id !== 'env-admin' ? req.user.id : undefined,
        },
      ],
    });

    res.status(201).json(order);
    emitResourceChanged(req, {
      domains: ['orders', 'sales', 'admin', 'vendors'],
      action: 'created',
      entity: 'order',
      entityId: order._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders
// @desc    Get all orders
// @access  Private (Sales/Production/Delivery/Admin)
router.get('/', protect, authorize('sales', 'production', 'delivery', 'admin'), async (req, res) => {
  try {
    const filter = {};

    if (req.query.status) {
      filter.status = { $in: String(req.query.status).split(',') };
    }

    const orders = await populateOrder(Order.find(filter).sort('-createdAt'));
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/history
// @desc    Get role-aware order history, paged 8 at a time and retained for 20 days
// @access  Private (Vendor/Sales/Production/Delivery/Admin)
router.get('/history', protect, authorize('vendor', 'sales', 'production', 'delivery', 'admin'), async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, HISTORY_DEFAULT_LIMIT), HISTORY_MAX_LIMIT);
    const skip = (page - 1) * limit;
    const deletedExpired = await cleanupExpiredOrderHistory();
    const filter = getHistoryFilterForUser(req.user);

    const [orders, total] = await Promise.all([
      populateOrder(Order.find(filter).sort('-updatedAt').skip(skip).limit(limit)),
      Order.countDocuments(filter),
    ]);

    res.json({
      orders,
      page,
      limit,
      total,
      hasMore: skip + orders.length < total,
      deletedExpired,
      retentionDays: HISTORY_RETENTION_DAYS,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/:id
// @desc    Get single order
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await populateOrder(Order.findById(req.params.id));
    if (order) {
      res.json(order);
    } else {
      res.status(404).json({ message: 'Order not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/status
// @desc    Update order status
// @access  Private (Sales/Production/Delivery/Admin)
router.put('/:id/status', protect, authorize('sales', 'production', 'delivery', 'admin'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (order) {
      order.status = req.body.status || order.status;
      if (req.body.status) {
        addStatusUpdate(order, req.body.status, req.body.note || 'Order status updated.', req.user.id);
      }
      
      // If payment is COD and status is Delivered, update payment status
      if (req.body.status === 'Delivered' && order.payment_method === 'COD') {
        order.payment_status = 'completed';
      }

      const updatedOrder = await order.save();
      res.json(updatedOrder);
      emitResourceChanged(req, {
        domains: ['orders', 'sales', 'production', 'admin', 'vendors', 'deliveries'],
        action: 'status-updated',
        entity: 'order',
        entityId: order._id,
      });
    } else {
      res.status(404).json({ message: 'Order not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/verify
// @desc    Sales team verifies the order
// @access  Private (Sales/Admin)
router.put('/:id/verify', protect, authorize('sales', 'admin'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (order) {
      order.status = 'Verified';
      addStatusUpdate(order, 'Verified', req.body.note || 'Sales verified order and sent it to production.', req.user.id);
      const updatedOrder = await order.save();
      res.json(updatedOrder);
      emitResourceChanged(req, {
        domains: ['orders', 'sales', 'production', 'admin', 'vendors'],
        action: 'verified',
        entity: 'order',
        entityId: order._id,
      });
    } else {
      res.status(404).json({ message: 'Order not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/assign-delivery
// @desc    Assign delivery boy to order
// @access  Private (Admin/Sales/Delivery)
router.put('/:id/assign-delivery', protect, authorize('admin', 'sales', 'delivery'), async (req, res) => {
  try {
    const deliveryBoy = await User.findOne({
      _id: req.body.delivery_boy_id,
      role: 'delivery',
      status: 'active',
      availability_status: 'active',
    });

    if (!deliveryBoy) {
      return res.status(400).json({ message: 'Select an active delivery boy' });
    }

    const order = await Order.findById(req.params.id);
    if (order) {
      order.delivery_boy = req.body.delivery_boy_id;
      order.delivery_assigned_at = new Date();
      order.status = 'Out for Delivery';
      addStatusUpdate(order, 'Out for Delivery', req.body.notes || `Assigned to ${deliveryBoy.name}.`, req.user.id);
      const updatedOrder = await order.save();

      const delivery = await Delivery.findOneAndUpdate(
        { order: order._id },
        {
          order: order._id,
          delivery_boy: req.body.delivery_boy_id,
          status: 'Assigned',
          notes: req.body.notes,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await emitDeliveryAssigned(req, delivery._id);

      res.json(updatedOrder);
      emitResourceChanged(req, {
        domains: ['orders', 'deliveries', 'sales', 'admin', 'vendors'],
        action: 'delivery-assigned',
        entity: 'order',
        entityId: order._id,
      });
    } else {
      res.status(404).json({ message: 'Order not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
