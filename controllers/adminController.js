// controllers/adminController.js
const User = require("../models/User");
const Quest = require("../models/Quest");
const Event = require("../models/Event");
const CourseApplication = require("../models/CourseApplication");
const UserQuestProgress = require("../models/UserQuestProgress");
const ApiUsage = require("../models/ApiUsage");
const emailService = require("../utils/emailService");

const Transaction = require("../models/Transaction");
const { notify, broadcast } = require('../utils/notificationService');


// ==================== DASHBOARD ====================

// Get Admin Dashboard Page
exports.getAdminDashboard = async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect('/auth');
    }

    const user = await User.findById(req.session.userId).select('-password');
    
    if (!user) {
      return res.redirect('/auth');
    }

    // Check if user is admin
    if (!user.isAdmin) {
      return res.redirect('/dashboard');
    }

    res.render('admin/dashboard', { 
      title: 'Admin Dashboard',
      user: user.toObject()
    });

  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).send("Error loading admin dashboard");
  }
};

// ==================== STATISTICS ====================

// Get Overall Statistics
exports.getStatistics = async (req, res) => {
  try {
    console.log('📊 Fetching statistics...');

    const totalUsers = await User.countDocuments();
    const activeQuests = await Quest.countDocuments({ isActive: true });
    const now = new Date();
    const upcomingEvents = await Event.countDocuments({
      startDate: { $gte: now },
      status: { $in: ['upcoming', 'ongoing'] }
    });
    const pendingApplications = await CourseApplication.countDocuments({ status: 'pending' });

    // Calculate total XP and USDC distributed
    const userStats = await User.aggregate([
      {
        $group: {
          _id: null,
          totalXP: { $sum: '$xp' },
          totalUSDC: { $sum: '$usdcBalance' }
        }
      }
    ]);

    // Get API usage stats (today)
    const apiUsageToday = await ApiUsage.getTodayUsage();

    // Get total API calls in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const totalApiCalls30Days = await ApiUsage.countDocuments({
      createdAt: { $gte: thirtyDaysAgo }
    });

    const stats = {
      totalUsers,
      activeQuests,
      upcomingEvents,
      pendingApplications,
      totalXP: userStats[0]?.totalXP || 0,
      totalUSDC: userStats[0]?.totalUSDC || 0,
      apiUsage: {
        today: apiUsageToday.total,
        last30Days: totalApiCalls30Days,
        byService: apiUsageToday.byService
      }
    };

    console.log('✅ Statistics:', stats);

    res.status(200).json({
      success: true,
      stats
    });

  } catch (error) {
    console.error("❌ Get statistics error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching statistics",
      error: error.message
    });
  }
};

// ==================== USERS MANAGEMENT ====================

// Get All Users
exports.getAllUsers = async (req, res) => {
  try {
    console.log('👥 Fetching users...');
    
    const { search, status, page = 1, limit = 50 } = req.query;

    let query = {};

    // Search filter
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Status filter
    if (status === 'verified') {
      query.isVerified = true;
    } else if (status === 'unverified') {
      query.isVerified = false;
    }

    const users = await User.find(query)
      .select('-password -verificationToken')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await User.countDocuments(query);

    console.log(`✅ Found ${users.length} users`);

    res.status(200).json({
      success: true,
      users,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error("❌ Get users error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message
    });
  }
};

// Get User Count
exports.getUserCount = async (req, res) => {
  try {
    const count = await User.countDocuments();
    console.log(`👥 Total users: ${count}`);
    
    res.status(200).json({
      success: true,
      count
    });
  } catch (error) {
    console.error("❌ Get user count error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user count",
      error: error.message
    });
  }
};

// Get Single User Details
exports.getUserDetails = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select('-password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Get user's quest progress
    const questProgress = await UserQuestProgress.find({ userId })
      .populate('questId', 'title xpReward')
      .sort({ createdAt: -1 })
      .limit(10);

    // Get user's event registrations
    const events = await Event.find({ 'registrations.user': userId })
      .select('title startDate eventType')
      .sort({ startDate: -1 })
      .limit(10);

    res.status(200).json({
      success: true,
      user,
      questProgress,
      events
    });

  } catch (error) {
    console.error("Get user details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user details"
    });
  }
};

// Update User
exports.updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { xp, usdcBalance, profession, isVerified } = req.body;

    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Update allowed fields
    if (xp !== undefined) user.xp = xp;
    if (usdcBalance !== undefined) user.usdcBalance = usdcBalance;
    if (profession !== undefined) user.profession = profession;
    if (isVerified !== undefined) user.isVerified = isVerified;

    await user.save();

    res.status(200).json({
      success: true,
      message: "User updated successfully",
      user
    });

  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating user"
    });
  }
};

// Delete User
exports.deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findByIdAndDelete(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Clean up user's data
    await UserQuestProgress.deleteMany({ userId });
    await Event.updateMany(
      { 'registrations.user': userId },
      { $pull: { registrations: { user: userId } } }
    );

    res.status(200).json({
      success: true,
      message: "User deleted successfully"
    });

  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting user"
    });
  }
};

// Login as User (Admin Impersonation)
exports.loginAsUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const adminId = req.session.userId;
    const adminUsername = req.session.username;

    // Find the target user
    const targetUser = await User.findById(userId);

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Prevent impersonating other admins
    if (targetUser.isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Cannot impersonate admin accounts"
      });
    }

    // Store admin's original session info for audit trail
    const originalAdminId = adminId;
    const originalAdminUsername = adminUsername;

    // Create new session as the target user
    req.session.userId = targetUser._id;
    req.session.username = targetUser.username;
    req.session.email = targetUser.email;
    req.session.isAdmin = false; // They should NOT have admin powers when impersonating
    req.session.role = targetUser.role || 'user';
    req.session.isVerified = targetUser.isVerified;

    // Store impersonation info in session
    req.session.isImpersonating = true;
    req.session.originalAdminId = originalAdminId;
    req.session.originalAdminUsername = originalAdminUsername;

    // Log the impersonation for audit
    console.log(`🔐 ADMIN IMPERSONATION: Admin "${originalAdminUsername}" (${originalAdminId}) logged in as user "${targetUser.username}" (${targetUser._id})`);

    // Add to target user's activity log
    targetUser.recentActivity = targetUser.recentActivity || [];
    targetUser.recentActivity.unshift({
      action: `Admin impersonation by ${originalAdminUsername}`,
      timestamp: new Date()
    });
    if (targetUser.recentActivity.length > 10) {
      targetUser.recentActivity = targetUser.recentActivity.slice(0, 10);
    }
    await targetUser.save();

    res.status(200).json({
      success: true,
      message: `Logged in as ${targetUser.username}`,
      redirectUrl: '/dashboard'
    });

  } catch (error) {
    console.error("Login as user error:", error);
    res.status(500).json({
      success: false,
      message: "Error logging in as user"
    });
  }
};

// Export Users CSV
exports.exportUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select('username email xp usdcBalance createdAt isVerified')
      .sort({ createdAt: -1 });

    // Create CSV
    let csv = 'Username,Email,XP,USDC Balance,Verified,Join Date\n';
    users.forEach(user => {
      csv += `${user.username},${user.email},${user.xp},${user.usdcBalance},${user.isVerified ? 'Yes' : 'No'},${new Date(user.createdAt).toLocaleDateString()}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send(csv);

  } catch (error) {
    console.error("Export users error:", error);
    res.status(500).json({
      success: false,
      message: "Error exporting users"
    });
  }
};

// ==================== QUESTS MANAGEMENT ====================

// Get All Quests (Admin)
exports.getAllQuests = async (req, res) => {
  try {
    console.log('🎯 Fetching quests...');
    
    const { search, status, category } = req.query;

    let query = {};

    if (search) {
      query.title = { $regex: search, $options: 'i' };
    }

    if (status === 'active') {
      query.isActive = true;
    } else if (status === 'inactive') {
      query.isActive = false;
    }

    if (category) {
      query.category = category;
    }

    const quests = await Quest.find(query)
      .sort({ createdAt: -1 });

    console.log(`✅ Found ${quests.length} quests`);

    res.status(200).json({
      success: true,
      quests
    });

  } catch (error) {
    console.error("❌ Get quests error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching quests",
      error: error.message
    });
  }
};

// Get Quest by ID
exports.getQuestById = async (req, res) => {
  try {
    const { questId } = req.params;
    const quest = await Quest.findById(questId);

    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    res.status(200).json({
      success: true,
      quest
    });

  } catch (error) {
    console.error("❌ Get quest by ID error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching quest"
    });
  }
};

// Get Quest Statistics
exports.getQuestStats = async (req, res) => {
  try {
    const active = await Quest.countDocuments({ isActive: true });
    const inactive = await Quest.countDocuments({ isActive: false });
    const total = await Quest.countDocuments();

    console.log(`🎯 Quest stats - Active: ${active}, Inactive: ${inactive}`);

    res.status(200).json({
      success: true,
      active,
      inactive,
      total
    });

  } catch (error) {
    console.error("❌ Get quest stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching quest statistics",
      error: error.message
    });
  }
};
exports.createQuest = async (req, res) => {
  try {
    const {
      title,
      description,
      shortDescription,
      category,
      difficulty,
      questType,
      baseXpReward,
      usdcReward,
      badgeReward,
      estimatedDuration,
      image,
      tasks,
      dailyTasks,
      resources,
      startDate,
      endDate,
      maxParticipants,
      batchEnabled,
      batchSize,
      batchIntervalHours,
      referralEnabled,
      xpPerReferralJoin,
      xpPerReferralComplete,
      competitionEnabled,
      topWinnersCount,
      winnerBonusXP,
      firstPlacePercent,
      secondPlacePercent,
      rankPercentages
    } = req.body;

    console.log('🎯 Creating quest with data:', req.body);

    // Validation
    if (!title || !description || !shortDescription) {
      return res.status(400).json({
        success: false,
        message: "Title, description, and short description are required"
      });
    }

    if (questType === 'referral_boost' && (Number(xpPerReferralJoin) || 0) <= 0 && (Number(xpPerReferralComplete) || 0) <= 0) {
      return res.status(400).json({ success: false, message: 'Set XP for at least one referral milestone (joining or completing the quest) before publishing a referral boost.' });
    }

    const winnerCount = Math.max(1, Math.min(100, parseInt(topWinnersCount, 10) || 10));
    let savedRankPercentages = Array.isArray(rankPercentages) ? rankPercentages.map(Number) : [];
    if (questType === 'competition') {
      if (!(Number(usdcReward) > 0)) return res.status(400).json({ success: false, message: 'Enter the USDC prize pool before publishing this competition.' });
      if (!savedRankPercentages.length) {
        const first = Math.min(100, Math.max(0, Number(firstPlacePercent ?? 50)));
        const second = winnerCount > 1 ? Math.min(100 - first, Math.max(0, Number(secondPlacePercent ?? 30))) : 0;
        savedRankPercentages = winnerCount === 1 ? [100] : winnerCount === 2 ? [first, 100 - first] : [first, second, ...Array(winnerCount - 2).fill((100 - first - second) / (winnerCount - 2))];
      }
      if (savedRankPercentages.length !== winnerCount || savedRankPercentages.some(p => !Number.isFinite(p) || p < 0 || p > 100) || Math.abs(savedRankPercentages.reduce((a, b) => a + b, 0) - 100) > 0.01) {
        return res.status(400).json({ success: false, message: `Enter one percentage for each of the ${winnerCount} places. Percentages must total 100%.` });
      }
    }

    // Format tasks with XP rewards
    const formattedTasks = Array.isArray(tasks)
      ? tasks.map((task, index) => {
          if (typeof task === "string") {
            return {
              title: task,
              description: task,
              order: index + 1,
              taskType: "submission",
              xpReward: 0, // Admin can set this
              isDaily: false
            };
          }

          // Auto-extract Twitter username from buttonLink if task is social
          // Only use twitterFollowTarget if admin explicitly set it
          let twitterFollowTarget = task.twitterFollowTarget || null;

          return {
            title: task.title || task.description || `Task ${index + 1}`,
            description: task.description || task.title || "",
            order: index + 1,
            taskType: task.taskType || "submission",
            xpReward: task.xpReward || 0, // XP per task
            isDaily: false,
            inputLabel: task.inputLabel || null,
            inputName: task.inputName || null,
            buttonText: task.buttonText || null,
            buttonLink: task.buttonLink || null,
            twitterFollowTarget: twitterFollowTarget,
            requirements: task.requirements || {},
            validationUrl: task.validationUrl || null,
            // New task type fields
            pollOptions: Array.isArray(task.pollOptions) ? task.pollOptions.map(o => ({ text: o.text || o, votes: 0 })) : [],
            webhookUrl: task.webhookUrl || null,
            discordGuildId: task.discordGuildId || null,
            discordGuildName: task.discordGuildName || null,
            telegramChatId: task.telegramChatId || null,
            telegramChatName: task.telegramChatName || null,
            inputType: task.inputType || (task.inputLabel ? "text" : "link"),
            requiresApproval: task.requiresApproval !== false && !!(task.inputLabel || task.requiresApproval)
          };
        })
      : [];

    // Format daily tasks (if any)
    const formattedDailyTasks = Array.isArray(dailyTasks)
      ? dailyTasks.map((task, index) => ({
          title: task.title,
          description: task.description,
          order: formattedTasks.length + index + 1,
          taskType: task.taskType || "submission",
          xpReward: task.xpReward || 0,
          isDaily: true,
          inputLabel: task.inputLabel || null,
          inputName: task.inputName || null,
          buttonText: task.buttonText || null,
          buttonLink: task.buttonLink || null,
          twitterFollowTarget: task.twitterFollowTarget || null
        }))
      : [];

    console.log('📋 Formatted tasks:', formattedTasks);
    console.log('📅 Formatted daily tasks:', formattedDailyTasks);

    const quest = new Quest({
      title,
      description,
      shortDescription,
      category: category || 'learning',
      difficulty: difficulty || 'beginner',
      questType: questType || 'standard',
      
      // Rewards
      baseXpReward: baseXpReward || 0,
      usdcReward: usdcReward || 0,
      badgeReward: badgeReward || null,
      
      estimatedDuration: estimatedDuration || "1-2 hours",
      image: image || null,
      tasks: formattedTasks,
      dailyTasks: formattedDailyTasks,
      resources: resources || [],
      
      // Dates
      startDate: startDate || null,
      endDate: endDate || null,
      maxParticipants: maxParticipants || null,
      
      // Referral config
      referralConfig: {
        enabled: referralEnabled || questType === 'referral_boost',
        xpPerReferralJoin: xpPerReferralJoin || 0,
        xpPerReferralComplete: xpPerReferralComplete || 0
      },
      
      // Batch config (FCFS only)
      batchConfig: {
        enabled:       batchEnabled || false,
        batchSize:     batchSize || 50,
        intervalHours: batchIntervalHours || 48
      },

      // Competition config
      competitionConfig: {
        enabled: competitionEnabled || questType === 'competition',
        topWinnersCount: winnerCount,
        winnerBonusXP: winnerBonusXP || 0,
        firstPlacePercent: firstPlacePercent === undefined ? 50 : Math.min(100, Math.max(0, parseFloat(firstPlacePercent) || 0)),
        secondPlacePercent: secondPlacePercent === undefined ? 30 : Math.min(100, Math.max(0, parseFloat(secondPlacePercent) || 0)),
        rankPercentages: savedRankPercentages
      },

      createdBy: req.session.userId,
      isActive: true
    });

    await quest.save();

    // Broadcast new quest notification to users who opted in
    broadcast('newQuests', {
        type:    'quest',
        title:   'New Quest Available!',
        message: `"${quest.title}" is now live. Complete it to earn ${quest.baseXpReward || quest.xpReward || 0} XP${quest.usdcReward > 0 ? ` + $${quest.usdcReward} USDC` : ''}!`,
        link:    '/dashboard/quests'
    }).catch(() => {});

    console.log('✅ Quest created successfully:', quest._id);

    res.status(201).json({
      success: true,
      message: "Quest created successfully",
      quest
    });

  } catch (error) {
    console.error("❌ Create quest error:", error);
    res.status(500).json({
      success: false,
      message: "Error creating quest",
      error: error.message
    });
  }
};

// ==================== ADD DAILY TASK TO QUEST ====================

exports.addDailyTask = async (req, res) => {
  try {
    const { questId } = req.params;
    const { title, description, taskType, xpReward, inputLabel, inputName, buttonText, buttonLink } = req.body;

    const quest = await Quest.findById(questId);
    
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    const newTask = {
      title,
      description,
      order: quest.tasks.length + quest.dailyTasks.length + 1,
      taskType: taskType || 'submission',
      xpReward: xpReward || 0,
      isDaily: true,
      inputLabel: inputLabel || null,
      inputName: inputName || null,
      buttonText: buttonText || null,
      buttonLink: buttonLink || null
    };

    quest.dailyTasks.push(newTask);
    await quest.save();

    // Update all active user progress to include this new task
    await UserQuestProgress.updateMany(
      { questId: questId, status: { $in: ['not_started', 'in_progress'] } },
      {
        $push: {
          taskProgress: {
            taskId: newTask._id,
            isCompleted: false
          }
        },
        $inc: { totalTasks: 1 }
      }
    );

    res.status(200).json({
      success: true,
      message: "Daily task added successfully",
      task: newTask
    });

  } catch (error) {
    console.error("Add daily task error:", error);
    res.status(500).json({
      success: false,
      message: "Error adding daily task"
    });
  }
};

// ==================== REMOVE DAILY TASK ====================

exports.removeDailyTask = async (req, res) => {
  try {
    const { questId, taskId } = req.params;

    const quest = await Quest.findById(questId);
    
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    // Remove from daily tasks
    quest.dailyTasks = quest.dailyTasks.filter(t => t._id.toString() !== taskId);
    await quest.save();

    // Remove from user progress
    await UserQuestProgress.updateMany(
      { questId: questId },
      {
        $pull: {
          taskProgress: { taskId: taskId }
        },
        $inc: { totalTasks: -1 }
      }
    );

    res.status(200).json({
      success: true,
      message: "Daily task removed successfully"
    });

  } catch (error) {
    console.error("Remove daily task error:", error);
    res.status(500).json({
      success: false,
      message: "Error removing daily task"
    });
  }
};

// ==================== GET QUEST LEADERBOARD (ADMIN VIEW) ====================

exports.getQuestLeaderboardAdmin = async (req, res) => {
  try {
    const { questId } = req.params;

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    const leaderboard = await UserQuestProgress.find({
      questId: questId,
      status: { $in: ['completed', 'in_progress'] }
    })
    .populate('userId', 'username email _id')
    .sort({ 'xpBreakdown.totalXp': -1, lastXpAt: 1, completedAt: 1, startedAt: 1, createdAt: 1 })
    .limit(100)
    .lean();

    // 🔧 FIX: Transform data to ensure userId is always a string
    const leaderboardData = leaderboard.map((entry, index) => {
      const userId = entry.userId?._id?.toString() || entry.userId;
      
      const xp = entry.xpBreakdown || {};
      const refs = entry.referralStats || {};
      return {
        rank: index + 1,
        userId: userId,
        username: entry.userId?.username || 'Unknown',
        email: entry.userId?.email || '',
        totalXp: xp.totalXp || 0,
        taskXp: xp.taskXp || 0,
        baseXp: xp.baseXp || 0,
        referralJoinBonus: xp.referralJoinBonus || 0,
        referralCompleteBonus: xp.referralCompleteBonus || 0,
        winnerBonus: xp.winnerBonus || 0,
        completedAt: entry.completedAt,
        timeSpent: entry.timeSpentMinutes || 0,
        isWinner: entry.isWinner || false,
        referralsJoined: (refs.referralsJoined || []).length,
        referralsCompleted: (refs.referralsCompleted || []).length
      };
    });

    res.status(200).json({
      success: true,
      quest: {
        title: quest.title,
        slug: quest.slug,
        questType: quest.questType,
        startDate: quest.startDate,
        endDate: quest.endDate,
        tasks: (quest.tasks || []).map(t => ({
          _id:        t._id,
          title:      t.title,
          description:t.description || '',
          taskType:   t.taskType,
          xpReward:   t.xpReward || 0,
          buttonText: t.buttonText || '',
          buttonLink: t.buttonLink || '',
          inputType:  t.inputType || 'none',
          inputLabel: t.inputLabel || '',
          inputName:  t.inputName  || ''
        }))
      },
      leaderboard: leaderboardData,
      totalParticipants: quest.totalParticipants,
      totalCompletions: quest.totalCompletions
    });

  } catch (error) {
    console.error("Get quest leaderboard error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching leaderboard"
    });
  }
};

// ==================== GET USER REFERRAL DETAILS (ADMIN AUDIT) ====================

exports.getUserReferralDetails = async (req, res) => {
  try {
    const { questId, userId } = req.params;

    // Get the user's quest progress with referral data
    const userProgress = await UserQuestProgress.findOne({
      questId: questId,
      userId: userId
    }).lean();

    if (!userProgress) {
      return res.status(404).json({
        success: false,
        message: "User quest progress not found"
      });
    }

    // Get detailed info for referrals who joined
    const referralsJoinedIds = userProgress.referralStats.referralsJoined.map(r => r.userId);
    const referralsCompletedIds = userProgress.referralStats.referralsCompleted.map(r => r.userId);
    const allReferralIds = [...new Set([...referralsJoinedIds, ...referralsCompletedIds])];

    // Fetch full user details for all referrals
    const referralUsers = await User.find({
      _id: { $in: allReferralIds }
    }).select('username email telegramConnected telegramUsername telegramVerifiedAt isVerified createdAt').lean();

    // Fetch quest progress for these referrals
    const referralProgresses = await UserQuestProgress.find({
      questId: questId,
      userId: { $in: allReferralIds }
    }).lean();

    // Create a map for easy lookup
    const userMap = {};
    referralUsers.forEach(user => {
      userMap[user._id.toString()] = user;
    });

    const progressMap = {};
    referralProgresses.forEach(prog => {
      progressMap[prog.userId.toString()] = prog;
    });

    // Build detailed referral data
    const referralsJoinedDetails = userProgress.referralStats.referralsJoined.map(ref => {
      const user = userMap[ref.userId.toString()] || {};
      const progress = progressMap[ref.userId.toString()] || {};

      return {
        userId: ref.userId,
        username: user.username || 'Unknown',
        email: user.email || '',
        joinedAt: ref.joinedAt,
        xpEarned: ref.xpEarned,
        // Telegram verification status
        telegramConnected: user.telegramConnected || false,
        telegramUsername: user.telegramUsername || null,
        telegramVerifiedAt: user.telegramVerifiedAt || null,
        // Email verification
        isEmailVerified: user.isVerified || false,
        // Account creation date
        accountCreatedAt: user.createdAt,
        // Quest progress
        questStatus: progress.status || 'not_started',
        questProgress: progress.progress || 0,
        tasksCompleted: progress.tasksCompleted || 0,
        totalTasks: progress.taskProgress?.length || 0,
        questCompletedAt: progress.completedAt || null
      };
    });

    const referralsCompletedDetails = userProgress.referralStats.referralsCompleted.map(ref => {
      const user = userMap[ref.userId.toString()] || {};
      const progress = progressMap[ref.userId.toString()] || {};

      return {
        userId: ref.userId,
        username: user.username || 'Unknown',
        email: user.email || '',
        completedAt: ref.completedAt,
        xpEarned: ref.xpEarned,
        // Telegram verification status
        telegramConnected: user.telegramConnected || false,
        telegramUsername: user.telegramUsername || null,
        telegramVerifiedAt: user.telegramVerifiedAt || null,
        // Email verification
        isEmailVerified: user.isVerified || false,
        // Account creation date
        accountCreatedAt: user.createdAt,
        // Quest progress
        questStatus: progress.status || 'completed',
        questProgress: progress.progress || 100,
        tasksCompleted: progress.tasksCompleted || 0,
        totalTasks: progress.taskProgress?.length || 0,
        timeSpentMinutes: progress.timeSpentMinutes || 0
      };
    });

    // Calculate summary stats
    const totalReferrals = allReferralIds.length;
    const telegramVerifiedCount = referralUsers.filter(u => u.telegramConnected).length;
    const questCompletedCount = referralProgresses.filter(p => p.status === 'completed').length;
    const suspiciousCount = referralUsers.filter(u => !u.telegramConnected || !u.isVerified).length;

    res.status(200).json({
      success: true,
      summary: {
        totalReferrals,
        telegramVerifiedCount,
        questCompletedCount,
        suspiciousCount,
        telegramVerificationRate: totalReferrals > 0 ? Math.round((telegramVerifiedCount / totalReferrals) * 100) : 0,
        questCompletionRate: totalReferrals > 0 ? Math.round((questCompletedCount / totalReferrals) * 100) : 0
      },
      referralsJoined: referralsJoinedDetails,
      referralsCompleted: referralsCompletedDetails,
      xpBreakdown: {
        referralJoinBonus: userProgress.xpBreakdown.referralJoinBonus,
        referralCompleteBonus: userProgress.xpBreakdown.referralCompleteBonus,
        totalReferralXp: userProgress.referralStats.totalReferralXp
      }
    });

  } catch (error) {
    console.error("Get user referral details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching referral details"
    });
  }
};

// ==================== GET QUEST REFERRAL AUDIT (ALL USERS) ====================

exports.getQuestReferralAudit = async (req, res) => {
  try {
    const { questId } = req.params;

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    // Get all users who have referral bonuses in this quest
    const usersWithReferrals = await UserQuestProgress.find({
      questId: questId,
      $or: [
        { 'referralStats.referralsJoined.0': { $exists: true } },
        { 'referralStats.referralsCompleted.0': { $exists: true } }
      ]
    })
    .populate('userId', 'username email telegramConnected telegramUsername')
    .sort({ 'xpBreakdown.totalXp': -1 })
    .lean();

    // Collect all referral user IDs
    const allReferralIds = new Set();
    usersWithReferrals.forEach(up => {
      up.referralStats.referralsJoined.forEach(r => allReferralIds.add(r.userId.toString()));
      up.referralStats.referralsCompleted.forEach(r => allReferralIds.add(r.userId.toString()));
    });

    // Fetch all referral users
    const referralUsers = await User.find({
      _id: { $in: Array.from(allReferralIds) }
    }).select('username telegramConnected telegramUsername isVerified createdAt').lean();

    // Fetch quest progress for referrals
    const referralProgresses = await UserQuestProgress.find({
      questId: questId,
      userId: { $in: Array.from(allReferralIds) }
    }).select('userId status progress tasksCompleted completedAt').lean();

    // Create lookup maps
    const userMap = {};
    referralUsers.forEach(u => { userMap[u._id.toString()] = u; });

    const progressMap = {};
    referralProgresses.forEach(p => { progressMap[p.userId.toString()] = p; });

    // Build audit data
    const auditData = usersWithReferrals.map(entry => {
      const referralsJoinedDetails = entry.referralStats.referralsJoined.map(ref => {
        const user = userMap[ref.userId.toString()] || {};
        const progress = progressMap[ref.userId.toString()] || {};
        return {
          username: user.username || 'Unknown',
          telegramConnected: user.telegramConnected || false,
          telegramUsername: user.telegramUsername || null,
          isEmailVerified: user.isVerified || false,
          questStatus: progress.status || 'not_started',
          questCompleted: progress.status === 'completed',
          xpAwarded: ref.xpEarned
        };
      });

      const referralsCompletedDetails = entry.referralStats.referralsCompleted.map(ref => {
        const user = userMap[ref.userId.toString()] || {};
        return {
          username: user.username || 'Unknown',
          telegramConnected: user.telegramConnected || false,
          telegramUsername: user.telegramUsername || null,
          isEmailVerified: user.isVerified || false,
          xpAwarded: ref.xpEarned
        };
      });

      // Count suspicious referrals (no TG, no TG username, or didn't complete quest)
      const suspiciousJoined = referralsJoinedDetails.filter(r =>
        !r.telegramConnected || !r.telegramUsername || !r.questCompleted
      ).length;
      const suspiciousCompleted = referralsCompletedDetails.filter(r =>
        !r.telegramConnected || !r.telegramUsername
      ).length;

      return {
        userId: entry.userId?._id?.toString(),
        username: entry.userId?.username || 'Unknown',
        email: entry.userId?.email || '',
        telegramConnected: entry.userId?.telegramConnected || false,
        telegramUsername: entry.userId?.telegramUsername || null,
        totalXp: entry.xpBreakdown.totalXp,
        referralJoinBonus: entry.xpBreakdown.referralJoinBonus,
        referralCompleteBonus: entry.xpBreakdown.referralCompleteBonus,
        referralsJoinedCount: entry.referralStats.referralsJoined.length,
        referralsCompletedCount: entry.referralStats.referralsCompleted.length,
        suspiciousReferrals: suspiciousJoined + suspiciousCompleted,
        referralsJoined: referralsJoinedDetails,
        referralsCompleted: referralsCompletedDetails
      };
    });

    // Overall stats
    const totalReferralXpAwarded = auditData.reduce((sum, u) =>
      sum + u.referralJoinBonus + u.referralCompleteBonus, 0);
    const totalSuspicious = auditData.reduce((sum, u) => sum + u.suspiciousReferrals, 0);
    const usersWithSuspiciousReferrals = auditData.filter(u => u.suspiciousReferrals > 0).length;

    res.status(200).json({
      success: true,
      quest: {
        title: quest.title,
        questType: quest.questType,
        referralConfig: quest.referralConfig
      },
      overallStats: {
        totalUsersWithReferrals: auditData.length,
        totalReferralXpAwarded,
        totalSuspiciousReferrals: totalSuspicious,
        usersWithSuspiciousReferrals
      },
      users: auditData
    });

  } catch (error) {
    console.error("Get quest referral audit error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching referral audit"
    });
  }
};

// ==================== UPDATE QUEST SETTINGS ====================

exports.updateQuestSettings = async (req, res) => {
  try {
    const { questId } = req.params;
    const {
      // Basic fields
      title,
      shortDescription,
      description,
      category,
      difficulty,
      questType,
      // Rewards
      baseXpReward,
      usdcReward,
      // Referral config
      referralEnabled,
      xpPerReferralJoin,
      xpPerReferralComplete,
      // Competition config
      competitionEnabled,
      topWinnersCount,
      winnerBonusXP,
      firstPlacePercent,
      secondPlacePercent,
      rankPercentages,
      // Dates and limits
      startDate,
      endDate,
      maxParticipants,
      // Batch config (FCFS only)
      batchEnabled,
      batchSize,
      batchIntervalHours,
      // Tasks
      tasks
    } = req.body;

    const quest = await Quest.findById(questId);

    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    if ((questType || quest.questType) === 'referral_boost' && (Number(xpPerReferralJoin ?? quest.referralConfig?.xpPerReferralJoin) || 0) <= 0 && (Number(xpPerReferralComplete ?? quest.referralConfig?.xpPerReferralComplete) || 0) <= 0) {
      return res.status(400).json({ success: false, message: 'Set XP for at least one referral milestone (joining or completing the quest) before saving a referral boost.' });
    }

    if ((questType || quest.questType) === 'competition' && !(Number(usdcReward ?? quest.usdcReward) > 0)) {
      return res.status(400).json({ success: false, message: 'Enter the USDC prize pool before saving this competition.' });
    }
    if (rankPercentages !== undefined) {
      const count = Math.max(1, Math.min(100, parseInt(topWinnersCount ?? quest.competitionConfig?.topWinnersCount, 10) || 1));
      const values = Array.isArray(rankPercentages) ? rankPercentages.map(Number) : [];
      if (values.length !== count || values.some(p => !Number.isFinite(p) || p < 0 || p > 100) || Math.abs(values.reduce((a, b) => a + b, 0) - 100) > 0.01) {
        return res.status(400).json({ success: false, message: `Enter one percentage for each of the ${count} places. Percentages must total 100%.` });
      }
      if (!quest.competitionConfig) quest.competitionConfig = {};
      quest.competitionConfig.rankPercentages = values;
      quest.competitionConfig.topWinnersCount = count;
    }

    // Update basic fields
    if (title !== undefined) quest.title = title;
    if (shortDescription !== undefined) quest.shortDescription = shortDescription;
    if (description !== undefined) quest.description = description;
    if (category !== undefined) quest.category = category;
    if (difficulty !== undefined) quest.difficulty = difficulty;
    if (questType !== undefined) quest.questType = questType;

    // Update rewards
    if (baseXpReward !== undefined) quest.baseXpReward = baseXpReward;
    if (usdcReward !== undefined) quest.usdcReward = usdcReward;

    // Update referral config
    if (referralEnabled !== undefined) quest.referralConfig.enabled = referralEnabled;
    if ((questType || quest.questType) === 'referral_boost') quest.referralConfig.enabled = true;
    if (xpPerReferralJoin !== undefined) quest.referralConfig.xpPerReferralJoin = xpPerReferralJoin;
    if (xpPerReferralComplete !== undefined) quest.referralConfig.xpPerReferralComplete = xpPerReferralComplete;

    // Update competition config
    if (competitionEnabled !== undefined) quest.competitionConfig.enabled = competitionEnabled;
    if ((questType || quest.questType) === 'competition') quest.competitionConfig.enabled = true;
    if (topWinnersCount !== undefined) quest.competitionConfig.topWinnersCount = Math.max(1, Math.min(100, parseInt(topWinnersCount, 10) || 1));
    if (winnerBonusXP !== undefined) quest.competitionConfig.winnerBonusXP = winnerBonusXP;
    if (firstPlacePercent !== undefined) quest.competitionConfig.firstPlacePercent = Math.min(100, Math.max(0, parseFloat(firstPlacePercent) || 0));
    if (secondPlacePercent !== undefined) quest.competitionConfig.secondPlacePercent = Math.min(100, Math.max(0, parseFloat(secondPlacePercent) || 0));

    // Update dates
    if (startDate !== undefined) quest.startDate = startDate;
    if (endDate !== undefined) quest.endDate = endDate;
    if (maxParticipants !== undefined) quest.maxParticipants = maxParticipants;

    // Update batch config
    if (!quest.batchConfig) quest.batchConfig = {};
    if (batchEnabled !== undefined) quest.batchConfig.enabled = batchEnabled;
    if (batchSize !== undefined) quest.batchConfig.batchSize = batchSize;
    if (batchIntervalHours !== undefined) quest.batchConfig.intervalHours = batchIntervalHours;

    // Update tasks if provided
    if (tasks !== undefined && Array.isArray(tasks)) {
      // Reindex tasks with order
      const previousTasks = quest.tasks;
      quest.tasks = tasks.map((task, index) => {
        const existing = task._id ? previousTasks.id(task._id) : null;
        const value = existing ? existing.toObject() : {};
        Object.keys(task).forEach(key => { if (task[key] !== undefined) value[key] = task[key]; });
        value.title = task.title;
        value.description = task.description;
        value.order = index + 1;
        value.taskType = task.taskType || value.taskType || 'submission';
        value.xpReward = Number(task.xpReward ?? value.xpReward) || 0;
        value.isDaily = task.isDaily ?? value.isDaily ?? false;
        value.inputLabel = task.inputLabel ?? value.inputLabel ?? null;
        value.inputName = task.inputName ?? value.inputName ?? null;
        value.requiresApproval = task.requiresApproval ?? value.requiresApproval ?? false;
        return value;
      });
    }

    quest.updatedAt = Date.now();
    await quest.save();

    if (tasks !== undefined && Array.isArray(tasks)) {
      const activeTaskIds = new Set(quest.tasks.map(task => task._id.toString()));
      const progressRows = await UserQuestProgress.find({ questId }).select('_id taskProgress status').lean();
      const totalTasks = quest.tasks.length;
      await Promise.all(progressRows.map(row => {
        const taskProgress = (row.taskProgress || []).filter(tp => activeTaskIds.has(tp.taskId.toString()));
        const tasksCompleted = taskProgress.filter(tp => tp.isCompleted).length;
        const status = row.status === 'abandoned' ? 'abandoned' : (totalTasks > 0 && tasksCompleted === totalTasks ? 'completed' : 'in_progress');
        return UserQuestProgress.updateOne({ _id: row._id }, { $set: { taskProgress, totalTasks, tasksCompleted, progress: totalTasks ? Math.round(tasksCompleted / totalTasks * 100) : 0, status } });
      }));
    }

    res.status(200).json({
      success: true,
      message: "Quest updated successfully",
      quest
    });

  } catch (error) {
    console.error("Update quest settings error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating quest settings"
    });
  }
};

// ==================== EXPORT QUEST LEADERBOARD CSV ====================

exports.exportQuestLeaderboard = async (req, res) => {
  try {
    const { questId } = req.params;

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    const leaderboard = await UserQuestProgress.find({
      questId: questId,
      status: 'completed'
    })
    .populate('userId', 'username email')
    .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1 });

    // Create CSV
    let csv = 'Rank,Username,Email,Total XP,Task XP,Base XP,Referral Join Bonus,Referral Complete Bonus,Winner Bonus,Referrals Joined,Referrals Completed,Completion Time (min),Completed At\n';
    
    leaderboard.forEach((entry, index) => {
      csv += `${index + 1},${entry.userId?.username || 'Unknown'},${entry.userId?.email || ''},${entry.xpBreakdown.totalXp},${entry.xpBreakdown.taskXp},${entry.xpBreakdown.baseXp},${entry.xpBreakdown.referralJoinBonus},${entry.xpBreakdown.referralCompleteBonus},${entry.xpBreakdown.winnerBonus},${entry.referralStats.referralsJoined.length},${entry.referralStats.referralsCompleted.length},${entry.timeSpentMinutes},${new Date(entry.completedAt).toLocaleString()}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${quest.title.replace(/\s+/g, '_')}_leaderboard.csv`);
    res.send(csv);

  } catch (error) {
    console.error("Export leaderboard error:", error);
    res.status(500).json({
      success: false,
      message: "Error exporting leaderboard"
    });
  }
};

// Export Task Completions with Task Breakdown
exports.exportTaskCompletions = async (req, res) => {
  try {
    const { questId } = req.params;
    const { taskIds } = req.query;

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({ success: false, message: "Quest not found" });
    }

    const completedUsers = await UserQuestProgress.find({
      questId: questId,
      status: 'completed'
    })
    .populate('userId', 'username')
    .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1 });

    // Filter tasks if specific ones requested
    let tasksToExport = quest.tasks;
    if (taskIds) {
      const taskIdArray = taskIds.split(',');
      tasksToExport = quest.tasks.filter(t => taskIdArray.includes(t._id.toString()));
    }

    // Simple CSV: Username + each task's user input
    const esc = (val) => `"${String(val || '').replace(/"/g, '""')}"`;

    // Header: Username, then each task title as a column
    let csv = 'Username';
    tasksToExport.forEach(task => {
      csv += ',' + esc(task.inputLabel || task.title);
    });
    csv += '\n';

    // Rows
    completedUsers.forEach((entry) => {
      const username = entry.userId?.username || 'Unknown';
      let row = esc(username);

      tasksToExport.forEach(task => {
        const tp = entry.taskProgress.find(p => p.taskId.toString() === task._id.toString());
        // Check submissionText, submissionUrl, and submissionData (custom-named inputs)
        let input = tp?.submissionText || tp?.submissionUrl || '';
        if (!input && tp?.submissionData) {
          const vals = Object.values(tp.submissionData).filter(v => v && v !== '');
          input = vals.join(', ');
        }
        row += ',' + esc(input);
      });

      csv += row + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${quest.title.replace(/\s+/g, '_')}_task_completions.csv`);
    res.send(csv);

  } catch (error) {
    console.error("Export task completions error:", error);
    res.status(500).json({ success: false, message: "Error exporting task completions" });
  }
};

// Delete Quest
exports.deleteQuest = async (req, res) => {
  try {
    const { questId } = req.params;

    const quest = await Quest.findByIdAndDelete(questId);

    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    // Delete associated progress records
    await UserQuestProgress.deleteMany({ questId });

    res.status(200).json({
      success: true,
      message: "Quest deleted successfully"
    });

  } catch (error) {
    console.error("Delete quest error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting quest"
    });
  }
};
// Toggle Quest Status (Active/Inactive)
exports.toggleQuestStatus = async (req, res) => {
  try {
    const { questId } = req.params;
    const { isActive } = req.body;

    const quest = await Quest.findById(questId);

    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    quest.isActive = isActive;
    quest.updatedAt = Date.now();
    await quest.save();

    res.status(200).json({
      success: true,
      message: `Quest ${isActive ? 'activated' : 'deactivated'} successfully`,
      quest
    });

  } catch (error) {
    console.error("Toggle quest status error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating quest status"
    });
  }
};

// Get user with their quest progress for review
exports.getUserWithQuestProgress = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Get all their quest completions
    const questProgress = await UserQuestProgress.find({
      userId: userId,
      status: 'completed'
    })
    .populate('questId', 'title questType')
    .sort({ completedAt: -1 });

    // Get their referral stats
    const referralStats = {
      totalReferred: user.referredUsers?.length || 0,
      referralCode: user.referralCode,
      referredBy: user.referredBy
    };

    res.status(200).json({
      success: true,
      user,
      questProgress,
      referralStats
    });

  } catch (error) {
    console.error("Get user with progress error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user data"
    });
  }
};

// Ban user and remove from all leaderboards
exports.banUserFromQuests = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason, removeXP, removeUSDC } = req.body;

    // 🔍 DEBUG: Log what we received
    console.log('🚫 Ban request received:');
    console.log('  userId from params:', userId);
    console.log('  userId type:', typeof userId);
    console.log('  userId length:', userId?.length);
    console.log('  reason:', reason);
    console.log('  removeXP:', removeXP);
    console.log('  removeUSDC:', removeUSDC);

    // Validate userId exists
    if (!userId || userId === 'undefined' || userId === 'null') {
      console.error('❌ Invalid user ID: userId is', userId);
      return res.status(400).json({
        success: false,
        message: "Invalid user ID: undefined or null"
      });
    }

    // Validate MongoDB ObjectId format (24 hex characters)
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      console.error('❌ Invalid MongoDB ObjectId format:', userId);
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format. Must be a valid MongoDB ObjectId."
      });
    }

    console.log(`✅ Valid userId received: ${userId}`);
    console.log(`🚫 Banning user for reason: ${reason}`);

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      console.error('❌ User not found:', userId);
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    console.log(`👤 Found user: ${user.username} (${user.email})`);

    // 1. Mark user as banned
    user.isBanned = true;
    user.banReason = reason;
    user.bannedAt = new Date();
    user.bannedBy = req.session.userId;

    // 2. Optionally remove their XP and USDC
    if (removeXP) {
      console.log(`  Removing XP: ${user.xp} → 0`);
      user.xp = 0;
    }
    if (removeUSDC) {
      console.log(`  Removing USDC: ${user.usdcBalance} → 0`);
      user.usdcBalance = 0;
    }

    await user.save();
    console.log('✅ User ban status saved');

    // 3. Delete ALL their quest progress (removes from leaderboards)
    const deletedProgress = await UserQuestProgress.deleteMany({ userId: userId });
    console.log(`✅ Deleted ${deletedProgress.deletedCount} quest progress records`);

    // 4. Update quest stats (reduce completion counts)
    const affectedQuests = await UserQuestProgress.distinct('questId', { userId: userId });
    console.log(`📊 Updating ${affectedQuests.length} quests...`);
    
    for (const questId of affectedQuests) {
      const quest = await Quest.findById(questId);
      if (quest) {
        quest.totalCompletions = Math.max(0, quest.totalCompletions - 1);
        quest.totalParticipants = Math.max(0, quest.totalParticipants - 1);
        await quest.save();
      }
    }

    // 5. Remove them from referral leaderboards (if applicable)
    if (user.referralCode) {
      const updatedReferrals = await User.updateMany(
        { referredBy: user.referralCode },
        { $set: { referredBy: null } }
      );
      console.log(`✅ Removed ${updatedReferrals.modifiedCount} referral connections`);
    }

    // 6. Log the ban action
    console.log(`✅ User ${user.username} banned successfully!`);
    console.log(`   - Quest completions removed: ${deletedProgress.deletedCount}`);
    console.log(`   - XP removed: ${removeXP}`);
    console.log(`   - USDC removed: ${removeUSDC}`);

    res.status(200).json({
      success: true,
      message: `User banned and removed from ${deletedProgress.deletedCount} quest leaderboards`,
      details: {
        username: user.username,
        questsRemoved: deletedProgress.deletedCount,
        xpRemoved: removeXP,
        usdcRemoved: removeUSDC
      }
    });

  } catch (error) {
    console.error("❌ Ban user error:", error);
    console.error("Error stack:", error.stack);
    res.status(500).json({
      success: false,
      message: "Error banning user: " + error.message
    });
  }
};
// Unban user (restore access, but don't restore quest progress)
exports.unbanUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    user.isBanned = false;
    user.banReason = null;
    user.bannedAt = null;
    user.bannedBy = null;

    await user.save();

    console.log(`✅ User ${user.username} unbanned`);

    res.status(200).json({
      success: true,
      message: "User unbanned successfully",
      user
    });

  } catch (error) {
    console.error("Unban user error:", error);
    res.status(500).json({
      success: false,
      message: "Error unbanning user"
    });
  }
};

// Get list of banned users
exports.getBannedUsers = async (req, res) => {
  try {
    const bannedUsers = await User.find({ isBanned: true }).lean()
      .select('username email banReason bannedAt xp usdcBalance')
      .sort({ bannedAt: -1 });

    res.status(200).json({
      success: true,
      bannedUsers,
      total: bannedUsers.length
    });

  } catch (error) {
    console.error("Get banned users error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching banned users"
    });
  }
};
// ==================== ADD THESE TO YOUR adminController.js ====================

// Get Quest Winners for Reward Distribution
exports.getQuestWinners = async (req, res) => {
  try {
    const { questId, topCount } = req.query;

    if (!questId) {
      return res.status(400).json({
        success: false,
        message: "Quest ID is required"
      });
    }

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    const count = parseInt(topCount) || 10;

    // Get top performers
    const winners = await UserQuestProgress.find({
      questId: questId,
      status: 'completed'
    })
    .populate('userId', 'username email walletAddress usdcBalance')
    .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1 })
    .limit(count);

    const winnersData = winners.map((entry, index) => ({
      rank: index + 1,
      userId: entry.userId._id,
      username: entry.userId.username,
      email: entry.userId.email,
      walletAddress: entry.userId.walletAddress,
      currentBalance: entry.userId.usdcBalance,
      totalXp: entry.xpBreakdown.totalXp,
      completedAt: entry.completedAt,
      suggestedReward: calculateReward(index + 1, count, quest)
    }));

    res.status(200).json({
      success: true,
      quest: {
        id: quest._id,
        title: quest.title
      },
      winners: winnersData
    });

  } catch (error) {
    console.error("Get quest winners error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching quest winners"
    });
  }
};

// Helper function to calculate suggested rewards
function calculateReward(rank, totalWinners, quest) {
  const budget = Math.max(0, Number(quest?.usdcReward) || 0);
  const configured = quest?.competitionConfig?.rankPercentages;
  if (!budget || totalWinners < 1) return 0;
  if (Array.isArray(configured) && configured.length && configured[rank - 1] !== undefined) {
    return Math.round((budget * Number(configured[rank - 1]) / 100) * 100) / 100;
  }
  const first = Math.min(100, Math.max(0, Number(quest?.competitionConfig?.firstPlacePercent ?? 50)));
  const second = Math.min(100 - first, Math.max(0, Number(quest?.competitionConfig?.secondPlacePercent ?? 30)));
  let percent;
  if (totalWinners === 1) percent = 100;
  else if (rank === 1) percent = first;
  else if (rank === 2 && totalWinners === 2) percent = 100 - first;
  else if (rank === 2) percent = second;
  else percent = (100 - first - second) / (totalWinners - 2);
  return Math.round((budget * percent / 100) * 100) / 100;
}

exports.getAllEvents = async (req, res) => {
  try {
    console.log('📅 [ADMIN] Fetching all events...');

    const events = await Event.find({})
      .sort({ startDate: -1 })
      .lean(); // Use lean() for better performance

    console.log(`✅ [ADMIN] Found ${events.length} events`);

    res.status(200).json({
      success: true,
      events
    });

  } catch (error) {
    console.error("❌ [ADMIN] Get all events error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching events: " + error.message,
      error: error.message
    });
  }
};

// Get Single Event by ID with populated registrations
exports.getEventById = async (req, res) => {
  try {
    const { eventId } = req.params;
    console.log('📅 [ADMIN] Fetching event:', eventId);

    const event = await Event.findById(eventId)
      .populate('registrations.user', 'username email')
      .lean();

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    console.log(`✅ [ADMIN] Found event with ${event.registrations.length} registrations`);

    res.status(200).json({
      success: true,
      event
    });

  } catch (error) {
    console.error("❌ [ADMIN] Get event by ID error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching event: " + error.message,
      error: error.message
    });
  }
};

// Get Event Statistics  
exports.getEventStats = async (req, res) => {
  try {
    const now = new Date();
    
    const upcoming = await Event.countDocuments({
      startDate: { $gte: now }
    });

    const completed = await Event.countDocuments({ 
      endDate: { $lt: now }
    });
    
    const total = await Event.countDocuments();

    console.log(`📅 Event stats - Upcoming: ${upcoming}, Completed: ${completed}`);

    res.status(200).json({
      success: true,
      upcoming,
      completed,
      total
    });

  } catch (error) {
    console.error("❌ Get event stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching event statistics",
      error: error.message
    });
  }
};

// Create Event
exports.createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      eventType,
      category,
      venue,
      virtualLink,
      startDate,
      endDate,
      startTime,
      endTime,
      timezone,
      prizePool
    } = req.body;

    console.log('📅 Creating event:', { title, eventType, venue, virtualLink });

    if (!title || !description || !eventType || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing"
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }

    if (end < start) {
      return res.status(400).json({
        success: false,
        message: "End date must be after start date"
      });
    }

    if ((eventType === 'physical' || eventType === 'hybrid') && (!venue || venue.trim().length === 0)) {
      return res.status(400).json({
        success: false,
        message: "Venue is required for physical and hybrid events"
      });
    }

    if ((eventType === 'virtual' || eventType === 'hybrid') && (!virtualLink || virtualLink.trim().length === 0)) {
      return res.status(400).json({
        success: false,
        message: "Virtual link is required for virtual and hybrid events"
      });
    }

    const eventData = {
      title: title.trim(),
      description: description.trim(),
      eventType,
      category: category || 'other',
      startDate: start,
      endDate: end,
      startTime: startTime || '10:00',
      endTime: endTime || '17:00',
      timezone: timezone || 'WAT',
      status: 'upcoming',
      createdBy: req.session.userId
    };

    if (venue && venue.trim()) eventData.venue = venue.trim();
    if (virtualLink && virtualLink.trim()) eventData.virtualLink = virtualLink.trim();
    if (prizePool) eventData.prizePool = prizePool;

    const event = new Event(eventData);
    await event.save();

    console.log('✅ Event created:', event._id);

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event
    });

  } catch (error) {
    console.error("❌ Create event error:", error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating event",
      error: error.message
    });
  }
};

// Delete Event
exports.deleteEvent = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findByIdAndDelete(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    console.log('✅ Event deleted:', eventId);

    res.status(200).json({
      success: true,
      message: "Event deleted successfully"
    });

  } catch (error) {
    console.error("Delete event error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting event"
    });
  }
};

// Update Event
exports.updateEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    const updateData = req.body;

    const event = await Event.findByIdAndUpdate(
      eventId,
      { ...updateData, updatedAt: Date.now() },
      { new: true }
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Event updated successfully",
      event
    });

  } catch (error) {
    console.error("Update event error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating event"
    });
  }
};

// Get Event Registrations
exports.getEventRegistrations = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId)
      .populate('registrations.user', 'username email xp');

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    res.status(200).json({
      success: true,
      registrations: event.registrations,
      total: event.totalRegistrations,
      checkedIn: event.registrations.filter(r => r.checkedIn).length
    });

  } catch (error) {
    console.error("Get registrations error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching registrations"
    });
  }
};

// Get Application Details
exports.getApplicationDetails = async (req, res) => {
  try {
    const { applicationId } = req.params;

    const application = await CourseApplication.findById(applicationId)
      .populate('user', 'username email xp');
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    res.status(200).json({
      success: true,
      application
    });

  } catch (error) {
    console.error("Get application details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching application details",
      error: error.message
    });
  }
};
// ==================== REPLACE YOUR EXISTING createEvent METHOD WITH THIS ====================

exports.createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      eventType,
      category,
      venue,
      virtualLink,
      startDate,
      endDate,
      startTime,
      endTime,
      timezone,
      prizePool
    } = req.body;

    console.log('📅 Creating event with data:', {
      title,
      description,
      eventType,
      venue: venue || 'not provided',
      virtualLink: virtualLink || 'not provided'
    });

    // Validation
    if (!title || !description || !eventType || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing"
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }

    if (end < start) {
      return res.status(400).json({
        success: false,
        message: "End date must be after start date"
      });
    }

    // Type-specific validation
    if ((eventType === 'physical' || eventType === 'hybrid')) {
      if (!venue || venue.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Venue is required for physical and hybrid events"
        });
      }
    }

    if ((eventType === 'virtual' || eventType === 'hybrid')) {
      if (!virtualLink || virtualLink.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Virtual link is required for virtual and hybrid events"
        });
      }
    }

    // Build event data
    const eventData = {
      title: title.trim(),
      description: description.trim(),
      eventType,
      category: category || 'other',
      startDate: start,
      endDate: end,
      startTime: startTime || '10:00',
      endTime: endTime || '17:00',
      timezone: timezone || 'WAT',
      status: 'upcoming',
      createdBy: req.session.userId
    };

    if (venue && venue.trim()) {
      eventData.venue = venue.trim();
    }
    
    if (virtualLink && virtualLink.trim()) {
      eventData.virtualLink = virtualLink.trim();
    }

    if (prizePool) {
      eventData.prizePool = prizePool;
    }

    console.log('💾 Saving event...');

    const event = new Event(eventData);
    await event.save();

    console.log('✅ Event created:', event._id);

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event
    });

  } catch (error) {
    console.error("❌ Create event error:", error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating event",
      error: error.message
    });
  }
};



// ==================== GET APPLICATION DETAILS ====================
// Add this with your other application functions

exports.getApplicationDetails = async (req, res) => {
  try {
    const { applicationId } = req.params;

    const application = await CourseApplication.findById(applicationId)
      .populate('user', 'username email xp');
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    res.status(200).json({
      success: true,
      application
    });

  } catch (error) {
    console.error("Get application details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching application details",
      error: error.message
    });
  }
};
// Get Event Statistics
exports.getEventStats = async (req, res) => {
  try {
    const now = new Date();
    
    const upcoming = await Event.countDocuments({
      startDate: { $gte: now }
    });

    const completed = await Event.countDocuments({ 
      endDate: { $lt: now }
    });
    
    const total = await Event.countDocuments();

    console.log(`📅 Event stats - Upcoming: ${upcoming}, Completed: ${completed}`);

    res.status(200).json({
      success: true,
      upcoming,
      completed,
      total
    });

  } catch (error) {
    console.error("❌ Get event stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching event statistics",
      error: error.message
    });
  }
};
exports.createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      eventType,
      category,
      venue,
      virtualLink,
      startDate,
      endDate,
      startTime,
      endTime,
      timezone,
      prizePool,
      maxRegistrations,
      bannerImage,
      city,
      country,
      googleMapsUrl,
      approvalType,
      maxAttendees
    } = req.body;

    console.log('📅 Creating event with data:', req.body);

    // Validation
    if (!title || !description || !eventType || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing: title, description, eventType, startDate, endDate"
      });
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }

    if (end < start) {
      return res.status(400).json({
        success: false,
        message: "End date must be after start date"
      });
    }

    // Validate venue/virtualLink based on eventType
    if (eventType === 'physical' || eventType === 'hybrid') {
      if (!venue || venue.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Venue is required for physical and hybrid events"
        });
      }
    }

    if (eventType === 'virtual' || eventType === 'hybrid') {
      if (!virtualLink || virtualLink.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Virtual link is required for virtual and hybrid events"
        });
      }
    }

    // Create event object with proper null handling
    const eventData = {
      title,
      description,
      eventType,
      category: category || 'other',
      startDate: start,
      endDate: end,
      startTime: startTime || '10:00',
      endTime: endTime || '17:00',
      timezone: timezone || 'WAT',
      prizePool: prizePool || null,
      maxRegistrations: maxRegistrations || null,
      bannerImage: bannerImage || null,
      city: city || null,
      country: country || null,
      googleMapsUrl: googleMapsUrl || null,
      approvalType: approvalType || 'auto',
      maxAttendees: maxAttendees ? parseInt(maxAttendees) : null,
      status: 'upcoming',
      createdBy: req.session.userId
    };

    // Only add venue if it's physical or hybrid
    if (eventType === 'physical' || eventType === 'hybrid') {
      eventData.venue = venue;
    }

    // Only add virtualLink if it's virtual or hybrid
    if (eventType === 'virtual' || eventType === 'hybrid') {
      eventData.virtualLink = virtualLink;
    }

    const event = new Event(eventData);

    await event.save();

    console.log('✅ Event created successfully:', event._id);

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event
    });

  } catch (error) {
    console.error("❌ Create event error:", error);
    
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error: " + messages.join(', '),
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating event",
      error: error.message,
      details: error.stack
    });
  }
};

// Update Event
exports.updateEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    const updateData = req.body;

    const event = await Event.findByIdAndUpdate(
      eventId,
      { ...updateData, updatedAt: Date.now() },
      { new: true }
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Event updated successfully",
      event
    });

  } catch (error) {
    console.error("Update event error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating event"
    });
  }
};

// Delete Event
exports.deleteEvent = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findByIdAndDelete(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Event deleted successfully"
    });

  } catch (error) {
    console.error("Delete event error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting event"
    });
  }
};

// Get Event Registrations
exports.getEventRegistrations = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId)
      .populate('registrations.user', 'username email xp');

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found"
      });
    }

    res.status(200).json({
      success: true,
      registrations: event.registrations,
      total: event.totalRegistrations,
      checkedIn: event.registrations.filter(r => r.checkedIn).length
    });

  } catch (error) {
    console.error("Get registrations error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching registrations"
    });
  }
};

// ==================== APPLICATIONS MANAGEMENT ====================

// Get All Applications (Admin)
exports.getAllApplications = async (req, res) => {
  try {
    console.log('📝 Fetching applications...');
    
    const { status, course, search } = req.query;

    let query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (course) {
      query.course = course;
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const applications = await CourseApplication.find(query)
      .populate('user', 'username email')
      .sort({ appliedAt: -1 });

    console.log(`✅ Found ${applications.length} applications`);

    res.status(200).json({
      success: true,
      applications
    });

  } catch (error) {
    console.error("❌ Get applications error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching applications",
      error: error.message
    });
  }
};

// Get Application Statistics
exports.getApplicationStats = async (req, res) => {
  try {
    const pending = await CourseApplication.countDocuments({ status: 'pending' });
    const approved = await CourseApplication.countDocuments({ status: 'approved' });
    const rejected = await CourseApplication.countDocuments({ status: 'rejected' });
    const total = await CourseApplication.countDocuments();

    console.log(`📝 Application stats - Pending: ${pending}, Approved: ${approved}, Rejected: ${rejected}`);

    res.status(200).json({
      success: true,
      pending,
      approved,
      rejected,
      total
    });

  } catch (error) {
    console.error("❌ Get application stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching application statistics",
      error: error.message
    });
  }
};

exports.approveApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { courseStartDate, courseEndDate, courseLink, notes } = req.body;

    console.log('📝 Approving application:', applicationId);

    const application = await CourseApplication.findById(applicationId);

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    // Approve the application
    await application.approve(req.session.userId, notes, {
      startDate: courseStartDate,
      endDate: courseEndDate,
      link: courseLink
    });

    // Send approval email
    try {
      const emailResult = await emailService.sendCourseApprovalEmail(
        application.email,
        application.fullName,
        application.course,
        {
          startDate: courseStartDate,
          endDate: courseEndDate,
          link: courseLink
        }
      );

      if (emailResult.success) {
        console.log('✅ Approval email sent successfully');
      } else {
        console.error('⚠️ Failed to send approval email:', emailResult.error);
      }
    } catch (emailError) {
      console.error('⚠️ Email error (non-blocking):', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: "Application approved successfully",
      application
    });

  } catch (error) {
    console.error("❌ Approve application error:", error);
    res.status(500).json({
      success: false,
      message: "Error approving application",
      error: error.message
    });
  }
};

// ==================== FIX: Reject Application with Email ====================
exports.rejectApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { notes } = req.body;

    console.log('📝 Rejecting application:', applicationId);

    const application = await CourseApplication.findById(applicationId);

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    // Reject the application
    await application.reject(req.session.userId, notes);

    // Send rejection email
    try {
      const emailResult = await emailService.sendCourseRejectionEmail(
        application.email,
        application.fullName,
        application.course,
        notes
      );

      if (emailResult.success) {
        console.log('✅ Rejection email sent successfully');
      } else {
        console.error('⚠️ Failed to send rejection email:', emailResult.error);
      }
    } catch (emailError) {
      console.error('⚠️ Email error (non-blocking):', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: "Application rejected",
      application
    });

  } catch (error) {
    console.error("❌ Reject application error:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting application",
      error: error.message
    });
  }
};


// Reject Application (Admin)
exports.rejectApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { notes } = req.body;

    console.log('📝 Rejecting application:', applicationId);

    const application = await CourseApplication.findById(applicationId);

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    // Reject the application
    await application.reject(req.session.userId, notes);

    // Send rejection email
    try {
      const emailResult = await emailService.sendCourseRejectionEmail(
        application.email,
        application.fullName,
        application.course,
        notes
      );

      if (emailResult.success) {
        console.log('✅ Rejection email sent successfully');
      } else {
        console.error('⚠️ Failed to send rejection email:', emailResult.error);
      }
    } catch (emailError) {
      console.error('⚠️ Email error (non-blocking):', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: "Application rejected",
      application
    });

  } catch (error) {
    console.error("❌ Reject application error:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting application",
      error: error.message
    });
  }
};

// Export Applications CSV
exports.exportApplications = async (req, res) => {
  try {
    const applications = await CourseApplication.find()
      .sort({ appliedAt: -1 });

    // Create CSV
    let csv = 'Name,Email,Course,Twitter,Status,Applied Date\n';
    applications.forEach(app => {
      csv += `${app.fullName},${app.email},${app.course},${app.twitterHandle || 'N/A'},${app.status},${new Date(app.appliedAt).toLocaleDateString()}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=applications.csv');
    res.send(csv);

  } catch (error) {
    console.error("Export applications error:", error);
    res.status(500).json({
      success: false,
      message: "Error exporting applications"
    });
  }
};

// ==================== ADD TO adminController.js ====================

const CampusAmbassador = require('../models/CampusAmbassador');

// Get All Campus Ambassador Applications
exports.getAllAmbassadorApplications = async (req, res) => {
  try {
    console.log('🎓 Fetching campus ambassador applications...');
    
    const { status, state, search } = req.query;

    let query = {};

    // Status filter
    if (status && status !== 'all') {
      query.status = status;
    }

    // State filter
    if (state) {
      query.state = state;
    }

    // Search filter
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { institutionName: { $regex: search, $options: 'i' } }
      ];
    }

    const applications = await CampusAmbassador.find(query)
      .populate('userId', 'username email')
      .sort({ createdAt: -1 });

    console.log(`✅ Found ${applications.length} ambassador applications`);

    res.status(200).json({
      success: true,
      applications
    });

  } catch (error) {
    console.error("❌ Get ambassador applications error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching ambassador applications",
      error: error.message
    });
  }
};

// Get Ambassador Application Statistics
exports.getAmbassadorStats = async (req, res) => {
  try {
    const pending = await CampusAmbassador.countDocuments({ status: 'pending' });
    const approved = await CampusAmbassador.countDocuments({ status: 'approved' });
    const rejected = await CampusAmbassador.countDocuments({ status: 'rejected' });
    const total = await CampusAmbassador.countDocuments();

    // Get stats by state
    const byState = await CampusAmbassador.aggregate([
      { $group: { _id: '$state', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Get stats by institution type
    const byType = await CampusAmbassador.aggregate([
      { $group: { _id: '$institutionType', count: { $sum: 1 } } }
    ]);

    console.log(`🎓 Ambassador stats - Pending: ${pending}, Approved: ${approved}, Rejected: ${rejected}`);

    res.status(200).json({
      success: true,
      pending,
      approved,
      rejected,
      total,
      byState,
      byType
    });

  } catch (error) {
    console.error("❌ Get ambassador stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching ambassador statistics",
      error: error.message
    });
  }
};

// Get Ambassador Application Details
exports.getAmbassadorDetails = async (req, res) => {
  try {
    const { applicationId } = req.params;

    const application = await CampusAmbassador.findById(applicationId)
      .populate('userId', 'username email xp');
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    res.status(200).json({
      success: true,
      application
    });

  } catch (error) {
    console.error("Get ambassador details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching application details",
      error: error.message
    });
  }
};

// Approve Ambassador Application
exports.approveAmbassadorApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { adminNotes } = req.body;

    console.log('🎓 Approving ambassador application:', applicationId);

    const application = await CampusAmbassador.findById(applicationId);

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: "Application has already been processed"
      });
    }

    await application.approve(adminNotes);

    // Optional: Send approval email
    // await emailService.sendAmbassadorApprovalEmail(application.email, application.fullName);

    res.status(200).json({
      success: true,
      message: "Ambassador application approved successfully",
      application
    });

  } catch (error) {
    console.error("❌ Approve ambassador error:", error);
    res.status(500).json({
      success: false,
      message: "Error approving application",
      error: error.message
    });
  }
};

// Reject Ambassador Application
exports.rejectAmbassadorApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { adminNotes } = req.body;

    console.log('🎓 Rejecting ambassador application:', applicationId);

    const application = await CampusAmbassador.findById(applicationId);

    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Application not found"
      });
    }

    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: "Application has already been processed"
      });
    }

    if (!adminNotes) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required"
      });
    }

    await application.reject(adminNotes);

    // Optional: Send rejection email
    // await emailService.sendAmbassadorRejectionEmail(application.email, application.fullName, adminNotes);

    res.status(200).json({
      success: true,
      message: "Ambassador application rejected",
      application
    });

  } catch (error) {
    console.error("❌ Reject ambassador error:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting application",
      error: error.message
    });
  }
};

// Update Ambassador Metrics
exports.updateAmbassadorMetrics = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { eventsOrganized, studentsReferred, contentCreated } = req.body;

    const application = await CampusAmbassador.findByIdAndUpdate(
      applicationId,
      { eventsOrganized, studentsReferred, contentCreated },
      { new: true }
    );
    
    if (!application) {
      return res.status(404).json({
        success: false,
        message: "Ambassador not found"
      });
    }
    
    res.status(200).json({
      success: true,
      message: "Metrics updated successfully",
      application
    });

  } catch (error) {
    console.error("Update ambassador metrics error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating metrics",
      error: error.message
    });
  }
};

// Export Ambassador Applications CSV
exports.exportAmbassadorApplications = async (req, res) => {
  try {
    const applications = await CampusAmbassador.find()
      .sort({ createdAt: -1 });

    // Create CSV
    let csv = 'Name,Email,Phone,State,Institution Type,Institution Name,Course,Level,Twitter,Telegram,Status,Applied Date,Approved Date\n';
    applications.forEach(app => {
      csv += `"${app.fullName}","${app.email}","${app.phone}","${app.state}","${app.institutionType}","${app.institutionName}","${app.courseOfStudy}","${app.currentLevel}","${app.twitter}","${app.telegram || 'N/A'}","${app.status}","${new Date(app.createdAt).toLocaleDateString()}","${app.approvedAt ? new Date(app.approvedAt).toLocaleDateString() : 'N/A'}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=campus_ambassadors.csv');
    res.send(csv);

  } catch (error) {
    console.error("Export ambassador applications error:", error);
    res.status(500).json({
      success: false,
      message: "Error exporting applications"
    });
  }
};

// ==================== QUEST REWARD DISTRIBUTION ====================

// Get Quest Winners for Reward Distribution
exports.getQuestWinners = async (req, res) => {
  try {
      const { questId } = req.params;  // <-- Make sure this is extracting from params, not query
      const { topCount } = req.query;
       console.log('📊 getQuestWinners called');
    console.log('Request params:', req.params);
    console.log('Quest ID:', questId);

    if (!questId) {
      return res.status(400).json({
        success: false,
        message: "Quest ID is required"
      });
    }

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    const count = parseInt(topCount) || 10;

    // Get top performers
    const winners = await UserQuestProgress.find({
      questId: questId,
      status: 'completed'
    })
    .populate('userId', 'username email walletAddress usdcBalance')
    .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1 })
    .limit(count);

    const winnersData = winners.map((entry, index) => ({
      rank: index + 1,
      userId: entry.userId._id,
      username: entry.userId.username,
      email: entry.userId.email,
      walletAddress: entry.userId.walletAddress,
      currentBalance: entry.userId.usdcBalance,
      totalXp: entry.xpBreakdown.totalXp,
      completedAt: entry.completedAt,
      // Default reward amount (can be edited by admin)
      suggestedReward: calculateReward(index + 1, count, quest)
    }));

    res.status(200).json({
      success: true,
      quest: {
        id: quest._id,
        title: quest.title
      },
      winners: winnersData
    });

  } catch (error) {
    console.error("Get quest winners error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching quest winners"
    });
  }
};

// Helper function to calculate suggested rewards
function calculateReward(rank, totalWinners, quest) {
  const budget = Math.max(0, Number(quest?.usdcReward) || 0);
  const configured = quest?.competitionConfig?.rankPercentages;
  if (!budget || totalWinners < 1) return 0;
  if (Array.isArray(configured) && configured.length && configured[rank - 1] !== undefined) {
    return Math.round((budget * Number(configured[rank - 1]) / 100) * 100) / 100;
  }
  const first = Math.min(100, Math.max(0, Number(quest?.competitionConfig?.firstPlacePercent ?? 50)));
  const second = Math.min(100 - first, Math.max(0, Number(quest?.competitionConfig?.secondPlacePercent ?? 30)));
  let percent;
  if (totalWinners === 1) percent = 100;
  else if (rank === 1) percent = first;
  else if (rank === 2 && totalWinners === 2) percent = 100 - first;
  else if (rank === 2) percent = second;
  else percent = (100 - first - second) / (totalWinners - 2);
  return Math.round((budget * percent / 100) * 100) / 100;
}

function openRewardDistributionFromLeaderboard() {
    const modal = document.getElementById('leaderboardModal');
    const questId = modal.getAttribute('data-quest-id');
    closeLeaderboardModal();
    openRewardDistribution(questId);
}




// Distribute Rewards to Quest Winners
exports.distributeQuestRewards = async (req, res) => {
  try {
    const { questId, rewards } = req.body;

    if (!questId || !rewards || !Array.isArray(rewards)) {
      return res.status(400).json({
        success: false,
        message: "Invalid request data"
      });
    }

    const quest = await Quest.findById(questId);
    if (!quest) {
      return res.status(404).json({
        success: false,
        message: "Quest not found"
      });
    }

    const results = [];
    let totalDistributed = 0;

    // Process each reward
    for (const reward of rewards) {
      try {
        const { userId, amount, position } = reward;
        
        if (!userId || !amount || amount <= 0) {
          results.push({
            userId,
            success: false,
            message: "Invalid amount"
          });
          continue;
        }

        const user = await User.findById(userId);
        if (!user) {
          results.push({
            userId,
            success: false,
            message: "User not found"
          });
          continue;
        }

        // Add USDC to user balance
        user.usdcBalance += parseFloat(amount);

        // Create transaction record
        const transaction = new Transaction({
          user: user._id,
          type: 'quest_reward',
          amount: parseFloat(amount),
          status: 'completed',
          questId: quest._id,
          questTitle: quest.title,
          description: `Quest reward for completing: ${quest.title}`,
          processedBy: req.session.userId,
          processedAt: new Date(),
          createdAt: new Date()
        });

        await transaction.save();

        // Add activity to user
        user.recentActivity.unshift({
          action: `Received $${amount} USDC reward from quest: ${quest.title}`,
          timestamp: new Date()
        });

        if (user.recentActivity.length > 10) {
          user.recentActivity = user.recentActivity.slice(0, 10);
        }

        await user.save();

        // Feed event — show USDC award in community feed
        try {
          const FeedEvent = require('../models/FeedEvent');
          const io        = req.app.get('io');
          const ev = await new FeedEvent({
            type: 'usdc_earned',
            userId: user._id,
            username: user.username,
            data: { amount: parseFloat(amount), questTitle: quest.title }
          }).save();
          io?.emit('feed_event', { ...ev.toObject(), viewerLiked: false });
        } catch (feedErr) { console.error('Feed event error (distribute):', feedErr.message); }

        // 👇 SEND EMAIL NOTIFICATION
        let emailSent = false;
        try {
          // Get user's quest progress for stats
          const UserQuestProgress = require('../models/UserQuestProgress');
          const userProgress = await UserQuestProgress.findOne({
            questId: quest._id,
            userId: user._id
          });

          const stats = userProgress ? {
            taskXp: userProgress.xpBreakdown?.taskXp || 0,
            baseXp: userProgress.xpBreakdown?.baseXp || 0,
            totalXp: userProgress.xpBreakdown?.totalXp || 0,
            tasksCompleted: userProgress.tasksCompleted || 0,
            totalTasks: userProgress.totalTasks || 0
          } : {};

          // If position is provided, send winner email; otherwise send regular reward email
          let emailResult;
          if (position) {
            emailResult = await emailService.sendQuestWinnerEmail(
              user.email,
              user.username,
              amount,
              quest.title,
              position,
              stats
            );
          } else {
            emailResult = await emailService.sendQuestRewardEmail(
              user.email,
              user.username,
              amount,
              quest.title
            );
          }

          if (emailResult && emailResult.success) {
            console.log(`📧 ${position ? 'Winner' : 'Reward'} email sent to ${user.email}`);
            emailSent = true;
          } else {
            console.error(`⚠️ Email failed for ${user.email}:`, emailResult?.error || 'Unknown error');
          }
        } catch (emailError) {
          console.error(`⚠️ Failed to send email to ${user.email}:`, emailError.message);
        }

        totalDistributed += parseFloat(amount);

        results.push({
          userId,
          username: user.username,
          success: true,
          amount: parseFloat(amount),
          transactionId: transaction._id,
          emailSent
        });

        console.log(`✅ Distributed $${amount} to ${user.username}`);

      } catch (error) {
        console.error(`Error processing reward for user ${reward.userId}:`, error);
        results.push({
          userId: reward.userId,
          success: false,
          message: error.message
        });
      }
    }

    const emailsSent = results.filter(r => r.emailSent).length;
    const successCount = results.filter(r => r.success).length;
    const emailMsg = emailsSent === successCount
      ? 'All emails sent!'
      : `${emailsSent}/${successCount} emails sent.`;

    res.status(200).json({
      success: true,
      message: `Distributed $${totalDistributed.toFixed(2)} to ${successCount} users. ${emailMsg}`,
      totalDistributed,
      emailsSent,
      results
    });

  } catch (error) {
    console.error("Distribute quest rewards error:", error);
    res.status(500).json({
      success: false,
      message: "Error distributing rewards: " + error.message
    });
  }
};

// ==================== WITHDRAWAL MANAGEMENT ====================

// Get All Withdrawal Requests
exports.getAllWithdrawals = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    let query = { type: 'withdrawal' };
    if (status !== 'all') {
      query.status = status;
    }

    const withdrawals = await Transaction.find(query)
      .populate('user', 'username email walletAddress')
      .sort({ createdAt: -1 })
      .limit(100);

    res.status(200).json({
      success: true,
      withdrawals
    });

  } catch (error) {
    console.error("Get withdrawals error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching withdrawals"
    });
  }
};

// Get Withdrawal Statistics
exports.getWithdrawalStats = async (req, res) => {
  try {
    const pending = await Transaction.countDocuments({
      type: 'withdrawal',
      status: 'pending'
    });

    const completed = await Transaction.countDocuments({
      type: 'withdrawal',
      status: 'completed'
    });

    const rejected = await Transaction.countDocuments({
      type: 'withdrawal',
      status: 'rejected'
    });

    // Total amounts
    const stats = await Transaction.aggregate([
      { $match: { type: 'withdrawal' } },
      {
        $group: {
          _id: '$status',
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      pending,
      completed,
      rejected,
      stats
    });

  } catch (error) {
    console.error("Get withdrawal stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching withdrawal statistics"
    });
  }
};

// Approve Withdrawal
exports.approveWithdrawal = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { txHash, notes } = req.body;

    const transaction = await Transaction.findOne({
      _id: transactionId,
      type: 'withdrawal',
      status: 'pending'
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending withdrawal not found"
      });
    }

    const user = await User.findById(transaction.user);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Update transaction
    transaction.status = 'completed';
    transaction.processedBy = req.session.userId;
    transaction.processedAt = new Date();
    transaction.txHash = txHash || null;
    transaction.notes = notes || null;

    await transaction.save();

    // Add activity to user
    user.recentActivity.unshift({
      action: `Withdrawal of $${transaction.amount} approved and processed`,
      timestamp: new Date()
    });

    if (user.recentActivity.length > 10) {
      user.recentActivity = user.recentActivity.slice(0, 10);
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: "Withdrawal approved successfully"
    });

  } catch (error) {
    console.error("Approve withdrawal error:", error);
    res.status(500).json({
      success: false,
      message: "Error approving withdrawal"
    });
  }
};

// Reject Withdrawal
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { notes } = req.body;

    const transaction = await Transaction.findOne({
      _id: transactionId,
      type: 'withdrawal',
      status: 'pending'
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending withdrawal not found"
      });
    }

    const user = await User.findById(transaction.user);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Restore balance to user
    user.usdcBalance += transaction.amount;

    // Update transaction
    transaction.status = 'rejected';
    transaction.processedBy = req.session.userId;
    transaction.processedAt = new Date();
    transaction.notes = notes || 'Withdrawal rejected by admin';

    await transaction.save();

    // Add activity to user
    user.recentActivity.unshift({
      action: `Withdrawal of $${transaction.amount} was rejected. Balance restored.`,
      timestamp: new Date()
    });

    if (user.recentActivity.length > 10) {
      user.recentActivity = user.recentActivity.slice(0, 10);
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: "Withdrawal rejected and balance restored"
    });

  } catch (error) {
    console.error("Reject withdrawal error:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting withdrawal"
    });
  }
};
