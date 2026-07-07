const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Wallet = require('../models/Wallet');
const { emitResourceChanged } = require('../realtime');

const REDEEM_MIN_POINTS = 3000;

// @route   GET /api/wallet
// @desc    Get current user wallet balance
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ user: req.user.id });
    
    if (!wallet) {
      wallet = await Wallet.create({ user: req.user.id });
    }
    
    res.json(wallet);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/wallet/redeem
// @desc    Request reward coin redemption for admin review
// @access  Private (Vendor)
router.post('/redeem', protect, authorize('vendor'), async (req, res) => {
  try {
    const { points, notes } = req.body;
    const redeemPoints = Number(points || REDEEM_MIN_POINTS);

    if (redeemPoints < REDEEM_MIN_POINTS) {
      return res.status(400).json({ message: `Collect ${REDEEM_MIN_POINTS} reward coins before redeeming` });
    }

    let wallet = await Wallet.findOne({ user: req.user.id });

    if (!wallet) {
      wallet = await Wallet.create({ user: req.user.id });
    }

    if (wallet.reward_points < redeemPoints) {
      return res.status(400).json({ message: 'Not enough reward coins' });
    }

    const hasPendingRequest = (wallet.reward_redemptions || []).some((request) => request.status === 'pending');

    if (hasPendingRequest) {
      return res.status(400).json({ message: 'A redeem request is already pending with admin' });
    }

    wallet.reward_redemptions.unshift({
      points: redeemPoints,
      notes,
      status: 'pending',
      requestedAt: new Date(),
    });
    wallet.transactions.unshift({
      title: 'Reward redeem request sent',
      type: 'redemption',
      points: redeemPoints,
      status: 'pending',
      notes: notes || 'Waiting for admin verification.',
    });

    const updatedWallet = await wallet.save();
    res.json(updatedWallet);
    emitResourceChanged(req, {
      domains: ['wallet', 'vendors', 'admin', 'rewards'],
      action: 'redeem-requested',
      entity: 'reward-redemption',
      entityId: wallet._id,
      audienceUsers: [req.user.id],
      audienceRoles: ['admin'],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
