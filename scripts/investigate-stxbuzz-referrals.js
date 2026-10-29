require('dotenv').config();
const mongoose = require('mongoose');
const Quest = require('../models/Quest');
const UserQuestProgress = require('../models/UserQuestProgress');
const User = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('Connected to DB\n');

  // Find STXBuzz / Apex Raiders quest
  const quest = await Quest.findOne({
    $or: [
      { title: /stxbuzz/i },
      { slug: /stxbuzz/i },
      { title: /apex.raiders/i },
      { slug: /apex.raiders/i }
    ]
  }).select('_id title slug referralConfig');

  if (!quest) {
    console.log('Quest not found. Listing all quests:');
    const all = await Quest.find({}).select('title slug').limit(30);
    all.forEach(q => console.log(`  [${q._id}] ${q.title} (${q.slug || 'no slug'})`));
    await mongoose.disconnect();
    return;
  }

  console.log(`Quest: ${quest.title} (${quest._id})`);
  console.log(`Referral config: join=${quest.referralConfig?.xpPerReferralJoin} XP, complete=${quest.referralConfig?.xpPerReferralComplete} XP\n`);

  // Get all progress records with referral data
  const allProgress = await UserQuestProgress.find({ questId: quest._id })
    .populate('userId', 'username email createdAt referredBy referralCode referralStats')
    .lean();

  console.log(`Total participants: ${allProgress.length}\n`);

  // Build referral map: referrerUserId -> list of referred userIds
  const referrerMap = {};
  for (const p of allProgress) {
    const user = p.userId;
    if (!user) continue;

    const joinReferrals = p.referralStats?.referralsJoined || [];
    const completeReferrals = p.referralStats?.referralsCompleted || [];
    const allRefs = [...new Set([
      ...joinReferrals.map(r => r.userId?.toString()),
      ...completeReferrals.map(r => r.userId?.toString())
    ].filter(Boolean))];

    if (allRefs.length > 0) {
      referrerMap[user._id.toString()] = {
        username: user.username,
        email: user.email,
        referralXp: p.xpBreakdown?.referralJoinBonus + p.xpBreakdown?.referralCompleteBonus,
        totalXp: p.xpBreakdown?.totalXp,
        joinReferrals: joinReferrals.length,
        completeReferrals: completeReferrals.length,
        referredUserIds: allRefs
      };
    }
  }

  // Sort by most referrals
  const sorted = Object.values(referrerMap).sort((a, b) => b.joinReferrals - a.joinReferrals);

  console.log('=== REFERRAL COUNTS PER USER (sorted by most referrals) ===\n');
  for (const r of sorted) {
    console.log(`${r.username} (${r.email})`);
    console.log(`  Referrals joined: ${r.joinReferrals} | Referrals completed: ${r.completeReferrals}`);
    console.log(`  Referral XP: ${r.referralXp} | Total XP: ${r.totalXp}`);

    // Check referred accounts for suspicious patterns
    if (r.referredUserIds.length > 0) {
      const referredUsers = await User.find({ _id: { $in: r.referredUserIds } })
        .select('username email createdAt referredBy recentActivity xp')
        .lean();

      const suspicious = referredUsers.filter(u => {
        const age = (Date.now() - new Date(u.createdAt)) / (1000 * 60 * 60 * 24);
        const lowActivity = (u.recentActivity || []).length <= 1;
        const lowXp = (u.xp || 0) < 100;
        return lowActivity && lowXp;
      });

      if (suspicious.length > 0) {
        console.log(`  ⚠  ${suspicious.length}/${referredUsers.length} referred accounts look suspicious (low XP + minimal activity):`);
        suspicious.forEach(u => {
          const ageDays = Math.floor((Date.now() - new Date(u.createdAt)) / (1000 * 60 * 60 * 24));
          console.log(`     - ${u.username} (${u.email}) | XP: ${u.xp || 0} | Age: ${ageDays}d | Activity entries: ${(u.recentActivity || []).length}`);
        });
      } else {
        console.log(`  ✓  All ${referredUsers.length} referred accounts look legitimate`);
      }
    }
    console.log('');
  }

  // Flag accounts referred by someone outside the quest (ghost referrals)
  console.log('\n=== ACCOUNTS WITH REFERRAL XP BUT REFERRER NOT ON LEADERBOARD ===\n');
  const participantIds = new Set(allProgress.map(p => p.userId?._id?.toString()).filter(Boolean));
  let ghostCount = 0;
  for (const p of allProgress) {
    const hasReferralXp = (p.xpBreakdown?.referralJoinBonus || 0) + (p.xpBreakdown?.referralCompleteBonus || 0) > 0;
    if (hasReferralXp && p.userId) {
      const referrerId = Object.keys(referrerMap).find(id =>
        referrerMap[id].referredUserIds.includes(p.userId._id.toString())
      );
      if (referrerId && !participantIds.has(referrerId)) {
        console.log(`  ${p.userId.username}: referrer (${referrerId}) not on leaderboard`);
        ghostCount++;
      }
    }
  }
  if (ghostCount === 0) console.log('  None found.');

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch(err => { console.error(err); process.exit(1); });
