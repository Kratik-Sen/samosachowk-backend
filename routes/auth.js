const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Wallet = require('../models/Wallet');
const { emitResourceChanged } = require('../realtime');

// Generate JWT
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

const vendorVerificationMethods = ['email', 'whatsapp'];
const selfSignupRoles = ['sales', 'production', 'delivery'];

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const normalizePhone = (phone) => String(phone || '').trim();

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

const hashOtp = (otp) =>
  crypto
    .createHash('sha256')
    .update(`${otp}:${process.env.JWT_SECRET || 'samosa-chowk'}`)
    .digest('hex');

const getOtpExpiryMinutes = () => {
  const expiryMinutes = Number(process.env.OTP_EXPIRY_MINUTES || 10);
  return Number.isFinite(expiryMinutes) && expiryMinutes > 0 ? expiryMinutes : 10;
};

const getOtpExpiry = () => {
  return new Date(Date.now() + getOtpExpiryMinutes() * 60 * 1000);
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const postJson = async (url, body, headers = {}) => {
  if (typeof fetch !== 'function') {
    throw new Error('This Node.js runtime does not support fetch. Use Node 18+ for OTP delivery.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let data = null;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error || responseText || 'OTP service request failed');
  }

  return data;
};

const sendEmailOtp = async ({ email, name, otp }) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    throw new Error('Resend is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL in server .env.');
  }

  return postJson(
    'https://api.resend.com/emails',
    {
      from,
      to: [email],
      subject: 'Samosa Chowk vendor verification OTP',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#181A16">
          <p>Hi ${escapeHtml(name || 'Vendor')},</p>
          <p>Your Samosa Chowk vendor signup OTP is:</p>
          <p style="font-size:28px;font-weight:800;letter-spacing:4px">${otp}</p>
          <p>This code expires in ${getOtpExpiryMinutes()} minutes.</p>
        </div>
      `,
      text: `Your Samosa Chowk vendor signup OTP is ${otp}. It expires in ${getOtpExpiryMinutes()} minutes.`,
    },
    {
      Authorization: `Bearer ${apiKey}`,
    }
  );
};

const formatMsg91WhatsAppRecipient = (phone) => {
  const countryCode = String(process.env.MSG91_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '');
  let digits = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');

  if (digits.length === 10 && countryCode) {
    digits = `${countryCode}${digits}`;
  }

  return digits;
};

const resolveMsg91TemplateValue = (value, variables) =>
  String(value || '').replace(/\{\{\s*(otp|phone|recipient)\s*\}\}/gi, (_, key) => {
    const normalizedKey = key.toLowerCase();
    return variables[normalizedKey] || '';
  });

const sendWhatsAppOtp = async ({ phone, otp }) => {
  const authkey = process.env.MSG91_AUTHKEY;
  const integratedNumber = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER;
  const templateName = process.env.MSG91_WHATSAPP_OTP_TEMPLATE_NAME;
  const namespace = process.env.MSG91_WHATSAPP_OTP_TEMPLATE_NAMESPACE;
  const language = process.env.MSG91_WHATSAPP_OTP_LANGUAGE || 'en';
  const componentKey = process.env.MSG91_WHATSAPP_OTP_COMPONENT_KEY || 'body_1';
  const buttonKey = process.env.MSG91_WHATSAPP_OTP_BUTTON_KEY;
  const buttonType = process.env.MSG91_WHATSAPP_OTP_BUTTON_TYPE || 'text';
  const buttonSubtype = process.env.MSG91_WHATSAPP_OTP_BUTTON_SUBTYPE;
  const buttonValueTemplate = process.env.MSG91_WHATSAPP_OTP_BUTTON_VALUE || '{{otp}}';
  const recipient = formatMsg91WhatsAppRecipient(phone);

  if (!authkey || !integratedNumber || !templateName) {
    throw new Error('MSG91 WhatsApp is not configured. Add MSG91_AUTHKEY, MSG91_WHATSAPP_INTEGRATED_NUMBER, and MSG91_WHATSAPP_OTP_TEMPLATE_NAME in server .env.');
  }

  if (!recipient) {
    throw new Error('A valid vendor mobile number is required for WhatsApp OTP.');
  }

  const components = {
    [componentKey]: {
      type: 'text',
      value: otp,
    },
  };

  if (buttonKey) {
    const buttonComponent = {
      type: buttonType,
      value: resolveMsg91TemplateValue(buttonValueTemplate, {
        otp,
        phone,
        recipient,
      }),
    };

    if (buttonSubtype) {
      buttonComponent.subtype = buttonSubtype;
    }

    components[buttonKey] = buttonComponent;
  }

  const template = {
    name: templateName,
    language: {
      code: language,
      policy: 'deterministic',
    },
    to_and_components: [
      {
        to: [recipient],
        components,
      },
    ],
  };

  if (namespace) {
    template.namespace = namespace;
  }

  return postJson(
    'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
    {
      integrated_number: integratedNumber,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template,
      },
    },
    {
      authkey,
    }
  );
};

const sendVendorOtp = async ({ verificationMethod, email, phone, name, otp }) => {
  if (verificationMethod === 'email') {
    return sendEmailOtp({ email, name, otp });
  }

  return sendWhatsAppOtp({ phone, otp });
};

const buildOtpFields = (otp, verificationMethod) => ({
  otpVerificationMethod: verificationMethod,
  otpHash: hashOtp(otp),
  otpExpiresAt: getOtpExpiry(),
  otpRequestedAt: new Date(),
  otpAttempts: 0,
});

const clearOtpFields = (user) => {
  user.otpVerificationMethod = undefined;
  user.otpHash = undefined;
  user.otpExpiresAt = undefined;
  user.otpRequestedAt = undefined;
  user.otpAttempts = 0;
};

const buildReferralCode = (storeName) => {
  const prefix = storeName.replace(/[^a-z0-9]/gi, '').substring(0, 4).toUpperCase() || 'VEND';
  return `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
};

const buildUniqueReferralCode = async (storeName) => {
  let referralCode = buildReferralCode(storeName);
  let attempts = 0;

  while (attempts < 5 && (await Vendor.exists({ referral_code: referralCode }))) {
    referralCode = buildReferralCode(storeName);
    attempts += 1;
  }

  return referralCode;
};

const ensureVendorAccountBundle = async (user) => {
  const storeName = `${user.name}'s Outlet`;
  const existingVendor = await Vendor.findOne({ user: user._id });

  if (!existingVendor) {
    await Vendor.create({
      user: user._id,
      store_name: storeName,
      owner_name: user.name,
      location: {
        address: 'Not provided',
        city: 'Not provided',
        state: 'Not provided',
        zip: '',
      },
      referral_code: await buildUniqueReferralCode(storeName),
      auto_approved: true,
    });
  }

  const existingWallet = await Wallet.findOne({ user: user._id });

  if (!existingWallet) {
    await Wallet.create({
      user: user._id,
      transactions: [
        {
          title: 'Vendor account activated',
          type: 'reward',
          points: 100,
          notes: 'OTP-verified vendor signup',
        },
      ],
      reward_points: 100,
    });
  }
};

const registerVendor = async (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);
  const verificationMethod = vendorVerificationMethods.includes(req.body.verificationMethod)
    ? req.body.verificationMethod
    : '';

  if (!name || !email || !phone || !password) {
    return res.status(400).json({ message: 'Name, email, mobile number, and password are required for vendor signup' });
  }

  if (!verificationMethod) {
    return res.status(400).json({ message: 'Select email or WhatsApp for OTP verification' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  const existingUser = await User.findOne({ email }).select('+password');

  if (existingUser && (existingUser.role !== 'vendor' || existingUser.status !== 'pending' || existingUser.otpVerifiedAt)) {
    return res.status(400).json({ message: 'This email is already registered' });
  }

  const otp = generateOtp();
  await sendVendorOtp({ verificationMethod, email, phone, name, otp });

  let user = existingUser;
  const otpFields = buildOtpFields(otp, verificationMethod);

  if (user) {
    user.name = name;
    user.phone = phone;
    user.password = password;
    user.status = 'pending';
    user.availability_status = 'inactive';
    Object.assign(user, otpFields);
    await user.save();
  } else {
    user = await User.create({
      name,
      email,
      phone,
      password,
      role: 'vendor',
      status: 'pending',
      availability_status: 'inactive',
      ...otpFields,
    });
  }

  res.status(existingUser ? 200 : 201).json({
    _id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    verificationMethod,
    message:
      verificationMethod === 'whatsapp'
        ? 'OTP sent to your WhatsApp number. Verify it to activate your vendor account.'
        : 'OTP sent to your email. Verify it to activate your vendor account.',
  });
  emitResourceChanged(req, {
    domains: ['users', 'admin'],
    action: 'vendor-otp-sent',
    entity: 'user',
    entityId: user._id,
  });
};

// @route   POST /api/auth/register
// @desc    Team self signup request or vendor OTP signup
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;

    if (role === 'vendor') {
      return registerVendor(req, res);
    }

    if (!selfSignupRoles.includes(role)) {
      return res.status(403).json({
        message: 'Select vendor, sales, production, or delivery for signup.',
      });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    const normalizedEmail = normalizeEmail(email);
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(400).json({ message: 'This email is already registered' });
    }

    const user = await User.create({
      name,
      email: normalizedEmail,
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

// @route   POST /api/auth/vendor/verify-otp
// @desc    Verify vendor signup OTP and activate account
// @access  Public
router.post('/vendor/verify-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || '').trim();

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const user = await User.findOne({ email, role: 'vendor' });

    if (!user) {
      return res.status(404).json({ message: 'Vendor signup request not found' });
    }

    if (user.status === 'active' && user.otpVerifiedAt) {
      return res.json({ message: 'Vendor account is already verified. You can login now.' });
    }

    if (!user.otpHash || !user.otpExpiresAt) {
      return res.status(400).json({ message: 'No active OTP found. Request a new OTP.' });
    }

    if (user.otpExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired. Request a new OTP.' });
    }

    if ((user.otpAttempts || 0) >= 5) {
      return res.status(429).json({ message: 'Too many OTP attempts. Request a new OTP.' });
    }

    if (hashOtp(otp) !== user.otpHash) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    user.status = 'active';
    user.otpVerifiedAt = new Date();
    clearOtpFields(user);
    await user.save();
    await ensureVendorAccountBundle(user);

    res.json({
      _id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      message: 'Vendor account verified. You can login now.',
    });
    emitResourceChanged(req, {
      domains: ['users', 'vendors', 'wallet', 'admin', 'sales'],
      action: 'vendor-verified',
      entity: 'user',
      entityId: user._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/vendor/resend-otp
// @desc    Resend vendor signup OTP
// @access  Public
router.post('/vendor/resend-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const requestedMethod = vendorVerificationMethods.includes(req.body.verificationMethod)
      ? req.body.verificationMethod
      : '';

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email, role: 'vendor' }).select('+password');

    if (!user || user.status !== 'pending' || user.otpVerifiedAt) {
      return res.status(404).json({ message: 'Pending vendor signup request not found' });
    }

    const verificationMethod = requestedMethod || user.otpVerificationMethod || 'email';
    const phone = normalizePhone(req.body.phone || user.phone);

    if (verificationMethod === 'whatsapp' && !phone) {
      return res.status(400).json({ message: 'Vendor mobile number is required for WhatsApp OTP' });
    }

    const otp = generateOtp();
    await sendVendorOtp({
      verificationMethod,
      email: user.email,
      phone,
      name: user.name,
      otp,
    });

    user.phone = phone || user.phone;
    Object.assign(user, buildOtpFields(otp, verificationMethod));
    await user.save();

    res.json({
      verificationMethod,
      message:
        verificationMethod === 'whatsapp'
          ? 'New OTP sent to your WhatsApp number.'
          : 'New OTP sent to your email.',
    });
    emitResourceChanged(req, {
      domains: ['users'],
      action: 'vendor-otp-resent',
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
    const normalizedEmail = normalizeEmail(email);

    if (!role) {
      return res.status(400).json({ message: 'Select a login role first' });
    }

    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (role === 'admin') {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminEmail || !adminPassword) {
        return res.status(500).json({ message: 'Admin credential is not configured on the server' });
      }

      if (normalizedEmail !== adminEmail.toLowerCase() || password !== adminPassword) {
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

    const user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (user && (await user.matchPassword(password))) {
      if (user.role !== role) {
        return res.status(401).json({ message: `This credential is not for ${role} login` });
      }

      if (user.status === 'pending') {
        if (user.role === 'vendor' && (user.otpHash || user.otpExpiresAt)) {
          return res.status(403).json({ message: 'Please verify your vendor OTP before login' });
        }

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
