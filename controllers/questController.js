const Quest = require("../models/Quest");
const UserQuestProgress = require("../models/UserQuestProgress");
const User = require("../models/User");
const QuestApplication = require("../models/QuestApplication");
const { notify } = require('../utils/notificationService');
const { syncQuestProgress } = require('../utils/questProgressSync');

// In-memory leaderboard cache — 5 min TTL, stampede protection
const _lbCache   = new Map();
const _lbFlight  = new Set(); // prevents multiple concurrent DB fetches
const _LB_TTL    = 5 * 60 * 1000;

function _getLbCache(questId) {
  const e = _lbCache.get(questId.toString());
  if (e && Date.now() - e.ts < _LB_TTL) return e.data;
  return null;
}
function _setLbCache(questId, data) {
  _lbCache.set(questId.toString(), { data, ts: Date.now() });
}
function _invalidateLbCache(questId) {
  _lbCache.delete(questId.toString());
}
exports.invalidateQuestLeaderboard = _invalidateLbCache;

// Tiebreaker: same XP → completed beats in_progress; both completed → earlier completedAt wins; both in_progress → earlier startedAt wins
function _sortLeaderboard(entries) {
  return entries.sort((a, b) => {
    const xpDiff = (b.xpBreakdown?.totalXp || 0) - (a.xpBreakdown?.totalXp || 0);
    if (xpDiff !== 0) return xpDiff;
    // Same XP: whoever earned it first (did their tasks earlier) ranks higher
    const aT = a.lastXpAt || a.completedAt || a.startedAt || a.createdAt;
    const bT = b.lastXpAt || b.completedAt || b.startedAt || b.createdAt;
    return (aT && bT) ? new Date(aT) - new Date(bT) : 0;
  });
}

// Add this at the top of your quest controller functions
const checkIfBanned = async (userId) => {
  const user = await User.findById(userId);
  if (user && user.isBanned) {
    return {
      banned: true,
      reason: user.banReason || 'Terms of Service violation'
    };
  }
  return { banned: false };
};


// ==================== QUEST LISTING ====================
exports.getAllQuests = async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect('/auth');
    }

    const user = await User.findById(req.session.userId).select('-password -recentActivity -notifications');

    if (!user) {
      return res.redirect('/auth');
    }
     if (user.isBanned) {
      return res.render('dashboard/quest', { 
        title: 'Quests - Access Restricted',
        user: user.toObject(),
        isBanned: true,
        banReason: user.banReason || 'Terms of Service violation',
        bannedAt: user.bannedAt,
        activeQuests: [],
        availableQuests: [],
        completedQuests: [],
        pastQuests: [],
        upcomingQuests: [],
        completedCount: 0
      });
    }
    
    const now = new Date();

    // Get ALL active quests
    const allQuests = await Quest.find({
      isActive: true
    }).sort({ createdAt: -1 });

    // Get user's progress — only need status/progress fields, not taskProgress arrays
    const userProgress = await UserQuestProgress.find({
      userId: req.session.userId
    })
    .select('questId status progress tasksCompleted totalTasks')
    .lean();

    // Get user's quest applications for gated quests
    const gatedQuestIds = allQuests.filter(q => q.gated).map(q => q._id);
    const appMap = {};
    if (gatedQuestIds.length > 0) {
      const apps = await QuestApplication.find({ userId: req.session.userId, questId: { $in: gatedQuestIds } }).select('questId status').lean();
      apps.forEach(a => { appMap[a.questId.toString()] = a; });
    }

    // Create a map of quest progress
    const progressMap = {};
    userProgress.forEach(progress => {
      progressMap[progress.questId.toString()] = progress;
    });

    // Categorize quests
    const activeQuests = [];
    const availableQuests = [];
    const completedQuests = [];
    const pastQuests = [];
    const upcomingQuests = [];
    const specialCampaigns = [];

    allQuests.forEach(quest => {
      const progress = progressMap[quest._id.toString()];
      const app = appMap[quest._id.toString()];

      const questData = {
        ...quest.toObject(),
        userProgress: progress || null,
        appStatus: app ? app.status : 'none'
      };

      // Check dates first so ended quests always land in pastQuests
      const isAvailableNow = (!quest.startDate || quest.startDate <= now) &&
                             (!quest.endDate || quest.endDate >= now);

      const hasEnded = quest.endDate && quest.endDate < now;

      if (hasEnded) {
        pastQuests.push(questData);
        return;
      }

      // Special/gated quests go in their own section (only if still active)
      if (quest.isSpecialQuest || quest.gated) {
        specialCampaigns.push(questData);
        return;
      }

      if (quest.startDate && quest.startDate > now) {
        upcomingQuests.push(questData);
        return;
      }

      if (isAvailableNow) {
        if (progress && progress.status === 'completed') {
          completedQuests.push(questData);
        } else if (progress && progress.status === 'in_progress') {
          activeQuests.push(questData);
        } else {
          availableQuests.push(questData);
        }
      }
    });

    console.log('📊 Quest counts - Special:', specialCampaigns.length, 'Available:', availableQuests.length, 'Active:', activeQuests.length, 'Completed:', completedQuests.length, 'Past:', pastQuests.length);

    res.render('dashboard/quest', {
      title: 'Quests',
      user: user.toObject(),
      activeQuests: activeQuests || [],
      availableQuests: availableQuests || [],
      completedQuests: completedQuests || [],
      pastQuests: pastQuests || [],
      upcomingQuests: upcomingQuests || [],
      specialCampaigns: specialCampaigns || [],
      completedCount: completedQuests.length
    });

  } catch (error) {
    console.error("❌ Get quests error:", error);
    res.status(500).send("Error loading quests");
  }
};

// ==================== QUEST DETAILS ====================
exports.getQuestDetails = async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect('/auth');
    }
    const { questId } = req.params;
    const user = await User.findById(req.session.userId).select('-password -recentActivity -notifications');
    

    // 🚫 CHECK IF USER IS BANNED
    if (user.isBanned) {
      return res.render('dashboard/quest-details', { 
        title: 'Quest - Access Restricted',
        user: user.toObject(),
        isBanned: true,
        banReason: user.banReason || 'Terms of Service violation',
        bannedAt: user.bannedAt,
        quest: null,
        userProgress: null,
        leaderboard: [],
        userRank: null
      });
    }
   
    
    const quest = await Quest.findById(questId);

    if (!quest) {
      return res.status(404).send("Quest not found");
    }

    // Handle gated quests: check application status before creating progress
    if (quest.gated && quest.memberApproval) {
      const application = await QuestApplication.findOne({ questId: quest._id, userId: req.session.userId });
      const appState = application ? application.status : 'none';

      if (appState !== 'approved') {
        // Fetch participant count for display
        const participantCount = await QuestApplication.countDocuments({ questId: quest._id, status: 'approved' });
        return res.render('dashboard/quest-details', {
          title: quest.title,
          user: user.toObject(),
          quest: quest.toObject(),
          questStatus: quest.getDisplayStatus(),
          appState: appState,
          application: application ? application.toObject() : null,
          participantCount,
          userProgress: null,
          leaderboard: [],
          userRank: null,
          isBanned: false
        });
      }
    }

    // Get or create user progress
    let userProgress = await UserQuestProgress.findOne({
      userId: req.session.userId,
      questId: questId
    });

    if (!userProgress) {
      // Combine regular tasks + daily tasks
      const allTasks = [...quest.tasks, ...(quest.dailyTasks || [])];

      userProgress = new UserQuestProgress({
        userId: req.session.userId,
        questId: questId,
        totalTasks: allTasks.length,
        taskProgress: allTasks.map(task => ({
          taskId: task._id,
          isCompleted: false
        }))
      });
      await userProgress.save();
    } else {
      if (syncQuestProgress(userProgress, quest)) {
        await userProgress.save();
        _invalidateLbCache(questId);
      }
    }

    // Leaderboard — served from 5-min cache, one DB fetch on cache miss
    let validLeaderboard = _getLbCache(questId);
    if (!validLeaderboard) {
      const lb = await UserQuestProgress.find({
        questId: questId,
        status: { $in: ['completed', 'in_progress'] }
      })
      .select('-taskProgress')
      .populate('userId', 'username profilePicture')
      .sort({ 'xpBreakdown.totalXp': -1, lastXpAt: 1, completedAt: 1, startedAt: 1, createdAt: 1 })
      .limit(100)
      .lean();
      validLeaderboard = _sortLeaderboard(lb.filter(entry => entry.userId));
      _setLbCache(questId, validLeaderboard);
    }

    // Find user's rank
    const userRank = validLeaderboard.findIndex(
      entry => entry.userId._id.toString() === req.session.userId
    ) + 1;

    // Get quest display status
    const questStatus = quest.getDisplayStatus();

    // For approved gated quest members: get participant count (cached with leaderboard)
    let participantCount = 0;
    if (quest.gated && quest.memberApproval) {
      const cached = _lbCache.get(questId.toString() + '_pc');
      if (cached && Date.now() - cached.ts < _LB_TTL) {
        participantCount = cached.data;
      } else {
        participantCount = await QuestApplication.countDocuments({ questId: quest._id, status: 'approved' });
        _lbCache.set(questId.toString() + '_pc', { data: participantCount, ts: Date.now() });
      }
    }

    res.render('dashboard/quest-details', {
      title: quest.title,
      user: user.toObject(),
      quest: quest.toObject(),
      questStatus: questStatus,
      appState: 'approved',
      application: null,
      participantCount,
      userProgress: userProgress.toObject(),
      leaderboard: [],
      userRank: userRank || null,
      isBanned: false
    });

  } catch (error) {
    console.error("Get quest details error:", error);
    res.status(500).send("Error loading quest details");
  }
};

// ==================== START QUEST ====================
exports.startQuest = async (req, res) => {
  try {
    const banCheck = await checkIfBanned(req.session.userId);
    if (banCheck.banned) {
      return res.status(403).json({
        success: false,
        message: `Account suspended: ${banCheck.reason}`
      });
    }


    const { questId } = req.body;

    const quest = await Quest.findById(questId);
    
    if (!quest) {
      return res.status(404).json({ 
        success: false, 
        message: "Quest not found" 
      });
    }

    // Check if quest has ended
    if (quest.hasEnded()) {
      const status = quest.getDisplayStatus();
      if (status === 'distributing') {
        return res.status(400).json({
          success: false,
          message: "This quest has ended. Rewards are being distributed.",
          questStatus: 'distributing'
        });
      }
      return res.status(400).json({
        success: false,
        message: "This quest has ended.",
        questStatus: 'ended'
      });
    }

    // Check if quest is currently active
    if (!quest.isCurrentlyActive()) {
      return res.status(400).json({
        success: false,
        message: "This quest is not currently available"
      });
    }

    // Check if user already has progress
    let userProgress = await UserQuestProgress.findOne({
      userId: req.session.userId,
      questId: questId
    });

    if (userProgress && userProgress.status === 'in_progress') {
      return res.status(400).json({ 
        success: false, 
        message: "Quest already in progress" 
      });
    }

    if (userProgress && userProgress.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        message: "Quest already completed" 
      });
    }

    // ==================== BATCH RELEASE CHECK (FCFS only) ====================
    if (quest.questType === 'fcfs' && quest.batchConfig?.enabled && quest.startDate) {
      const batchSize = quest.batchConfig.batchSize || 50;
      const intervalHours = quest.batchConfig.intervalHours || 48;
      const hoursElapsed = (Date.now() - new Date(quest.startDate).getTime()) / (1000 * 60 * 60);
      const currentBatch = Math.floor(hoursElapsed / intervalHours) + 1;
      const spotsAvailable = currentBatch * batchSize;

      if (quest.totalParticipants >= spotsAvailable) {
        const nextBatchAt = new Date(quest.startDate.getTime() + currentBatch * intervalHours * 60 * 60 * 1000);
        return res.status(403).json({
          success: false,
          message: `This batch is full. The next batch of ${batchSize} spots opens soon.`,
          batchFull: true,
          nextBatchAt,
          spotsInBatch: batchSize,
          currentBatch
        });
      }
    }

    if (!userProgress) {
      const allTasks = [...quest.tasks, ...(quest.dailyTasks || [])];

      userProgress = new UserQuestProgress({
        userId: req.session.userId,
        questId: questId,
        totalTasks: allTasks.length,
        taskProgress: allTasks.map(task => ({
          taskId: task._id,
          isCompleted: false
        }))
      });
    } else {
      // 🔄 SYNC PROGRESS: If user had old progress, sync with current quest structure
      const allTasks = [...quest.tasks, ...(quest.dailyTasks || [])];
      const currentTaskIds = allTasks.map(t => t._id.toString());

      // Remove tasks that no longer exist
      const validTaskProgress = userProgress.taskProgress.filter(tp =>
        currentTaskIds.includes(tp.taskId.toString())
      );

      // Add new tasks
      allTasks.forEach(task => {
        const exists = validTaskProgress.find(tp => tp.taskId.toString() === task._id.toString());
        if (!exists) {
          validTaskProgress.push({
            taskId: task._id,
            isCompleted: false
          });
        }
      });

      userProgress.taskProgress = validTaskProgress;
      userProgress.totalTasks = allTasks.length;
      userProgress.tasksCompleted = validTaskProgress.filter(tp => tp.isCompleted).length;
      userProgress.progress = Math.round((userProgress.tasksCompleted / userProgress.totalTasks) * 100);
    }

    userProgress.status = 'in_progress';
    userProgress.startedAt = new Date();
    await userProgress.save();

    // Update quest stats
    quest.totalAttempts += 1;
    quest.totalParticipants += 1;
    await quest.save();

    // ==================== REFERRAL BONUS ====================
    const user = await User.findById(req.session.userId);
    
    if (quest.referralConfig?.enabled && user.referredBy) {
      await processReferralJoinBonus(user.referredBy, user._id, questId, quest.referralConfig.xpPerReferralJoin);
    }

    // Add activity to user
    user.recentActivity.unshift({
      action: `Started quest: ${quest.title}`,
      timestamp: new Date()
    });
    if (user.recentActivity.length > 10) {
      user.recentActivity = user.recentActivity.slice(0, 10);
    }
    await user.save();

    res.status(200).json({ 
      success: true, 
      message: "Quest started successfully",
      questId: questId
    });

  } catch (error) {
    console.error("Start quest error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
};

// ==================== SUBMIT TASK - FIXED ====================
exports.submitTask = async (req, res) => {
  try {
    const { questId, taskId, submissionUrl, submissionData } = req.body;
    let submissionText = req.body.submissionText;


    const userProgress = await UserQuestProgress.findOne({
      userId: req.session.userId,
      questId: questId
    });

    if (!userProgress) {
      return res.status(404).json({ 
        success: false, 
        message: "Quest progress not found" 
      });
    }

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    // Check if quest has ended
    if (quest.hasEnded()) {
      const status = quest.getDisplayStatus();
      if (status === 'distributing') {
        return res.status(400).json({
          success: false,
          message: "This quest has ended. Rewards are being distributed. No more submissions allowed.",
          questStatus: 'distributing'
        });
      }
      return res.status(400).json({
        success: false,
        message: "This quest has ended. No more submissions allowed.",
        questStatus: 'ended'
      });
    }

    // Find the task in quest first
    const allTasks = [...quest.tasks, ...(quest.dailyTasks || [])];
    const task = allTasks.find(t => t._id.toString() === taskId);

    // Sync taskProgress — remove stale entries for deleted tasks, add entries for new tasks
    // This handles cases where tasks were changed after the user joined (e.g. after a quest reset)
    const currentTaskIds = new Set(allTasks.map(t => t._id.toString()));
    // Remove entries for tasks that no longer exist
    userProgress.taskProgress = userProgress.taskProgress.filter(tp => currentTaskIds.has(tp.taskId.toString()));
    // Add entries for tasks not yet tracked
    allTasks.forEach(t => {
      if (!userProgress.taskProgress.find(tp => tp.taskId.toString() === t._id.toString())) {
        userProgress.taskProgress.push({ taskId: t._id, isCompleted: false });
      }
    });
    userProgress.totalTasks = allTasks.length;

    // Find the task in progress
    let taskProgress = userProgress.taskProgress.find(
      tp => tp.taskId.toString() === taskId
    );

    if (!taskProgress) {
      if (!task) {
        return res.status(404).json({
          success: false,
          message: "Task not found"
        });
      }
      // Shouldn't reach here after sync above, but safety net
      userProgress.taskProgress.push({ taskId: task._id, isCompleted: false });
      userProgress.totalTasks = allTasks.length;
      taskProgress = userProgress.taskProgress[userProgress.taskProgress.length - 1];
    }

    // If task was removed from quest but exists in user's progress, auto-complete it with 0 XP
    if (!task) {
      console.log(`⚠️ Task ${taskId} removed from quest but exists in user progress - auto-completing`);

      taskProgress.isCompleted = true;
      taskProgress.completedAt = new Date();
      taskProgress.xpEarned = 0;

      userProgress.tasksCompleted += 1;
      userProgress.progress = Math.round((userProgress.tasksCompleted / userProgress.totalTasks) * 100);

      await userProgress.save();

      return res.status(200).json({
        success: true,
        message: "This task is no longer part of the quest and has been marked as complete",
        progress: userProgress.progress,
        isQuestCompleted: userProgress.tasksCompleted === userProgress.totalTasks,
        taskXpEarned: 0,
        taskRemoved: true
      });
    }

    if (taskProgress.isCompleted) {
      return res.status(400).json({
        success: false,
        message: "Task already completed"
      });
    }

    // ==================== DAY-UNLOCK GATE ====================
    if (task.availableFromDay > 0 && quest.startDate) {
      const unlockAt = new Date(quest.startDate).getTime() + task.availableFromDay * 24 * 60 * 60 * 1000;
      if (Date.now() < unlockAt) {
        const daysLeft = Math.ceil((unlockAt - Date.now()) / (24 * 60 * 60 * 1000));
        return res.status(400).json({
          success: false,
          message: `This task unlocks on Day ${task.availableFromDay + 1} of the quest (in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}).`
        });
      }
    }

    // A configured custom input (for example, an X username) is required proof.
    if (task.inputName && !['poll', 'webhook', 'discord_join', 'telegram_join'].includes(task.taskType)) {
      const answer = submissionData?.[task.inputName] ?? submissionText;
      if (typeof answer !== 'string' || !answer.trim()) {
        return res.status(400).json({ success: false, message: `${task.inputLabel || 'Please provide the requested proof'} is required.` });
      }
      submissionText = answer.trim();
      if (task.inputType === 'link') {
        let parsedAnswer;
        try { parsedAnswer = new URL(submissionText); } catch { return res.status(400).json({ success: false, message: 'Enter a valid URL for this task.' }); }
        if (!['http:', 'https:'].includes(parsedAnswer.protocol)) return res.status(400).json({ success: false, message: 'Task links must use http:// or https://.' });
      }
    }

    if (task.taskType === 'submission' && !task.inputName) {
      const submittedUrl = String(submissionUrl || submissionText || '').trim();
      let parsedUrl;
      try { parsedUrl = new URL(submittedUrl); } catch { return res.status(400).json({ success: false, message: 'Enter a valid URL for this task.' }); }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).json({ success: false, message: 'Task links must use http:// or https://.' });
    }
    // ==================== SPECIAL TASK TYPE VERIFICATION ====================
    const { verifyTelegramMembership, verifyDiscordMembership, callWebhook } = require('../utils/socialVerification');

    if (task.taskType === 'poll') {
      const pollChoice = submissionData?.pollChoice;
      if (!pollChoice) {
        return res.status(400).json({ success: false, message: 'Please select a poll option' });
      }
      // Find and increment the vote on the quest document
      const taskInQuest = quest.tasks.id(taskId) || (quest.dailyTasks || []).find(t => t._id.toString() === taskId);
      if (taskInQuest) {
        const option = taskInQuest.pollOptions.find(o => o.text === pollChoice);
        if (!option) return res.status(400).json({ success: false, message: 'Invalid poll option' });
        option.votes += 1;
        quest.markModified('tasks');
        quest.markModified('dailyTasks');
        await quest.save();
      }
      // Store the choice in submissionText so it's visible in admin
      submissionText = pollChoice;

    } else if (task.taskType === 'webhook') {
      if (!task.webhookUrl) {
        return res.status(400).json({ success: false, message: 'This task has no verification endpoint configured' });
      }
      const webhookUser = await User.findById(req.session.userId).select('username telegramUsername').lean();
      const result = await callWebhook(task.webhookUrl, {
        userId:   req.session.userId,
        username: webhookUser?.username,
        telegram: webhookUser?.telegramUsername,
        taskId,
        questId
      });
      if (!result.success) {
        return res.status(400).json({ success: false, message: result.message || 'Verification failed' });
      }

    } else if (task.taskType === 'telegram_join') {
      const tgUser = await User.findById(req.session.userId).select('telegramId').lean();
      if (!tgUser?.telegramId) {
        return res.status(400).json({ success: false, message: 'Connect your Telegram account first', requiresTelegram: true });
      }
      if (!task.telegramChatId) {
        return res.status(400).json({ success: false, message: 'Task has no Telegram group configured' });
      }
      const result = await verifyTelegramMembership(task.telegramChatId, tgUser.telegramId);
      if (!result.isMember) {
        const chatName = task.telegramChatName ? `"${task.telegramChatName}"` : 'the required Telegram group';
        return res.status(400).json({ success: false, message: `You are not a member of ${chatName}. Join it and try again.` });
      }

    } else if (task.taskType === 'discord_join') {
      const dcUser = await User.findById(req.session.userId).select('discordId discordConnected').lean();
      if (!dcUser?.discordConnected || !dcUser?.discordId) {
        return res.status(400).json({ success: false, message: 'Connect your Discord account first', requiresDiscord: true });
      }
      if (!task.discordGuildId) {
        return res.status(400).json({ success: false, message: 'Task has no Discord server configured' });
      }
      const result = await verifyDiscordMembership(task.discordGuildId, dcUser.discordId);
      if (!result.isMember) {
        const guildName = task.discordGuildName ? `"${task.discordGuildName}"` : 'the required Discord server';
        return res.status(400).json({ success: false, message: `You are not a member of ${guildName}. Join it and try again.` });
      }

    } else {
      // ==================== ANTI-GARBAGE VALIDATION (standard tasks) ====================
      const { validateSubmission } = require('../utils/submissionValidator');

      const validationResult = await validateSubmission(
        task,
        { url: submissionUrl, text: submissionText, screenshot: submissionData },
        req.session.userId
      );

      if (!validationResult.isValid) {
        return res.status(400).json({
          success: false,
          message: "Submission validation failed",
          errors: validationResult.errors,
          warnings: validationResult.warnings
        });
      }
    }

    // Update task progress
    const needsApproval = task.requiresApproval && quest.questType !== 'fcfs';
    taskProgress.approvalStatus = needsApproval ? 'pending' : 'auto';
    taskProgress.submissionUrl  = submissionUrl;
    taskProgress.submissionText = submissionText;
    taskProgress.submissionData = submissionData;
    if (submissionData && submissionData.image) {
      taskProgress.submissionImage = submissionData.image;
    }

    if (needsApproval) {
      await userProgress.save();
      return res.json({
        success: true,
        pending: true,
        message: 'Submission received — pending admin review',
        progress: userProgress.progress
      });
    }

    taskProgress.isCompleted = true;
    taskProgress.completedAt = new Date();
    userProgress.lastXpAt = new Date();

    // Award XP for this specific task
    const taskXp = task.xpReward || 0;
    taskProgress.xpEarned = taskXp;
    
    // ✅ QUEST-SPECIFIC XP (for leaderboard) — sum from real data to avoid drift
    userProgress.xpBreakdown.taskXp = userProgress.taskProgress
      .filter(tp => tp.isCompleted)
      .reduce((sum, tp) => sum + (tp.xpEarned || 0), 0);

    // Update overall progress
    userProgress.tasksCompleted += 1;
    userProgress.progress = Math.round((userProgress.tasksCompleted / userProgress.totalTasks) * 100);

    // ✅ Recalculate totalXp
    userProgress.xpBreakdown.totalXp = 
      (userProgress.xpBreakdown.taskXp || 0) +
      (userProgress.xpBreakdown.baseXp || 0) +
      (userProgress.xpBreakdown.referralJoinBonus || 0) +
      (userProgress.xpBreakdown.referralCompleteBonus || 0) +
      (userProgress.xpBreakdown.winnerBonus || 0) +
      (userProgress.xpBreakdown.adminAdjustmentXp || 0);

    userProgress.markModified('xpBreakdown');

    // ✅ GLOBAL XP (for dashboard) - Add task XP immediately
    const user = await User.findById(req.session.userId);
    user.xp += taskXp;
    
    user.recentActivity.unshift({
      action: `Completed task: ${task.title} (+${taskXp} XP)`,
      timestamp: new Date()
    });

    // ==================== CHECK IF QUEST COMPLETED ====================
    const alreadyCompleted = userProgress.status === 'completed';
    if (userProgress.tasksCompleted === userProgress.totalTasks && !alreadyCompleted) {
      userProgress.status = 'completed';
      userProgress.completedAt = new Date();
      
      // Calculate time spent
      if (userProgress.startedAt) {
        userProgress.timeSpentMinutes = Math.round(
          (userProgress.completedAt - userProgress.startedAt) / 60000
        );
      }

      // ✅ QUEST-SPECIFIC: Base XP for completing quest
      const baseQuestXp = quest.baseXpReward || 0;
      userProgress.xpBreakdown.baseXp = baseQuestXp;
      // Ranked USDC is a shared prize pool: do not credit the whole pool to each completer.
      // The admin distributes configured rank shares after results are finalized.
      const rankPercentages = quest.competitionConfig?.rankPercentages;
      const hasRankedPrizePool = quest.questType === 'competition' ||
        (Array.isArray(rankPercentages) && rankPercentages.length > 0);
      const instantUsdcReward = quest.questType === 'fcfs'
        ? Math.max(0, Number(quest.rewardPlan?.rewardPerPerson) || 0)
        : (hasRankedPrizePool ? 0 : Math.max(0, Number(quest.usdcReward) || 0));
      userProgress.usdcEarned = instantUsdcReward;
      userProgress.badgeEarned = quest.badgeReward;

      // ✅ Recalculate totalXp with base XP
      userProgress.xpBreakdown.totalXp = 
        (userProgress.xpBreakdown.taskXp || 0) +
        baseQuestXp +
        (userProgress.xpBreakdown.referralJoinBonus || 0) +
        (userProgress.xpBreakdown.referralCompleteBonus || 0) +
        (userProgress.xpBreakdown.winnerBonus || 0) +
        (userProgress.xpBreakdown.adminAdjustmentXp || 0);

      userProgress.markModified('xpBreakdown');

      // ✅ GLOBAL XP: Add base quest XP to user's total
      user.xp += baseQuestXp;
      user.usdcBalance += userProgress.usdcEarned;

      // Calculate total quest XP for display
      const totalQuestXp = userProgress.xpBreakdown.taskXp + baseQuestXp;

      user.recentActivity.unshift({
        action: `🎉 Completed quest: ${quest.title} (+${totalQuestXp} XP${userProgress.usdcEarned > 0 ? ', +' + userProgress.usdcEarned + ' USDC' : ''})`,
        timestamp: new Date()
      });

      // Update quest stats
      quest.totalCompletions += 1;

      // Update average completion time
      const completedQuests = await UserQuestProgress.find({
        questId: questId,
        status: 'completed',
        timeSpentMinutes: { $gt: 0 }
      });

      if (completedQuests.length > 0) {
        const totalTime = completedQuests.reduce((sum, q) => sum + q.timeSpentMinutes, 0);
        quest.averageCompletionTime = Math.round(totalTime / completedQuests.length);
      }

      // ==================== FCFS: auto-close when slots fill up ====================
      if (quest.questType === 'fcfs' && quest.maxParticipants && quest.totalParticipants >= quest.maxParticipants) {
        quest.isActive = false;
        console.log(`[FCFS] Quest ${quest._id} auto-closed: ${quest.totalParticipants}/${quest.maxParticipants} slots filled`);
      }

      await quest.save();

      // ==================== REFERRAL COMPLETION BONUS ====================
      if (quest.referralConfig?.enabled && user.referredBy) {
        await processReferralCompleteBonus(user.referredBy, user._id, questId, quest.referralConfig.xpPerReferralComplete);
      }

      // ==================== FCFS/COMPETITION LOGIC ====================
      if (quest.questType === 'fcfs' || quest.questType === 'competition') {
        await updateQuestLeaderboard(questId, quest);
      }
    }
    
    if (user.recentActivity.length > 10) {
      user.recentActivity = user.recentActivity.slice(0, 10);
    }

    // ── Feed events: role upgrade + USDC earned ────────────────────────────
    try {
      const FeedEvent = require('../models/FeedEvent');
      const io        = req.app.get('io');

      const getRoleKey = (xp) => {
        if ((xp||0) >= 250000) return 'major';
        if ((xp||0) >= 100000) return 'legend';
        if ((xp||0) >= 25000)  return 'ambassador';
        if ((xp||0) >= 10000)  return 'contributor';
        return 'citizen';
      };

      const totalXpAwarded = taskXp + (userProgress.status === 'completed' ? (quest.baseXpReward || 0) : 0);
      const xpBefore = user.xp - totalXpAwarded;
      const oldRole  = getRoleKey(xpBefore);
      const newRole  = getRoleKey(user.xp);

      if (oldRole !== newRole) {
        const ev = await FeedEvent.create({
          type: 'role_upgrade', userId: user._id, username: user.username,
          data: { oldRole, newRole }
        });
        io?.emit('feed_event', {
          type: 'role_upgrade', username: user.username,
          data: { oldRole, newRole }, createdAt: ev.createdAt
        });
      }

      if (userProgress.status === 'completed' && (userProgress.usdcEarned || 0) > 0) {
        const ev = await FeedEvent.create({
          type: 'usdc_earned', userId: user._id, username: user.username,
          data: { amount: userProgress.usdcEarned, questTitle: quest.title }
        });
        io?.emit('feed_event', {
          type: 'usdc_earned', username: user.username,
          data: { amount: userProgress.usdcEarned, questTitle: quest.title }, createdAt: ev.createdAt
        });
      }
    } catch (_) {}
    // ──────────────────────────────────────────────────────────────────────

    await user.save();
    await userProgress.save();
    _invalidateLbCache(questId);

    // ── Notifications ───────────────────────────────────────────────────────
    if (userProgress.status === 'completed') {
        const totalXp = userProgress.xpBreakdown?.totalXp || 0;
        const usdc    = userProgress.usdcEarned || 0;
        await notify(user._id, {
            type:    'quest',
            title:   'Quest Completed!',
            message: `You completed "${quest.title}" and earned ${totalXp} XP${usdc > 0 ? ` + $${usdc} USDC` : ''}!`,
            link:    `/dashboard/quests/${quest._id}`
        });
    } else if (taskXp > 0) {
        await notify(user._id, {
            type:    'submission',
            title:   'Task Approved',
            message: `Your task in "${quest.title}" was approved. +${taskXp} XP`,
            link:    `/dashboard/quests/${quest._id}`
        });
    }
    // ────────────────────────────────────────────────────────────────────────

    res.status(200).json({
      success: true,
      message: userProgress.status === 'completed' ? "Quest completed!" : "Task submitted successfully",
      progress: userProgress.progress,
      isQuestCompleted: userProgress.status === 'completed',
      taskXpEarned: taskXp,
      rewards: userProgress.status === 'completed' ? {
        xp: userProgress.xpBreakdown.totalXp,
        usdc: userProgress.usdcEarned,
        badge: userProgress.badgeEarned
      } : null
    });

  } catch (error) {
    console.error("Submit task error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
  }
};

// ==================== QUEST LEADERBOARD ====================
exports.getQuestLeaderboard = async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect('/auth');
    }

    const { questId } = req.params;
    const user = await User.findById(req.session.userId).select('-password -recentActivity -notifications');

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).send("Quest not found");
    }

    // Leaderboard — served from cache if fresh
    let validLeaderboard = _getLbCache(questId);
    if (!validLeaderboard) {
      const leaderboard = await UserQuestProgress.find({
        questId: questId,
        status: { $in: ['completed', 'in_progress'] }
      })
      .select('-taskProgress')
      .populate('userId', 'username profilePicture')
      .sort({ 'xpBreakdown.totalXp': -1, lastXpAt: 1, completedAt: 1, startedAt: 1, createdAt: 1 })
      .limit(100)
      .lean();
      validLeaderboard = _sortLeaderboard(leaderboard.filter(entry => entry.userId));
      _setLbCache(questId, validLeaderboard);
    }

    // Find user's rank
    const userRank = validLeaderboard.findIndex(
      entry => entry.userId._id.toString() === req.session.userId
    ) + 1;

    // Get user's progress
    const userProgress = await UserQuestProgress.findOne({
      userId: req.session.userId,
      questId: questId
    });

    console.log(`📊 Leaderboard for ${quest.title}:`);
    console.log(`   Total entries: ${validLeaderboard.length}`);
    console.log(`   User rank: ${userRank || 'Not found'}`);
    if (userProgress) {
      console.log(`   User status: ${userProgress.status}`);
      console.log(`   User XP: ${userProgress.xpBreakdown?.totalXp || 0}`);
      console.log(`   User tasks: ${userProgress.tasksCompleted}/${userProgress.totalTasks}`);
    }

    res.render('dashboard/quest-leaderboard', {
      title: `${quest.title} - Leaderboard`,
      user: user.toObject(),
      quest: quest.toObject(),
      leaderboard: validLeaderboard,
      userRank: userRank || null,
      userProgress: userProgress ? userProgress.toObject() : null
    });

  } catch (error) {
    console.error("Get leaderboard error:", error);
    res.status(500).send("Error loading leaderboard");
  }
};

// ==================== QUEST LEADERBOARD JSON API ====================
exports.getQuestLeaderboardJSON = async (req, res) => {
  try {
    const { questId } = req.params;
    const userId = req.session.userId;

    let validLeaderboard = _getLbCache(questId);
    if (!validLeaderboard) {
      const lb = await UserQuestProgress.find({
        questId: questId,
        status: { $in: ['completed', 'in_progress'] }
      })
      .select('-taskProgress')
      .populate('userId', 'username profilePicture')
      .sort({ 'xpBreakdown.totalXp': -1, lastXpAt: 1, completedAt: 1, startedAt: 1, createdAt: 1 })
      .limit(100)
      .lean();
      validLeaderboard = _sortLeaderboard(lb.filter(entry => entry.userId));
      _setLbCache(questId, validLeaderboard);
    }

    const entries = validLeaderboard.map((entry, idx) => ({
      rank: idx + 1,
      username: entry.userId?.username || 'Anonymous',
      profilePicture: entry.userId?.profilePicture || null,
      totalXp: entry.xpBreakdown?.totalXp || 0,
      timeSpentMinutes: entry.timeSpentMinutes || 0,
      completedAt: entry.completedAt || null,
      isWinner: entry.isWinner || false,
      isCurrentUser: entry.userId?._id?.toString() === userId?.toString()
    }));

    res.json({ success: true, entries, total: entries.length });
  } catch (error) {
    console.error('Quest leaderboard JSON error:', error);
    res.json({ success: false, entries: [], total: 0 });
  }
};

// ==================== HELPER FUNCTIONS - FIXED (NO VERIFICATION CHECKS) ====================
async function processReferralJoinBonus(referralCode, referredUserId, questId, xpBonus) {
  try {
    if (xpBonus <= 0) return;

    const quest = await Quest.findById(questId);
    if (quest && quest.hasEnded()) {
      console.log(`⏹️ Quest ${questId} has ended - skipping referral join bonus`);
      return;
    }

    // ✅ REMOVED ALL VERIFICATION CHECKS - Just verify user exists
    const referredUser = await User.findById(referredUserId);
    if (!referredUser) {
      console.log(`⚠️ Referral join bonus skipped - referred user not found`);
      return;
    }

    const referrer = await User.findOne({ referralCode });
    if (!referrer) {
      console.log(`⚠️ Referral join bonus skipped - referrer not found`);
      return;
    }

    let referrerProgress = await UserQuestProgress.findOne({
      userId: referrer._id,
      questId: questId
    });

    // Update quest-level referral stats if referrer has started the quest
    if (referrerProgress) {
      // Check if this referral was already counted
      const alreadyCounted = referrerProgress.referralStats.referralsJoined.some(
        r => r.userId.toString() === referredUserId.toString()
      );
      if (alreadyCounted) {
        console.log(`⚠️ Referral join bonus skipped - already counted for ${referredUser.username}`);
        return;
      }

      // ✅ Add referral to quest progress
      referrerProgress.referralStats.referralsJoined.push({
        userId: referredUserId,
        joinedAt: new Date(),
        xpEarned: xpBonus
      });

      // ✅ Recalculate referral XP
      referrerProgress.calculateReferralXp();
      referrerProgress.markModified('xpBreakdown');
      referrerProgress.markModified('referralStats');
      await referrerProgress.save();
    } else {
      console.log(`ℹ️ Referrer ${referrer.username} hasn't started this quest yet - awarding global XP only`);
    }

    // ✅ GLOBAL XP: Always award to referrer regardless of quest progress
    referrer.xp += xpBonus;
    referrer.recentActivity.unshift({
      action: `Earned ${xpBonus} XP - ${referredUser.username} joined quest 🎁`,
      timestamp: new Date()
    });

    if (referrer.recentActivity.length > 10) {
      referrer.recentActivity = referrer.recentActivity.slice(0, 10);
    }

    await referrer.save();
    console.log(`✅ Referral join bonus: ${referrer.username} earned ${xpBonus} XP for ${referredUser.username}`);
  } catch (error) {
    console.error("Process referral join bonus error:", error);
  }
}

async function processReferralCompleteBonus(referralCode, referredUserId, questId, xpBonus) {
  try {
    if (xpBonus <= 0) return;

    const quest = await Quest.findById(questId);
    if (quest && quest.hasEnded()) {
      console.log(`⏹️ Quest ${questId} has ended - skipping referral complete bonus`);
      return;
    }

    // ✅ REMOVED ALL VERIFICATION CHECKS - Just verify user exists
    const referredUser = await User.findById(referredUserId);
    if (!referredUser) {
      console.log(`⚠️ Referral complete bonus skipped - referred user not found`);
      return;
    }

    const referrer = await User.findOne({ referralCode });
    if (!referrer) {
      console.log(`⚠️ Referral complete bonus skipped - referrer not found`);
      return;
    }

    let referrerProgress = await UserQuestProgress.findOne({
      userId: referrer._id,
      questId: questId
    });

    // Update quest-level referral stats if referrer has started the quest
    if (referrerProgress) {
      // Check if already counted
      const alreadyCounted = referrerProgress.referralStats.referralsCompleted.some(
        r => r.userId.toString() === referredUserId.toString()
      );
      if (alreadyCounted) {
        console.log(`⚠️ Referral complete bonus skipped - already counted for ${referredUser.username}`);
        return;
      }

      // ✅ Add referral to quest progress
      referrerProgress.referralStats.referralsCompleted.push({
        userId: referredUserId,
        completedAt: new Date(),
        xpEarned: xpBonus
      });

      // ✅ Recalculate referral XP
      referrerProgress.calculateReferralXp();
      referrerProgress.markModified('xpBreakdown');
      referrerProgress.markModified('referralStats');
      await referrerProgress.save();
    } else {
      console.log(`ℹ️ Referrer ${referrer.username} hasn't started this quest yet - awarding global XP only`);
    }

    // ✅ GLOBAL XP: Always award to referrer regardless of quest progress
    referrer.xp += xpBonus;
    referrer.recentActivity.unshift({
      action: `Earned ${xpBonus} XP - ${referredUser.username} completed quest 🏆`,
      timestamp: new Date()
    });

    if (referrer.recentActivity.length > 10) {
      referrer.recentActivity = referrer.recentActivity.slice(0, 10);
    }

    await referrer.save();
    console.log(`✅ Referral complete bonus: ${referrer.username} earned ${xpBonus} XP for ${referredUser.username}`);
  } catch (error) {
    console.error("Process referral complete bonus error:", error);
  }
}

async function updateQuestLeaderboard(questId, quest) {
  try {
    const questEnded    = !quest.endDate || new Date() >= new Date(quest.endDate);
    const topWinners    = quest.competitionConfig?.topWinnersCount || 10;
    const winnerBonusXp = questEnded ? (quest.competitionConfig?.winnerBonusXP || 0) : 0;

    // Only fetch the fields we actually write — avoids loading taskProgress arrays
    const allCompleted = await UserQuestProgress.find({
      questId: questId,
      status: 'completed'
    })
    .select('userId leaderboardRank isWinner winnerRank xpBreakdown')
    .sort({ completedAt: 1 })
    .lean();

    if (!allCompleted.length) return;

    const bulkOps = [];
    const winnerUserUpdates = []; // userId + xpBonus pairs

    for (let i = 0; i < allCompleted.length; i++) {
      const progress  = allCompleted[i];
      const rank      = i + 1;
      const isWinner  = questEnded && i < topWinners;
      const update    = { leaderboardRank: rank, isWinner, winnerRank: isWinner ? rank : null };

      if (isWinner && winnerBonusXp > 0 && !(progress.xpBreakdown?.winnerBonus > 0)) {
        const newTotal = (progress.xpBreakdown?.taskXp || 0) +
                         (progress.xpBreakdown?.baseXp || 0) +
                         (progress.xpBreakdown?.referralJoinBonus || 0) +
                         (progress.xpBreakdown?.referralCompleteBonus || 0) +
                         (progress.xpBreakdown?.adminAdjustmentXp || 0) +
                         winnerBonusXp;
        update['xpBreakdown.winnerBonus'] = winnerBonusXp;
        update['xpBreakdown.totalXp']     = newTotal;
        winnerUserUpdates.push({ userId: progress.userId, bonus: winnerBonusXp, rank });
      }

      bulkOps.push({ updateOne: { filter: { _id: progress._id }, update: { $set: update } } });
    }

    // Single bulkWrite instead of N sequential saves
    await UserQuestProgress.bulkWrite(bulkOps, { ordered: false });

    // Award winner bonus XP to users (only when quest ended and bonus configured)
    for (const { userId, bonus, rank } of winnerUserUpdates) {
      await User.findByIdAndUpdate(userId, {
        $inc: { xp: bonus },
        $push: { recentActivity: { $each: [{ action: `🥇 Won #${rank} in quest! (+${bonus} bonus XP)`, timestamp: new Date() }], $position: 0, $slice: 10 } }
      });
    }
  } catch (error) {
    console.error("Update leaderboard error:", error);
  }
}
