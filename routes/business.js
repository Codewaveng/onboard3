const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');

const User                = require('../models/User');
const FeedEvent           = require('../models/FeedEvent');
const Business            = require('../models/Business');
const BusinessFundRequest = require('../models/BusinessFundRequest');
const BusinessTransaction = require('../models/BusinessTransaction');
const BDEarning           = require('../models/BDEarning');
const CommissionSettings  = require('../models/CommissionSettings');
const WalletAddress       = require('../models/WalletAddress');
const Quest               = require('../models/Quest');
const Bounty              = require('../models/Bounty');
const UserQuestProgress   = require('../models/UserQuestProgress');
const BountySubmission    = require('../models/BountySubmission');
const businessAuth        = require('../middleware/businessAuth');
const QuestApplication    = require('../models/QuestApplication');

// Memory storage — avoids EROFS on read-only serverless filesystems (Vercel /var/task).
// Screenshot is stored as a base64 data URI in MongoDB; admin <img src> works with data URIs.
const _multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed (PNG, JPG, GIF, WebP)'), ok);
  }
});

// Wraps multer so its errors redirect back to the dashboard instead of hitting the global 500 handler
function uploadScreenshot(req, res, next) {
  _multerUpload.single('screenshot')(req, res, function(err) {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'Screenshot must be under 5 MB'
      : (err.message || 'Upload failed');
    console.error('Multer upload error:', err);
    return res.redirect('/business/dashboard?tab=wallet&error=' + encodeURIComponent(msg));
  });
}

// ── Auth pages ────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  if (req.session.businessId) return res.redirect('/business/dashboard');
  res.redirect('/business/login');
});

router.get('/login', (req, res) => {
  if (req.session.businessId) return res.redirect('/business/dashboard');
  res.render('business/login', { error: null });
});

router.get('/signup', (req, res) => {
  if (req.session.businessId) return res.redirect('/business/dashboard');
  res.render('business/signup', { error: null, success: null });
});

router.post('/signup', async (req, res) => {
  try {
    const { name, username, email, password, industry, website, description } = req.body;
    if (!name || !username || !email || !password || !description) {
      return res.render('business/signup', { error: 'Please fill in all required fields.', success: null });
    }
    if (password.length < 8) {
      return res.render('business/signup', { error: 'Password must be at least 8 characters.', success: null });
    }
    const cleanUsername = username.toLowerCase().trim().replace(/[^a-z0-9_\-]/g, '');
    if (!cleanUsername) {
      return res.render('business/signup', { error: 'Invalid username. Use only letters, numbers, _ or -.', success: null });
    }
    const exists = await Business.findOne({ $or: [{ username: cleanUsername }, { email: email.toLowerCase().trim() }] });
    if (exists) {
      return res.render('business/signup', { error: 'An account with that username or email already exists.', success: null });
    }
    await Business.create({
      name: name.trim(),
      username: cleanUsername,
      email: email.toLowerCase().trim(),
      password,
      industry: industry || 'other',
      website: website?.trim() || undefined,
      description: description.trim(),
      status: 'pending'
    });
    res.render('business/signup', {
      error: null,
      success: 'Application submitted! Admin will review and approve your account. You\'ll be able to log in once approved.'
    });
  } catch (err) {
    console.error('Business signup error:', err);
    res.render('business/signup', { error: 'Something went wrong. Please try again.', success: null });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const business = await Business.findOne({ username: username.toLowerCase().trim() });
    if (!business || !(await business.comparePassword(password))) {
      return res.render('business/login', { error: 'Invalid username or password.' });
    }
    if (business.status === 'pending') {
      return res.render('business/login', { error: 'This account is pending admin approval.' });
    }
    if (business.status === 'rejected') {
      return res.render('business/login', { error: 'This account application was rejected.' });
    }
    if (business.status === 'suspended') {
      return res.render('business/login', { error: 'This account has been suspended.' });
    }
    business.lastLogin = new Date();
    await business.save();
    req.session.businessId   = business._id.toString();
    req.session.businessName = business.name;
    res.redirect('/business/dashboard');
  } catch (err) {
    console.error('Business login error:', err);
    res.render('business/login', { error: 'Something went wrong. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/business/login'));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/dashboard', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const settings = await CommissionSettings.getCurrent();

    const Event = require('../models/Event');
    const [quests, bounties, fundRequests, transactions, walletAddresses, events] = await Promise.all([
      Quest.find({ sponsoredBy: business._id }).sort({ createdAt: -1 }),
      Bounty.find({ sponsoredBy: business._id }).sort({ createdAt: -1 }),
      BusinessFundRequest.find({ businessId: business._id }).sort({ createdAt: -1 }).limit(10),
      BusinessTransaction.find({ businessId: business._id }).sort({ createdAt: -1 }).limit(10),
      WalletAddress.find({ isActive: true }).sort({ token: 1, network: 1 }),
      Event.find({ sponsoredBy: business._id }).sort({ startDate: -1 }),
    ]);

    let totalQuestCompletions = 0;
    let totalBountySubmissions = 0;
    if (quests.length) {
      const questIds = quests.map(q => q._id);
      totalQuestCompletions = await UserQuestProgress.countDocuments({
        questId: { $in: questIds },
        status: 'completed'
      });
    }
    if (bounties.length) {
      const bountyIds = bounties.map(b => b._id);
      totalBountySubmissions = await BountySubmission.countDocuments({
        bountyId: { $in: bountyIds }
      });
    }

    res.render('business/dashboard', {
      business,
      settings,
      quests,
      bounties,
      fundRequests,
      transactions,
      walletAddresses,
      events,
      totalQuestCompletions,
      totalBountySubmissions
    });
  } catch (err) {
    console.error('Business dashboard error:', err);
    res.redirect('/business/login');
  }
});

// ── Fund account ──────────────────────────────────────────────────────────────

router.post('/fund-request', businessAuth, uploadScreenshot, async (req, res) => {
  try {
    const business = req.business;
    const { amount, token, network, walletAddressId, proofNote } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt < 1)    return res.redirect('/business/dashboard?tab=wallet&error=invalid_amount');
    if (!token || !network) return res.redirect('/business/dashboard?tab=wallet&error=missing_fields');

    // Build a base64 data URI from the in-memory buffer (no filesystem write needed)
    const screenshotPath = req.file
      ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
      : null;

    if (!screenshotPath) return res.redirect('/business/dashboard?tab=wallet&error=screenshot_required');

    await BusinessFundRequest.create({
      businessId: business._id,
      amount: amt,
      token,
      network,
      walletAddressId: walletAddressId || null,
      screenshotPath,
      proofNote
    });
    res.redirect('/business/dashboard?tab=wallet&success=fund_request_submitted');
  } catch (err) {
    console.error('Fund request error:', err);
    res.redirect('/business/dashboard?tab=wallet&error=server_error');
  }
});

// ── Create quest ──────────────────────────────────────────────────────────────

router.post('/create-quest', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const settings = await CommissionSettings.getCurrent();

    const {
      title, description, shortDescription, budget, endDate, startDate,
      category, difficulty, questType, baseXpReward, image, tasksJson,
      maxParticipants,
      competitionTopWinners, competitionWinnerXP, rankPercentages,
      referralEnabled, referralJoinXP, referralCompleteXP,
      batchEnabled, batchSize, batchIntervalHours,
      rewardPerPerson, maxWinners
    } = req.body;

    const totalBudget = parseFloat(budget);
    let rankShares = [];
    if (typeof rankPercentages === 'string') { try { rankShares = JSON.parse(rankPercentages); } catch (_) { rankShares = []; } }
    else if (Array.isArray(rankPercentages)) rankShares = rankPercentages.map(Number);
    {
      const count = Math.max(1, Math.min(100, parseInt(competitionTopWinners, 10) || 10));
      if (rankShares.length !== count || rankShares.some(p => !Number.isFinite(Number(p)) || Number(p) < 0 || Number(p) > 100) || Math.abs(rankShares.reduce((sum, p) => sum + Number(p), 0) - 100) > 0.01) {
        return res.redirect('/business/dashboard?tab=quests&error=invalid_reward_split');
      }
    }

    if (!title || !description || !totalBudget || totalBudget < 1) {
      return res.redirect('/business/dashboard?tab=quests&error=missing_fields');
    }
    if (business.balance < totalBudget) {
      return res.redirect('/business/dashboard?tab=quests&error=insufficient_balance');
    }

    const bdRate   = settings.bdCommissionRate       / 100;
    const platRate = settings.platformCommissionRate / 100;
    const bdAmt    = Math.round(totalBudget * bdRate   * 100) / 100;
    const platAmt  = Math.round(totalBudget * platRate * 100) / 100;
    const poolAmt  = Math.round((totalBudget - bdAmt - platAmt) * 100) / 100;

    let tasks = [];
    try { tasks = JSON.parse(tasksJson || '[]'); } catch(_) {}

    const quest = await Quest.create({
      title,
      description,
      shortDescription: shortDescription || title,
      category:    category    || 'social',
      difficulty:  difficulty  || 'beginner',
      questType:   questType   || 'standard',
      baseXpReward: parseInt(baseXpReward) || 0,
      usdcReward:   poolAmt,
      image:        image || '',
      startDate:    startDate ? new Date(startDate) : null,
      endDate:      endDate   ? new Date(endDate)   : null,
      maxParticipants: maxParticipants ? parseInt(maxParticipants) : null,
      isActive:       false,
      approvalStatus: 'pending',
      sponsoredBy:    business._id,
      rewardPlan: {
        rewardPerPerson: parseFloat(rewardPerPerson) || (poolAmt / (parseInt(maxWinners) || 1)),
        maxWinners: parseInt(maxWinners) || 0
      },
      competitionConfig: {
        enabled:       questType === 'competition',
        topWinnersCount: parseInt(competitionTopWinners) || 10,
        winnerBonusXP:   parseInt(competitionWinnerXP)   || 0,
        rankPercentages: rankShares
      },
      referralConfig: {
        enabled:              referralEnabled === 'on' || referralEnabled === 'true',
        xpPerReferralJoin:    parseInt(referralJoinXP)     || 0,
        xpPerReferralComplete: parseInt(referralCompleteXP) || 0
      },
      batchConfig: {
        enabled:       batchEnabled === 'on' || batchEnabled === 'true',
        batchSize:     parseInt(batchSize)         || 50,
        intervalHours: parseInt(batchIntervalHours) || 48
      },
      tasks: tasks.map((t, i) => ({
        title:            t.title            || 'Task',
        description:      t.description      || '',
        taskType:         t.taskType         || 'external',
        xpReward:         parseInt(t.xpReward) || 0,
        buttonText:       t.buttonText       || 'Complete',
        buttonLink:       t.buttonLink       || '',
        discordGuildId:   t.discordGuildId   || null,
        discordGuildName: t.discordGuildName || null,
        telegramChatId:   t.telegramChatId   || null,
        telegramChatName: t.telegramChatName || null,
        webhookUrl:       t.webhookUrl       || null,
        order: i
      }))
    });

    const balanceBefore = business.balance;
    business.balance    -= totalBudget;
    business.totalSpent += totalBudget;
    business.quests.push(quest._id);
    await business.save();

    const tx = await BusinessTransaction.create({
      businessId:         business._id,
      type:               'quest_creation',
      totalAmount:        totalBudget,
      poolAmount:         poolAmt,
      bdCommission:       bdAmt,
      platformCommission: platAmt,
      bdCommissionRate:       settings.bdCommissionRate,
      platformCommissionRate: settings.platformCommissionRate,
      description: `Quest: ${title}`,
      questId:     quest._id,
      balanceBefore,
      balanceAfter: business.balance
    });

    const bd = await require('../models/BusinessDeveloper').findById(business.createdBy);
    if (bd) {
      const effectiveRate = bd.commissionRate !== null ? bd.commissionRate : settings.bdCommissionRate;
      const bdEarnAmt = Math.round(totalBudget * effectiveRate / 100 * 100) / 100;
      await BDEarning.create({
        bdId:             bd._id,
        businessId:       business._id,
        transactionId:    tx._id,
        type:             'quest_commission',
        grossAmount:      totalBudget,
        commissionRate:   effectiveRate,
        commissionAmount: bdEarnAmt
      });
      bd.pendingEarnings += bdEarnAmt;
      bd.totalEarned     += bdEarnAmt;
      await bd.save();
    }

    res.redirect('/business/dashboard?tab=quests&success=quest_submitted');
  } catch (err) {
    console.error('Create quest error:', err);
    res.redirect('/business/dashboard?tab=quests&error=server_error');
  }
});

// ── Create bounty ─────────────────────────────────────────────────────────────

router.post('/create-bounty', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const settings = await CommissionSettings.getCurrent();

    const { title, description, shortDescription, budget, endDate, startDate,
            category, image, maxSubmissionsPerUser, splitJson } = req.body;
    const totalBudget = parseFloat(budget);

    if (!title || !description || !totalBudget || totalBudget < 1) {
      return res.redirect('/business/dashboard?tab=bounties&error=missing_fields');
    }
    if (business.balance < totalBudget) {
      return res.redirect('/business/dashboard?tab=bounties&error=insufficient_balance');
    }

    const bdAmt   = Math.round(totalBudget * settings.bdCommissionRate       / 100 * 100) / 100;
    const platAmt = Math.round(totalBudget * settings.platformCommissionRate / 100 * 100) / 100;
    const poolAmt = Math.round((totalBudget - bdAmt - platAmt) * 100) / 100;

    let rewardSplit = [
      { rank: 1, label: '1st Place', percentage: 50 },
      { rank: 2, label: '2nd Place', percentage: 30 },
      { rank: 3, label: '3rd Place', percentage: 20 }
    ];
    try {
      const parsed = JSON.parse(splitJson || '[]');
      if (parsed.length > 0) {
        rewardSplit = parsed.map((s, i) => ({
          rank:       i + 1,
          label:      s.label      || `#${i + 1} Place`,
          percentage: parseFloat(s.percentage) || 0
        }));
      }
    } catch(_) {}

    const bounty = await Bounty.create({
      title,
      description,
      shortDescription:     shortDescription || title,
      category:             category || 'other',
      image:                image || '',
      rewardPool:           poolAmt,
      rewardToken:          'USDC',
      rewardSplit,
      maxSubmissionsPerUser: parseInt(maxSubmissionsPerUser) || 1,
      startDate: startDate ? new Date(startDate) : null,
      endDate:   endDate   ? new Date(endDate)   : null,
      status:         'draft',
      isActive:       false,
      approvalStatus: 'pending',
      sponsoredBy:    business._id
    });

    const balanceBefore = business.balance;
    business.balance    -= totalBudget;
    business.totalSpent += totalBudget;
    business.bounties.push(bounty._id);
    await business.save();

    const tx = await BusinessTransaction.create({
      businessId:         business._id,
      type:               'bounty_creation',
      totalAmount:        totalBudget,
      poolAmount:         poolAmt,
      bdCommission:       bdAmt,
      platformCommission: platAmt,
      bdCommissionRate:       settings.bdCommissionRate,
      platformCommissionRate: settings.platformCommissionRate,
      description: `Bounty: ${title}`,
      bountyId:    bounty._id,
      balanceBefore,
      balanceAfter: business.balance
    });

    const bd = await require('../models/BusinessDeveloper').findById(business.createdBy);
    if (bd) {
      const effectiveRate = bd.commissionRate !== null ? bd.commissionRate : settings.bdCommissionRate;
      const bdEarnAmt = Math.round(totalBudget * effectiveRate / 100 * 100) / 100;
      await BDEarning.create({
        bdId:             bd._id,
        businessId:       business._id,
        transactionId:    tx._id,
        type:             'bounty_commission',
        grossAmount:      totalBudget,
        commissionRate:   effectiveRate,
        commissionAmount: bdEarnAmt
      });
      bd.pendingEarnings += bdEarnAmt;
      bd.totalEarned     += bdEarnAmt;
      await bd.save();
    }

    res.redirect('/business/dashboard?tab=bounties&success=bounty_submitted');
  } catch (err) {
    console.error('Create bounty error:', err);
    res.redirect('/business/dashboard?tab=bounties&error=server_error');
  }
});

// ── Quest stats API ───────────────────────────────────────────────────────────

router.get('/api/quest/:id/stats', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }

    const [leaderboard, completions, participants] = await Promise.all([
      UserQuestProgress.find({ questId: quest._id })
        .sort({ 'xpBreakdown.totalXp': -1, lastXpAt: 1, completedAt: 1, startedAt: 1, createdAt: 1 })
        .limit(100)
        .populate('userId', 'username')
        .lean(),
      UserQuestProgress.countDocuments({ questId: quest._id, status: 'completed' }),
      UserQuestProgress.countDocuments({ questId: quest._id })
    ]);

    res.json({
      success: true,
      stats: {
        totalParticipants:  participants,
        totalCompletions:   completions,
        completionRate:     participants > 0 ? ((completions / participants) * 100).toFixed(1) : '0.0',
        rewardPool:         quest.usdcReward,
        rewardsDistributed: quest.rewardsDistributed,
        hasEnded:           quest.endDate ? new Date() > new Date(quest.endDate) : false,
        questType:          quest.questType,
        telegramGroupLink:  quest.telegramGroupLink || null
      },
      leaderboard: leaderboard.map((p, i) => ({
        rank:        i + 1,
        progressId:  p._id,
        username:    p.userId?.username || 'Unknown',
        xp:          p.xpBreakdown?.totalXp || 0,
        status:      p.status,
        completedAt: p.completedAt,
        usdcEarned:  p.usdcEarned || 0
      }))
    });
  } catch (err) {
    console.error('Quest stats error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Award extra XP to a user ──────────────────────────────────────────────────

router.post('/api/quest/:id/award-xp', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }

    const { username, xpAmount } = req.body;
    const xp = parseInt(xpAmount);
    if (!username || !xp || xp <= 0 || xp > 10000) {
      return res.json({ success: false, message: 'Invalid parameters' });
    }

    const User = require('../models/User');
    const user = await User.findOne({ username: new RegExp('^' + username.trim() + '$', 'i') });
    if (!user) return res.json({ success: false, message: 'User not found' });

    const progress = await UserQuestProgress.findOne({ questId: quest._id, userId: user._id });
    if (!progress) return res.json({ success: false, message: 'User has not participated in this quest' });

    progress.xpBreakdown.winnerBonus = (progress.xpBreakdown.winnerBonus || 0) + xp;
    await progress.save();

    user.totalXP = (user.totalXP || 0) + xp;
    await user.save();

    res.json({ success: true, message: `Awarded ${xp} XP to @${user.username}` });
  } catch (err) {
    console.error('Award XP error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Disburse USDC rewards ─────────────────────────────────────────────────────

router.post('/api/quest/:id/disburse', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    if (quest.rewardsDistributed) {
      return res.json({ success: false, message: 'Rewards already distributed' });
    }
    const hasEnded = quest.endDate ? new Date() > new Date(quest.endDate) : false;
    if (!hasEnded) {
      return res.json({ success: false, message: 'Quest has not ended yet. Set an end date or wait until it passes.' });
    }

    const pool = quest.usdcReward || 0;
    if (pool <= 0) {
      return res.json({ success: false, message: 'No reward pool to distribute' });
    }

    let winnersQuery = UserQuestProgress.find({ questId: quest._id, status: 'completed' })
      .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1 })
      .populate('userId', 'username');

    if (Array.isArray(quest.competitionConfig?.rankPercentages) && quest.competitionConfig.rankPercentages.length) {
      const topN = quest.competitionConfig.topWinnersCount || 10;
      winnersQuery = winnersQuery.limit(topN);
    }

    const winners = await winnersQuery;
    if (!winners.length) {
      return res.json({ success: false, message: 'No completions to distribute rewards to' });
    }

    const configuredShares = quest.competitionConfig?.rankPercentages;
    const useRankShares = Array.isArray(configuredShares) && configuredShares.length >= winners.length && Math.abs(configuredShares.reduce((sum, p) => sum + Number(p || 0), 0) - 100) <= 0.01;
    const payoutAmounts = winners.map((_, index) => useRankShares ? Math.round(pool * Number(configuredShares[index]) / 100 * 100) / 100 : Math.round(pool / winners.length * 100) / 100);
    const perUser = payoutAmounts[0] || 0;
    const io = req.app.get('io');

    await Promise.all(winners.map(async (w, index) => {
      const rewardAmount = payoutAmounts[index];
      w.usdcEarned    = rewardAmount;
      w.rewardsClaimed = true;
      await w.save();

      // Credit user balance + feed event
      const userId = w.userId?._id || w.userId;
      const userDoc = await User.findById(userId);
      if (!userDoc) return;

      userDoc.usdcBalance = Math.round(((userDoc.usdcBalance || 0) + rewardAmount) * 100) / 100;
      userDoc.recentActivity.unshift({
        action: `Received $${rewardAmount.toFixed(2)} USDC from quest: ${quest.title}`,
        timestamp: new Date()
      });
      if (userDoc.recentActivity.length > 10) userDoc.recentActivity = userDoc.recentActivity.slice(0, 10);
      await userDoc.save();

      try {
        const ev = await new FeedEvent({
          type: 'usdc_earned',
          userId: userDoc._id,
          username: userDoc.username,
          data: { amount: rewardAmount, questTitle: quest.title }
        }).save();
        io?.emit('feed_event', { ...ev.toObject(), viewerLiked: false });
      } catch (e) { console.error('Feed event error (disburse):', e.message); }
    }));

    quest.rewardsDistributed    = true;
    quest.rewardsDistributedAt  = new Date();
    await quest.save();

    res.json({
      success: true,
      message: `Distributed prize shares to ${winners.length} winner${winners.length !== 1 ? 's' : ''}.`,
      winners: winners.length,
      perUser,
      payouts: payoutAmounts
    });
  } catch (err) {
    console.error('Disburse error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Quest entries API ─────────────────────────────────────────────────────────

router.get('/api/quest/:id/entries', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id).lean();
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const entries = await UserQuestProgress.find({ questId: req.params.id })
      .populate('userId', 'username email xp')
      .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1 })
      .lean();
    res.json({ success: true, quest, entries });
  } catch (err) {
    console.error('Quest entries error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Flag entry (remove 50 XP) ─────────────────────────────────────────────────

router.post('/api/quest/:id/entries/:progressId/flag', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const progress = await UserQuestProgress.findById(req.params.progressId).lean();
    if (!progress || String(progress.questId) !== String(quest._id)) {
      return res.json({ success: false, message: 'Entry not found' });
    }
    const currentTotal = progress.xpBreakdown?.totalXp || 0;
    const penaltyXp = Math.min(50, currentTotal);
    if (penaltyXp > 0) {
      await UserQuestProgress.updateOne(
        { _id: progress._id },
        { $set: { flagged: true }, $inc: { 'xpBreakdown.taskXp': -penaltyXp, 'xpBreakdown.totalXp': -penaltyXp } }
      );
      const User = require('../models/User');
      await User.findByIdAndUpdate(progress.userId, { $inc: { xp: -penaltyXp } });
    } else {
      await UserQuestProgress.updateOne({ _id: progress._id }, { $set: { flagged: true } });
    }
    res.json({ success: true, message: `Entry flagged. Removed ${penaltyXp} XP.` });
  } catch (err) {
    console.error('Flag entry error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Set Telegram group link ───────────────────────────────────────────────────

router.patch('/api/quest/:id/telegram-link', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const { link } = req.body;
    quest.telegramGroupLink = link ? link.trim() : null;
    await quest.save();
    res.json({ success: true, message: 'Telegram group link updated.' });
  } catch (err) {
    console.error('Telegram link update error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Remove entry from leaderboard ────────────────────────────────────────────

router.post('/api/quest/:id/entries/:progressId/remove', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const progress = await UserQuestProgress.findById(req.params.progressId);
    if (!progress || String(progress.questId) !== String(quest._id)) {
      return res.json({ success: false, message: 'Entry not found' });
    }
    if (progress.status === 'abandoned') {
      return res.json({ success: false, message: 'Entry already removed' });
    }
    const xpToDeduct = progress.xpBreakdown?.totalXp || 0;
    await UserQuestProgress.updateOne({ _id: progress._id }, { $set: { status: 'abandoned' } });
    if (xpToDeduct > 0) {
      const User = require('../models/User');
      await User.findByIdAndUpdate(progress.userId, { $inc: { xp: -xpToDeduct } });
    }
    res.json({ success: true, message: 'Participant removed from leaderboard.' + (xpToDeduct > 0 ? ' ' + xpToDeduct + ' XP deducted.' : '') });
  } catch (err) {
    console.error('Remove entry error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Add task (competition only) ───────────────────────────────────────────────

router.post('/api/quest/:id/tasks', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    if (quest.questType !== 'competition') {
      return res.json({ success: false, message: 'Tasks can only be added to competition quests' });
    }
    const { title, description, taskType, xpReward, buttonText, buttonLink, inputType, inputName, inputLabel, requiresApproval } = req.body;
    if (!title) return res.json({ success: false, message: 'Task title is required' });
    quest.tasks.push({
      title: title.trim(),
      description: description || '',
      taskType: taskType || 'external',
      xpReward: parseInt(xpReward) || 0,
      buttonText: buttonText || 'Complete',
      buttonLink: buttonLink || '',
      inputType: inputType || 'link',
      inputName: inputName || '',
      inputLabel: inputLabel || '',
      requiresApproval: requiresApproval === true || requiresApproval === 'true',
      order: quest.tasks.length
    });
    await quest.save();
    const newTask = quest.tasks[quest.tasks.length - 1];
    res.json({ success: true, task: newTask });
  } catch (err) {
    console.error('Add task error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Edit task ─────────────────────────────────────────────────────────────────
router.patch('/api/quest/:id/tasks/:taskId', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const task = quest.tasks.id(req.params.taskId);
    if (!task) return res.json({ success: false, message: 'Task not found' });
    const { title, description, taskType, xpReward, buttonText, buttonLink, inputType, inputLabel, inputName } = req.body;
    if (title) task.title = title.trim();
    if (description !== undefined) task.description = description;
    if (taskType) task.taskType = taskType;
    if (xpReward !== undefined) task.xpReward = parseInt(xpReward) || 0;
    if (buttonText !== undefined) task.buttonText = buttonText;
    if (buttonLink !== undefined) task.buttonLink = buttonLink;
    if (inputType) task.inputType = inputType;
    if (inputLabel !== undefined) task.inputLabel = inputLabel;
    if (inputName !== undefined) task.inputName = inputName;
    await quest.save();
    res.json({ success: true, task });
  } catch (err) {
    console.error('Edit task error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Delete task ───────────────────────────────────────────────────────────────
router.delete('/api/quest/:id/tasks/:taskId', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    if (!quest.tasks.id(req.params.taskId)) return res.json({ success: false, message: 'Task not found' });
    quest.tasks.pull(req.params.taskId);
    await quest.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete task error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Review task submission (approve/reject) ───────────────────────────────────

router.post('/api/quest/:id/review/:progressId', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const { action, taskId } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.json({ success: false, message: 'Invalid action' });
    }
    const progress = await UserQuestProgress.findById(req.params.progressId);
    if (!progress || String(progress.questId) !== String(quest._id)) {
      return res.json({ success: false, message: 'Progress not found' });
    }
    const taskProgress = progress.taskProgress.find(tp => tp.taskId.toString() === taskId);
    if (!taskProgress) return res.json({ success: false, message: 'Task progress not found' });

    if (action === 'approve') {
      const allTasks = [...quest.tasks, ...(quest.dailyTasks || [])];
      const task = allTasks.find(t => t._id.toString() === taskId);
      const taskXp = task ? (task.xpReward || 0) : 0;
      taskProgress.approvalStatus = 'approved';
      taskProgress.isCompleted = true;
      taskProgress.completedAt = new Date();
      taskProgress.xpEarned = taskXp;
      progress.xpBreakdown.taskXp = (progress.xpBreakdown.taskXp || 0) + taskXp;
      progress.tasksCompleted = (progress.tasksCompleted || 0) + 1;
      progress.progress = Math.round((progress.tasksCompleted / (progress.totalTasks || 1)) * 100);
      progress.xpBreakdown.totalXp = (progress.xpBreakdown.taskXp || 0) + (progress.xpBreakdown.baseXp || 0) +
        (progress.xpBreakdown.referralJoinBonus || 0) + (progress.xpBreakdown.referralCompleteBonus || 0) +
        (progress.xpBreakdown.winnerBonus || 0) + (progress.xpBreakdown.adminAdjustmentXp || 0);
      if (progress.tasksCompleted >= (progress.totalTasks || 1) && progress.status !== 'completed') {
        progress.status = 'completed';
        progress.completedAt = new Date();
        progress.xpBreakdown.baseXp = quest.baseXpReward || 0;
        progress.xpBreakdown.totalXp += (quest.baseXpReward || 0);
        quest.totalCompletions = (quest.totalCompletions || 0) + 1;
        await quest.save();
      }
      progress.markModified('xpBreakdown');
      await progress.save();
      if (taskXp > 0) {
        const User = require('../models/User');
        await User.findByIdAndUpdate(progress.userId, { $inc: { xp: taskXp } });
      }
    } else {
      taskProgress.approvalStatus = 'rejected';
      await progress.save();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Review submission error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Quest applications (gated quests) ────────────────────────────────────────

router.get('/api/quest/:id/applications', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id).lean();
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const { status } = req.query;
    const filter = { questId: quest._id };
    if (status) filter.status = status;
    const applications = await QuestApplication.find(filter)
      .populate('userId', 'username profilePicture')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, applications });
  } catch (err) {
    console.error('Quest applications error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

router.post('/api/quest/:id/applications/:appId/approve', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id);
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const application = await QuestApplication.findById(req.params.appId);
    if (!application || String(application.questId) !== String(quest._id)) {
      return res.json({ success: false, message: 'Application not found' });
    }
    application.status = 'approved';
    application.reviewedAt = new Date();
    await application.save();

    const existing = await UserQuestProgress.findOne({ questId: quest._id, userId: application.userId });
    if (!existing) {
      await UserQuestProgress.create({
        questId:    quest._id,
        userId:     application.userId,
        status:     'not_started',
        startedAt:  new Date(),
        totalTasks: quest.tasks ? quest.tasks.length : 0,
        taskProgress: []
      });
      await Quest.findByIdAndUpdate(quest._id, { $inc: { totalParticipants: 1 } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Approve application error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

router.post('/api/quest/:id/applications/:appId/reject', businessAuth, async (req, res) => {
  try {
    const business = req.business;
    const quest = await Quest.findById(req.params.id).lean();
    if (!quest || String(quest.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Quest not found' });
    }
    const application = await QuestApplication.findById(req.params.appId);
    if (!application || String(application.questId) !== String(quest._id)) {
      return res.json({ success: false, message: 'Application not found' });
    }
    application.status = 'rejected';
    application.rejectionReason = (req.body.reason || '').trim();
    application.reviewedAt = new Date();
    await application.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Reject application error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Wallet address lookup API ─────────────────────────────────────────────────

router.get('/api/wallet-address', businessAuth, async (req, res) => {
  try {
    const { token, network } = req.query;
    const wallet = await WalletAddress.findOne({ token, network, isActive: true });
    if (!wallet) return res.json({ found: false });
    res.json({ found: true, address: wallet.address, label: wallet.label, id: wallet._id });
  } catch (err) {
    res.json({ found: false });
  }
});

// ── Commission preview API ────────────────────────────────────────────────────

router.get('/api/commission-preview', businessAuth, async (req, res) => {
  try {
    const settings = await CommissionSettings.getCurrent();
    const amount   = parseFloat(req.query.amount) || 0;
    const bdAmt    = Math.round(amount * settings.bdCommissionRate       / 100 * 100) / 100;
    const platAmt  = Math.round(amount * settings.platformCommissionRate / 100 * 100) / 100;
    const poolAmt  = Math.round((amount - bdAmt - platAmt) * 100) / 100;
    res.json({ bdAmt, platAmt, poolAmt, bdRate: settings.bdCommissionRate, platRate: settings.platformCommissionRate });
  } catch (err) {
    res.json({ error: true });
  }
});

// ── Events API ────────────────────────────────────────────────────────────────

router.post('/api/events/create', businessAuth, async (req, res) => {
  try {
    const Event = require('../models/Event');
    const business = req.business;
    const { title, description, eventType, startDate, endDate, location, maxAttendees, approvalType, bannerImage } = req.body;
    if (!title?.trim() || !description?.trim() || !startDate) {
      return res.json({ success: false, message: 'Title, description and start date are required' });
    }
    const et = ['virtual', 'physical', 'hybrid'].includes(eventType) ? eventType : 'virtual';
    const loc = location?.trim() || null;
    await Event.create({
      title: title.trim(),
      description: description.trim(),
      eventType: et,
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : new Date(startDate),
      startTime: '10:00', endTime: '17:00',
      venue: (et === 'physical' || et === 'hybrid') ? loc : null,
      virtualLink: (et === 'virtual' || et === 'hybrid') ? loc : null,
      maxAttendees: maxAttendees ? +maxAttendees : null,
      approvalType: approvalType === 'manual' ? 'manual' : 'auto',
      bannerImage: bannerImage?.trim() || null,
      sponsoredBy: business._id,
      isActive: true,
      organizer: business.name,
    });
    res.json({ success: true, message: 'Event created.' });
  } catch (err) {
    console.error('Business create event error:', err);
    res.json({ success: false, message: err.message || 'Server error' });
  }
});

router.get('/api/events/:id/registrations', businessAuth, async (req, res) => {
  try {
    const Event = require('../models/Event');
    const business = req.business;
    const event = await Event.findById(req.params.id)
      .populate('registrations.user', 'username email profilePicture')
      .lean();
    if (!event || String(event.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Event not found' });
    }
    res.json({ success: true, event, registrations: event.registrations || [] });
  } catch (err) {
    console.error('Business event registrations error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

router.post('/api/events/:id/approve/:userId', businessAuth, async (req, res) => {
  try {
    const Event = require('../models/Event');
    const business = req.business;
    const event = await Event.findById(req.params.id);
    if (!event || String(event.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Event not found' });
    }
    const reg = event.registrations.find(r => String(r.user) === req.params.userId);
    if (!reg) return res.json({ success: false, message: 'Registration not found' });
    if (event.maxAttendees && event.totalApproved >= event.maxAttendees) {
      return res.json({ success: false, message: 'Event has reached maximum capacity' });
    }
    reg.status = 'approved';
    reg.approvedAt = new Date();
    await event.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Business approve reg error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

router.post('/api/events/:id/reject/:userId', businessAuth, async (req, res) => {
  try {
    const Event = require('../models/Event');
    const business = req.business;
    const event = await Event.findById(req.params.id);
    if (!event || String(event.sponsoredBy) !== String(business._id)) {
      return res.json({ success: false, message: 'Event not found' });
    }
    const reg = event.registrations.find(r => String(r.user) === req.params.userId);
    if (!reg) return res.json({ success: false, message: 'Registration not found' });
    reg.status = 'rejected';
    reg.rejectionReason = req.body.reason || null;
    await event.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Business reject reg error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
