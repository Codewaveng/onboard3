require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('Connected to DB');

  const from = new Date('2026-10-19T00:00:00.000Z');
  const to   = new Date('2026-10-24T23:59:59.999Z');

  const users = await User.find({
    'recentActivity': {
      $elemMatch: {
        action: /swept.*USDC|USDCx.*swept/i,
        timestamp: { $gte: from, $lte: to }
      }
    }
  }).select('_id username recentActivity');

  console.log(`Found ${users.length} user(s) with sweep activity in that range`);

  let totalRemoved = 0;
  for (const user of users) {
    const before = user.recentActivity.length;
    user.recentActivity = user.recentActivity.filter(entry => {
      const isSweep = /swept.*USDC|USDCx.*swept/i.test(entry.action);
      const inRange = entry.timestamp >= from && entry.timestamp <= to;
      return !(isSweep && inRange);
    });
    const removed = before - user.recentActivity.length;
    totalRemoved += removed;
    console.log(`  ${user.username}: removed ${removed} entry(ies)`);
    await user.save();
  }

  console.log(`\nTotal sweep entries removed: ${totalRemoved}`);
  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
