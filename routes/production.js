const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Production = require('../models/Production');
const Order = require('../models/Order');
const { emitResourceChanged } = require('../realtime');

const addStatusUpdate = (order, status, note, userId) => {
  order.status_updates.push({
    status,
    note,
    updated_by: userId && userId !== 'env-admin' ? userId : undefined,
  });
};

// @route   GET /api/production/dashboard
// @desc    Get production overview
// @access  Private (Production/Admin)
router.get('/dashboard', protect, authorize('production', 'admin'), async (req, res) => {
  try {
    const batches = await Production.find({}).populate('product').sort('-createdAt');
    res.json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/production/orders
// @desc    Get sales-verified orders for production
// @access  Private (Production/Admin)
router.get('/orders', protect, authorize('production', 'admin'), async (req, res) => {
  try {
    const orders = await Order.find({ status: { $in: ['Verified', 'In Production'] } })
      .sort('createdAt')
      .populate('user', 'name email phone');

    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/production/orders/:id/start
// @desc    Mark a verified order as in production
// @access  Private (Production/Admin)
router.put('/orders/:id/start', protect, authorize('production', 'admin'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!['Verified', 'In Production'].includes(order.status)) {
      return res.status(400).json({ message: 'Only verified orders can be started in production' });
    }

    order.status = 'In Production';
    addStatusUpdate(order, 'In Production', req.body.note || 'Production started preparing the order.', req.user.id);

    const updatedOrder = await order.save();
    res.json(updatedOrder);
    emitResourceChanged(req, {
      domains: ['orders', 'production', 'sales', 'admin', 'vendors'],
      action: 'production-started',
      entity: 'order',
      entityId: order._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/production/orders/:id/ready
// @desc    Mark production order complete and return it to sales
// @access  Private (Production/Admin)
router.put('/orders/:id/ready', protect, authorize('production', 'admin'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!['Verified', 'In Production'].includes(order.status)) {
      return res.status(400).json({ message: 'Only production orders can be marked ready' });
    }

    order.status = 'Ready';
    addStatusUpdate(order, 'Ready', req.body.note || 'Production completed the order and sent it back to sales.', req.user.id);

    const updatedOrder = await order.save();
    res.json(updatedOrder);
    emitResourceChanged(req, {
      domains: ['orders', 'production', 'sales', 'admin', 'vendors'],
      action: 'ready',
      entity: 'order',
      entityId: order._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/production/batch
// @desc    Create new production batch
// @access  Private (Admin/Production Manager)
router.post('/batch', protect, authorize('admin', 'production'), async (req, res) => {
  try {
    const { product_id, quantity_planned, assigned_to, notes } = req.body;
    
    const batch = await Production.create({
      product: product_id,
      quantity_planned,
      assigned_to,
      notes
    });
    
    res.status(201).json(batch);
    emitResourceChanged(req, {
      domains: ['production', 'admin'],
      action: 'created',
      entity: 'production-batch',
      entityId: batch._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/production/batch/:id
// @desc    Update production status and quantity
// @access  Private (Production)
router.put('/batch/:id', protect, authorize('production', 'admin'), async (req, res) => {
  try {
    const { quantity_produced, status, notes } = req.body;
    const batch = await Production.findById(req.params.id);
    
    if (batch) {
      batch.quantity_produced = quantity_produced || batch.quantity_produced;
      batch.status = status || batch.status;
      if (notes) batch.notes = notes;
      
      const updatedBatch = await batch.save();
      res.json(updatedBatch);
      emitResourceChanged(req, {
        domains: ['production', 'admin'],
        action: 'updated',
        entity: 'production-batch',
        entityId: batch._id,
      });
    } else {
      res.status(404).json({ message: 'Batch not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
