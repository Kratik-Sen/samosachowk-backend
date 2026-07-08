const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const PushToken = require('../models/PushToken');

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

    res.json({ success: true, token: pushToken.token });
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
