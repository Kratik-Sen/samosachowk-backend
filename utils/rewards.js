const Product = require('../models/Product');
const Wallet = require('../models/Wallet');

const normalizeCoins = (value) => {
  const coins = Number(value || 0);
  return Number.isFinite(coins) ? Math.max(0, Math.floor(coins)) : 0;
};

const getItemProductId = (item) => {
  const product = item?.product;
  return (product?._id || product || '').toString();
};

const attachRewardCoinsToItems = async (items = []) => {
  const productIds = Array.from(new Set(items.map(getItemProductId).filter(Boolean)));
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).select('reward_coins').lean()
    : [];
  const coinsByProduct = products.reduce((acc, product) => {
    acc[product._id.toString()] = normalizeCoins(product.reward_coins);
    return acc;
  }, {});

  return items.map((item) => {
    const productId = getItemProductId(item);

    return {
      ...item,
      quantity: Math.max(0, Number(item.quantity || 0)),
      reward_coins: coinsByProduct[productId] ?? normalizeCoins(item.reward_coins),
    };
  });
};

const getOrderRewardCoins = (order) =>
  (order.items || []).reduce((sum, item) => {
    return sum + normalizeCoins(item.reward_coins) * Math.max(0, Number(item.quantity || 0));
  }, 0);

const hydrateMissingRewardCoins = async (order) => {
  const items = order.items || [];
  const hasMissingSnapshot = items.some((item) => item.reward_coins === undefined || item.reward_coins === null);

  if (!hasMissingSnapshot) {
    return;
  }

  const hydratedItems = await attachRewardCoinsToItems(
    items.map((item) => (item.toObject ? item.toObject() : item))
  );

  hydratedItems.forEach((item, index) => {
    order.items[index].reward_coins = item.reward_coins;
  });
};

const awardDeliveredOrderRewards = async ({ order }) => {
  if (!order?.user || order.customer_role !== 'vendor' || order.reward_points_awarded_at) {
    return null;
  }

  await hydrateMissingRewardCoins(order);
  const pointsAwarded = getOrderRewardCoins(order);
  order.reward_points_awarded = pointsAwarded;
  order.reward_points_awarded_at = new Date();

  if (!pointsAwarded) {
    return { pointsAwarded };
  }

  let wallet = await Wallet.findOne({ user: order.user });

  if (!wallet) {
    wallet = await Wallet.create({ user: order.user });
  }

  wallet.reward_points += pointsAwarded;
  wallet.transactions.unshift({
    title: 'Delivered order coins',
    type: 'reward',
    points: pointsAwarded,
    order: order._id,
    notes: `Coins earned after delivery for order ${order._id?.toString().slice(-6).toUpperCase()}.`,
  });

  await wallet.save();
  return { wallet, pointsAwarded };
};

module.exports = {
  attachRewardCoinsToItems,
  awardDeliveredOrderRewards,
  normalizeCoins,
};
