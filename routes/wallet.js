const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Wallet = require('../models/Wallet');
const { emitResourceChanged } = require('../realtime');

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
// @desc    Redeem reward points
// @access  Private
router.post('/redeem', protect, async (req, res) => {
  try {
    const { points, notes } = req.body;
    const redeemPoints = Number(points || 0);

    if (redeemPoints <= 0) {
      return res.status(400).json({ message: 'Enter points to redeem' });
    }

    let wallet = await Wallet.findOne({ user: req.user.id });

    if (!wallet) {
      wallet = await Wallet.create({ user: req.user.id });
    }

    if (wallet.reward_points < redeemPoints) {
      return res.status(400).json({ message: 'Not enough reward points' });
    }

    wallet.reward_points -= redeemPoints;
    wallet.balance += redeemPoints;
    wallet.transactions.unshift({
      title: 'Reward redemption',
      type: 'redemption',
      amount: redeemPoints,
      points: redeemPoints,
      notes,
    });

    const updatedWallet = await wallet.save();
    res.json(updatedWallet);
    emitResourceChanged(req, {
      domains: ['wallet', 'vendors', 'admin'],
      action: 'redeemed',
      entity: 'wallet',
      entityId: wallet._id,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
