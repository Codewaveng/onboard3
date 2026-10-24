require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');

const START = new Date('2026-10-19T00:00:00+01:00');
const END = new Date('2026-10-25T00:00:00+01:00');
const APPLY = process.argv.includes('--apply');
const REWARD_PATTERN = /^Bounty reward swept: \$([\d.]+) USDC credited/;
const CORRECTION_NAMESPACE = 'stx-sweep-credit-correction-2026-10-19-24';

const corrections = [
  { username: 'Abdulrun', amounts: [286, 170] },
  { username: 'Ibnmarzuk', amounts: [286, 170] },
  { username: 'Ebukaokorie1', amounts: [143] },
  { username: 'FRT', amounts: [144] },
  { username: 'Zaynab', amounts: [144, 170] },
  { username: 'Sunsave', amounts: [144] },
  { username: 'Joelonchain', amounts: [145] },
  { username: 'Web3_qwin', amounts: [145] },
  { username: 'Abuhphil', amounts: [145] },
  { username: 'Ramanola', amounts: [145, 170] },
  { username: 'Ridique', amounts: [145] },
  { username: 'Manoel', amounts: [145] },
  { username: 'Kay', amounts: [145] },
  { username: 'Ealo', amounts: [145] },
  { username: 'Majiksavi', amounts: [145, 256] },
  { username: 'AbuYusro0x', amounts: [171] },
  { username: 'Dennis-kaizen', amounts: [170] },
  { username: 'Micolee006', amounts: [170] },
  { username: 'Bolacrypt', amounts: [170] },
  { username: 'Morenike', amounts: [170] }
];

function correctionId(userId) {
  const hex = crypto
    .createHash('sha256')
    .update(`${CORRECTION_NAMESPACE}:${userId}`)
    .digest('hex')
    .slice(0, 24);
  return new mongoose.Types.ObjectId(hex);
}

function findMatchingActivity(activity, expectedAmounts) {
  const candidates = new Map();

  (activity || []).forEach((item, index) => {
    const timestamp = new Date(item.timestamp);
    const match = (item.action || '').match(REWARD_PATTERN);
    if (!match || timestamp < START || timestamp >= END) return;

    const cents = Math.round(Number(match[1]) * 100);
    if (!expectedAmounts.includes(cents)) return;
    if (!candidates.has(cents)) candidates.set(cents, []);
    candidates.get(cents).push({ index, timestamp, action: item.action, cents });
  });

  const selected = [];
  for (const [cents, count] of countAmounts(expectedAmounts)) {
    const matches = (candidates.get(cents) || [])
      .sort((a, b) => a.timestamp - b.timestamp);
    if (matches.length < count) {
      return { selected: [], missing: { cents, expected: count, found: matches.length } };
    }
    selected.push(...matches.slice(0, count));
  }

  return { selected, missing: null };
}

function countAmounts(amounts) {
  const counts = new Map();
  for (const amount of amounts) counts.set(amount, (counts.get(amount) || 0) + 1);
  return counts;
}

function amountInDollars(cents) {
  return cents / 100;
}

async function correctAccount(correction) {
  const user = await User.findOne({
    username: new RegExp(`^${correction.username}$`, 'i')
  }).select('username usdcBalance recentActivity').lean();

  if (!user) {
    return { username: correction.username, status: 'skipped', reason: 'account not found' };
  }

  const existingCorrection = await Transaction.findById(correctionId(user._id)).lean();
  if (existingCorrection) {
    return { username: user.username, status: 'already-corrected' };
  }

  const matches = findMatchingActivity(user.recentActivity, correction.amounts);
  if (matches.missing) {
    const dollars = amountInDollars(matches.missing.cents).toFixed(2);
    return {
      username: user.username,
      status: 'skipped',
      reason: `expected ${matches.missing.expected} matching $${dollars} activity entr${matches.missing.expected === 1 ? 'y' : 'ies'}, found ${matches.missing.found}`
    };
  }

  const totalCents = correction.amounts.reduce((sum, amount) => sum + amount, 0);
  const total = amountInDollars(totalCents);
  const balance = Number(user.usdcBalance || 0);
  if (balance + 1e-9 < total) {
    return {
      username: user.username,
      status: 'skipped',
      reason: `insufficient balance: $${balance.toFixed(2)} available, $${total.toFixed(2)} to reverse`
    };
  }

  if (!APPLY) {
    return {
      username: user.username,
      status: 'would-correct',
      amount: total,
      entries: matches.selected.length,
      balance
    };
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const freshUser = await User.findById(user._id).session(session);
      if (!freshUser) throw new Error('Account disappeared before correction');

      const freshMatches = findMatchingActivity(freshUser.recentActivity, correction.amounts);
      if (freshMatches.missing) {
        throw new Error('Matching activity changed before correction');
      }

      const currentBalance = Number(freshUser.usdcBalance || 0);
      if (currentBalance + 1e-9 < total) {
        throw new Error(`Balance changed; only $${currentBalance.toFixed(2)} is available`);
      }

      const removeIndexes = new Set(freshMatches.selected.map(item => item.index));
      freshUser.usdcBalance = Math.round((currentBalance - total) * 100) / 100;
      freshUser.recentActivity = (freshUser.recentActivity || [])
        .filter((_, index) => !removeIndexes.has(index));
      await freshUser.save({ session });

      const id = correctionId(freshUser._id);
      await Transaction.create([{
        _id: id,
        user: freshUser._id,
        type: 'admin_adjustment',
        amount: -total,
        status: 'completed',
        notes: `Correction of erroneous STX bounty sweep credits dated Oct 19-24, 2026; ${freshMatches.selected.length} user activity entries removed. Correction ref: ${CORRECTION_NAMESPACE}.`
      }], { session });

      await Notification.deleteMany({
        userId: freshUser._id,
        createdAt: { $gte: START, $lt: END },
        $or: [
          { title: /Bounty reward swept/i },
          { message: /Bounty reward swept/i }
        ]
      }).session(session);
    });
  } finally {
    await session.endSession();
  }

  return {
    username: user.username,
    status: 'corrected',
    amount: total,
    entries: matches.selected.length
  };
}

async function main() {
  const expectedTotal = corrections.reduce(
    (sum, correction) => sum + correction.amounts.reduce((accountSum, amount) => accountSum + amount, 0),
    0
  );
  if (expectedTotal !== 4239) {
    throw new Error(`Correction list total mismatch: expected 4239 cents, got ${expectedTotal}`);
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  try {
    const results = [];
    for (const correction of corrections) {
      try {
        results.push(await correctAccount(correction));
      } catch (error) {
        results.push({
          username: correction.username,
          status: 'error',
          reason: error.message
        });
      }
    }

    const eligible = results.filter(result => result.status === (APPLY ? 'corrected' : 'would-correct'));
    console.log(`${APPLY ? 'Applied' : 'DRY RUN'}: ${eligible.length} accounts, $${eligible.reduce((sum, result) => sum + result.amount, 0).toFixed(2)} USDC, ${eligible.reduce((sum, result) => sum + result.entries, 0)} activity entries.`);
    console.log(JSON.stringify(results, null, 2));

    if (results.some(result => ['skipped', 'error'].includes(result.status))) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error('STX sweep correction failed:', error);
  process.exitCode = 1;
});
