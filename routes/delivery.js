const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Delivery = require('../models/Delivery');
const Order = require('../models/Order');
const User = require('../models/User');
const { emitDeliveryLocation, emitDeliveryStatus, emitResourceChanged } = require('../realtime');

const DELIVERY_CLOSE_DISTANCE_KM = 0.7;
const DELIVERY_CLOSE_DISTANCE_TEXT = '0.7 km';
const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const toCoordinate = (location) => {
  const lat = Number(location?.lat ?? location?.latitude);
  const lng = Number(location?.lng ?? location?.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return { lat, lng };
};

const getDistanceKm = (from, to) => {
  const latitudeDelta = toRadians(to.lat - from.lat);
  const longitudeDelta = toRadians(to.lng - from.lng);
  const startLatitude = toRadians(from.lat);
  const endLatitude = toRadians(to.lat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const formatDistance = (distanceKm) => {
  if (distanceKm < 1) {
    return `${Math.max(1, Math.round(distanceKm * 1000))} m`;
  }

  return `${distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm)} km`;
};

const populateDelivery = (query) =>
  query.populate({
    path: 'order',
    populate: [
      { path: 'user', select: 'name email phone' },
      { path: 'delivery_boy', select: 'name phone status availability_status' },
    ],
  });

const addStatusUpdate = (order, status, note, userId) => {
  order.status_updates.push({
    status,
    note,
    updated_by: userId && userId !== 'env-admin' ? userId : undefined,
  });
};

// @route   GET /api/delivery/dashboard
// @desc    Get assigned deliveries for delivery boy
// @access  Private (Delivery)
router.get('/dashboard', protect, authorize('delivery'), async (req, res) => {
  try {
    const filter = { delivery_boy: req.user.id };

    if (req.query.scope === 'active') {
      filter.status = { $ne: 'Delivered' };
    }

    const deliveries = await populateDelivery(
      Delivery.find(filter).sort('-createdAt')
    );
    res.json(deliveries);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/delivery/availability
// @desc    Get delivery boy assignment availability
// @access  Private (Delivery)
router.get('/availability', protect, authorize('delivery'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('availability_status status');

    if (!user) {
      return res.status(404).json({ message: 'Delivery user not found' });
    }

    res.json({
      status: user.status,
      availability_status: user.availability_status || 'inactive',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/delivery/availability
// @desc    Toggle delivery boy assignment availability
// @access  Private (Delivery)
router.put('/availability', protect, authorize('delivery'), async (req, res) => {
  try {
    const nextStatus = req.body.availability_status;

    if (!['active', 'inactive'].includes(nextStatus)) {
      return res.status(400).json({ message: 'Availability must be active or inactive' });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'Delivery user not found' });
    }

    if (user.status !== 'active') {
      return res.status(400).json({ message: 'Only active delivery accounts can be available for assignment' });
    }

    user.availability_status = nextStatus;
    await user.save();

    res.json({
      status: user.status,
      availability_status: user.availability_status,
    });
    emitResourceChanged(req, {
      domains: ['deliveries', 'users', 'sales'],
      action: 'availability-updated',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/delivery/:id/accept
// @desc    Accept delivery assignment
// @access  Private (Delivery)
router.put('/:id/accept', protect, authorize('delivery'), async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id);
    if (delivery && delivery.delivery_boy.toString() === req.user.id) {
      delivery.status = 'Picked Up';
      await delivery.save();
      
      // Update order status as well
      const order = await Order.findById(delivery.order);
      if (order) {
        order.status = 'Out for Delivery';
        addStatusUpdate(order, 'Out for Delivery', 'Delivery boy accepted the assigned run.', req.user.id);
        await order.save();
      }

      const trackedDelivery = await Delivery.findById(delivery._id).populate('order', 'user status');
      emitDeliveryStatus(req, trackedDelivery);
      emitResourceChanged(req, {
        domains: ['deliveries', 'orders', 'sales', 'admin', 'vendors'],
        action: 'accepted',
        entity: 'delivery',
        entityId: delivery._id,
      });
      
      res.json(delivery);
    } else {
      res.status(404).json({ message: 'Delivery not found or not assigned to you' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/delivery/:id/delivered
// @desc    Mark delivered and record payment
// @access  Private (Delivery)
router.put('/:id/delivered', protect, authorize('delivery'), async (req, res) => {
  try {
    const { payment_collected, amount_collected } = req.body;
    const delivery = await Delivery.findById(req.params.id).populate('order');
    
    if (delivery && delivery.delivery_boy.toString() === req.user.id) {
      const currentLocation = toCoordinate(req.body.current_location || req.body);
      const vendorLocation = toCoordinate(delivery.order?.delivery_address);

      if (!vendorLocation) {
        return res.status(400).json({ message: 'Vendor location is required before closing delivery' });
      }

      if (!currentLocation) {
        return res.status(400).json({ message: 'Current delivery location is required before closing delivery' });
      }

      const distanceToVendorKm = getDistanceKm(currentLocation, vendorLocation);

      if (distanceToVendorKm > DELIVERY_CLOSE_DISTANCE_KM) {
        return res.status(400).json({
          message: `Reach within ${DELIVERY_CLOSE_DISTANCE_TEXT} of the vendor before closing this delivery. Current distance: ${formatDistance(distanceToVendorKm)}.`,
        });
      }

      delivery.status = 'Delivered';
      delivery.current_location = { ...currentLocation, updated_at: new Date() };
      if (payment_collected) {
        delivery.payment_collected = true;
        delivery.amount_collected = amount_collected;
      }
      await delivery.save();
      emitDeliveryLocation(req, delivery);
      
      // Update order status
      const order = await Order.findById(delivery.order._id);
      order.status = 'Delivered';
      addStatusUpdate(order, 'Delivered', 'Delivery completed at vendor outlet.', req.user.id);
      if (payment_collected && order.payment_method === 'COD') {
        order.payment_status = 'completed';
      }
      await order.save();

      const trackedDelivery = await Delivery.findById(delivery._id).populate('order', 'user status');
      emitDeliveryStatus(req, trackedDelivery);
      emitResourceChanged(req, {
        domains: ['deliveries', 'orders', 'sales', 'admin', 'vendors', 'wallet'],
        action: 'delivered',
        entity: 'delivery',
        entityId: delivery._id,
      });
      
      res.json(delivery);
    } else {
      res.status(404).json({ message: 'Delivery not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/delivery/:id/location
// @desc    Update live location
// @access  Private (Delivery)
router.post('/:id/location', protect, authorize('delivery'), async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng) || Math.abs(parsedLat) > 90 || Math.abs(parsedLng) > 180) {
      return res.status(400).json({ message: 'Valid latitude and longitude are required' });
    }

    const delivery = await Delivery.findById(req.params.id).populate('order', 'user status');
    
    if (delivery && delivery.delivery_boy.toString() === req.user.id) {
      delivery.current_location = { lat: parsedLat, lng: parsedLng, updated_at: new Date() };
      await delivery.save();
      emitDeliveryLocation(req, delivery);
      res.json({ success: true, current_location: delivery.current_location });
    } else {
      res.status(404).json({ message: 'Delivery not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
