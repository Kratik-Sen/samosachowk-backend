const Delivery = require('../models/Delivery');
const Order = require('../models/Order');
const { emitDeliveryStatus, emitResourceChanged } = require('../realtime');

const DELIVERY_RESPONSE_WINDOW_MS = 60 * 1000;

const getAssignmentExpiry = () => new Date(Date.now() + DELIVERY_RESPONSE_WINDOW_MS);

const rejectExpiredDelivery = async (req, delivery, actorId) => {
  if (!delivery || delivery.status !== 'Assigned') {
    return null;
  }

  if (!delivery.assigned_expires_at || delivery.assigned_expires_at.getTime() > Date.now()) {
    return null;
  }

  delivery.status = 'Rejected';
  delivery.responded_at = new Date();
  delivery.notes = 'Automatically rejected because the delivery boy did not respond within 1 minute.';
  await delivery.save();

  const order = await Order.findById(delivery.order);

  if (order) {
    order.status = 'Ready';
    order.delivery_boy = undefined;
    order.delivery_assigned_at = undefined;
    order.status_updates.push({
      status: 'Ready',
      note: 'Delivery request auto-rejected after 1 minute. Sales must assign again.',
      updated_by: actorId && actorId !== 'env-admin' ? actorId : undefined,
    });
    await order.save();
  }

  const trackedDelivery = await Delivery.findById(delivery._id)
    .populate('order', 'user status customer_name')
    .populate('delivery_boy', 'name');

  emitDeliveryStatus(req, trackedDelivery);
  emitResourceChanged(req, {
    domains: ['deliveries', 'orders', 'sales', 'production', 'admin', 'vendors'],
    action: 'auto-rejected',
    entity: 'delivery',
    entityId: delivery._id,
    audienceUsers: [order?.user, delivery.delivery_boy],
    audienceRoles: ['admin', 'sales', 'production'],
  });

  return trackedDelivery || delivery;
};

const rejectExpiredAssignments = async (req, filter = {}) => {
  const expiredDeliveries = await Delivery.find({
    ...filter,
    status: 'Assigned',
    assigned_expires_at: { $lte: new Date() },
  });

  const rejected = [];

  for (const delivery of expiredDeliveries) {
    const result = await rejectExpiredDelivery(req, delivery, req.user?.id);
    if (result) {
      rejected.push(result);
    }
  }

  return rejected;
};

module.exports = {
  DELIVERY_RESPONSE_WINDOW_MS,
  getAssignmentExpiry,
  rejectExpiredDelivery,
  rejectExpiredAssignments,
};
