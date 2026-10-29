require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const suspects = ['Ridique', 'Majiksavi', 'Lrick 05', 'Web3_qwin', 'Luckee'];

  for (const name of suspects) {
    const referrer = await User.findOne({ username: new RegExp('^' + name + '$', 'i') })
      .select('_id username referralCode referralStats xp createdAt');
    if (!referrer) { console.log(name + ': not found\n'); continue; }

    const referred = await User.find({ referredBy: referrer.referralCode })
      .select('username email xp createdAt recentActivity')
      .lean();

    const fake = referred.filter(u => (u.xp || 0) < 200 && (u.recentActivity || []).length <= 2);
    const veryNew = referred.filter(u => (Date.now() - new Date(u.createdAt)) / 86400000 < 60);

    console.log('=== ' + referrer.username + ' (code: ' + referrer.referralCode + ') ===');
    console.log('Total referred: ' + referred.length + ' | Suspicious (low XP + minimal activity): ' + fake.length + ' | Joined <60 days ago: ' + veryNew.length);

    if (fake.length > 0) {
      console.log('Sample suspicious accounts:');
      fake.slice(0, 10).forEach(u => {
        const age = Math.floor((Date.now() - new Date(u.createdAt)) / 86400000);
        console.log('  - ' + u.username + ' | XP: ' + (u.xp || 0) + ' | Age: ' + age + 'd | Activity entries: ' + (u.recentActivity || []).length + ' | ' + u.email);
      });
    }
    console.log('');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
