const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const PushToken = require('../models/PushToken');
const { sendExpoPushNotifications } = require('../utils/pushNotifications');

const isExpoPushToken = (token) => /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(String(token || '').trim());

// @route   POST /api/notifications/push-token
// @desc    Register this device for Expo push notifications
// @access  Private
router.post('/push-token', protect, async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();

    if (!isExpoPushToken(token)) {
      return res.status(400).json({ message: 'Valid Expo push token is required' });
    }

    const pushToken = await PushToken.findOneAndUpdate(
      { token },
      {
        token,
        user_id: String(req.user.id),
        role: req.user.role,
        platform: String(req.body.platform || ''),
        active: true,
        last_registered_at: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      token: pushToken.token,
      active: pushToken.active,
      last_registered_at: pushToken.last_registered_at,
      last_sent_at: pushToken.last_sent_at,
      last_error: pushToken.last_error || '',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/notifications/status
// @desc    Check whether this user has active Expo push tokens
// @access  Private
router.get('/status', protect, async (req, res) => {
  try {
    const tokens = await PushToken.find({
      user_id: String(req.user.id),
      active: true,
    })
      .sort('-last_registered_at')
      .select('platform last_registered_at last_sent_at last_error')
      .lean();

    res.json({
      active: tokens.length > 0,
      count: tokens.length,
      latest: tokens[0] || null,
      tokens,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/notifications/test
// @desc    Send a test push to the logged-in user
// @access  Private
router.post('/test', protect, async (req, res) => {
  try {
    const result = await sendExpoPushNotifications({
      users: [req.user.id],
      title: 'Samosa Chowk test',
      body: 'Push notifications are connected on this device.',
      data: { type: 'push-test', userId: req.user.id, createdAt: new Date().toISOString() },
    });

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/notifications/push-token
// @desc    Deactivate this device token for the logged-in user
// @access  Private
router.delete('/push-token', protect, async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();

    if (!token) {
      return res.json({ success: true });
    }

    await PushToken.updateOne(
      { token, user_id: String(req.user.id) },
      { active: false }
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
