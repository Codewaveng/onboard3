const mongoose = require("mongoose");

const taskProgressSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  isCompleted: {
    type: Boolean,
    default: false
  },
  submissionUrl: String,
  submissionText: String,
  submissionData: mongoose.Schema.Types.Mixed,
  completedAt: Date,
  
  // XP earned from this specific task
  xpEarned: {
    type: Number,
    default: 0
  },
  
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  verifiedAt: Date,
  notes: String,
  approvalStatus: {
    type: String,
    enum: ['auto', 'pending', 'approved', 'rejected'],
    default: 'auto'
  },
  submissionImage: {
    type: String,
    default: null
  }
});

const userQuestProgressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  questId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quest',
    required: true
  },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'completed', 'abandoned'],
    default: 'not_started'
  },
  progress: {
    type: Number,
    default: 0
  },
  tasksCompleted: {
    type: Number,
    default: 0
  },
  totalTasks: {
    type: Number,
    required: true
  },
  taskProgress: [taskProgressSchema],
  
  // ==================== TIMING ====================
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  // Timestamp of the most recent task completion that awarded XP (used for tiebreaker)
  lastXpAt: {
    type: Date,
    default: null
  },
  timeSpentMinutes: {
    type: Number,
    default: 0
  },
  
  // ==================== XP BREAKDOWN ====================
  xpBreakdown: {
    // XP from completing tasks
    taskXp: {
      type: Number,
      default: 0
    },
    // Base XP from completing quest
    baseXp: {
      type: Number,
      default: 0
    },
    // Bonus XP from referrals who joined
    referralJoinBonus: {
      type: Number,
      default: 0
    },
    // Bonus XP from referrals who completed
    referralCompleteBonus: {
      type: Number,
      default: 0
    },
    // Bonus XP for winning/ranking
    winnerBonus: {
      type: Number,
      default: 0
    },
    // Manual XP adjustment made from the admin leaderboard manager
    adminAdjustmentXp: {
      type: Number,
      default: 0
    },
    // Total XP earned from this quest
    totalXp: {
      type: Number,
      default: 0
    }
  },
  
  // ==================== REFERRAL TRACKING ====================
  referralStats: {
    // Referrals who joined this quest
    referralsJoined: [{
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      joinedAt: Date,
      xpEarned: Number
    }],
    // Referrals who completed this quest
    referralsCompleted: [{
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      completedAt: Date,
      xpEarned: Number
    }],
    totalReferralXp: {
      type: Number,
      default: 0
    }
  },
  
  // ==================== COMPETITION/RANKING ====================
  leaderboardRank: {
    type: Number,
    default: null
  },
  isWinner: {
    type: Boolean,
    default: false
  },
  winnerRank: {
    type: Number,
    default: null
  },
  
  // ==================== REWARDS ====================
  usdcEarned: {
    type: Number,
    default: 0
  },
  badgeEarned: {
    type: String,
    default: null
  },
  rewardsClaimed: {
    type: Boolean,
    default: false
  },
  
  // Notes and feedback
  userNotes: String,
  feedbackRating: {
    type: Number,
    min: 1,
    max: 5,
    default: null
  },
  feedbackText: String,
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for unique user-quest combination
userQuestProgressSchema.index({ userId: 1, questId: 1 }, { unique: true });

// Leaderboard query: questId + status filter + xp sort (covers the full query)
userQuestProgressSchema.index({ questId: 1, status: 1, 'xpBreakdown.totalXp': -1 });
userQuestProgressSchema.index({ questId: 1, completedAt: 1 });


// Update timestamp on save
userQuestProgressSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  // Calculate total XP
  this.xpBreakdown.totalXp = 
    (this.xpBreakdown.taskXp || 0) +
    (this.xpBreakdown.baseXp || 0) +
    (this.xpBreakdown.referralJoinBonus || 0) +
    (this.xpBreakdown.referralCompleteBonus || 0) +
    (this.xpBreakdown.winnerBonus || 0) +
    (this.xpBreakdown.adminAdjustmentXp || 0);
  
  next();
});

// Calculate referral XP total
userQuestProgressSchema.methods.calculateReferralXp = function() {
  const joinXp = this.referralStats.referralsJoined.reduce((sum, ref) => sum + (ref.xpEarned || 0), 0);
  const completeXp = this.referralStats.referralsCompleted.reduce((sum, ref) => sum + (ref.xpEarned || 0), 0);

  this.referralStats.totalReferralXp = joinXp + completeXp;
  this.xpBreakdown.referralJoinBonus = joinXp;
  this.xpBreakdown.referralCompleteBonus = completeXp;

  // SAFETY: Force recalculate total XP immediately to prevent sync issues
  this.xpBreakdown.totalXp =
    (this.xpBreakdown.taskXp || 0) +
    (this.xpBreakdown.baseXp || 0) +
    joinXp +
    completeXp +
    (this.xpBreakdown.winnerBonus || 0) +
    (this.xpBreakdown.adminAdjustmentXp || 0);
};

// Full XP recalculation - use this to fix any sync issues
userQuestProgressSchema.methods.recalculateAllXp = function() {
  // Recalculate task XP from taskProgress array
  if (this.taskProgress && this.taskProgress.length > 0) {
    let calculatedTaskXp = this.taskProgress
      .filter(t => t.isCompleted)
      .reduce((sum, t) => sum + (t.xpEarned || 0), 0);
    
    this.xpBreakdown.taskXp = calculatedTaskXp;
  }

  // Recalculate referral XP
  this.calculateReferralXp();

  // Force mark as modified
  this.markModified('xpBreakdown');
  this.markModified('referralStats');
};

module.exports = mongoose.model("UserQuestProgress", userQuestProgressSchema);
