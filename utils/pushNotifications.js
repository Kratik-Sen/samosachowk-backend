const PushToken = require('../models/PushToken');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH_SIZE = 100;

const uniqueStrings = (values = []) =>
  Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));

const isExpoPushToken = (token) => /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(String(token || '').trim());

const chunk = (items, size) => {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const resolvePushTokens = async ({ users = [], roles = [] } = {}) => {
  const userIds = uniqueStrings(users);
  const roleNames = uniqueStrings(roles);

  if (!userIds.length && !roleNames.length) {
    return [];
  }

  const query = {
    active: true,
    $or: [
      ...(userIds.length ? [{ user_id: { $in: userIds } }] : []),
      ...(roleNames.length ? [{ role: { $in: roleNames } }] : []),
    ],
  };
  const docs = await PushToken.find(query).select('token').lean();

  return uniqueStrings(docs.map((doc) => doc.token)).filter(isExpoPushToken);
};

const deactivateTokens = async (tokens, lastError = 'DeviceNotRegistered') => {
  const tokenList = uniqueStrings(tokens);

  if (!tokenList.length) {
    return;
  }

  await PushToken.updateMany({ token: { $in: tokenList } }, { active: false, last_error: lastError });
};

const markTokensSent = async (tokens) => {
  const tokenList = uniqueStrings(tokens);

  if (!tokenList.length) {
    return;
  }

  await PushToken.updateMany(
    { token: { $in: tokenList } },
    { last_sent_at: new Date(), last_error: '' }
  );
};

const markTokenErrors = async (errors) => {
  const entries = Object.entries(errors || {});

  await Promise.all(
    entries.map(([token, error]) =>
      PushToken.updateOne(
        { token },
        { last_error: error || 'Expo push ticket error' }
      )
    )
  );
};

const sendExpoPushNotifications = async ({ users = [], roles = [], title, body, data = {} }) => {
  if (!title || !body || typeof fetch !== 'function') {
    return { sent: 0 };
  }

  const tokens = await resolvePushTokens({ users, roles });

  if (!tokens.length) {
    return { sent: 0 };
  }

  const inactiveTokens = [];
  const ticketErrors = {};
  const sentTokens = [];

  for (const batch of chunk(tokens, MAX_BATCH_SIZE)) {
    const messages = batch.map((to) => ({
      to,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
      channelId: 'orders',
    }));

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(result?.errors?.[0]?.message || 'Expo push request failed');
    }

    (result?.data || []).forEach((ticket, index) => {
      const token = batch[index];

      if (ticket?.details?.error === 'DeviceNotRegistered') {
        inactiveTokens.push(token);
        return;
      }

      if (ticket?.status === 'error') {
        ticketErrors[token] = ticket?.details?.error || ticket?.message || 'Expo push ticket error';
        return;
      }

      sentTokens.push(token);
    });
  }

  await Promise.all([
    markTokensSent(sentTokens),
    markTokenErrors(ticketErrors),
    deactivateTokens(inactiveTokens),
  ]);

  if (Object.keys(ticketErrors).length) {
    console.warn('Expo push ticket errors:', ticketErrors);
  }

  return {
    sent: sentTokens.length,
    failed: Object.keys(ticketErrors).length,
    deactivated: inactiveTokens.length,
  };
};

module.exports = {
  sendExpoPushNotifications,
};
