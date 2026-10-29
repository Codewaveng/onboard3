require('dotenv').config();
const mongoose = require('mongoose');
const Quest = require('../models/Quest');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const now = new Date();

  const result = await Quest.updateMany(
    { isActive: true, endDate: { $lt: now } },
    { $set: { isActive: false } }
  );

  console.log('Deactivated ' + result.modifiedCount + ' ended quest(s).');
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
