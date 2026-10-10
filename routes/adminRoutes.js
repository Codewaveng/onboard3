// routes/adminRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require('mongoose');
const adminController = require("../controllers/adminController");
const pages = require("../controllers/adminPagesController");
const QuestApplication = require('../models/QuestApplication');

// ==================== MIDDLEWARE ====================

// Role-based permission map
const ROLE_PERMISSIONS = {
  super_admin:  '*',
  operations:   ['overview','analytics','users','quests','bounties','events','applications','quest-applications','pathway-applications','support','ambassadors','projects','banned','partners','pathway-content'],
  community:    ['overview','analytics','users','applications','quest-applications','pathway-applications','support','ambassadors','banned','leaderboard'],
  partnerships: ['overview','analytics','quests','bounties','projects','partners','business-developers','businesses','fund-requests','commission-settings'],
  finance:      ['overview','analytics','withdrawals','fund-requests','wallet-addresses'],
};

function getAdminRole(user) {
  if (!user || !user.isAdmin || !user.adminRole) return null;
  return user.adminRole;
}

function canAccess(role, section) {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (perms === '*') return true;
  return Array.isArray(perms) && perms.includes(section);
}

// Admin authentication middleware (JSON APIs)
const isAdmin = async (req, res, next) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Not authenticated' });
    const User = require('../models/User');
    const user = await User.findById(req.session.userId);
    if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Access denied' });
    req.user = user;
    req.adminRole = getAdminRole(user);
    next();
  } catch (err) {
    console.error('Admin middleware error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════
// MULTI-PAGE ADMIN ROUTES (server-side rendered)
// ══════════════════════════════════════════════════════

// Auto-map URL path → permission section
const PATH_SECTION_MAP = {
  'analytics': 'analytics', 'users': 'users', 'quests': 'quests', 'bounties': 'bounties',
  'events': 'events', 'withdrawals': 'withdrawals', 'applications': 'applications',
  'ambassadors': 'ambassadors', 'projects': 'projects', 'banned': 'banned',
  'settings': 'settings', 'pathway-applications': 'pathway-applications',
  'quest-applications': 'quest-applications', 'support': 'support', 'leaderboard': 'leaderboard',
  'business-developers': 'business-developers', 'businesses': 'businesses',
  'fund-requests': 'fund-requests', 'wallet-addresses': 'wallet-addresses',
  'commission-settings': 'commission-settings',
  'platform-settings': 'platform-settings', 'partners': 'partners',
};

// Page middleware — redirects to /auth for HTML pages, enforces role permissions
const isAdminPage = async (req, res, next) => {
  try {
    if (!req.session.userId) return res.redirect('/auth');
    const User = require('../models/User');
    const user = await User.findById(req.session.userId);
    if (!user || !user.isAdmin) return res.redirect('/dashboard');
    req.user = user;
    req.adminRole = getAdminRole(user);
    // Auto-check permission based on URL path segment
    const segment = req.path.replace(/^\//, '').split('/')[0];
    const section = PATH_SECTION_MAP[segment];
    if (section && !canAccess(req.adminRole, section)) {
      const isJson = req.headers.accept && req.headers.accept.includes('application/json');
      return isJson
        ? res.status(403).json({ success: false, message: 'Access denied' })
        : res.redirect('/admin?error=access_denied');
    }
    next();
  } catch { res.redirect('/auth'); }
};

// Role-specific page guard — call after isAdminPage or isAdmin
const requireSection = (section) => (req, res, next) => {
  if (!canAccess(req.adminRole, section)) {
    const isJson = req.headers.accept && req.headers.accept.includes('application/json');
    return isJson
      ? res.status(403).json({ success: false, message: 'Access denied' })
      : res.redirect('/admin?error=access_denied');
  }
  next();
};

router.get('/analytics',            isAdminPage, requireSection('analytics'),            pages.analyticsPage);
router.get('/',                     isAdminPage,                                            pages.overview);
router.get('/users',                isAdminPage, requireSection('users'),                   pages.usersPage);
router.get('/quests',               isAdminPage, requireSection('quests'),                  pages.questsPage);
router.get('/events',               isAdminPage, requireSection('events'),                  pages.eventsPage);
router.get('/withdrawals',          isAdminPage, requireSection('withdrawals'),              pages.withdrawalsPage);
router.get('/applications',         isAdminPage, requireSection('applications'),             pages.applicationsPage);
router.get('/ambassadors',          isAdminPage, requireSection('ambassadors'),              pages.ambassadorsPage);
router.get('/projects',             isAdminPage, requireSection('projects'),                 pages.projectsPage);
router.get('/banned',               isAdminPage, requireSection('banned'),                   pages.bannedPage);
router.get('/settings',             isAdminPage, requireSection('settings'),                 pages.settingsPage);
router.get('/pathway-applications', isAdminPage, requireSection('pathway-applications'),     pages.pathwayApplicationsPage);

// ── Team Management (super_admin only) ────────────────────────────────────────
router.get('/team', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.redirect('/admin?error=access_denied');
  try {
    const User = require('../models/User');
    const team = await User.find({ isAdmin: true }).select('username email adminRole createdAt').sort({ createdAt: -1 }).lean();
    res.render('admin/pages/team', { user: req.user, team, page: 'team' });
  } catch (err) { console.error(err); res.redirect('/admin'); }
});

router.post('/team/assign', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false, message: 'Access denied' });
  try {
    const User = require('../models/User');
    const { userId, adminRole } = req.body;
    const validRoles = ['super_admin', 'operations', 'community', 'partnerships', 'finance'];
    if (!validRoles.includes(adminRole)) return res.json({ success: false, message: 'Invalid role' });
    const target = await User.findById(userId);
    if (!target) return res.json({ success: false, message: 'User not found' });
    target.isAdmin  = true;
    target.adminRole = adminRole;
    await target.save();
    res.json({ success: true, message: `${target.username} assigned as ${adminRole.replace('_',' ')}` });
  } catch (err) { res.json({ success: false, message: 'Server error' }); }
});

router.post('/team/remove', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false, message: 'Access denied' });
  try {
    const User = require('../models/User');
    const { userId } = req.body;
    if (userId === req.user._id.toString()) return res.json({ success: false, message: 'Cannot remove yourself' });
    await User.findByIdAndUpdate(userId, { isAdmin: false, adminRole: null });
    res.json({ success: true, message: 'Admin access removed' });
  } catch (err) { res.json({ success: false, message: 'Server error' }); }
});

router.get('/team/search', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ users: [] });
  try {
    const User = require('../models/User');
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const users = await User.find({
      $or: [{ username: { $regex: q, $options: 'i' } }, { email: { $regex: q, $options: 'i' } }]
    }).select('username email adminRole isAdmin').limit(8).lean();
    res.json({ users });
  } catch (err) { res.json({ users: [] }); }
});

// Page actions
router.post('/quests/create',                         isAdminPage, pages.createQuestPage);
router.post('/quests/:id/toggle',                     isAdminPage, pages.toggleQuestPage);
router.post('/quests/:id/delete',                     isAdminPage, pages.deleteQuestPage);
router.post('/quests/:id/add-task',                   isAdminPage, pages.addQuestTask);
router.post('/quests/:id/tasks/:taskId/update',     isAdminPage, pages.updateQuestTask);
router.post('/quests/:id/tasks/:taskId/delete',     isAdminPage, pages.deleteQuestTask);
router.get( '/quests/:id/entries',                          isAdminPage, pages.getQuestEntries);
router.post('/quests/:id/entries/:progressId/remove',       isAdminPage, pages.removeQuestEntry);
router.post('/quests/:id/users/:userId/bonus-xp',           isAdminPage, pages.awardBonusXp);
router.post('/quests/:id/submissions/:progressId/review', isAdminPage, pages.reviewTaskSubmission);
router.post('/quests/:id/update-settings',            isAdminPage, pages.updateQuestSettings);

// ── Business quest approval ───────────────────────────────────────────────────
router.post('/business-quests/:id/approve', isAdminPage, async (req, res) => {
  try {
    const quest = await Quest.findById(req.params.id);
    if (!quest) return res.redirect('/admin/quests?error=not_found');
    quest.approvalStatus = 'approved';
    quest.approvalNote   = '';
    quest.isActive       = true;
    await quest.save();
    res.redirect('/admin/quests?approved=1');
  } catch (err) { console.error(err); res.redirect('/admin/quests?error=1'); }
});

router.post('/business-quests/:id/reject', isAdminPage, async (req, res) => {
  try {
    const quest = await Quest.findById(req.params.id);
    if (!quest) return res.redirect('/admin/quests?error=not_found');
    const reason = (req.body.reason || '').trim() || 'Does not meet platform guidelines.';
    quest.approvalStatus = 'rejected';
    quest.approvalNote   = reason;
    quest.isActive       = false;
    await quest.save();
    // Refund business
    if (quest.sponsoredBy && quest.usdcReward > 0) {
      await Business.findByIdAndUpdate(quest.sponsoredBy, {
        $inc: { balance: quest.usdcReward, totalSpent: -quest.usdcReward }
      });
    }
    res.redirect('/admin/quests?rejected=1');
  } catch (err) { console.error(err); res.redirect('/admin/quests?error=1'); }
});
router.post('/events/create',              isAdminPage, requireSection('events'),            pages.createEventPage);
router.get( '/events/:id',                 isAdminPage, requireSection('events'),            pages.getEventDetailPage);
router.post('/events/:id/approve/:userId', isAdminPage, requireSection('events'),            pages.approveEventRegistration);
router.post('/events/:id/reject/:userId',  isAdminPage, requireSection('events'),            pages.rejectEventRegistration);
router.post('/events/:id/banner',          isAdminPage, requireSection('events'),            pages.updateEventBanner);
router.post('/events/:id/delete',          isAdminPage, requireSection('events'),            pages.deleteEventPage);
router.post('/withdrawals/:id/approve',    isAdminPage, requireSection('withdrawals'),        pages.approveWithdrawal);
router.post('/withdrawals/:id/reject',     isAdminPage, requireSection('withdrawals'),        pages.rejectWithdrawal);
router.post('/users/:id/ban',              isAdminPage, requireSection('users'),              pages.banUser);
router.post('/users/:id/unban',            isAdminPage, requireSection('users'),              pages.unbanUser);
router.post('/applications/:id/approve',   isAdminPage, requireSection('applications'),       pages.approveApplication);
router.post('/applications/:id/reject',    isAdminPage, requireSection('applications'),       pages.rejectApplication);
router.post('/ambassadors/:id/approve',    isAdminPage, requireSection('ambassadors'),        pages.approveAmbassador);
router.post('/ambassadors/:id/reject',     isAdminPage, requireSection('ambassadors'),        pages.rejectAmbassador);
router.post('/projects/:id/approve',       isAdminPage, requireSection('projects'),           pages.approveProject);
router.post('/projects/:id/reject',        isAdminPage, requireSection('projects'),           pages.rejectProject);
router.post('/settings/pathways',                    isAdminPage, requireSection('settings'),             pages.savePathways);
router.post('/settings/pathway-approval-mode',       isAdminPage, requireSection('settings'),             pages.savePathwayApprovalMode);
router.post('/api/reset-pathways',                   isAdminPage, requireSection('settings'),             async (req, res) => {
  try {
    const result = await User.updateMany({}, {
      $set: {
        pathway: null, pathwayStatus: null,
        pathwayApplication: { reason: '', experience: '', appliedAt: null, reviewedAt: null, reviewNote: '' }
      }
    });
    res.json({ success: true, count: result.modifiedCount });
  } catch (err) {
    console.error('[reset-pathways]', err);
    res.json({ success: false, message: 'DB error' });
  }
});
router.post('/api/reject-all-pathway-applications',  isAdminPage, requireSection('pathway-applications'), async (req, res) => {
  try {
    const result = await User.updateMany(
      { pathwayStatus: 'pending' },
      { $set: { pathwayStatus: 'rejected', 'pathwayApplication.reviewedAt': new Date(), 'pathwayApplication.reviewNote': 'Pathway re-selection required.' } }
    );
    res.json({ success: true, count: result.modifiedCount });
  } catch (err) {
    console.error('[reject-all-pathway-applications]', err);
    res.json({ success: false, message: 'DB error' });
  }
});
router.post('/pathway-applications/:id/approve',     isAdminPage, requireSection('pathway-applications'), pages.approvePathwayApplication);
router.post('/pathway-applications/:id/reject',      isAdminPage, requireSection('pathway-applications'), pages.rejectPathwayApplication);

// ── Business Quest Approve/Reject ─────────────────────

router.post('/business-quests/:id/approve', isAdminPage, async (req, res) => {
  try {
    const _Quest = require('../models/Quest');
    const quest = await _Quest.findById(req.params.id);
    if (!quest) return res.redirect('/admin/quests?error=not_found');
    quest.approvalStatus = 'approved';
    quest.isActive = true;
    await quest.save();
    res.redirect('/admin/quests?success=quest_approved');
  } catch (err) {
    console.error('[Admin] Approve business quest error:', err);
    res.redirect('/admin/quests?error=server');
  }
});

router.post('/business-quests/:id/reject', isAdminPage, async (req, res) => {
  try {
    const _Quest    = require('../models/Quest');
    const _Business = require('../models/Business');
    const quest = await _Quest.findById(req.params.id);
    if (!quest) return res.redirect('/admin/quests?error=not_found');
    quest.approvalStatus = 'rejected';
    quest.approvalNote = req.body.reason || '';
    quest.isActive = false;
    await quest.save();
    // Refund business
    if (quest.sponsoredBy) {
      const business = await _Business.findById(quest.sponsoredBy);
      if (business) {
        business.balance += quest.usdcReward || 0;
        business.totalSpent -= quest.usdcReward || 0;
        if (business.totalSpent < 0) business.totalSpent = 0;
        await business.save();
      }
    }
    res.redirect('/admin/quests?success=quest_rejected');
  } catch (err) {
    console.error('[Admin] Reject business quest error:', err);
    res.redirect('/admin/quests?error=server');
  }
});


// ── Bounties ──────────────────────────────────────────
const bc = require('../controllers/bountyController');
router.get('/bounties',                   isAdminPage, bc.adminListBounties);
router.post('/bounties/create',           isAdminPage, bc.adminCreateBounty);
router.get('/bounties/:id',               isAdminPage, bc.adminBountyDetail);
router.post('/bounties/:id/toggle',       isAdminPage, bc.adminToggleBounty);
router.post('/bounties/:id/winners',      isAdminPage, bc.adminAnnounceWinners);
router.post('/bounties/:id/delete',       isAdminPage, bc.adminDeleteBounty);

const PlatformSettings = require('../models/PlatformSettings');

// POST /admin/stacks-wallets/test-zad-auth — test ZAD authentication flow for index 0
router.post('/stacks-wallets/test-zad-auth', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false, message: 'Unauthorized' });
  try {
    const sw = require('../utils/stacksWallet');
    const { bountyId } = req.body;
    const result = await sw.submitToZADWebAPI(
      null, // privKey — will be derived from index 0 internally
      bountyId || '1a9af04e-14d8-4f3e-bea6-e62a92935b0b',
      'Test submission from ONBOARD3 integration test',
      null,
      'test-tx-' + Date.now()
    );
    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, message: err.message, stack: err.stack?.slice(0, 500) });
  }
});

// DELETE /admin/submissions/external/:bountyId/:userId — remove a third-party submission
router.post('/submissions/external/delete', isAdminPage, async (req, res) => {
  try {
    const ThirdPartySubmission = require('../models/ThirdPartySubmission');
    const { bountyId, userId, deleteAll } = req.body;
    const query = {};
    if (!deleteAll) {
      if (bountyId) query.externalBountyId = bountyId;
      if (userId)   query.userId = userId;
      if (!bountyId && !userId) return res.json({ success: false, message: 'Provide bountyId, userId, or deleteAll:true' });
    }
    const result = await ThirdPartySubmission.deleteMany(query);
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


// ── Platform Settings ─────────────────────────────────
// Render platform settings page
router.get('/platform-settings', isAdminPage, requireSection('platform-settings'), async (req, res) => {
  try {
    const settings = await PlatformSettings.get();
    res.render('admin/pages/platform-settings', { user: req.user, settings: settings.toObject() });
  } catch (err) {
    console.error('[admin platform-settings]', err);
    res.status(500).send('Error loading platform settings');
  }
});

// Save platform settings
router.post('/platform-settings', isAdminPage, requireSection('platform-settings'), async (req, res) => {
  try {
    const { apeitWalletUrl, withdrawalMin, feeTierSmall, feeTierSmallUpTo, feeTierMedium, feeTierMediumUpTo, feeTierLarge } = req.body;
    const settings = await PlatformSettings.get();
    if (apeitWalletUrl)    settings.apeitWalletUrl    = apeitWalletUrl;
    if (withdrawalMin)     settings.withdrawalMin     = parseFloat(withdrawalMin);
    if (feeTierSmall)      settings.feeTierSmall      = parseFloat(feeTierSmall);
    if (feeTierSmallUpTo)  settings.feeTierSmallUpTo  = parseFloat(feeTierSmallUpTo);
    if (feeTierMedium)     settings.feeTierMedium     = parseFloat(feeTierMedium);
    if (feeTierMediumUpTo) settings.feeTierMediumUpTo = parseFloat(feeTierMediumUpTo);
    if (feeTierLarge)      settings.feeTierLarge      = parseFloat(feeTierLarge);
    await settings.save();
    res.redirect('/admin/platform-settings?saved=1');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/platform-settings?error=1');
  }
});

// ── Partner API Key Management (JSON) ─────────────────
const PartnerApiKey              = require('../models/PartnerApiKey');
const SponsoredBountySubmission  = require('../models/SponsoredBountySubmission');

// List all partner keys
router.get('/api/partner-keys', isAdmin, async (req, res) => {
  try {
    const keys = await PartnerApiKey.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: keys });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate a new partner API key
// Body: { name, allowedBounties?, notes? }
router.post('/api/partner-keys', isAdmin, async (req, res) => {
  try {
    const { name, allowedBounties = [], notes = '' } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const { rawKey, doc } = PartnerApiKey.generate(name, req.user._id, allowedBounties);
    doc.notes = notes;
    const record = await PartnerApiKey.create(doc);

    res.json({
      success: true,
      data: {
        id:        record._id,
        name:      record.name,
        keyPrefix: record.keyPrefix,
        rawKey,    // shown ONCE — store it securely
        createdAt: record.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Revoke a partner API key
router.post('/api/partner-keys/:keyId/revoke', isAdmin, async (req, res) => {
  try {
    const key = await PartnerApiKey.findByIdAndUpdate(
      req.params.keyId,
      { isActive: false },
      { new: true }
    );
    if (!key) return res.status(404).json({ success: false, error: 'Key not found' });
    res.json({ success: true, data: { id: key._id, isActive: key.isActive } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List sponsored submissions for a bounty
router.get('/api/bounties/:id/sponsored-submissions', isAdmin, async (req, res) => {
  try {
    const submissions = await SponsoredBountySubmission.find({ bountyId: req.params.id })
      .populate('partnerKeyId', 'name keyPrefix')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: submissions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// LEGACY DASHBOARD PAGE (kept for backward compat)
// ══════════════════════════════════════════════════════
router.get('/legacy',        isAdmin, adminController.getAdminDashboard);

// ==================== STATISTICS ====================

// Get overall statistics
router.get("/api/statistics", isAdmin, adminController.getStatistics);

// ==================== USERS ====================

// IMPORTANT: Put /count and /export BEFORE /:userId to avoid route conflicts
router.get("/api/users/count", isAdmin, adminController.getUserCount);
router.get("/api/users/export", isAdmin, adminController.exportUsers);
router.get("/api/users", isAdmin, adminController.getAllUsers);
router.get("/api/users/:userId", isAdmin, adminController.getUserDetails);
router.put("/api/users/:userId", isAdmin, adminController.updateUser);
router.delete("/api/users/:userId", isAdmin, adminController.deleteUser);
router.post("/api/users/:userId/login-as", isAdmin, adminController.loginAsUser);

// ==================== QUESTS ====================

// IMPORTANT: Put /stats BEFORE /:questId
router.get("/api/quests/stats", isAdmin, adminController.getQuestStats);
router.get("/api/quests", isAdmin, adminController.getAllQuests);
router.post("/api/quests", isAdmin, adminController.createQuest);

// Quest-specific routes
router.get("/api/quests/:questId", isAdmin, adminController.getQuestById);
router.post("/api/quests/:questId/daily-task", isAdmin, adminController.addDailyTask);
router.delete("/api/quests/:questId/daily-task/:taskId", isAdmin, adminController.removeDailyTask);
router.get("/api/quests/:questId/leaderboard", isAdmin, adminController.getQuestLeaderboardAdmin);
router.patch("/api/quests/:questId/settings", isAdmin, adminController.updateQuestSettings);
router.get("/api/quests/:questId/export", isAdmin, adminController.exportQuestLeaderboard);
router.get("/api/quests/:questId/export-tasks", isAdmin, adminController.exportTaskCompletions);
// Referral Audit Routes
router.get("/api/quests/:questId/referral-audit", isAdmin, adminController.getQuestReferralAudit);
router.get("/api/quests/:questId/users/:userId/referrals", isAdmin, adminController.getUserReferralDetails);
router.patch("/api/quests/:questId/toggle", isAdmin, adminController.toggleQuestStatus);
router.delete("/api/quests/:questId", isAdmin, adminController.deleteQuest);

// Individual task CRUD (admin)
router.patch("/api/quests/:questId/tasks/:taskId", isAdmin, async (req, res) => {
  try {
    const Quest = require('../models/Quest');
    const quest = await Quest.findById(req.params.questId);
    if (!quest) return res.json({ success: false, message: 'Quest not found' });
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
    res.json({ success: false, message: 'Server error' });
  }
});
router.delete("/api/quests/:questId/tasks/:taskId", isAdmin, async (req, res) => {
  try {
    const Quest = require('../models/Quest');
    const quest = await Quest.findById(req.params.questId);
    if (!quest) return res.json({ success: false, message: 'Quest not found' });
    if (!quest.tasks.id(req.params.taskId)) return res.json({ success: false, message: 'Task not found' });
    quest.tasks.pull(req.params.taskId);
    await quest.save();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Server error' });
  }
});

// ==================== EVENTS ====================

// IMPORTANT: Put /stats BEFORE /:eventId
router.get("/api/events/stats", isAdmin, adminController.getEventStats);
router.get("/api/events", isAdmin, adminController.getAllEvents);
router.post("/api/events", isAdmin, adminController.createEvent);
router.get("/api/events/:eventId", isAdmin, adminController.getEventById);
router.put("/api/events/:eventId", isAdmin, adminController.updateEvent);
router.delete("/api/events/:eventId", isAdmin, adminController.deleteEvent);
router.get("/api/events/:eventId/registrations", isAdmin, adminController.getEventRegistrations);

// ==================== APPLICATIONS ====================

// IMPORTANT: Put /stats and /export BEFORE /:applicationId
router.get("/api/applications/stats", isAdmin, adminController.getApplicationStats);
router.get("/api/applications/export", isAdmin, adminController.exportApplications);
router.get("/api/applications", isAdmin, adminController.getAllApplications);
router.get("/api/applications/:applicationId", isAdmin, adminController.getApplicationDetails);
router.post("/api/applications/:applicationId/approve", isAdmin, adminController.approveApplication);
router.post("/api/applications/:applicationId/reject", isAdmin, adminController.rejectApplication);

// ══════════════════════════════════════════════════════
// BUSINESS DEVELOPER & BUSINESS MANAGEMENT
// ══════════════════════════════════════════════════════

const BusinessDeveloper  = require('../models/BusinessDeveloper');
const Business           = require('../models/Business');
const BusinessFundRequest= require('../models/BusinessFundRequest');
const BusinessTransaction= require('../models/BusinessTransaction');
const BDEarning          = require('../models/BDEarning');
const CommissionSettings = require('../models/CommissionSettings');
const WalletAddress      = require('../models/WalletAddress');

// ── BD pages ──────────────────────────────────────────

router.get('/business-developers', isAdminPage, async (req, res) => {
  try {
    const statusFilter = req.query.status && req.query.status !== 'all' ? req.query.status : null;
    const query = statusFilter ? { status: statusFilter } : {};
    const bds = await BusinessDeveloper.find(query).sort({ createdAt: -1 });

    const counts = {};
    const all = await BusinessDeveloper.find();
    counts.all = all.length;
    ['pending','approved','rejected','suspended'].forEach(s => {
      counts[s] = all.filter(b => b.status === s).length;
    });

    res.render('admin/pages/business-developers', {
      user: req.user, bds, counts, activeStatus: req.query.status || 'all'
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

router.post('/business-developers/:id/approve', isAdminPage, async (req, res) => {
  try {
    await BusinessDeveloper.findByIdAndUpdate(req.params.id, {
      status: 'approved', approvedAt: new Date(), approvedBy: req.user._id
    });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/business-developers/:id/reject', isAdminPage, async (req, res) => {
  try {
    await BusinessDeveloper.findByIdAndUpdate(req.params.id, {
      status: 'rejected', rejectionReason: req.body.reason || ''
    });
    res.redirect('/admin/business-developers');
  } catch (err) { res.redirect('/admin/business-developers'); }
});

router.post('/business-developers/:id/suspend', isAdminPage, async (req, res) => {
  try {
    await BusinessDeveloper.findByIdAndUpdate(req.params.id, { status: 'suspended' });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/business-developers/:id/commission', isAdminPage, async (req, res) => {
  try {
    const rate = req.body.commissionRate !== '' && req.body.commissionRate !== undefined
      ? parseFloat(req.body.commissionRate)
      : null;
    await BusinessDeveloper.findByIdAndUpdate(req.params.id, { commissionRate: rate });
    res.redirect('/admin/business-developers');
  } catch (err) { res.redirect('/admin/business-developers'); }
});

router.post('/business-developers/:id/delete', isAdminPage, async (req, res) => {
  try {
    await BusinessDeveloper.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/business-developers/:id/login-as', isAdminPage, async (req, res) => {
  try {
    const bd = await BusinessDeveloper.findById(req.params.id);
    if (!bd) return res.json({ success: false, message: 'BD not found' });
    req.session.bdId   = bd._id.toString();
    req.session.bdName = bd.name;
    res.json({ success: true, redirect: '/business-developers/dashboard' });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/business-developers/:id/mark-paid', isAdminPage, async (req, res) => {
  try {
    const bd = await BusinessDeveloper.findById(req.params.id);
    if (!bd) return res.json({ success: false, message: 'BD not found' });
    const amount = bd.pendingEarnings;
    bd.paidEarnings   += amount;
    bd.pendingEarnings = 0;
    await bd.save();
    await BDEarning.updateMany({ bdId: bd._id, status: 'pending' }, { status: 'paid', paidAt: new Date() });
    res.json({ success: true, amount });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ── Business pages ────────────────────────────────────

router.get('/businesses', isAdminPage, async (req, res) => {
  try {
    const statusFilter = req.query.status && req.query.status !== 'all' ? req.query.status : null;
    const query = statusFilter ? { status: statusFilter } : {};
    const businesses = await Business.find(query).populate('createdBy', 'name email').sort({ createdAt: -1 });

    const all = await Business.find();
    const counts = { all: all.length };
    ['pending','approved','rejected','suspended'].forEach(s => {
      counts[s] = all.filter(b => b.status === s).length;
    });

    res.render('admin/pages/businesses', {
      user: req.user, businesses, counts, activeStatus: req.query.status || 'all'
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

router.post('/businesses/:id/approve', isAdminPage, async (req, res) => {
  try {
    await Business.findByIdAndUpdate(req.params.id, {
      status: 'approved', approvedAt: new Date(), approvedBy: req.user._id
    });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/businesses/:id/reject', isAdminPage, async (req, res) => {
  try {
    await Business.findByIdAndUpdate(req.params.id, {
      status: 'rejected', rejectionReason: req.body.reason || ''
    });
    res.redirect('/admin/businesses');
  } catch (err) { res.redirect('/admin/businesses'); }
});

router.post('/businesses/:id/suspend', isAdminPage, async (req, res) => {
  try {
    await Business.findByIdAndUpdate(req.params.id, { status: 'suspended' });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/businesses/:id/delete', isAdminPage, async (req, res) => {
  try {
    const biz = await Business.findById(req.params.id);
    if (!biz) return res.json({ success: false, message: 'Business not found' });

    // Reverse BD commission earnings tied to this business
    const bdEarnings = await BDEarning.find({ businessId: biz._id });
    if (bdEarnings.length && biz.createdBy) {
      const totalPending  = bdEarnings.reduce((s, e) => s + (e.commissionAmount || 0), 0);
      const BusinessDeveloper = require('../models/BusinessDeveloper');
      await BusinessDeveloper.findByIdAndUpdate(biz.createdBy, {
        $inc: { pendingEarnings: -totalPending, totalEarned: -totalPending }
      });
    }

    // Delete all related records
    await Promise.all([
      BDEarning.deleteMany({ businessId: biz._id }),
      BusinessTransaction.deleteMany({ businessId: biz._id }),
      BusinessFundRequest.deleteMany({ businessId: biz._id })
    ]);

    await Business.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete business error:', err);
    res.json({ success: false, message: err.message });
  }
});

router.post('/businesses/:id/login-as', isAdminPage, async (req, res) => {
  try {
    const biz = await Business.findById(req.params.id);
    if (!biz) return res.json({ success: false, message: 'Business not found' });
    req.session.businessId   = biz._id.toString();
    req.session.businessName = biz.name;
    res.json({ success: true, redirect: '/business/dashboard' });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ── Fund requests ─────────────────────────────────────

router.get('/fund-requests', isAdminPage, requireSection('fund-requests'), async (req, res) => {
  try {
    const statusFilter = req.query.status && req.query.status !== 'all' ? req.query.status : null;
    const query = statusFilter ? { status: statusFilter } : {};
    const requests = await BusinessFundRequest.find(query)
      .populate('businessId', 'name username')
      .sort({ createdAt: -1 });

    const all = await BusinessFundRequest.find();
    const counts = { all: all.length };
    ['pending','approved','rejected'].forEach(s => {
      counts[s] = all.filter(r => r.status === s).length;
    });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const approvedThisMonth = all.filter(r => r.status === 'approved' && new Date(r.createdAt) >= monthStart);
    const totalApprovedThisMonth = approvedThisMonth.reduce((s, r) => s + r.amount, 0);
    const totalApproved = all.filter(r => r.status === 'approved').reduce((s, r) => s + r.amount, 0);

    res.render('admin/pages/fund-requests', {
      user: req.user, requests, counts,
      activeStatus: req.query.status || 'all',
      totalApprovedThisMonth, totalApproved
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

router.post('/fund-requests/:id/approve', isAdminPage, requireSection('fund-requests'), async (req, res) => {
  try {
    const fr = await BusinessFundRequest.findById(req.params.id);
    if (!fr || fr.status !== 'pending') return res.json({ success: false, message: 'Request not found or already processed.' });

    fr.status     = 'approved';
    fr.approvedAt = new Date();
    fr.approvedBy = req.user._id;
    await fr.save();

    const business = await Business.findById(fr.businessId);
    if (business) {
      const balanceBefore = business.balance;
      business.balance     += fr.amount;
      business.totalFunded += fr.amount;
      await business.save();

      await BusinessTransaction.create({
        businessId:    business._id,
        type:          'fund',
        totalAmount:   fr.amount,
        poolAmount:    fr.amount,
        description:   'Account funding approved',
        balanceBefore,
        balanceAfter: business.balance
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message });
  }
});

router.post('/fund-requests/:id/reject', isAdminPage, requireSection('fund-requests'), async (req, res) => {
  try {
    await BusinessFundRequest.findByIdAndUpdate(req.params.id, {
      status: 'rejected', rejectionReason: req.body.reason || ''
    });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ── Wallet addresses ──────────────────────────────────

router.get('/wallet-addresses', isAdminPage, requireSection('wallet-addresses'), async (req, res) => {
  try {
    const wallets = await WalletAddress.find().populate('addedBy', 'username').sort({ token: 1, network: 1 });
    res.render('admin/pages/wallet-addresses', { user: req.user, wallets });
  } catch (err) { res.redirect('/admin'); }
});

router.post('/wallet-addresses/add', isAdminPage, requireSection('wallet-addresses'), async (req, res) => {
  try {
    const { token, network, address, label } = req.body;
    await WalletAddress.create({ token, network, address, label, addedBy: req.user._id });
    res.redirect('/admin/wallet-addresses?success=added');
  } catch (err) { res.redirect('/admin/wallet-addresses?error=' + encodeURIComponent(err.message)); }
});

router.post('/wallet-addresses/:id/toggle', isAdminPage, requireSection('wallet-addresses'), async (req, res) => {
  try {
    const w = await WalletAddress.findById(req.params.id);
    if (!w) return res.json({ success: false });
    w.isActive = !w.isActive;
    await w.save();
    res.json({ success: true, isActive: w.isActive });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/wallet-addresses/:id/delete', isAdminPage, requireSection('wallet-addresses'), async (req, res) => {
  try {
    await WalletAddress.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ── Commission settings ───────────────────────────────

router.get('/commission-settings', isAdminPage, requireSection('commission-settings'), async (req, res) => {
  try {
    const settings = await CommissionSettings.getCurrent();
    res.render('admin/pages/commission-settings', {
      user: req.user, settings,
      saved: req.query.saved === '1'
    });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/commission-settings', isAdminPage, requireSection('commission-settings'), async (req, res) => {
  try {
    const { bdCommissionRate, platformCommissionRate } = req.body;
    await CommissionSettings.create({
      bdCommissionRate:       parseFloat(bdCommissionRate),
      platformCommissionRate: parseFloat(platformCommissionRate),
      updatedBy: req.user._id
    });
    res.redirect('/admin/commission-settings?saved=1');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/commission-settings');
  }
});

// ══════════════════════════════════════════════════════════
// LAUNCH REWARDS
// ══════════════════════════════════════════════════════════
const LaunchReward = require('../models/LaunchReward');
const { getTreasuryBalance } = require('../utils/sendUsdc');

router.get('/launch-rewards', isAdmin, async (req, res) => {
  try {
    const all = await LaunchReward.find({}).sort({ amount: -1, xp: -1 }).lean();
    const balance = await getTreasuryBalance();
    const stats = {
      total: all.length,
      pending: all.filter(r => r.status === 'pending').length,
      sent: all.filter(r => r.status === 'sent').length,
      failed: all.filter(r => r.status === 'failed').length,
      skipped: all.filter(r => r.status === 'skipped_no_wallet').length,
      totalOwed: all.filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
      totalSent: all.filter(r => r.status === 'sent').reduce((s, r) => s + r.amount, 0),
    };
    res.render('admin/launch-rewards', { rewards: all, stats, balance });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading rewards');
  }
});

router.post('/api/launch-rewards/seed', isAdmin, async (req, res) => {
  try {
    const { execFile } = require('child_process');
    const path = require('path');
    const script = path.join(__dirname, '../scripts/seed-launch-rewards.js');
    execFile('node', [script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return res.json({ ok: false, error: err.message, stderr });
      res.json({ ok: true, output: stdout });
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

let _distributing = false;
router.post('/api/launch-rewards/distribute', isAdmin, async (req, res) => {
  if (_distributing) return res.json({ ok: false, error: 'Distribution already running' });
  _distributing = true;
  res.json({ ok: true, message: 'Distribution started — refresh the page to see progress' });

  const User = require('../models/User');
  const pending = await LaunchReward.find({ status: 'pending' }).lean();
  let sent = 0, failed = 0;

  for (const reward of pending) {
    try {
      await User.collection.updateOne(
        { _id: reward.userId },
        { $inc: { usdcBalance: reward.amount } }
      );
      await LaunchReward.updateOne({ _id: reward._id }, {
        $set: { status: 'sent', sentAt: new Date() }
      });
      sent++;
      console.log(`[Rewards] Credited $${reward.amount} → @${reward.username}`);
    } catch (err) {
      await LaunchReward.updateOne({ _id: reward._id }, {
        $set: { status: 'failed', failReason: err.message }
      });
      failed++;
      console.error(`[Rewards] FAILED @${reward.username}: ${err.message}`);
    }
  }
  console.log(`[Rewards] Done — sent:${sent} failed:${failed}`);
  _distributing = false;
});

router.get('/api/launch-rewards/status', isAdmin, async (req, res) => {
  try {
    const all = await LaunchReward.find({}).lean();
    res.json({
      total: all.length,
      pending: all.filter(r => r.status === 'pending').length,
      sent: all.filter(r => r.status === 'sent').length,
      failed: all.filter(r => r.status === 'failed').length,
      skipped: all.filter(r => r.status === 'skipped_no_wallet').length,
      totalSent: all.filter(r => r.status === 'sent').reduce((s, r) => s + r.amount, 0),
      distributing: _distributing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/launch-rewards/retry-failed', isAdmin, async (req, res) => {
  try {
    const result = await LaunchReward.updateMany({ status: 'failed' }, { $set: { status: 'pending', failReason: null, txSignature: null } });
    res.json({ ok: true, reset: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/api/launch-rewards/:rewardId', isAdmin, async (req, res) => {
  try {
    const { amount, tier } = req.body;
    if (amount === undefined && tier === undefined) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    const existing = await LaunchReward.findById(req.params.rewardId);
    if (!existing) return res.status(404).json({ ok: false, error: 'Reward not found' });

    const update = {};
    if (tier !== undefined) update.tier = tier;
    if (amount !== undefined) update.amount = parseFloat(amount);

    // If already sent, credit/debit the difference to the user's in-app balance
    let diff = 0;
    if (existing.status === 'sent' && amount !== undefined) {
      diff = parseFloat(amount) - existing.amount;
      if (diff !== 0) {
        const User = require('../models/User');
        await User.collection.updateOne({ _id: existing.userId }, { $inc: { usdcBalance: diff } });
      }
    }

    await LaunchReward.updateOne({ _id: existing._id }, { $set: update });
    res.json({ ok: true, diff });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reset a user's launch reward so they can redo the welcome task and collect the corrected amount
router.post('/api/launch-rewards/:rewardId/reset', isAdmin, async (req, res) => {
  try {
    const { amount, tier } = req.body;
    if (amount === undefined) return res.status(400).json({ ok: false, error: 'amount required' });
    const existing = await LaunchReward.findById(req.params.rewardId);
    if (!existing) return res.status(404).json({ ok: false, error: 'Reward not found' });

    const User = require('../models/User');
    // Reset the reward record to pending with the corrected amount
    await LaunchReward.updateOne({ _id: existing._id }, {
      $set: {
        amount: parseFloat(amount),
        tier: tier || existing.tier,
        status: 'pending',
        sentAt: null,
        failReason: null
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fix all MANUAL override users who received the wrong (lower) amount
router.post('/api/launch-rewards/fix-manual-overrides', isAdmin, async (req, res) => {
  try {
    const User = require('../models/User');
    const MANUAL = {
      'ridique': 5, 'zaynab': 5, 'lrick 05': 5,
      'bolacrypt': 3, 'defioyin': 3, 'luckee': 3, 'trae♠️': 3, 'promzy10': 3,
      'ragnar': 3, 'obasalopi': 3, 'imxihab': 3, 'levrone': 3, 'cynthia anto': 3,
      'naana': 2, 'abdulkourey': 2, 'ibnmarzuk': 2, 'jayed': 2, 'ghostdev': 2,
      'desmonolord': 1, 'desmondolord': 1, 'brainly': 1, 'bless': 1, 'nassir1': 1,
      'destancrypt': 1, 'adenuga': 1, 'byмusa': 1, 'bymusa': 1, 'jonathan': 1,
      'dominus': 1, 'king marlito': 1, 'heelat123': 1,
    };

    const all = await LaunchReward.find({}).lean();
    const fixed = [];

    for (const r of all) {
      const key = (r.username || '').toLowerCase().trim();
      const correctBase = MANUAL[key];
      if (correctBase === undefined) continue;
      // Only fix if they got significantly less than intended (more than $0.13 off, accounting for jitter)
      if (r.amount >= correctBase - 0.13) continue;

      await LaunchReward.updateOne({ _id: r._id }, {
        $set: { amount: correctBase, tier: correctBase >= 5 ? 'top5' : correctBase >= 3 ? 'legend_manual' : correctBase >= 2 ? 'captain_active' : 'captain', status: 'pending', sentAt: null, failReason: null }
      });
      await User.collection.updateOne({ _id: r.userId }, { $set: { launchDayCompleted: false } });
      fixed.push({ username: r.username, was: r.amount, now: correctBase });
    }

    res.json({ ok: true, fixed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Direct balance credit — add USDC to any user's in-app balance
router.post('/api/users/credit-balance', isAdmin, async (req, res) => {
  try {
    const User = require('../models/User');
    const { username, amount } = req.body;
    if (!username || !amount) return res.status(400).json({ ok: false, error: 'username and amount required' });
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });
    const user = await User.findOne({ username: new RegExp('^' + username.trim() + '$', 'i') }).select('_id username usdcBalance');
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    await User.collection.updateOne({ _id: user._id }, { $inc: { usdcBalance: parsed } });
    res.json({ ok: true, username: user.username, credited: parsed, newBalance: (user.usdcBalance || 0) + parsed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
router.get('/api/quests/:questId/winners', isAdmin, adminController.getQuestWinners);
router.post('/api/quests/distribute-rewards', isAdmin, adminController.distributeQuestRewards);
router.get('/api/withdrawals', isAdmin, requireSection('withdrawals'), adminController.getAllWithdrawals);
router.get('/api/withdrawals/stats', isAdmin, requireSection('withdrawals'), adminController.getWithdrawalStats);
router.post('/api/withdrawals/:transactionId/approve', isAdmin, requireSection('withdrawals'), adminController.approveWithdrawal);
router.post('/api/withdrawals/:transactionId/reject', isAdmin, requireSection('withdrawals'), adminController.rejectWithdrawal);

// Add these routes if they don't exist
router.get('/api/quests/:questId/leaderboard', isAdmin, adminController.getQuestLeaderboardAdmin);
router.get('/api/quests/:questId/export', isAdmin, adminController.exportQuestLeaderboard);
// IMPORTANT: Put /stats and /export BEFORE /:applicationId
router.get("/api/ambassadors/stats", isAdmin, adminController.getAmbassadorStats);
router.get("/api/ambassadors/export", isAdmin, adminController.exportAmbassadorApplications);
router.get("/api/ambassadors", isAdmin, adminController.getAllAmbassadorApplications);
router.get("/api/ambassadors/:applicationId", isAdmin, adminController.getAmbassadorDetails);
router.post("/api/ambassadors/:applicationId/approve", isAdmin, adminController.approveAmbassadorApplication);
router.post("/api/ambassadors/:applicationId/reject", isAdmin, adminController.rejectAmbassadorApplication);
router.put("/api/ambassadors/:applicationId/metrics", isAdmin, adminController.updateAmbassadorMetrics);

// Add these routes to your admin routes file (after the existing routes)

// ==================== USER BANNING ====================
router.get("/api/users/:userId/quest-progress", isAdmin, adminController.getUserWithQuestProgress);
router.post("/api/users/:userId/ban", isAdmin, adminController.banUserFromQuests);
router.post("/api/users/:userId/unban", isAdmin, adminController.unbanUser);
router.get("/api/banned-users", isAdmin, adminController.getBannedUsers);

// ==================== PROJECT SUBMISSIONS MANAGEMENT ====================

const ProjectSubmission = require('../models/ProjectSubmission');

router.get("/api/projects/submissions", isAdmin, async (req, res) => {
    try {
        const { status, category, page = 1, limit = 50 } = req.query;

        const query = {};
        if (status && status !== 'all') query.status = status;
        if (category) query.category = category;

        const skip = (page - 1) * limit;

        const [submissions, total] = await Promise.all([
            ProjectSubmission.find(query)
                .sort({ submittedAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('submittedBy', 'username email')
                .populate('reviewedBy', 'username'),
            ProjectSubmission.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: submissions,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching project submissions:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while fetching project submissions'
        });
    }
});

router.put("/api/projects/submissions/:id/review", isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reviewNotes } = req.body;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be "approved" or "rejected"'
            });
        }

        const submission = await ProjectSubmission.findByIdAndUpdate(
            id,
            {
                status,
                reviewNotes: reviewNotes || undefined,
                reviewedBy: req.user._id,
                reviewedAt: new Date()
            },
            { new: true }
        );

        if (!submission) {
            return res.status(404).json({
                success: false,
                message: 'Project submission not found'
            });
        }

        res.json({
            success: true,
            message: `Project ${status} successfully`,
            data: submission
        });

    } catch (error) {
        console.error('Error reviewing project submission:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while reviewing the submission'
        });
    }
});

// ==================== ROLE SETTINGS ====================

router.get('/settings/roles', isAdminPage, requireSection('settings'), (req, res) => {
  const { ROLES } = require('../config/gamification');
  res.render('admin/role-settings', {
    title: 'Role Settings - Admin',
    user: req.user,
    roles: ROLES
  });
});

// ==================== SITE SETTINGS ====================

router.get('/api/settings', isAdmin, async (req, res) => {
  try {
    const SiteSettings = require('../models/SiteSettings');
    const settings = await SiteSettings.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/settings/email-provider', isAdmin, async (req, res) => {
  try {
    const SiteSettings = require('../models/SiteSettings');
    const { provider } = req.body;
    if (!['resend', 'gmail'].includes(provider)) {
      return res.status(400).json({ success: false, message: 'Invalid provider. Use resend or gmail.' });
    }
    const settings = await SiteSettings.getSettings();
    settings.emailProvider = provider;
    await settings.save();
    console.log(`Admin switched email provider → ${provider}`);
    res.json({ success: true, emailProvider: settings.emailProvider });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/settings/email-verification', isAdmin, async (req, res) => {
  try {
    const SiteSettings = require('../models/SiteSettings');
    const { required } = req.body;
    const settings = await SiteSettings.getSettings();
    settings.emailVerificationRequired = !!required;
    await settings.save();
    console.log(`Admin toggled emailVerificationRequired → ${settings.emailVerificationRequired}`);
    res.json({ success: true, emailVerificationRequired: settings.emailVerificationRequired });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/settings/test-email', isAdmin, async (req, res) => {
  try {
    const { sendEmail } = require('../utils/emailService');
    const to = req.user.email;
    const result = await sendEmail({
      to,
      subject: 'ONBOARD3 — Email Delivery Test',
      html: `<div style="font-family:Arial,sans-serif;background:#fff;padding:32px;border-radius:12px;max-width:480px;margin:0 auto;border:1px solid #eee">
        <h2 style="color:#111;margin-bottom:8px">&#x2705; Email Delivery Test</h2>
        <p style="color:#444">This test email was sent from the ONBOARD3 admin panel.<br>If you are reading this, email delivery is working correctly.</p>
        <p style="color:#888;font-size:13px;margin-top:24px">Sent at: ${new Date().toISOString()}</p>
      </div>`
    });
    res.json({ success: result.success, sentTo: to, error: result.error || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/update-roles', isAdmin, async (req, res) => {
  try {
    const { roles } = req.body;
    const fs = require('fs');
    const path = require('path');
    if (!roles) return res.json({ success: false, message: 'No role data provided' });

    const configPath = path.join(__dirname, '../config/gamification.js');
    let configContent = fs.readFileSync(configPath, 'utf8');

    Object.keys(roles).forEach(roleKey => {
      const roleConfig = roles[roleKey];
      configContent = configContent.replace(new RegExp(`(${roleKey}:\\s*{[\\s\\S]*?minXP:\\s*)\\d+`, 'm'), `$1${roleConfig.minXP}`);
      configContent = configContent.replace(new RegExp(`(${roleKey}:[\\s\\S]*?monthlyBonus:\\s*)\\d+`, 'm'), `$1${roleConfig.benefits.monthlyBonus}`);
      configContent = configContent.replace(new RegExp(`(${roleKey}:[\\s\\S]*?classDiscount:\\s*)\\d+`, 'm'), `$1${roleConfig.benefits.classDiscount}`);
    });

    fs.writeFileSync(configPath, configContent, 'utf8');
    delete require.cache[require.resolve('../config/gamification')];
    res.json({ success: true, message: 'Role configuration updated successfully' });
  } catch (error) {
    console.error('Error updating roles:', error);
    res.json({ success: false, message: 'Error updating configuration' });
  }
});

// ==================== LEADERBOARD MANAGER ====================

router.get('/leaderboard', isAdminPage, requireSection('leaderboard'), async (req, res) => {
  try {
    const User = require('../models/User');
    const Quest = require('../models/Quest');
    const quests = await Quest.find().select('title _id isActive').sort({ isActive: -1, createdAt: -1 });
    res.render('admin/leaderboard-manager', { title: 'Leaderboard Manager', user: req.user, admin: req.user, quests: quests });
  } catch (error) {
    console.error('Error loading leaderboard:', error);
    res.status(500).send('Server error');
  }
});

// Get leaderboard data (global XP or quest-specific)
router.get('/api/leaderboard/data', isAdmin, requireSection('leaderboard'), async (req, res) => {
  try {
    const { type } = req.query;
    const User = require('../models/User');
    const UserQuestProgress = require('../models/UserQuestProgress');

    if (type === 'global' || !type) {
      // Global XP leaderboard
      const users = await User.find({}).sort({ xp: -1 }).limit(100).select('username xp isFakeUser');
      const data = users.map(u => ({
        _id: u._id,
        username: u.username,
        points: u.xp || 0,
        isFakeUser: u.isFakeUser || false
      }));
      return res.json({ success: true, data });
    } else {
      // Quest-specific leaderboard
      const progress = await UserQuestProgress.find({ questId: type, status: { $in: ['completed', 'in_progress'] } })
        .populate('userId', 'username isFakeUser')
        .sort({ 'xpBreakdown.totalXp': -1, lastXpAt: 1, completedAt: 1, startedAt: 1, createdAt: 1 })
        .limit(100);

      const data = progress.map(p => ({
        _id: p.userId?._id,
        progressId: p._id,
        username: p.userId?.username || 'Unknown',
        points: p.xpBreakdown?.totalXp || 0,
        isFakeUser: p.userId?.isFakeUser || false,
        completedAt: p.completedAt
      }));
      return res.json({ success: true, data });
    }
  } catch (error) {
    console.error('Error fetching leaderboard data:', error);
    res.json({ success: false, message: 'Error fetching leaderboard data' });
  }
});

router.post('/api/leaderboard/add', isAdmin, requireSection('leaderboard'), async (req, res) => {
  try {
    const { username, points, leaderboardType } = req.body;
    const User = require('../models/User');
    const crypto = require('crypto');
    const cleanUsername = String(username || '').trim();
    const xpPoints = Number(points);
    if (cleanUsername.length < 3 || cleanUsername.length > 30)
      return res.status(400).json({ success: false, message: 'Username must be between 3 and 30 characters' });
    if (!Number.isSafeInteger(xpPoints) || xpPoints < 0)
      return res.status(400).json({ success: false, message: 'XP must be a whole number of 0 or more' });
    const usernamePattern = `^${cleanUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const usernameQuery = { username: { $regex: usernamePattern, $options: 'i' } };

    if (leaderboardType === 'global' || !leaderboardType) {
      let leaderboardUser = await User.findOne(usernameQuery);
      if (leaderboardUser) {
        leaderboardUser.xp = xpPoints;
        await leaderboardUser.save();
        return res.json({ success: true, message: 'Existing user XP updated on the global leaderboard' });
      }
      leaderboardUser = new User({
        username: cleanUsername,
        email: `leaderboard-${crypto.randomUUID()}@fake.onboard3.local`,
        password: crypto.randomUUID(),
        xp: xpPoints,
        isFakeUser: true,
        isVerified: true
      });
      await leaderboardUser.save();
      return res.json({ success: true, message: 'User added to leaderboard' });
    } else {
      // Add user to quest leaderboard
      const UserQuestProgress = require('../models/UserQuestProgress');
      const Quest = require('../models/Quest');
      if (!mongoose.Types.ObjectId.isValid(leaderboardType))
        return res.status(400).json({ success: false, message: 'Invalid quest' });
      const quest = await Quest.findById(leaderboardType);
      if (!quest) return res.status(404).json({ success: false, message: 'Quest not found' });

      // Find or create fake user
      let user = await User.findOne(usernameQuery);
      if (!user) {
        user = new User({
          username: cleanUsername,
          email: `leaderboard-${crypto.randomUUID()}@fake.onboard3.local`,
          password: crypto.randomUUID(),
          xp: 0,
          isFakeUser: true,
          isVerified: true
        });
        await user.save();
      }

      // Add or update the quest entry, including existing in-progress users.
      let progress = await UserQuestProgress.findOne({ userId: user._id, questId: leaderboardType });
      const taskCount = quest.tasks?.length || 1;
      if (progress) {
        const xp = progress.xpBreakdown || {};
        const naturalXp = (xp.taskXp || 0) + (xp.baseXp || 0) + (xp.referralJoinBonus || 0)
          + (xp.referralCompleteBonus || 0) + (xp.winnerBonus || 0);
        await UserQuestProgress.updateOne({ _id: progress._id }, { $set: {
          status: 'completed', progress: 100, tasksCompleted: taskCount,
          totalTasks: taskCount, completedAt: new Date(),
          'xpBreakdown.totalXp': xpPoints,
          'xpBreakdown.adminAdjustmentXp': xpPoints - naturalXp
        }});
      } else {
        progress = new UserQuestProgress({
          userId: user._id,
          questId: leaderboardType,
          status: 'completed',
          progress: 100,
          tasksCompleted: taskCount,
          totalTasks: taskCount,
          completedAt: new Date(),
          xpBreakdown: { totalXp: xpPoints, baseXp: xpPoints }
        });
        await progress.save();
      }
      require('../controllers/questController').invalidateQuestLeaderboard(leaderboardType);
      return res.json({ success: true, message: 'User added or updated on the quest leaderboard' });
    }
  } catch (error) {
    console.error('Error adding user:', error);
    res.json({ success: false, message: 'Error adding user: ' + error.message });
  }
});

router.post('/api/leaderboard/update/:userId', isAdmin, requireSection('leaderboard'), async (req, res) => {
  try {
    const { username, points, delta, action, isFakeUser, leaderboardType } = req.body;
    const User = require('../models/User');
    if (!['add', 'deduct', 'set'].includes(action))
      return res.status(400).json({ success: false, message: 'Choose add, deduct, or set XP' });
    const amount = Number(action === 'set' ? points : delta);
    if (!Number.isSafeInteger(amount) || amount < 0)
      return res.status(400).json({ success: false, message: 'XP must be a whole number of 0 or more' });

    if (leaderboardType === 'global' || !leaderboardType) {
      const user = await User.findById(req.params.userId);
      if (!user) return res.json({ success: false, message: 'User not found' });
      if (username) user.username = username;
      if (isFakeUser !== undefined) user.isFakeUser = isFakeUser;
      if (action === 'add') user.xp = (user.xp || 0) + amount;
      else if (action === 'deduct') user.xp = Math.max(0, (user.xp || 0) - amount);
      else user.xp = amount;
      if (!Number.isSafeInteger(user.xp))
        return res.status(400).json({ success: false, message: 'Resulting XP exceeds the supported range' });
      await user.save();
      res.json({ success: true, message: 'User updated successfully', newTotal: user.xp });
    } else {
      if (!mongoose.Types.ObjectId.isValid(leaderboardType))
        return res.status(400).json({ success: false, message: 'Invalid quest' });
      const UserQuestProgress = require('../models/UserQuestProgress');
      const progress = await UserQuestProgress.findOne({ userId: req.params.userId, questId: leaderboardType });
      if (!progress) return res.json({ success: false, message: 'Quest progress not found' });

      const current = progress.xpBreakdown?.totalXp || 0;
      const xp = progress.xpBreakdown || {};
      const naturalXp = (xp.taskXp || 0) + (xp.baseXp || 0) + (xp.referralJoinBonus || 0)
        + (xp.referralCompleteBonus || 0) + (xp.winnerBonus || 0);
      let newTotal;
      if (action === 'add') newTotal = current + amount;
      else if (action === 'deduct') newTotal = Math.max(0, current - amount);
      else newTotal = amount;
      if (!Number.isSafeInteger(newTotal))
        return res.status(400).json({ success: false, message: 'Resulting XP exceeds the supported range' });

      // Use updateOne to bypass pre-save hook that would re-sum breakdown fields
      await UserQuestProgress.updateOne(
        { _id: progress._id },
        { $set: {
          'xpBreakdown.totalXp': newTotal,
          'xpBreakdown.adminAdjustmentXp': newTotal - naturalXp
        }}
      );
      require('../controllers/questController').invalidateQuestLeaderboard(leaderboardType);
      res.json({ success: true, message: 'Quest progress updated successfully', newTotal });
    }
  } catch (error) {
    console.error('Error updating user:', error);
    res.json({ success: false, message: 'Error updating user' });
  }
});

router.post('/api/leaderboard/delete/:userId', isAdmin, requireSection('leaderboard'), async (req, res) => {
  try {
    const { type } = req.query;
    const User = require('../models/User');

    if (type === 'global' || !type) {
      const user = await User.findById(req.params.userId);
      if (!user) return res.json({ success: false, message: 'User not found' });
      if (!user.isFakeUser) return res.json({ success: false, message: 'Cannot delete real users' });
      await User.findByIdAndDelete(req.params.userId);
      res.json({ success: true, message: 'User deleted successfully' });
    } else {
      // Delete quest progress entry
      const UserQuestProgress = require('../models/UserQuestProgress');
      const progress = await UserQuestProgress.findOne({ userId: req.params.userId, questId: type });
      if (!progress) return res.json({ success: false, message: 'Quest progress not found' });
      await UserQuestProgress.findByIdAndDelete(progress._id);
      require('../controllers/questController').invalidateQuestLeaderboard(type);
      res.json({ success: true, message: 'Quest leaderboard entry deleted successfully' });
    }
  } catch (error) {
    console.error('Error deleting user:', error);
    res.json({ success: false, message: 'Error deleting user' });
  }
});

// ==================== PARTNER MANAGEMENT ====================

const Partner = require('../models/Partner');

// Partner management page
router.get('/partners', isAdmin, async (req, res) => {
  try {
    res.render('admin/partners', { title: 'Partner Management', user: req.user, admin: req.user });
  } catch (error) {
    console.error('Error loading partners page:', error);
    res.status(500).send('Server error');
  }
});

// Get partner stats
router.get('/api/partners/stats', isAdmin, async (req, res) => {
  try {
    const totalPartners = await Partner.countDocuments({ applicationStatus: 'approved' });
    const pendingApplications = await Partner.countDocuments({ applicationStatus: 'pending' });

    // Count pending proposals across all partners
    const partnersWithProposals = await Partner.find({ 'proposals.status': 'pending' });
    let pendingProposals = 0;
    partnersWithProposals.forEach(p => {
      pendingProposals += p.proposals.filter(prop => prop.status === 'pending').length;
    });

    // Total commission paid
    const commissionAgg = await Partner.aggregate([
      { $match: { applicationStatus: 'approved' } },
      { $group: { _id: null, total: { $sum: '$totalCommissionEarned' } } }
    ]);
    const totalCommission = commissionAgg[0]?.total || 0;

    res.json({
      success: true,
      stats: { totalPartners, pendingApplications, pendingProposals, totalCommission }
    });
  } catch (error) {
    console.error('Error getting partner stats:', error);
    res.json({ success: false, message: 'Error getting stats' });
  }
});

// Get partners list
router.get('/api/partners', isAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { applicationStatus: status } : {};

    const partners = await Partner.find(query)
      .populate('userId', 'username email xp')
      .sort({ appliedAt: -1 });

    res.json({ success: true, data: partners });
  } catch (error) {
    console.error('Error getting partners:', error);
    res.json({ success: false, message: 'Error getting partners' });
  }
});

// Get all proposals
router.get('/api/partners/proposals', isAdmin, async (req, res) => {
  try {
    const partners = await Partner.find({ 'proposals.0': { $exists: true } })
      .populate('userId', 'username');

    const proposals = [];
    partners.forEach(p => {
      p.proposals.forEach(proposal => {
        proposals.push({
          partnerId: p._id,
          proposalId: proposal._id,
          partnerName: p.fullName,
          partnerUsername: p.userId?.username,
          ...proposal.toObject()
        });
      });
    });

    // Sort by submitted date, newest first
    proposals.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.json({ success: true, data: proposals });
  } catch (error) {
    console.error('Error getting proposals:', error);
    res.json({ success: false, message: 'Error getting proposals' });
  }
});

// Get single partner details
router.get('/api/partners/:id', isAdmin, async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id)
      .populate('userId', 'username email xp');

    if (!partner) {
      return res.json({ success: false, message: 'Partner not found' });
    }

    res.json({ success: true, data: partner });
  } catch (error) {
    console.error('Error getting partner:', error);
    res.json({ success: false, message: 'Error getting partner' });
  }
});

// Get single proposal
router.get('/api/partners/:partnerId/proposals/:proposalId', isAdmin, async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.partnerId);
    if (!partner) {
      return res.json({ success: false, message: 'Partner not found' });
    }

    const proposal = partner.proposals.id(req.params.proposalId);
    if (!proposal) {
      return res.json({ success: false, message: 'Proposal not found' });
    }

    res.json({ success: true, data: proposal });
  } catch (error) {
    console.error('Error getting proposal:', error);
    res.json({ success: false, message: 'Error getting proposal' });
  }
});

// Approve partner application
router.post('/api/partners/:id/approve', isAdmin, async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);

    if (!partner) {
      return res.json({ success: false, message: 'Partner not found' });
    }

    partner.applicationStatus = 'approved';
    partner.approvedAt = new Date();
    partner.approvedBy = req.user._id;
    await partner.save();

    res.json({ success: true, message: 'Application approved' });
  } catch (error) {
    console.error('Error approving application:', error);
    res.json({ success: false, message: 'Error approving application' });
  }
});

// Reject partner application
router.post('/api/partners/:id/reject', isAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const partner = await Partner.findById(req.params.id);

    if (!partner) {
      return res.json({ success: false, message: 'Partner not found' });
    }

    partner.applicationStatus = 'rejected';
    partner.rejectedAt = new Date();
    partner.rejectedBy = req.user._id;
    partner.rejectionReason = reason || '';
    await partner.save();

    res.json({ success: true, message: 'Application rejected' });
  } catch (error) {
    console.error('Error rejecting application:', error);
    res.json({ success: false, message: 'Error rejecting application' });
  }
});

// Approve proposal
router.post('/api/partners/:partnerId/proposals/:proposalId/approve', isAdmin, async (req, res) => {
  try {
    const { commission } = req.body;
    const partner = await Partner.findById(req.params.partnerId)
      .populate('userId', 'telegramId');

    if (!partner) {
      return res.json({ success: false, message: 'Partner not found' });
    }

    const proposal = partner.proposals.id(req.params.proposalId);
    if (!proposal) {
      return res.json({ success: false, message: 'Proposal not found' });
    }

    proposal.status = 'approved';
    proposal.reviewedAt = new Date();
    proposal.reviewedBy = req.user._id;
    proposal.commissionPaid = commission || 0;

    partner.approvedProposals = (partner.approvedProposals || 0) + 1;
    partner.totalCommissionEarned = (partner.totalCommissionEarned || 0) + (commission || 0);

    await partner.save();

    res.json({ success: true, message: 'Proposal approved' });
  } catch (error) {
    console.error('Error approving proposal:', error);
    res.json({ success: false, message: 'Error approving proposal' });
  }
});

// Reject proposal
router.post('/api/partners/:partnerId/proposals/:proposalId/reject', isAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const partner = await Partner.findById(req.params.partnerId);

    if (!partner) {
      return res.json({ success: false, message: 'Partner not found' });
    }

    const proposal = partner.proposals.id(req.params.proposalId);
    if (!proposal) {
      return res.json({ success: false, message: 'Proposal not found' });
    }

    proposal.status = 'rejected';
    proposal.reviewedAt = new Date();
    proposal.reviewedBy = req.user._id;
    proposal.reviewNotes = reason || '';

    await partner.save();

    res.json({ success: true, message: 'Proposal rejected' });
  } catch (error) {
    console.error('Error rejecting proposal:', error);
    res.json({ success: false, message: 'Error rejecting proposal' });
  }
});

// ── Quest Applications ────────────────────────────────
router.get('/quest-applications', isAdminPage, async (req, res) => {
  try {
    const applications = await QuestApplication.find()
      .populate('questId', 'title')
      .populate('userId', 'username profilePicture')
      .sort({ createdAt: -1 })
      .lean();

    // Group by quest
    const grouped = {};
    applications.forEach(a => {
      const qid = a.questId ? a.questId._id.toString() : 'unknown';
      if (!grouped[qid]) {
        grouped[qid] = { quest: a.questId, items: [] };
      }
      grouped[qid].items.push(a);
    });

    res.render('admin/pages/quest-applications', {
      user: req.user,
      applications,
      grouped: Object.values(grouped)
    });
  } catch (err) {
    console.error('[admin quest-applications]', err);
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/quest-applications/:id/approve', isAdminPage, async (req, res) => {
  try {
    const Quest             = require('../models/Quest');
    const UserQuestProgress = require('../models/UserQuestProgress');
    const { notify }        = require('../utils/notificationService');

    const application = await QuestApplication.findById(req.params.id);
    if (!application) return res.json({ success: false, message: 'Not found' });

    application.status     = 'approved';
    application.reviewedAt = new Date();
    application.reviewedBy = req.user._id;
    await application.save();

    // Create UserQuestProgress so user can participate
    const quest = await Quest.findById(application.questId);
    if (quest) {
      const existing = await UserQuestProgress.findOne({ questId: quest._id, userId: application.userId });
      if (!existing) {
        const allTasks = [...(quest.tasks || []), ...(quest.dailyTasks || [])];
        await UserQuestProgress.create({
          questId:    quest._id,
          userId:     application.userId,
          status:     'not_started',
          startedAt:  new Date(),
          totalTasks: allTasks.length,
          taskProgress: allTasks.map(task => ({ taskId: task._id, isCompleted: false }))
        });
        await Quest.findByIdAndUpdate(quest._id, { $inc: { totalParticipants: 1 } });
      }

      // Notify the user they've been approved
      notify(application.userId, {
        type:    'system',
        title:   `You're approved for ${quest.title}!`,
        message: `Your application to join "${quest.title}" has been approved. Head to Quests to start completing tasks and earning XP.`,
        link:    '/dashboard/quests'
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[approve quest-application]', err);
    res.json({ success: false, message: err.message });
  }
});

router.post('/quest-applications/:id/reject', isAdminPage, async (req, res) => {
  try {
    const application = await QuestApplication.findById(req.params.id);
    if (!application) return res.json({ success: false, message: 'Not found' });

    application.status          = 'rejected';
    application.rejectionReason = (req.body.reason || '').trim();
    application.reviewedAt      = new Date();
    application.reviewedBy      = req.user._id;
    await application.save();

    res.json({ success: true });
  } catch (err) {
    console.error('[reject quest-application]', err);
    res.json({ success: false, message: err.message });
  }
});

router.get('/quest-applications/:questId/leaderboard', isAdminPage, async (req, res) => {
  res.redirect('/admin/quests');
});

// ── Shared image upload → base64 (works on any host, no disk dependency) ──────
const multer = require('multer');
const _memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});

// Generic upload — returns base64 data URL, stores nothing on disk
router.post('/upload-image', isAdminPage, (req, res, next) => {
  _memUpload.single('image')(req, res, (err) => {
    if (err) return res.json({ success: false, message: err.message });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No file' });
  const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  res.json({ success: true, url: b64 });
});

// Upload logo for a quest (base64, stored in Quest.image)
router.post('/quests/:questId/upload-logo', isAdminPage, (req, res, next) => {
  _memUpload.single('logo')(req, res, (err) => {
    if (err) return res.json({ success: false, message: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const Quest = require('../models/Quest');
    if (!req.file) return res.json({ success: false, message: 'No file uploaded' });
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await Quest.findByIdAndUpdate(req.params.questId, { image: b64 });
    res.json({ success: true, image: b64 });
  } catch (err) {
    console.error('[upload-logo]', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Admin Support Chat ────────────────────────────────────────────────────────
const ChatConversation = require('../models/ChatConversation');

router.get('/support', isAdminPage, requireSection('support'), async (req, res) => {
  try {
    const conversations = await ChatConversation.find()
      .sort({ lastMessageAt: -1 })
      .populate('userId', 'username profilePicture')
      .lean();
    res.render('admin/pages/support', { conversations, user: req.user, page: 'support' });
  } catch (err) {
    console.error('[admin support]', err);
    res.redirect('/admin');
  }
});

router.post('/support/:id/reply', isAdminPage, requireSection('support'), async (req, res) => {
  try {
    const User = require('../models/User');
    const admin = await User.findById(req.session.userId).select('username').lean();
    const text = (req.body.message || '').trim().slice(0, 500);
    if (!text) return res.json({ success: false, message: 'Empty message' });
    const convo = await ChatConversation.findById(req.params.id);
    if (!convo) return res.json({ success: false, message: 'Not found' });
    convo.messages.push({ role: 'admin', content: text, adminName: admin ? admin.username : 'Admin' });
    convo.lastMessageAt = new Date();
    await convo.save();
    res.json({ success: true, adminName: admin ? admin.username : 'Admin' });
  } catch (err) {
    res.json({ success: false, message: 'Server error' });
  }
});

router.post('/support/:id/mark-read', isAdminPage, requireSection('support'), async (req, res) => {
  try {
    await ChatConversation.findByIdAndUpdate(req.params.id, { unreadByAdmin: 0 });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

router.post('/support/:id/resolve', isAdminPage, requireSection('support'), async (req, res) => {
  try {
    await ChatConversation.findByIdAndUpdate(req.params.id, { status: 'resolved' });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ── Stacks Wallets ─────────────────────────────────────────────────────────────
const stacksWallet = require('../utils/stacksWallet');

// Background refresh job state — persists across requests until server restarts
let _refreshJob = { running: false, total: 0, done: 0, updated: 0, failed: 0, startedAt: null, finishedAt: null, wallets: [], errors: [], stxPrice: 0 };

async function runRefreshJob() {
  const User = require('../models/User');
  try {
    const users = await User.find({ stacksWalletIndex: { $ne: null } })
      .sort({ stacksBalance: -1 })
      .select('stacksWalletIndex stacksAddress')
      .lean();
    _refreshJob.total    = users.length;
    _refreshJob.stxPrice = await stacksWallet.getSTXPrice();

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      if (!u.stacksAddress) {
        _refreshJob.failed++;
        _refreshJob.errors.push({ id: u._id.toString(), address: '' });
        _refreshJob.done = i + 1;
        continue;
      }
      const checkedAt = new Date();
      const [microSTX, usdcxBalance] = await Promise.all([
        stacksWallet.getBalance(u.stacksAddress, 1),
        stacksWallet.getUSDCxBalance(u.stacksAddress),
      ]);
      if (microSTX < 0) {
        _refreshJob.failed++;
        _refreshJob.errors.push({ id: u._id.toString(), address: u.stacksAddress });
        console.error(`[refresh-job] FAILED (${i+1}/${users.length}): ${u.stacksAddress}`);
      } else {
        const usd = Math.round((microSTX / 1_000_000) * _refreshJob.stxPrice * 100) / 100;
        await User.findByIdAndUpdate(u._id, { stacksBalance: microSTX, stacksBalanceUSD: usd, usdcxBalance: Number(usdcxBalance), stacksCheckedAt: checkedAt });
        _refreshJob.updated++;
        _refreshJob.wallets.push({ id: u._id.toString(), microSTX, stx: microSTX / 1_000_000, usd, usdcxBalance, checkedAt });
        console.log(`[refresh-job] OK (${i+1}/${users.length}): ${u.stacksAddress.slice(0,12)}... = ${(microSTX/1e6).toFixed(4)} STX`);
      }
      _refreshJob.done = i + 1;
      // 8-second gap between wallets → ~7.5 req/min, safely under Hiro's 10 req/min free limit
      if (i < users.length - 1) await new Promise(r => setTimeout(r, 8000));
    }
  } catch (err) {
    console.error('[refresh-job] Fatal:', err.message);
  } finally {
    _refreshJob.running    = false;
    _refreshJob.finishedAt = new Date();
    console.log(`[refresh-job] Done: ${_refreshJob.updated}/${_refreshJob.total} updated, ${_refreshJob.failed} failed`);
  }
}


router.get('/stacks-wallets', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.status(403).send('Forbidden');
  try {
    const User = require('../models/User');
    const users = await User.find({ stacksWalletIndex: { $ne: null } })
      .sort({ stacksBalance: -1 })
      .select('username email stacksWalletIndex stacksAddress stacksBalance stacksBalanceUSD usdcxBalance stacksCheckedAt usdcBalance')
      .lean();

    const stxPrice  = await stacksWallet.getSTXPrice();
    let feeWallet   = null;
    try { feeWallet = await stacksWallet.getFeeWalletInfo(); } catch (_) {}
    res.render('admin/pages/stacks-wallets', {
      user: req.user, users, stxPrice, feeWallet, page: 'stacks-wallets',
      hasSeed:       !!process.env.STACKS_MASTER_SEED,
      hasMainWallet: !!process.env.STACKS_MAIN_WALLET
    });
  } catch (err) {
    console.error('[stacks-wallets]', err);
    res.status(500).send('Error: ' + err.message);
  }
});

// GET refresh status — frontend polls this while job runs
router.get('/stacks-wallets/refresh-status', isAdminPage, (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  res.json({ success: true, ..._refreshJob });
});

// Refresh balance — single wallet (sync) or all wallets (background job)
router.post('/stacks-wallets/refresh', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    const User = require('../models/User');
    const { userId } = req.body;

    // ── Single wallet: synchronous, returns result immediately ──
    if (userId) {
      const user = await User.findById(userId).select('stacksAddress').lean();
      if (!user?.stacksAddress) return res.json({ success: false, message: 'Wallet not found' });
      const stxPrice = await stacksWallet.getSTXPrice();
      const [microSTX, usdcxBalance] = await Promise.all([
        stacksWallet.getBalance(user.stacksAddress, 2),
        stacksWallet.getUSDCxBalance(user.stacksAddress),
      ]);
      if (microSTX < 0) return res.json({ success: false, message: 'Hiro API failed — try again shortly' });
      const usd = Math.round((microSTX / 1_000_000) * stxPrice * 100) / 100;
      const checkedAt = new Date();
      await User.findByIdAndUpdate(userId, { stacksBalance: microSTX, stacksBalanceUSD: usd, usdcxBalance: Number(usdcxBalance), stacksCheckedAt: checkedAt });
      return res.json({ success: true, wallets: [{ id: userId, microSTX, stx: microSTX / 1_000_000, usd, usdcxBalance, checkedAt }], stxPrice });
    }

    // ── Bulk: start background job, return immediately ──
    if (_refreshJob.running) {
      return res.json({ success: true, alreadyRunning: true });
    }
    _refreshJob = { running: true, total: 0, done: 0, updated: 0, failed: 0, startedAt: new Date(), finishedAt: null, wallets: [], errors: [], stxPrice: 0 };
    runRefreshJob().catch(e => console.error('[refresh-job] Uncaught:', e.message));
    res.json({ success: true, started: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Sweep one user's wallet to main wallet
router.post('/stacks-wallets/sweep/:userId', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    const result = await stacksWallet.sweepWallet(req.params.userId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Bulk Mail ──────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');
const BulkMailJob = require('../models/BulkMailJob');

const GMAIL_ACCOUNTS = [
  { name: 'onboard3a', email: 'kwarablockchain@gmail.com',  password: 'jiqv ihyj xwfr sfif' },
  { name: 'onboard3b', email: 'mrjerrytv9@gmail.com',        password: 'mhwf vkxm jezc gjhf' },
  { name: 'onboard3c', email: 'onboardweb3ng@gmail.com',     password: 'vabc cryg qjhm yauw' },
  { name: 'onboard3d', email: 'cryptomoo123@gmail.com',      password: 'oosu axcs xzcr bjpf' },
  { name: 'onboard3e', email: 'replyfing@gmail.com',         password: 'tmje fjvi axko nzjp' },
];
const DAILY_LIMIT = 450;
const BATCH_SIZE  = 3;
const _tp = {};

function getTP(acct) {
  if (!_tp[acct.email]) {
    _tp[acct.email] = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: acct.email, pass: acct.password }
    });
  }
  return _tp[acct.email];
}

function buildBackEmailHtml(username) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

  <tr><td style="padding-bottom:24px;text-align:center">
    <span style="font-size:22px;font-weight:900;color:#5EC213;letter-spacing:3px">ONBOARD3</span>
  </td></tr>

  <tr><td style="background:#111;border:1px solid rgba(94,194,19,.18);border-radius:18px;padding:40px 32px">

    <h1 style="margin:0 0 8px 0;color:#ffffff;font-size:26px;font-weight:900;line-height:1.25">
      ${username}, we are back.
    </h1>
    <p style="margin:0 0 24px 0;color:#5EC213;font-size:14px;font-weight:700">Bigger. Faster. Stronger.</p>

    <p style="margin:0 0 14px 0;color:#bbb;font-size:15px;line-height:1.75">
      It has been 4 months. We went quiet — but we were building something big. Now ONBOARD3 is back with a major upgrade and we are starting things off by giving something back to every member who stuck with us.
    </p>
    <p style="margin:0 0 28px 0;color:#bbb;font-size:15px;line-height:1.75">
      Your account is waiting. Your XP and progress are all still there.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
    <tr><td style="background:rgba(94,194,19,.07);border:1px solid rgba(94,194,19,.22);border-radius:12px;padding:24px">
      <p style="margin:0 0 4px 0;color:#5EC213;font-size:12px;font-weight:800;letter-spacing:.6px;text-transform:uppercase">Something waiting for you</p>
      <p style="margin:0 0 12px 0;color:#fff;font-size:22px;font-weight:900;line-height:1.2">A surprise on your dashboard — August 24</p>
      <p style="margin:0;color:#999;font-size:13px;line-height:1.6">Log in on August 24, complete your profile, and a special gift is already added to your account. No tasks. No forms. Just show up.</p>
    </td></tr>
    </table>

    <p style="margin:0 0 14px 0;color:#fff;font-size:15px;font-weight:800">How to get it:</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
      <tr><td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:28px;height:28px;min-width:28px;background:#5EC213;border-radius:50%;text-align:center;vertical-align:middle">
            <span style="color:#000;font-size:13px;font-weight:900;line-height:28px">1</span>
          </td>
          <td style="padding-left:12px;color:#bbb;font-size:14px;line-height:1.6">
            Visit <strong style="color:#fff">onboard3.app</strong> on August 24
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:28px;height:28px;min-width:28px;background:#5EC213;border-radius:50%;text-align:center;vertical-align:middle">
            <span style="color:#000;font-size:13px;font-weight:900;line-height:28px">2</span>
          </td>
          <td style="padding-left:12px;color:#bbb;font-size:14px;line-height:1.6">
            Log in and <strong style="color:#fff">complete your profile</strong>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 0">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="width:28px;height:28px;min-width:28px;background:#5EC213;border-radius:50%;text-align:center;vertical-align:middle">
            <span style="color:#000;font-size:13px;font-weight:900;line-height:28px">3</span>
          </td>
          <td style="padding-left:12px;color:#bbb;font-size:14px;line-height:1.6">
            Your gift is <strong style="color:#fff">already on your dashboard</strong> — automatically added
          </td>
        </tr></table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:24px">
      <a href="https://onboard3.app" style="display:inline-block;background:#5EC213;color:#000;font-weight:900;font-size:15px;padding:15px 36px;border-radius:10px;text-decoration:none">
        Go to ONBOARD3 on August 24
      </a>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
    <tr><td style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:18px 20px">
      <p style="margin:0 0 6px 0;color:#fff;font-size:13px;font-weight:800">Excited? Share it.</p>
      <p style="margin:0;color:#888;font-size:13px;line-height:1.6">
        Screenshot this email, post on X and tag <strong style="color:#fff">@onboard3___</strong> to let everyone know we are back.
      </p>
    </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:20px">
      <a href="https://x.com/onboard3___" style="color:#aaa;font-size:13px;font-weight:700;text-decoration:none">Follow on X</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="https://t.me/onboard_3" style="color:#229ED9;font-size:13px;font-weight:700;text-decoration:none">Join Telegram</a>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid rgba(255,255,255,.06);padding-top:16px">
      <p style="margin:0;color:#555;font-size:12px;text-align:center">August 24, 2026 &middot; ONBOARD3 Launch Day</p>
    </td></tr></table>

  </td></tr>

  <tr><td style="padding:20px 0 0 0;text-align:center">
    <p style="margin:0 0 4px 0;color:#444;font-size:12px">ONBOARD3 - Web3 Builder Hub &middot; Lagos, Nigeria</p>
    <p style="margin:0 0 4px 0;color:#333;font-size:11px">You signed up at onboard3.app &middot; <a href="mailto:onboardweb3ng@gmail.com?subject=unsubscribe" style="color:#333">Unsubscribe</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function buildBackEmailText(username) {
  return `${username}, we are back.

It has been 4 months. We went quiet but we were building something big. ONBOARD3 is back with a major upgrade and we are starting things off by giving something back to every member who stuck with us.

There is a surprise on your dashboard waiting for you on August 24.

HOW TO GET IT:
1. Visit onboard3.app on August 24
2. Log in and complete your profile
3. Your gift is already on your dashboard — no tasks, no forms, just show up

Go to ONBOARD3: https://onboard3.app

Excited? Screenshot this email, post on X and tag @onboard3___ to let everyone know we are back.

Follow on X: https://x.com/onboard3___
Join Telegram: https://t.me/onboard_3

August 24, 2026 - ONBOARD3 Launch Day
ONBOARD3 - Web3 Builder Hub - Lagos, Nigeria

You signed up at onboard3.app. To unsubscribe, reply with "unsubscribe" in the subject.`;
}

async function getOrCreateJob() {
  let job = await BulkMailJob.findOne();
  if (!job) {
    const User = require('../models/User');
    const total = await User.countDocuments({ isVerified: true, xp: { $gte: 1000 } });
    job = new BulkMailJob({
      totalRecipients: total,
      accountUsage: GMAIL_ACCOUNTS.map(a => ({ email: a.email, name: a.name, sentToday: 0, totalSent: 0, lastReset: new Date() }))
    });
    await job.save();
  }
  return job;
}

async function runTick(job) {
  const now = new Date();
  // Debounce — skip if a tick ran within last 2 seconds
  if (job.lastTickAt && (now - new Date(job.lastTickAt)) < 2000) return;
  job.lastTickAt = now;

  // Reset daily counters after 24h
  for (const u of job.accountUsage) {
    if ((now - new Date(u.lastReset)) >= 86400000) {
      u.sentToday = 0;
      u.lastReset = now;
    }
  }

  // Check if any account has capacity
  const hasCapacity = job.accountUsage.some(u => u.sentToday < DAILY_LIMIT);
  if (!hasCapacity) {
    await BulkMailJob.collection.updateOne({ _id: job._id }, { $set: { status: 'limit_reached', lastTickAt: now } });
    return;
  }

  // Get next batch
  const User = require('../models/User');
  const users = await User.find({ isVerified: true, xp: { $gte: 1000 } })
    .sort({ xp: -1, _id: 1 })
    .skip(job.currentIndex)
    .limit(BATCH_SIZE)
    .select('email username')
    .lean();

  if (!users.length) {
    await BulkMailJob.collection.updateOne({ _id: job._id }, { $set: { status: 'completed', completedAt: now, lastTickAt: now } });
    return;
  }

  // Round-robin starting account
  let acctPtr = job.sentCount % GMAIL_ACCOUNTS.length;

  for (const user of users) {
    // Find next available account
    let tries = 0;
    while (job.accountUsage[acctPtr].sentToday >= DAILY_LIMIT && tries < GMAIL_ACCOUNTS.length) {
      acctPtr = (acctPtr + 1) % GMAIL_ACCOUNTS.length;
      tries++;
    }
    if (tries === GMAIL_ACCOUNTS.length) break; // all maxed

    const usage = job.accountUsage[acctPtr];
    const acct  = GMAIL_ACCOUNTS.find(a => a.email === usage.email);

    try {
      await getTP(acct).sendMail({
        from: `Tope from ONBOARD3 <${acct.email}>`,
        replyTo: 'onboardweb3ng@gmail.com',
        to: user.email,
        subject: `${user.username}, ONBOARD3 is back`,
        html: buildBackEmailHtml(user.username),
        text: buildBackEmailText(user.username),
        headers: {
          'List-Unsubscribe': '<mailto:' + acct.email + '?subject=unsubscribe>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'Precedence': 'bulk'
        }
      });
      job.sentCount++;
      usage.sentToday++;
      usage.totalSent++;
      job.recentActivity.unshift({ email: user.email, username: user.username, status: 'sent', account: usage.name, timestamp: now });
    } catch (err) {
      job.failedCount++;
      job.recentActivity.unshift({ email: user.email, username: user.username, status: 'failed', account: usage.name, error: err.message.slice(0, 120), timestamp: now });
    }

    job.currentIndex++;
    acctPtr = (acctPtr + 1) % GMAIL_ACCOUNTS.length;
  }

  if (job.recentActivity.length > 120) job.recentActivity = job.recentActivity.slice(0, 120);
  await BulkMailJob.collection.updateOne({ _id: job._id }, { $set: {
    lastTickAt:    now,
    sentCount:     job.sentCount,
    failedCount:   job.failedCount,
    currentIndex:  job.currentIndex,
    status:        job.status,
    accountUsage:  job.accountUsage,
    recentActivity: job.recentActivity,
  }});
}

// GET /admin/bulkmail
router.get('/bulkmail', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.redirect('/admin');
  try {
    const job = await getOrCreateJob();
    res.render('admin/pages/bulkmail', { user: req.user, admin: req.user, page: 'bulkmail', job });
  } catch (err) {
    console.error('[bulkmail]', err);
    res.status(500).send('Error loading bulk mail page');
  }
});

// GET /admin/bulkmail/status (JSON)
router.get('/bulkmail/status', isAdminPage, async (req, res) => {
  try {
    const job = await BulkMailJob.findOne().lean();
    if (!job) return res.json({ status: 'idle', sentCount: 0, failedCount: 0, currentIndex: 0, totalRecipients: 0, recentActivity: [], accountUsage: [], comingSoonMode: true });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/bulkmail/start
router.post('/bulkmail/start', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    const job = await getOrCreateJob();
    if (job.status === 'completed') return res.json({ success: false, message: 'Job already completed. Reset to start again.' });
    job.status = 'running';
    if (!job.startedAt) job.startedAt = new Date();
    await job.save();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST /admin/bulkmail/pause
router.post('/bulkmail/pause', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    const job = await BulkMailJob.findOne();
    if (job) { job.status = 'paused'; await job.save(); }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST /admin/bulkmail/reset
router.post('/bulkmail/reset', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    await BulkMailJob.deleteMany();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST /admin/bulkmail/tick (called by frontend to process a batch)
router.post('/bulkmail/tick', isAdminPage, async (req, res) => {
  try {
    const job = await BulkMailJob.findOne();
    if (!job || job.status !== 'running') return res.json({ skipped: true });
    await runTick(job);
    res.json({ success: true, sentCount: job.sentCount, failedCount: job.failedCount, currentIndex: job.currentIndex, status: job.status });
  } catch (err) {
    console.error('[tick]', err);
    res.json({ success: false, error: err.message });
  }
});

// POST /admin/bulkmail/coming-soon
router.post('/bulkmail/coming-soon', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    const { enabled } = req.body;
    const job = await getOrCreateJob();
    job.comingSoonMode = !!enabled;
    await job.save();
    res.json({ success: true, comingSoonMode: job.comingSoonMode });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST /admin/bulkmail/test — send one test email
router.post('/bulkmail/test', isAdminPage, async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.json({ success: false });
  try {
    const { email, username } = req.body;
    if (!email) return res.json({ success: false, message: 'email required' });
    const acct = GMAIL_ACCOUNTS[0];
    await getTP(acct).sendMail({
      from: `Tope from ONBOARD3 <${acct.email}>`,
      replyTo: 'onboardweb3ng@gmail.com',
      to: email,
      subject: `${username || 'Friend'}, ONBOARD3 is back`,
      html: buildBackEmailHtml(username || 'Friend'),
      text: buildBackEmailText(username || 'Friend'),
      headers: {
        'List-Unsubscribe': '<mailto:onboardweb3ng@gmail.com?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Precedence': 'bulk'
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Full quest progress reset (keeps approvals, wipes XP + task progress) ───
router.post('/api/quest/reset-progress', isAdminPage, async (req, res) => {
  try {
    const Quest             = require('../models/Quest');
    const UserQuestProgress = require('../models/UserQuestProgress');
    const User              = require('../models/User');
    const { questId } = req.body;
    if (!questId) return res.json({ success: false, message: 'questId required' });

    const quest = await Quest.findById(questId);
    if (!quest) return res.json({ success: false, message: 'Quest not found' });

    // Zero out quest completion bonus so only per-task XP counts
    quest.baseXpReward = 0;
    if (quest.competitionConfig) {
      quest.competitionConfig.winnerBonusXP = 0;
      quest.markModified('competitionConfig');
    }
    await quest.save();

    // Get all progress records
    const records = await UserQuestProgress.find({ questId: quest._id });

    for (const rec of records) {
      const totalXpToRemove = rec.xpBreakdown?.totalXp || 0;
      // Deduct from global user XP
      if (totalXpToRemove > 0) {
        await User.findByIdAndUpdate(rec.userId, { $inc: { xp: -totalXpToRemove } });
      }
      // Reset progress — keep taskProgress array structure but clear completion state
      const resetTasks = (rec.taskProgress || []).map(tp => ({
        taskId:         tp.taskId,
        isCompleted:    false,
        xpEarned:       0,
        approvalStatus: undefined,
        submissionUrl:  undefined,
        submissionText: undefined,
        submissionData: undefined,
        completedAt:    undefined
      }));

      await UserQuestProgress.updateOne({ _id: rec._id }, {
        $set: {
          status:         'not_started',
          progress:       0,
          tasksCompleted: 0,
          completedAt:    null,
          taskProgress:   resetTasks,
          'xpBreakdown.taskXp':              0,
          'xpBreakdown.baseXp':              0,
          'xpBreakdown.totalXp':             0,
          'xpBreakdown.referralJoinBonus':    0,
          'xpBreakdown.referralCompleteBonus':0,
          'xpBreakdown.winnerBonus':          0,
          'xpBreakdown.adminAdjustmentXp':    0,
          isWinner:   false,
          winnerRank: null
        }
      });
    }

    res.json({ success: true, reset: records.length, message: `Reset ${records.length} participants to 0 XP. Quest completion bonus zeroed. Approvals untouched.` });
  } catch (err) {
    console.error('[reset-progress]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── Fix base XP being added on top of task XP ───────────────────────────────
// Zeros quest.baseXpReward and removes the extra baseXp from all progress records
router.post('/api/apex/fix-base-xp', isAdminPage, async (req, res) => {
  try {
    const Quest             = require('../models/Quest');
    const UserQuestProgress = require('../models/UserQuestProgress');
    const { questId } = req.body;
    const quest = questId ? await Quest.findById(questId) : await Quest.findOne({ slug: 'apex-raiders' });
    if (!quest) return res.json({ success: false, message: 'Quest not found' });

    const oldBase = quest.baseXpReward || 0;
    quest.baseXpReward = 0;
    await quest.save();

    if (oldBase === 0) return res.json({ success: true, fixed: 0, message: 'baseXpReward was already 0 — nothing to fix' });

    // Find all progress records that have baseXp > 0
    const records = await UserQuestProgress.find({ questId: quest._id, 'xpBreakdown.baseXp': { $gt: 0 } });
    for (const rec of records) {
      const base = rec.xpBreakdown.baseXp || 0;
      await User.findByIdAndUpdate(rec.userId, { $inc: { xp: -base } });
      await UserQuestProgress.updateOne(
        { _id: rec._id },
        { $set: {
          'xpBreakdown.baseXp':  0,
          'xpBreakdown.totalXp': Math.max(0,
            (rec.xpBreakdown.taskXp || 0) +
            (rec.xpBreakdown.referralJoinBonus || 0) +
            (rec.xpBreakdown.referralCompleteBonus || 0) +
            (rec.xpBreakdown.winnerBonus || 0) +
            (rec.xpBreakdown.adminAdjustmentXp || 0)
          )
        }}
      );
    }
    res.json({ success: true, fixed: records.length, message: `Removed ${oldBase} base XP from ${records.length} users and set baseXpReward to 0` });
  } catch (err) {
    console.error('[fix-base-xp]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── Strip winner bonus from a competition quest ──────────────────────────────
router.post('/api/apex/fix-winner-bonus', isAdminPage, async (req, res) => {
  try {
    const Quest             = require('../models/Quest');
    const UserQuestProgress = require('../models/UserQuestProgress');
    const { questId } = req.body;
    const quest = questId
      ? await Quest.findById(questId)
      : await Quest.findOne({ slug: 'apex-raiders' });
    if (!quest) return res.json({ success: false, message: 'Quest not found' });

    quest.competitionConfig.winnerBonusXP = 0;
    quest.markModified('competitionConfig');
    await quest.save();

    const records = await UserQuestProgress.find({ questId: quest._id, 'xpBreakdown.winnerBonus': { $gt: 0 } });
    for (const rec of records) {
      const bonus = rec.xpBreakdown.winnerBonus || 0;
      await User.findByIdAndUpdate(rec.userId, { $inc: { xp: -bonus } });
      rec.xpBreakdown.winnerBonus = 0;
      rec.xpBreakdown.totalXp =
        (rec.xpBreakdown.taskXp || 0) + (rec.xpBreakdown.baseXp || 0) +
        (rec.xpBreakdown.referralJoinBonus || 0) + (rec.xpBreakdown.referralCompleteBonus || 0) +
        (rec.xpBreakdown.adminAdjustmentXp || 0);
      rec.isWinner = false; rec.winnerRank = null;
      rec.markModified('xpBreakdown');
      await rec.save();
    }
    res.json({ success: true, fixed: records.length, message: `Removed winner bonus from ${records.length} users` });
  } catch (err) {
    console.error('[fix-winner-bonus]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── Add Discord daily task to a quest (one-time setup) ──────────────────────
router.post('/api/apex/add-discord-task', isAdminPage, async (req, res) => {
  try {
    const Quest = require('../models/Quest');
    const { discordLink, taskTitle, questId } = req.body;
    const quest = questId
      ? await Quest.findById(questId)
      : await Quest.findOne({ slug: 'apex-raiders' });
    if (!quest) return res.json({ success: false, message: 'Quest not found' });

    const title = (taskTitle || 'Join Discord Community').trim();
    const link  = (discordLink || 'https://discord.gg/onboard3').trim();

    const alreadyExists = (quest.dailyTasks || []).some(t => t.title === title);
    if (alreadyExists) return res.json({ success: false, message: 'Discord daily task already exists' });

    quest.dailyTasks = quest.dailyTasks || [];
    quest.dailyTasks.push({
      title, description: 'Join the community Discord server and engage daily.',
      taskType: 'external', xpReward: 50, isDaily: true,
      buttonText: 'Join Discord', buttonLink: link, inputType: 'none', order: 0
    });
    quest.markModified('dailyTasks');
    await quest.save();
    res.json({ success: true, message: 'Discord daily task added to Apex Raiders' });
  } catch (err) {
    console.error('[add-discord-task]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── ONE-TIME: retroactively fix XP for users whose taskXp was under-counted ──
router.post('/fix-all-quest-xp', isAdmin, async (req, res) => {
  try {
    const UserQuestProgress = require('../models/UserQuestProgress');
    const User = require('../models/User');
    const all = await UserQuestProgress.find({});
    const results = [];
    let fixed = 0;

    for (const prog of all) {
      const actualTaskXp = prog.taskProgress
        .filter(t => t.isCompleted)
        .reduce((s, t) => s + (t.xpEarned || 0), 0);

      const storedTaskXp = prog.xpBreakdown?.taskXp || 0;
      const diff = actualTaskXp - storedTaskXp;
      if (diff === 0) continue;

      const user = await User.findById(prog.userId);
      if (!user) continue;

      results.push({ username: user.username, questId: prog.questId, diff });

      prog.xpBreakdown.taskXp = actualTaskXp;
      prog.xpBreakdown.totalXp =
        actualTaskXp +
        (prog.xpBreakdown.baseXp || 0) +
        (prog.xpBreakdown.referralJoinBonus || 0) +
        (prog.xpBreakdown.referralCompleteBonus || 0) +
        (prog.xpBreakdown.winnerBonus || 0) +
        (prog.xpBreakdown.adminAdjustmentXp || 0);
      prog.markModified('xpBreakdown');
      await prog.save();

      user.xp += diff;
      await user.save();
      fixed++;
    }

    res.json({ success: true, fixed, results });
  } catch (err) {
    console.error('[fix-all-quest-xp]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── Pathway Content Management ────────────────────────────────────────────────
const PathwayContent = require('../models/PathwayContent');
const PathwayConfigModel = require('../models/PathwayConfig');

const PW_META_ADMIN = {
    web3_jobs: { name:'Web3 Jobs',             icon:'fa-briefcase',  color:'#fbbf24' },
    ai:        { name:'AI & Web3',             icon:'fa-microchip',  color:'#c084fc' }
};
const ADMIN_PATHWAYS = ['web3_jobs','ai'];

router.get('/pathway-content', isAdminPage, async (req, res) => {
    try {
        const User = require('../models/User');
        const pw = ADMIN_PATHWAYS.includes(req.query.pathway) ? req.query.pathway : 'web3_jobs';
        const [config, content] = await Promise.all([
            PathwayConfigModel.findOne({ pathway: pw }).lean(),
            PathwayContent.find({ pathway: pw }).sort({ isPinned:-1, isLive:-1, createdAt:-1 }).lean()
        ]);
        // Populate all leads
        const leads = [];
        if (config?.leads?.length) {
            const leadUsers = await User.find({ _id: { $in: config.leads.map(l => l.userId) } }).select('username profilePicture').lean();
            const userMap = {}; leadUsers.forEach(u => { userMap[u._id.toString()] = u; });
            config.leads.forEach(l => {
                const u = userMap[l.userId?.toString()];
                if (u) leads.push({ ...l, user: u });
            });
        }
        // Legacy single lead fallback
        let lead = leads[0]?.user || null;
        if (!lead && config?.leadUserId) lead = await User.findById(config.leadUserId).select('username profilePicture').lean();
        res.render('admin/pages/pathway-content', {
            user: req.user, admin: req.user,
            pathway: pw, PATHWAYS: ADMIN_PATHWAYS, PW_META: PW_META_ADMIN,
            config: config||{}, content, lead, leads, page: 'pathway-content'
        });
    } catch (err) { console.error('[admin pathway-content]', err); res.status(500).send('Error'); }
});

router.post('/pathway-content/save-config', isAdminPage, async (req, res) => {
    try {
        const { pathway, tagline, leadUsername, leadName, leadBio } = req.body;
        if (!ADMIN_PATHWAYS.includes(pathway)) return res.json({ success: false, message: 'Invalid pathway' });
        let leadUserId = undefined;
        if (leadUsername && leadUsername.trim()) {
            const u = await User.findOne({ username: leadUsername.trim() }).select('_id').lean();
            if (!u) return res.json({ success: false, message: `User "${leadUsername.trim()}" not found` });
            leadUserId = u._id;
        }
        const upd = { tagline: tagline||'', leadName: leadName||'', leadBio: leadBio||'', updatedAt: new Date() };
        if (leadUserId !== undefined) upd.leadUserId = leadUserId;
        await PathwayConfigModel.findOneAndUpdate({ pathway }, { $set: upd }, { upsert: true });
        res.json({ success: true });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/pathway-content/create', isAdminPage, async (req, res) => {
    try {
        const { pathway, section, title, body, scheduledAt, endsAt, isLive, venue, resourceUrl, resourceType, resourceFilename, opportunityType, externalUrl, isPinned } = req.body;
        if (!ADMIN_PATHWAYS.includes(pathway) || !['update','class','resource','opportunity','event'].includes(section) || !title?.trim())
            return res.json({ success: false, message: 'Invalid fields.' });
        const item = await PathwayContent.create({
            pathway, section, title: title.trim(), body: body||'',
            scheduledAt: scheduledAt||null, endsAt: endsAt||null,
            isLive: isLive==='true'||isLive===true,
            venue: venue||null,
            resourceUrl: resourceUrl||null, resourceType: resourceType||null, resourceFilename: resourceFilename||null,
            opportunityType: opportunityType||null, externalUrl: externalUrl||null,
            isPinned: isPinned==='true'||isPinned===true, isPublished: true, createdBy: req.user._id
        });
        res.json({ success: true, item });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/pathway-content/:id/update', isAdminPage, async (req, res) => {
    try {
        const { title, body, scheduledAt, endsAt, isLive, venue, resourceUrl, resourceType, resourceFilename, opportunityType, externalUrl, isPinned, isPublished } = req.body;
        const item = await PathwayContent.findByIdAndUpdate(req.params.id, { $set: {
            title: title?.trim()||'', body: body||'',
            scheduledAt: scheduledAt||null, endsAt: endsAt||null,
            isLive: isLive==='true'||isLive===true,
            venue: venue||null,
            resourceUrl: resourceUrl||null, resourceType: resourceType||null, resourceFilename: resourceFilename||null,
            opportunityType: opportunityType||null, externalUrl: externalUrl||null,
            isPinned: isPinned==='true'||isPinned===true,
            isPublished: isPublished!=='false'&&isPublished!==false
        }}, { new: true });
        if (!item) return res.json({ success: false });
        res.json({ success: true, item });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/pathway-content/:id/toggle-live', isAdminPage, async (req, res) => {
    try {
        const item = await PathwayContent.findById(req.params.id);
        if (!item) return res.json({ success: false });
        item.isLive = !item.isLive;
        await item.save();
        res.json({ success: true, isLive: item.isLive });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/pathway-content/:id/toggle-publish', isAdminPage, async (req, res) => {
    try {
        const item = await PathwayContent.findById(req.params.id);
        if (!item) return res.json({ success: false });
        item.isPublished = !item.isPublished;
        await item.save();
        res.json({ success: true, isPublished: item.isPublished });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

router.post('/pathway-content/:id/delete', isAdminPage, async (req, res) => {
    try {
        await PathwayContent.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// ── Pathway Leads management ──────────────────────────────────────────────────

// Search existing users for lead assignment
router.get('/pathway-content/lead-search', isAdminPage, async (req, res) => {
    try {
        const User = require('../models/User');
        const q = (req.query.q || '').trim();
        if (!q) return res.json({ users: [] });
        const users = await User.find({
            $or: [
                { username: { $regex: q, $options: 'i' } },
                { email:    { $regex: q, $options: 'i' } }
            ]
        }).select('username email profilePicture').limit(8).lean();
        res.json({ users });
    } catch (err) { res.json({ users: [] }); }
});

// Assign a user as pathway lead
router.post('/pathway-content/leads/assign', isAdminPage, async (req, res) => {
    try {
        const User = require('../models/User');
        const { pathway, userId, displayName, bio } = req.body;
        if (!ADMIN_PATHWAYS.includes(pathway)) return res.json({ success: false, message: 'Invalid pathway' });
        const u = await User.findById(userId).select('username').lean();
        if (!u) return res.json({ success: false, message: 'User not found' });

        // Prevent duplicates
        const existing = await PathwayConfigModel.findOne({ pathway, 'leads.userId': userId }).lean();
        if (existing) return res.json({ success: false, message: 'User is already a lead for this pathway' });

        await PathwayConfigModel.findOneAndUpdate(
            { pathway },
            { $push: { leads: { userId, displayName: displayName || u.username, bio: bio || '', assignedAt: new Date() } } },
            { upsert: true, new: true }
        );

        // Mark on User model
        await User.findByIdAndUpdate(userId, { $addToSet: { pathwayLeadOf: pathway } });

        res.json({ success: true, username: u.username });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Remove a pathway lead
router.post('/pathway-content/leads/remove', isAdminPage, async (req, res) => {
    try {
        const User = require('../models/User');
        const { pathway, userId } = req.body;
        if (!ADMIN_PATHWAYS.includes(pathway)) return res.json({ success: false, message: 'Invalid pathway' });

        await PathwayConfigModel.findOneAndUpdate(
            { pathway },
            { $pull: { leads: { userId: mongoose.Types.ObjectId.createFromHexString(userId) } } }
        );

        await User.findByIdAndUpdate(userId, { $pull: { pathwayLeadOf: pathway } });

        res.json({ success: true });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════
// ACADEMY ADMIN ROUTES
// ═══════════════════════════════════════════════════════
const academy = require('../controllers/academyController');

router.get('/academy/cohorts',                   isAdmin, academy.adminListCohorts);
router.get('/academy/cohorts/new',               isAdmin, academy.adminCohortForm);
router.post('/academy/cohorts/new',              isAdmin, academy.adminSaveCohort);
router.get('/academy/cohorts/:id/edit',          isAdmin, academy.adminCohortForm);
router.post('/academy/cohorts/:id/edit',         isAdmin, academy.adminSaveCohort);
router.post('/academy/cohorts/:id/delete',       isAdmin, academy.adminDeleteCohort);

router.get('/academy/applications',              isAdmin, academy.adminListApplications);
router.post('/academy/applications/:id/review',  isAdmin, academy.adminReviewApplication);

router.get('/academy/cohorts/:id/students',      isAdmin, academy.adminStudents);
router.post('/academy/students/:id/attendance',  isAdmin, academy.adminUpdateAttendance);
router.post('/academy/students/:id/graduate',    isAdmin, academy.adminGraduate);

module.exports = router;
