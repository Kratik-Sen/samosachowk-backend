const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { emitResourceChanged } = require('../realtime');

// Generate JWT
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

const selfSignupRoles = ['sales', 'production', 'delivery'];

// @route   POST /api/auth/register
// @desc    Team self signup request; vendor accounts are admin-created only
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;

    if (!selfSignupRoles.includes(role)) {
      return res.status(403).json({
        message: 'Vendor accounts are created by admin only. Select sales, production, or delivery for self signup.',
      });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });

    if (existingUser) {
      return res.status(400).json({ message: 'This email is already registered' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      phone,
      password,
      role,
      status: 'pending',
      availability_status: 'inactive',
    });

    res.status(201).json({
      _id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      message: 'Signup request sent to admin for verification. You can login after admin approval.',
    });
    emitResourceChanged(req, {
      domains: ['users', 'admin', ...(role === 'delivery' ? ['deliveries', 'sales'] : [])],
      action: 'signup-requested',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!role) {
      return res.status(400).json({ message: 'Select a login role first' });
    }

    if (role === 'admin') {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminEmail || !adminPassword) {
        return res.status(500).json({ message: 'Admin credential is not configured on the server' });
      }

      if (email.toLowerCase() !== adminEmail.toLowerCase() || password !== adminPassword) {
        return res.status(401).json({ message: 'Invalid admin email or password' });
      }

      return res.json({
        _id: 'env-admin',
        name: process.env.ADMIN_NAME || 'Samosa Chowk Admin',
        email: adminEmail,
        phone: '',
        role: 'admin',
        status: 'active',
        availability_status: 'inactive',
        token: generateToken('env-admin', 'admin'),
      });
    }

    const user = await User.findOne({ email }).select('+password');

    if (user && (await user.matchPassword(password))) {
      if (user.role !== role) {
        return res.status(401).json({ message: `This credential is not for ${role} login` });
      }

      if (user.status === 'pending') {
        return res.status(403).json({ message: 'Your signup request is waiting for admin verification' });
      }

      if (user.status === 'suspended') {
        return res.status(403).json({ message: 'This account is suspended' });
      }

      user.lastLoginAt = new Date();
      await user.save();
      
      res.json({
        _id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        availability_status: user.availability_status || 'inactive',
        token: generateToken(user._id, user.role),
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Record a password reset request for admin follow-up
// @access  Public
router.post('/forgot-password', async (req, res) => {
  try {
    const { email, role } = req.body;

    if (role === 'admin') {
      return res.json({
        message: 'Admin password is managed from server .env only.',
      });
    }

    const user = await User.findOne({ email, ...(role ? { role } : {}) });

    if (user) {
      user.resetPasswordToken = Math.random().toString(36).slice(2);
      user.resetPasswordExpire = Date.now() + 60 * 60 * 1000;
      user.resetPasswordRequestedAt = new Date();
      await user.save();

      emitResourceChanged(req, {
        domains: ['users', 'admin'],
        action: 'password-reset-requested',
        entity: 'user',
        entityId: user._id,
        roles: ['admin'],
      });
    }

    res.json({
      message: 'If this account exists, an admin can reset the password from access management.',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/bootstrap-admin
// @desc    Disabled; admin credential comes from server .env
// @access  Public
router.post('/bootstrap-admin', async (req, res) => {
  res.status(410).json({ message: 'Admin credential is configured from server .env only' });
});

module.exports = router;
