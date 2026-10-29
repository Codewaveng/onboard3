require('dotenv').config();
const mongoose = require('mongoose');
const Quest = require('../models/Quest');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const now = new Date();
  const quests = await Quest.find({}).select('title isActive startDate endDate rewardPool rewardToken').lean();

  console.log('All quests (' + quests.length + ' total):\n');
  quests.forEach(q => {
    const ended = q.endDate && new Date(q.endDate) < now;
    const notStarted = q.startDate && new Date(q.startDate) > now;
    let state = q.isActive ? 'ACTIVE' : 'INACTIVE';
    if (ended) state += ' | ENDED ' + new Date(q.endDate).toISOString().split('T')[0];
    else if (notStarted) state += ' | UPCOMING ' + new Date(q.startDate).toISOString().split('T')[0];
    else if (!q.endDate) state += ' | no-endDate';
    else state += ' | live until ' + new Date(q.endDate).toISOString().split('T')[0];
    console.log(q.title + ' | ' + state + ' | pool: ' + (q.rewardPool || 0) + ' ' + (q.rewardToken || ''));
  });

  const activeEnded = quests.filter(q => q.isActive && q.endDate && new Date(q.endDate) < now);
  const trulyLive = quests.filter(q => q.isActive && (!q.endDate || new Date(q.endDate) > now) && (!q.startDate || new Date(q.startDate) <= now));

  console.log('\n--- SUMMARY ---');
  console.log('isActive=true but endDate passed (stale): ' + activeEnded.length);
  console.log('Truly live right now: ' + trulyLive.length);

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
