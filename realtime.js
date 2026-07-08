const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const Delivery = require('./models/Delivery');
const User = require('./models/User');
const { sendExpoPushNotifications } = require('./utils/pushNotifications');

const userRoom = (userId) => `user:${userId}`;
const deliveryRoom = (deliveryId) => `delivery:${deliveryId}`;
const roleRoom = (role) => `role:${role}`;
const signupRoom = (role, email) => `signup:${role}:${String(email || '').trim().toLowerCase()}`;

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

const summarizeOrderItems = (orderOrItems) => {
  const items = Array.isArray(orderOrItems) ? orderOrItems : orderOrItems?.items || [];
  const summary = items
    .map((item) => `${Number(item.quantity || 0)} ${item.name || 'item'}`)
    .filter(Boolean)
    .join(', ');

  return summary || 'order items';
};

const formatOrderAmount = (order) => `Rs ${Number(order?.final_amount || 0).toFixed(0)}`;

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

  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      socket.user = null;
      return next();
    }

    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);

      if (socket.user.id !== 'env-admin') {
        const user = await User.findById(socket.user.id).select('role status');

        if (!user) {
          return next(new Error('Account no longer exists'));
        }

        if (user.status !== 'active') {
          return next(new Error('Account is not active'));
        }

        socket.user.role = user.role;
      }

      return next();
    } catch (error) {
      return next(new Error('Authentication token is invalid'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.user) {
      socket.join(userRoom(socket.user.id));
      socket.join(roleRoom(socket.user.role));
    }

    socket.on('signup:watch', async ({ email, role } = {}, callback) => {
      try {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        const normalizedRole = String(role || '').trim();

        if (!normalizedEmail || !normalizedRole) {
          throw new Error('Email and role are required');
        }

        socket.join(signupRoom(normalizedRole, normalizedEmail));
        const user = await User.findOne({ email: normalizedEmail, role: normalizedRole }).select('status');
        const payload = {
          email: normalizedEmail,
          role: normalizedRole,
          status: user?.status || 'not_found',
          message:
            user?.status === 'active'
              ? 'admin verify your request you can login now'
              : user?.status === 'pending'
                ? 'Signup request sent to admin for verification. You can login after admin approval.'
                : '',
        };

        socket.emit('signup:status', payload);

        if (typeof callback === 'function') {
          callback({ success: true, ...payload });
        }
      } catch (error) {
        if (typeof callback === 'function') {
          callback({ success: false, message: error.message });
        }
      }
    });

    socket.on('tracking:join', async ({ deliveryId } = {}, callback) => {
      try {
        if (!socket.user) {
          throw new Error('Authentication token is required');
        }

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

  const delivery = await Delivery.findById(deliveryId).populate(
    'order',
    'user customer_name customer_phone delivery_address status items final_amount payment_method'
  );

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
    assigned_expires_at: delivery.assigned_expires_at,
    updatedAt: new Date().toISOString(),
  };

  io.to(userRoom(delivery.delivery_boy)).emit('delivery:assigned', payload);
  emitNotification(req, {
    title: `New delivery: ${summarizeOrderItems(delivery.order)}`,
    message: `Deliver ${summarizeOrderItems(delivery.order)} to ${delivery.order.customer_name || 'vendor'}, total ${formatOrderAmount(delivery.order)}.`,
    type: 'delivery-assigned',
    entity: 'delivery',
    entityId: delivery._id,
    users: [delivery.delivery_boy],
    data: payload,
  });
};

const emitNotification = (
  req,
  {
    title,
    message,
    type = 'info',
    entity,
    entityId,
    users = [],
    roles = [],
    data = {},
  } = {}
) => {
  if (!message) {
    return;
  }

  const payload = {
    id: `${type}:${entity || 'general'}:${entityId || Date.now()}:${Date.now()}`,
    title: title || 'Notification',
    message,
    type,
    entity,
    entityId: entityId?.toString(),
    data,
    createdAt: new Date().toISOString(),
  };

  sendExpoPushNotifications({
    users,
    roles,
    title: payload.title,
    body: payload.message,
    data: payload,
  }).catch((error) => {
    console.warn('Expo push notification failed:', error.message);
  });
};

const emitDeliveryStatus = (req, delivery) => {
  const io = req.app.get('io');

  if (!io || !delivery) {
    return;
  }

  const order = delivery.order;
  const orderId = order?._id || order;
  const vendorUserId = toIdString(order?.user);
  const deliveryBoyId = toIdString(delivery.delivery_boy);
  const payload = {
    deliveryId: delivery._id.toString(),
    orderId: orderId?.toString(),
    status: delivery.status,
    orderStatus: order?.status,
    customer_name: order?.customer_name,
    delivery_boy_name: delivery.delivery_boy?.name,
    assigned_expires_at: delivery.assigned_expires_at,
    responded_at: delivery.responded_at,
    notes: delivery.notes,
    auto_rejected: delivery.status === 'Rejected' && /automatically rejected|did not respond|expired/i.test(delivery.notes || ''),
  };

  io.to(deliveryRoom(delivery._id)).emit('delivery:status', payload);
  io.to(roleRoom('sales')).emit('delivery:status', payload);

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

const emitAccountDeleted = (req, userId) => {
  const io = req.app.get('io');

  if (!io || !userId) {
    return;
  }

  io.to(userRoom(userId)).emit('account:deleted', {
    message: 'Your account was deleted by admin. Please login again.',
    userId: userId.toString(),
    updatedAt: new Date().toISOString(),
  });
};

const emitSignupStatus = (req, user, status, message) => {
  const io = req.app.get('io');

  if (!io || !user?.email || !user?.role) {
    return;
  }

  io.to(signupRoom(user.role, user.email)).emit('signup:status', {
    email: user.email,
    role: user.role,
    status,
    message,
    userId: user._id?.toString(),
    updatedAt: new Date().toISOString(),
  });
};

module.exports = {
  createRealtimeServer,
  emitDeliveryAssigned,
  emitDeliveryLocation,
  emitVendorLocation,
  emitResourceChanged,
  emitDeliveryStatus,
  emitAccountDeleted,
  emitSignupStatus,
  emitNotification,
  formatOrderAmount,
  summarizeOrderItems,
};
