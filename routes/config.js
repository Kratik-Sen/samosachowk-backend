const express = require('express');
const router = express.Router();

// @route   GET /api/config/public
// @desc    Client-safe runtime config
// @access  Public
router.get('/public', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  });
});

module.exports = router;
