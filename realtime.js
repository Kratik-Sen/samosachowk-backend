const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const Delivery = require('./models/Delivery');

const userRoom = (userId) => `user:${userId}`;
const deliveryRoom = (deliveryId) => `delivery:${deliveryId}`;
const roleRoom = (role) => `role:${role}`;

const toIdString = (value) => {
  if (!value) {
    return '';
  }

  return (value._id || value.id || value).toString();
};

const uniqueStrings = (values = []) =>
  Array.from(new Set(values.map((value) => toIdString(value)).filter(Boolean)));

const getUserPhone = (user) => {
  if (!user || typeof user !== 'object') {
    return '';
  }

  return user.phone || '';
};

const serializeLocation = (location) => {
  if (!location) {
    return null;
  }

  const lat = Number(location.lat);
  const lng = Number(location.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return {
    lat,
    lng,
    ...(location.location || location.address ? { location: location.location || location.address } : {}),
    updated_at: location.updated_at || new Date(),
  };
};

const canJoinDelivery = async (user, deliveryId) => {
  const delivery = await Delivery.findById(deliveryId).populate({
    path: 'order',
    select: 'user customer_name customer_phone delivery_address status',
    populate: { path: 'user', select: 'name phone' },
  });

  if (!delivery || !delivery.order) {
    return null;
  }

  const userId = String(user.id);
  const deliveryBoyId = delivery.delivery_boy?.toString();
  const vendorId = delivery.order.user?.toString();
  const staffRoles = ['admin', 'sales', 'production'];
  const isAllowed =
    staffRoles.includes(user.role) ||
    (user.role === 'delivery' && deliveryBoyId === userId) ||
    (user.role === 'vendor' && vendorId === userId);

  if (!isAllowed) {
    return null;
  }

  return delivery;
};

const createRealtimeServer = (server) => {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return next(new Error('Authentication token is required'));
    }

    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      return next();
    } catch (error) {
      return next(new Error('Authentication token is invalid'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(userRoom(socket.user.id));
    socket.join(roleRoom(socket.user.role));

    socket.on('tracking:join', async ({ deliveryId } = {}, callback) => {
      try {
        if (!deliveryId) {
          throw new Error('deliveryId is required');
        }

        const delivery = await canJoinDelivery(socket.user, deliveryId);

        if (!delivery) {
          throw new Error('You cannot join this delivery');
        }

        socket.join(deliveryRoom(delivery._id));
        const snapshot = {
          deliveryId: delivery._id.toString(),
          orderId: delivery.order._id.toString(),
          status: delivery.status,
          orderStatus: delivery.order.status,
          current_location: serializeLocation(delivery.current_location),
          vendor_location: serializeLocation(delivery.order.delivery_address),
        };

        socket.emit('tracking:snapshot', snapshot);

        if (typeof callback === 'function') {
          callback({ success: true, ...snapshot });
        }
      } catch (error) {
        if (typeof callback === 'function') {
          callback({ success: false, message: error.message });
        } else {
          socket.emit('tracking:error', { message: error.message });
        }
      }
    });

    socket.on('tracking:leave', ({ deliveryId } = {}) => {
      if (deliveryId) {
        socket.leave(deliveryRoom(deliveryId));
      }
    });
  });

  return io;
};

const emitDeliveryLocation = (req, delivery) => {
  const io = req.app.get('io');

  if (!io || !delivery) {
    return;
  }

  const order = delivery.order;
  const orderId = order?._id || order;
  const vendorUserId = order?.user;
  const deliveryBoyId = delivery.delivery_boy;
  const payload = {
    deliveryId: delivery._id.toString(),
    orderId: orderId?.toString(),
    current_location: serializeLocation(delivery.current_location),
    vendor_location: serializeLocation(order?.delivery_address),
  };

  io.to(deliveryRoom(delivery._id)).emit('delivery:location', payload);

  if (vendorUserId) {
    io.to(userRoom(vendorUserId)).emit('delivery:location', payload);
  }

  if (deliveryBoyId) {
    io.to(userRoom(deliveryBoyId)).emit('delivery:location', payload);
  }
};

const emitVendorLocation = (req, delivery) => {
  const io = req.app.get('io');

  if (!io || !delivery) {
    return;
  }

  const order = delivery.order;
  const orderId = order?._id || order;
  const vendorUserId = order?.user;
  const deliveryBoyId = delivery.delivery_boy;
  const payload = {
    deliveryId: delivery._id.toString(),
    orderId: orderId?.toString(),
    vendor_location: serializeLocation(order?.delivery_address),
  };

  io.to(deliveryRoom(delivery._id)).emit('vendor:location', payload);

  if (vendorUserId) {
    io.to(userRoom(vendorUserId)).emit('vendor:location', payload);
  }

  if (deliveryBoyId) {
    io.to(userRoom(deliveryBoyId)).emit('vendor:location', payload);
  }
};

const emitDeliveryAssigned = async (req, deliveryId) => {
  const io = req.app.get('io');

  if (!io || !deliveryId) {
    return;
  }

  const delivery = await Delivery.findById(deliveryId).populate('order', 'user delivery_address status');

  if (!delivery || !delivery.order) {
    return;
  }

  const payload = {
    deliveryId: delivery._id.toString(),
    orderId: delivery.order._id.toString(),
    status: delivery.status,
    orderStatus: delivery.order.status,
    customer_name: delivery.order.customer_name,
    vendor_name: delivery.order.user?.name || delivery.order.customer_name,
    vendor_phone: getUserPhone(delivery.order.user) || delivery.order.customer_phone || '',
    current_location: serializeLocation(delivery.current_location),
    vendor_location: serializeLocation(delivery.order.delivery_address),
    updatedAt: new Date().toISOString(),
  };

  io.to(userRoom(delivery.delivery_boy)).emit('delivery:assigned', payload);
  const vendorUserId = toIdString(delivery.order.user);

  if (vendorUserId) {
    io.to(userRoom(vendorUserId)).emit('delivery:assigned', payload);
  }
};

const emitDeliveryStatus = (req, delivery) => {
  const io = req.app.get('io');

  if (!io || !delivery) {
    return;
  }

  const order = delivery.order;
  const orderId = order?._id || order;
  const vendorUserId = order?.user;
  const deliveryBoyId = delivery.delivery_boy;
  const payload = {
    deliveryId: delivery._id.toString(),
    orderId: orderId?.toString(),
    status: delivery.status,
    orderStatus: order?.status,
  };

  io.to(deliveryRoom(delivery._id)).emit('delivery:status', payload);

  if (vendorUserId) {
    io.to(userRoom(vendorUserId)).emit('delivery:status', payload);
  }

  if (deliveryBoyId) {
    io.to(userRoom(deliveryBoyId)).emit('delivery:status', payload);
  }
};

const emitResourceChanged = (
  req,
  {
    domains = [],
    action,
    entity,
    entityId,
    users = [],
    roles = [],
    audienceUsers = [],
    audienceRoles = [],
  } = {}
) => {
  const io = req.app.get('io');

  if (!io) {
    return;
  }

  const payloadUsers = uniqueStrings(audienceUsers);
  const payloadRoles = uniqueStrings(audienceRoles);
  const payload = {
    domains: Array.from(new Set(domains)),
    action,
    entity,
    entityId: entityId?.toString(),
    audienceUsers: payloadUsers,
    audienceRoles: payloadRoles,
    updatedAt: new Date().toISOString(),
  };
  const rooms = [
    ...uniqueStrings(users).map((userId) => userRoom(userId)),
    ...uniqueStrings(roles).map((role) => roleRoom(role)),
  ];

  if (!rooms.length) {
    io.emit('resource:changed', payload);
    return;
  }

  rooms.forEach((room) => {
    io.to(room).emit('resource:changed', payload);
  });
};

module.exports = {
  createRealtimeServer,
  emitDeliveryAssigned,
  emitDeliveryLocation,
  emitVendorLocation,
  emitResourceChanged,
  emitDeliveryStatus,
};
