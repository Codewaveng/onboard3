require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const LaunchReward = require('../models/LaunchReward');

function jitter(base, username) {
  let hash = 0;
  for (const character of username) {
    hash = (hash * 31 + character.charCodeAt(0)) & 0xfffffff;
  }
  return Math.round((base + ((hash % 100) / 100 - 0.5) * 0.24) * 100) / 100;
}

function getReward(xp, active) {
  if (xp >= 50000) return active
    ? { amount: 4, tier: 'legend_active' }
    : { amount: 3, tier: 'legend' };
  if (xp >= 25000) return active
    ? { amount: 2, tier: 'captain_active' }
    : { amount: 1, tier: 'captain' };
  if (xp >= 10000) return active
    ? { amount: 0.75, tier: 'contributor_active' }
    : { amount: 0.5, tier: 'contributor' };
  if (xp >= 1000) return active
    ? { amount: 0.25, tier: 'citizen_active' }
    : { amount: 0.2, tier: 'citizen' };
  if (xp >= 100) return { amount: 0.1, tier: 'new' };
  return null;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  try {
    const existing = await LaunchReward.find({}).select('userId').lean();
    const existingIds = new Set(existing.map(reward => reward.userId.toString()));
    const users = await User.find({})
      .select('username xp walletAddress lastLogin twitter')
      .lean();
    const now = Date.now();
    const activeSince = now - 7 * 24 * 60 * 60 * 1000;
    const rewards = [];

    for (const user of users) {
      if (['admin', 'server'].includes(user.username.toLowerCase())) continue;
      if (existingIds.has(user._id.toString())) continue;

      const xp = user.xp || 0;
      const active = user.lastLogin && new Date(user.lastLogin).getTime() >= activeSince;
      const reward = getReward(xp, active);
      if (!reward) continue;

      rewards.push({
        userId: user._id,
        username: user.username,
        walletAddress: user.walletAddress || null,
        amount: jitter(reward.amount, user.username),
        tier: reward.tier,
        xp,
        twitterHandle: user.twitter || null,
        status: 'pending'
      });
    }

    if (rewards.length) {
      await LaunchReward.insertMany(rewards, { ordered: false });
    }

    const total = rewards.reduce((sum, reward) => sum + reward.amount, 0);
    console.log(`Seeded ${rewards.length} new reward records; total pending: $${total.toFixed(2)}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error('Launch reward seeding failed:', error);
  process.exitCode = 1;
});
