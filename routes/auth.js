const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Wallet = require('../models/Wallet');
const { emitResourceChanged } = require('../realtime');

const requireEnv = (value, name) => {
  if (!value) {
    throw new Error(`${name} is required in server .env`);
  }

  return value;
};

// Generate JWT
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, requireEnv(process.env.JWT_SECRET, 'JWT_SECRET'), {
    expiresIn: '30d',
  });
};

const vendorVerificationMethods = ['email', 'whatsapp'];
const selfSignupRoles = ['customer', 'sales', 'production', 'delivery'];
const WHATSAPP_EMAIL_DOMAIN = 'whatsapp.samosachowk.in';

const normalizeEmail = (email) => String(email || '').trim().toLowerCase() || undefined;
const normalizePhone = (phone) => {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');

  if (!digits) {
    return '';
  }

  if (digits.length === 10) {
    return `+91${digits}`;
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }

  return raw.startsWith('+') ? raw : `+${digits}`;
};

const normalizeCredential = (credential) => String(credential || '').trim();
const buildWhatsAppPlaceholderEmail = (phone, role = 'vendor') => {
  const digits = String(phone || '').replace(/\D/g, '');
  const prefix = role === 'customer' ? 'customer-wa' : 'wa';
  return digits ? `${prefix}-${digits}@${WHATSAPP_EMAIL_DOMAIN}` : undefined;
};

const findUserByCredential = async (credential, role, selectPassword = false) => {
  const normalizedCredential = normalizeCredential(credential);
  const normalizedEmail = normalizedCredential.includes('@') ? normalizeEmail(normalizedCredential) : undefined;
  const normalizedPhone = normalizePhone(normalizedCredential);
  const query = {
    ...(role ? { role } : {}),
    $or: [
      ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
      ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
    ],
  };

  if (!query.$or.length) {
    return null;
  }

  const userQuery = User.findOne(query);
  return selectPassword ? userQuery.select('+password') : userQuery;
};

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

const getVendorProfileState = async (userId) => {
  const vendor = await Vendor.findOne({ user: userId });

  return {
    vendor_profile_complete: Boolean(vendor?.profile_complete),
    vendor_missing_profile_fields: vendor?.missing_profile_fields || [],
  };
};

const hashOtp = (otp) =>
  crypto
    .createHash('sha256')
    .update(`${otp}:${requireEnv(process.env.JWT_SECRET, 'JWT_SECRET')}`)
    .digest('hex');

const getOtpExpiryMinutes = () => {
  const expiryMinutes = Number(requireEnv(process.env.OTP_EXPIRY_MINUTES, 'OTP_EXPIRY_MINUTES'));

  if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
    throw new Error('OTP_EXPIRY_MINUTES must be a positive number in server .env');
  }

  return expiryMinutes;
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

const sendEmailOtp = async ({ email, name, otp, purpose = 'vendor signup' }) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const isPasswordReset = purpose === 'password reset';
  const isCustomerSignup = purpose === 'customer signup';
  const subject = isPasswordReset
    ? 'Samosa Chowk password reset OTP'
    : isCustomerSignup
      ? 'Samosa Chowk customer verification OTP'
      : 'Samosa Chowk vendor verification OTP';
  const label = isPasswordReset ? 'password reset' : isCustomerSignup ? 'customer signup' : 'vendor signup';

  if (!apiKey || !from) {
    throw new Error('Resend is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL in server .env.');
  }

  return postJson(
    'https://api.resend.com/emails',
    {
      from,
      to: [email],
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#181A16">
          <p>Hi ${escapeHtml(name || 'Vendor')},</p>
          <p>Your Samosa Chowk ${label} OTP is:</p>
          <p style="font-size:28px;font-weight:800;letter-spacing:4px">${otp}</p>
          <p>This code expires in ${getOtpExpiryMinutes()} minutes.</p>
        </div>
      `,
      text: `Your Samosa Chowk ${label} OTP is ${otp}. It expires in ${getOtpExpiryMinutes()} minutes.`,
    },
    {
      Authorization: `Bearer ${apiKey}`,
    }
  );
};

const formatMsg91WhatsAppRecipient = (phone) => {
  const countryCode = String(requireEnv(process.env.MSG91_DEFAULT_COUNTRY_CODE, 'MSG91_DEFAULT_COUNTRY_CODE')).replace(/\D/g, '');
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
  const language = requireEnv(process.env.MSG91_WHATSAPP_OTP_LANGUAGE, 'MSG91_WHATSAPP_OTP_LANGUAGE');
  const componentKey = requireEnv(process.env.MSG91_WHATSAPP_OTP_COMPONENT_KEY, 'MSG91_WHATSAPP_OTP_COMPONENT_KEY');
  const buttonKey = process.env.MSG91_WHATSAPP_OTP_BUTTON_KEY;
  const buttonType = requireEnv(process.env.MSG91_WHATSAPP_OTP_BUTTON_TYPE, 'MSG91_WHATSAPP_OTP_BUTTON_TYPE');
  const buttonSubtype = process.env.MSG91_WHATSAPP_OTP_BUTTON_SUBTYPE;
  const buttonValueTemplate = requireEnv(process.env.MSG91_WHATSAPP_OTP_BUTTON_VALUE, 'MSG91_WHATSAPP_OTP_BUTTON_VALUE');
  const recipient = formatMsg91WhatsAppRecipient(phone);

  if (!authkey || !integratedNumber || !templateName) {
    throw new Error('MSG91 WhatsApp is not configured. Add MSG91_AUTHKEY, MSG91_WHATSAPP_INTEGRATED_NUMBER, and MSG91_WHATSAPP_OTP_TEMPLATE_NAME in server .env.');
  }

  if (!recipient) {
    throw new Error('A valid mobile number is required for WhatsApp OTP.');
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

const sendSignupOtp = async ({ role, verificationMethod, email, phone, name, otp }) => {
  if (verificationMethod === 'email') {
    return sendEmailOtp({
      email,
      name,
      otp,
      purpose: role === 'customer' ? 'customer signup' : 'vendor signup',
    });
  }

  return sendWhatsAppOtp({ phone, otp });
};

const sendPasswordResetOtp = async ({ verificationMethod, email, phone, name, otp }) => {
  if (verificationMethod === 'whatsapp') {
    return sendWhatsAppOtp({ phone, otp });
  }

  return sendEmailOtp({ email, name, otp, purpose: 'password reset' });
};

const buildOtpFields = (otp, verificationMethod) => ({
  otpVerificationMethod: verificationMethod,
  otpHash: hashOtp(otp),
  otpExpiresAt: getOtpExpiry(),
  otpRequestedAt: new Date(),
  otpAttempts: 0,
});

const clearOtpFields = (user) => {
  user.otpHash = undefined;
  user.otpExpiresAt = undefined;
  user.otpRequestedAt = undefined;
  user.otpAttempts = 0;
};

const clearResetPasswordFields = (user) => {
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  user.resetPasswordRequestedAt = undefined;
  user.resetPasswordVerificationMethod = undefined;
  user.resetPasswordAttempts = 0;
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
    await Wallet.create({ user: user._id });
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

  if (!name || !password) {
    return res.status(400).json({ message: 'Name and password are required for vendor signup' });
  }

  if (!verificationMethod) {
    return res.status(400).json({ message: 'Select email or WhatsApp for OTP verification' });
  }

  if (verificationMethod === 'email' && !email) {
    return res.status(400).json({ message: 'Email is required for email OTP verification' });
  }

  if (verificationMethod === 'whatsapp' && !phone) {
    return res.status(400).json({ message: 'WhatsApp mobile number is required for OTP verification' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  const existingUser = await User.findOne(
    verificationMethod === 'email'
      ? { email }
      : { phone, role: 'vendor' }
  ).select('+password');

  if (existingUser && (existingUser.role !== 'vendor' || existingUser.status !== 'pending' || existingUser.otpVerifiedAt)) {
    return res.status(400).json({
      message: verificationMethod === 'email' ? 'This email is already registered' : 'This WhatsApp number is already registered',
    });
  }

  const otp = generateOtp();
  await sendSignupOtp({ role: 'vendor', verificationMethod, email, phone, name, otp });
  const accountEmail = email || buildWhatsAppPlaceholderEmail(phone, 'vendor');

  let user = existingUser;
  const otpFields = buildOtpFields(otp, verificationMethod);

  if (user) {
    user.name = name;
    user.email = accountEmail;
    user.phone = phone;
    user.password = password;
    user.status = 'pending';
    user.availability_status = 'inactive';
    Object.assign(user, otpFields);
    await user.save();
  } else {
    user = await User.create({
      name,
      email: accountEmail,
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

const registerCustomer = async (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);
  const verificationMethod = vendorVerificationMethods.includes(req.body.verificationMethod)
    ? req.body.verificationMethod
    : '';

  if (!name || !password) {
    return res.status(400).json({ message: 'Name and password are required for customer signup' });
  }

  if (!verificationMethod) {
    return res.status(400).json({ message: 'Select email or WhatsApp for OTP verification' });
  }

  if (verificationMethod === 'email' && !email) {
    return res.status(400).json({ message: 'Email is required for email OTP verification' });
  }

  if (verificationMethod === 'whatsapp' && !phone) {
    return res.status(400).json({ message: 'WhatsApp mobile number is required for OTP verification' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  const existingUser = await User.findOne(
    verificationMethod === 'email'
      ? { email }
      : { phone, role: 'customer' }
  ).select('+password');

  if (existingUser && (existingUser.role !== 'customer' || existingUser.status !== 'pending' || existingUser.otpVerifiedAt)) {
    return res.status(400).json({
      message: verificationMethod === 'email' ? 'This email is already registered' : 'This WhatsApp number is already registered',
    });
  }

  const otp = generateOtp();
  await sendSignupOtp({ role: 'customer', verificationMethod, email, phone, name, otp });
  const accountEmail = email || buildWhatsAppPlaceholderEmail(phone, 'customer');
  const otpFields = buildOtpFields(otp, verificationMethod);
  let user = existingUser;

  if (user) {
    user.name = name;
    user.email = accountEmail;
    user.phone = phone;
    user.password = password;
    user.status = 'pending';
    user.availability_status = 'inactive';
    Object.assign(user, otpFields);
    await user.save();
  } else {
    user = await User.create({
      name,
      email: accountEmail,
      phone,
      password,
      role: 'customer',
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
        ? 'OTP sent to your WhatsApp number. Verify it to activate your customer account.'
        : 'OTP sent to your email. Verify it to activate your customer account.',
  });
  emitResourceChanged(req, {
    domains: ['users', 'admin'],
    action: 'customer-otp-sent',
    entity: 'user',
    entityId: user._id,
  });
};

// @route   POST /api/auth/register
// @desc    Customer/team self signup request or vendor OTP signup
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;

    if (role === 'vendor') {
      return registerVendor(req, res);
    }

    if (role === 'customer') {
      return registerCustomer(req, res);
    }

    if (!selfSignupRoles.includes(role)) {
      return res.status(403).json({
        message: 'Select customer, vendor, sales, production, or delivery for signup.',
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
    const phone = normalizePhone(req.body.phone);
    const otp = String(req.body.otp || '').trim();

    if ((!email && !phone) || !otp) {
      return res.status(400).json({ message: 'Selected contact and OTP are required' });
    }

    const user = await User.findOne({
      role: 'vendor',
      $or: [
        ...(email ? [{ email }] : []),
        ...(phone ? [{ phone }] : []),
      ],
    });

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

    const verifiedMethod = user.otpVerificationMethod;

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
      verificationMethod: verifiedMethod,
      ...(await getVendorProfileState(user._id)),
      message: `Vendor account verified. Login with ${verifiedMethod === 'whatsapp' ? 'phone' : 'email'} to complete your outlet details.`,
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

// @route   POST /api/auth/customer/verify-otp
// @desc    Verify customer signup OTP and activate account
// @access  Public
router.post('/customer/verify-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const otp = String(req.body.otp || '').trim();

    if ((!email && !phone) || !otp) {
      return res.status(400).json({ message: 'Selected contact and OTP are required' });
    }

    const user = await User.findOne({
      role: 'customer',
      $or: [
        ...(email ? [{ email }] : []),
        ...(phone ? [{ phone }] : []),
      ],
    });

    if (!user) {
      return res.status(404).json({ message: 'Customer signup request not found' });
    }

    if (user.status === 'active' && user.otpVerifiedAt) {
      return res.json({ message: 'Customer account is already verified. You can login now.' });
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

    const verifiedMethod = user.otpVerificationMethod;

    user.status = 'active';
    user.otpVerifiedAt = new Date();
    clearOtpFields(user);
    await user.save();

    res.json({
      _id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      verificationMethod: verifiedMethod,
      message: `Customer account verified. Login with ${verifiedMethod === 'whatsapp' ? 'phone' : 'email'} to order.`,
    });
    emitResourceChanged(req, {
      domains: ['users', 'admin'],
      action: 'customer-verified',
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
    const requestPhone = normalizePhone(req.body.phone);
    const requestedMethod = vendorVerificationMethods.includes(req.body.verificationMethod)
      ? req.body.verificationMethod
      : '';

    if (!email && !requestPhone) {
      return res.status(400).json({ message: 'Selected contact is required' });
    }

    const user = await User.findOne({
      role: 'vendor',
      $or: [
        ...(email ? [{ email }] : []),
        ...(requestPhone ? [{ phone: requestPhone }] : []),
      ],
    }).select('+password');

    if (!user || user.status !== 'pending' || user.otpVerifiedAt) {
      return res.status(404).json({ message: 'Pending vendor signup request not found' });
    }

    const verificationMethod = requestedMethod || user.otpVerificationMethod || 'email';
    const phone = requestPhone || normalizePhone(user.phone);

    if (verificationMethod === 'whatsapp' && !phone) {
      return res.status(400).json({ message: 'Vendor mobile number is required for WhatsApp OTP' });
    }

    const otp = generateOtp();
    await sendSignupOtp({
      role: 'vendor',
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

// @route   POST /api/auth/customer/resend-otp
// @desc    Resend customer signup OTP
// @access  Public
router.post('/customer/resend-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const requestPhone = normalizePhone(req.body.phone);
    const requestedMethod = vendorVerificationMethods.includes(req.body.verificationMethod)
      ? req.body.verificationMethod
      : '';

    if (!email && !requestPhone) {
      return res.status(400).json({ message: 'Selected contact is required' });
    }

    const user = await User.findOne({
      role: 'customer',
      $or: [
        ...(email ? [{ email }] : []),
        ...(requestPhone ? [{ phone: requestPhone }] : []),
      ],
    }).select('+password');

    if (!user || user.status !== 'pending' || user.otpVerifiedAt) {
      return res.status(404).json({ message: 'Pending customer signup request not found' });
    }

    const verificationMethod = requestedMethod || user.otpVerificationMethod || 'email';
    const phone = requestPhone || normalizePhone(user.phone);

    if (verificationMethod === 'whatsapp' && !phone) {
      return res.status(400).json({ message: 'Customer mobile number is required for WhatsApp OTP' });
    }

    const otp = generateOtp();
    await sendSignupOtp({
      role: 'customer',
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
      action: 'customer-otp-resent',
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
    const credential = normalizeCredential(email);
    const normalizedEmail = normalizeEmail(email);

    if (!role) {
      return res.status(400).json({ message: 'Select a login role first' });
    }

    if (!credential || !password) {
      return res.status(400).json({ message: 'Email or phone and password are required' });
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
        name: requireEnv(process.env.ADMIN_NAME, 'ADMIN_NAME'),
        email: adminEmail,
        phone: '',
        role: 'admin',
        status: 'active',
        availability_status: 'inactive',
        token: generateToken('env-admin', 'admin'),
      });
    }

    const user = await findUserByCredential(credential, role, true);

    if (!user) {
      return res.status(404).json({ message: 'account not exist please signup' });
    }

    if (await user.matchPassword(password)) {
      if (user.role !== role) {
        return res.status(401).json({ message: `This credential is not for ${role} login` });
      }

      if (user.status === 'pending') {
        if (user.role === 'vendor' && (user.otpHash || user.otpExpiresAt)) {
          return res.status(403).json({ message: 'Please verify your vendor OTP before login' });
        }

        if (user.role === 'customer' && (user.otpHash || user.otpExpiresAt)) {
          return res.status(403).json({ message: 'Please verify your customer OTP before login' });
        }

        return res.status(403).json({ message: 'Your signup request is waiting for admin verification' });
      }

      if (user.status === 'suspended') {
        return res.status(403).json({ message: 'This account is suspended' });
      }

      user.lastLoginAt = new Date();
      await user.save();

      const vendorProfileState = user.role === 'vendor' ? await getVendorProfileState(user._id) : {};
      
      res.json({
        _id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        availability_status: user.availability_status || 'inactive',
        ...vendorProfileState,
        token: generateToken(user._id, user.role),
      });
    } else {
      res.status(401).json({ message: 'Invalid email/phone or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Send password reset OTP by the user's preferred verification method
// @access  Public
router.post('/forgot-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { role } = req.body;

    if (role === 'admin') {
      return res.json({
        message: 'Admin password is managed from server .env only.',
      });
    }

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email, ...(role ? { role } : {}) });

    if (user) {
      if (user.status === 'suspended') {
        return res.status(403).json({ message: 'This account is suspended. Contact admin.' });
      }

      const verificationMethod =
        user.role === 'vendor' && user.otpVerificationMethod === 'whatsapp' ? 'whatsapp' : 'email';

      if (verificationMethod === 'whatsapp' && !user.phone) {
        return res.status(400).json({ message: 'No registered WhatsApp number found for this account.' });
      }

      const otp = generateOtp();
      await sendPasswordResetOtp({
        verificationMethod,
        email: user.email,
        phone: user.phone,
        name: user.name,
        otp,
      });

      user.resetPasswordToken = hashOtp(otp);
      user.resetPasswordExpire = getOtpExpiry();
      user.resetPasswordRequestedAt = new Date();
      user.resetPasswordVerificationMethod = verificationMethod;
      user.resetPasswordAttempts = 0;
      await user.save();

      emitResourceChanged(req, {
        domains: ['users', 'admin'],
        action: 'password-reset-requested',
        entity: 'user',
        entityId: user._id,
        roles: ['admin'],
      });

      return res.json({
        verificationMethod,
        expiresInMinutes: getOtpExpiryMinutes(),
        message:
          verificationMethod === 'whatsapp'
            ? 'Password reset OTP sent to your registered WhatsApp number.'
            : 'Password reset OTP sent to your registered email.',
      });
    }

    res.json({
      message: 'If this account exists, a password reset OTP will be sent.',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset account password using OTP
// @access  Public
router.post('/reset-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || '').trim();
    const password = String(req.body.password || '');
    const { role } = req.body;

    if (role === 'admin') {
      return res.status(400).json({ message: 'Admin password is managed from server .env only.' });
    }

    if (!email || !otp || !password) {
      return res.status(400).json({ message: 'Email, OTP, and new password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const user = await User.findOne({ email, ...(role ? { role } : {}) }).select('+password');

    if (!user) {
      return res.status(404).json({ message: 'Reset request not found' });
    }

    if (!user.resetPasswordToken || !user.resetPasswordExpire) {
      return res.status(400).json({ message: 'No active reset OTP found. Request a new OTP.' });
    }

    if (user.resetPasswordExpire.getTime() < Date.now()) {
      clearResetPasswordFields(user);
      await user.save();
      return res.status(400).json({ message: 'Reset OTP expired. Request a new OTP.' });
    }

    if ((user.resetPasswordAttempts || 0) >= 5) {
      return res.status(429).json({ message: 'Too many OTP attempts. Request a new OTP.' });
    }

    if (hashOtp(otp) !== user.resetPasswordToken) {
      user.resetPasswordAttempts = (user.resetPasswordAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    user.password = password;
    clearResetPasswordFields(user);
    await user.save();

    emitResourceChanged(req, {
      domains: ['users', 'admin'],
      action: 'password-reset-completed',
      entity: 'user',
      entityId: user._id,
      roles: ['admin'],
    });

    res.json({ message: 'Password reset successfully. You can login with the new password.' });
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
