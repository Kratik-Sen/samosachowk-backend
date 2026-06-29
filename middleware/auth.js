const jwt = require('jsonwebtoken');
const User = require('../models/User');

const getBearerToken = (req) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }

  return null;
};

const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

const protect = async (req, res, next) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    req.user = verifyToken(token);

    if (req.user.id !== 'env-admin') {
      const user = await User.findById(req.user.id).select('role status');

      if (!user) {
        return res.status(401).json({ message: 'Account no longer exists. Please login again.' });
      }

      if (user.status !== 'active') {
        return res.status(403).json({ message: 'This account is not active. Please login again.' });
      }

      req.user.role = user.role;
    }

    return next();
  } catch (error) {
    console.error(error);
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

const optionalAuth = async (req, res, next) => {
  const token = getBearerToken(req);

  if (!token) {
    return next();
  }

  try {
    req.user = verifyToken(token);

    if (req.user.id !== 'env-admin') {
      const user = await User.findById(req.user.id).select('role status');

      if (!user) {
        return res.status(401).json({ message: 'Account no longer exists. Please login again.' });
      }

      if (user.status !== 'active') {
        return res.status(403).json({ message: 'This account is not active. Please login again.' });
      }

      req.user.role = user.role;
    }

    return next();
  } catch (error) {
    console.error(error);
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `User role ${req.user ? req.user.role : 'none'} is not authorized to access this route` 
      });
    }
    next();
  };
};

module.exports = { protect, optionalAuth, authorize };
