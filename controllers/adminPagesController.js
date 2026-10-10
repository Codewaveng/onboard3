// Admin multi-page controller — server-side rendered pages
const User              = require('../models/User');
const Quest             = require('../models/Quest');
const Event             = require('../models/Event');
const Transaction       = require('../models/Transaction');
const CourseApplication = require('../models/CourseApplication');
const PathwayConfig     = require('../models/PathwayConfig');
const UserQuestProgress = require('../models/UserQuestProgress');
const { syncQuestProgressForQuest } = require('../utils/questProgressSync');

const isAdmin = (req, res) => {
    if (!req.session.userId) { res.redirect('/auth'); return false; }
    return true;
};

// ── GET /admin ── Overview ────────────────────────────────────────────────────
exports.overview = async (req, res) => {
    try {
        const [
            totalUsers, verifiedUsers, activeQuests, upcomingEvents,
            pendingApps, pendingWithdrawalAgg, totalXpAgg, totalUsdcAgg,
            recentUsers, topQuests, pendingWithdrawalList
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ isVerified: true }),
            Quest.countDocuments({ isActive: true }),
            Event.countDocuments({ isActive: true, startDate: { $gte: new Date() } }),
            CourseApplication.countDocuments({ status: 'pending' }).catch(() => 0),
            Transaction.aggregate([{ $match:{ type:'withdrawal', status:'pending' } }, { $group:{ _id:null, total:{ $sum:'$amount' } } }]).catch(()=>[]),
            User.aggregate([{ $group:{ _id:null, total:{ $sum:'$xp' } } }]).catch(()=>[]),
            Transaction.aggregate([{ $match:{ type:{ $in:['quest_reward','referral_bonus'] }, status:'completed' } }, { $group:{ _id:null, total:{ $sum:'$amount' } } }]).catch(()=>[]),
            User.find().sort({ createdAt:-1 }).limit(6).select('username email xp createdAt profilePicture').lean(),
            Quest.find().sort({ totalParticipants:-1 }).limit(5).select('title isActive totalParticipants totalCompletions').lean(),
            Transaction.find({ type:'withdrawal', status:'pending' }).populate('userId','username walletAddress').sort({ createdAt:1 }).limit(10).lean().catch(()=>[])
        ]);

        res.render('admin/pages/overview', { admin: req.user,
            user: req.user,
            stats: {
                totalUsers, verifiedUsers, activeQuests, upcomingEvents,
                pendingApplications: pendingApps,
                pendingWithdrawals:  pendingWithdrawalAgg[0]?.total || 0,
                totalXpDistributed:  totalXpAgg[0]?.total || 0,
                totalUsdcDistributed: totalUsdcAgg[0]?.total || 0
            },
            recentUsers,
            questStats: topQuests,
            pendingWithdrawalList
        });
    } catch (err) {
        console.error('[Admin Overview]', err);
        res.status(500).send('Error loading overview');
    }
};

// ── GET /admin/users ──────────────────────────────────────────────────────────
exports.usersPage = async (req, res) => {
    try {
        const { q = '', status = '', page = 1 } = req.query;
        const limit = 50;
        let query = {};
        if (q) query.$or = [{ username:{ $regex:q, $options:'i' } }, { email:{ $regex:q, $options:'i' } }];
        if (status === 'verified')   query.isVerified = true;
        if (status === 'unverified') query.isVerified = false;

        const [users, total] = await Promise.all([
            User.find(query).select('username email xp usdcBalance isVerified isAdmin isBanned createdAt profilePicture').sort({ createdAt:-1 }).limit(limit).skip((+page-1)*limit).lean(),
            User.countDocuments(query)
        ]);

        res.render('admin/pages/users', { admin: req.user,
            user: req.user, users, total,
            search: q, statusFilter: status,
            currentPage: +page, totalPages: Math.ceil(total/limit)
        });
    } catch (err) {
        console.error('[Admin Users]', err);
        res.status(500).send('Error loading users');
    }
};

// ── GET /admin/quests ─────────────────────────────────────────────────────────
exports.questsPage = async (req, res) => {
    try {
        const quests = await Quest.find()
        .select('title shortDescription description category difficulty isActive baseXpReward usdcReward rewardPlan questType referralConfig competitionConfig totalParticipants totalCompletions startDate endDate createdAt image tasks approvalStatus approvalNote sponsoredBy')
            .populate('sponsoredBy', 'name username')
            .sort({ createdAt:-1 }).lean();
        res.render('admin/pages/quests', { admin: req.user, user: req.user, quests });
    } catch (err) {
        console.error('[Admin Quests]', err);
        res.status(500).send('Error loading quests');
    }
};

// ── GET /admin/events ─────────────────────────────────────────────────────────
exports.eventsPage = async (req, res) => {
    try {
        const items = await Event.find().sort({ startDate:-1 }).lean();
        res.render('admin/pages/events', { admin: req.user, user: req.user, items });
    } catch (err) {
        console.error('[Admin Events]', err);
        res.status(500).send('Error loading events');
    }
};

// ── GET /admin/withdrawals ────────────────────────────────────────────────────
exports.withdrawalsPage = async (req, res) => {
    try {
        const PlatformSettings = require('../models/PlatformSettings');
        const { status = 'pending' } = req.query;
        const query = status !== 'all' ? { type:'withdrawal', status } : { type:'withdrawal' };
        const [withdrawals, pendingAgg, completedCount, allAgg, settings] = await Promise.all([
            Transaction.find(query).populate('user','username walletAddress').sort({ createdAt:-1 }).limit(100).lean(),
            Transaction.aggregate([{ $match:{ type:'withdrawal', status:'pending' } }, { $group:{ _id:null, total:{ $sum:'$amount' } } }]),
            Transaction.countDocuments({ type:'withdrawal', status:'completed' }),
            Transaction.aggregate([{ $match:{ type:'withdrawal', status:'completed' } }, { $group:{ _id:null, total:{ $sum:'$amount' } } }]),
            PlatformSettings.get()
        ]);
        res.render('admin/pages/withdrawals', { admin: req.user,
            user: req.user, withdrawals, statusFilter: status, platformSettings: settings,
            stats: {
                pending: await Transaction.countDocuments({ type:'withdrawal', status:'pending' }),
                completed: completedCount,
                pendingAmount: pendingAgg[0]?.total || 0,
                totalPaid: allAgg[0]?.total || 0
            }
        });
    } catch (err) {
        console.error('[Admin Withdrawals]', err);
        res.status(500).send('Error loading withdrawals');
    }
};

// ── GET /admin/applications ───────────────────────────────────────────────────
exports.applicationsPage = async (req, res) => {
    try {
        const items = await CourseApplication.find().sort({ createdAt:-1 }).lean().catch(()=>[]);
        res.render('admin/pages/applications', { admin: req.user, user: req.user, items });
    } catch (err) {
        res.status(500).send('Error loading applications');
    }
};

// ── GET /admin/ambassadors ────────────────────────────────────────────────────
exports.ambassadorsPage = async (req, res) => {
    try {
        const CampusAmbassador = require('../models/CampusAmbassador');
        const items = await CampusAmbassador.find().populate('userId','username').sort({ createdAt:-1 }).lean().catch(()=>[]);
        res.render('admin/pages/ambassadors', { admin: req.user, user: req.user, items });
    } catch (err) {
        res.status(500).send('Error loading ambassadors');
    }
};

// ── GET /admin/projects ───────────────────────────────────────────────────────
exports.projectsPage = async (req, res) => {
    try {
        const Project = require('../models/Project').catch ? null : require('../models/Project');
        const items = Project ? await Project.find().populate('userId','username').sort({ createdAt:-1 }).lean().catch(()=>[]) : [];
        res.render('admin/pages/projects', { admin: req.user, user: req.user, items });
    } catch (err) {
        res.render('admin/pages/projects', { admin: req.user, user: req.user, items: [] });
    }
};

// ── GET /admin/banned ─────────────────────────────────────────────────────────
exports.bannedPage = async (req, res) => {
    try {
        const items = await User.find({ isBanned: true }).select('username email banReason bannedAt').sort({ bannedAt:-1 }).lean();
        res.render('admin/pages/banned', { admin: req.user, user: req.user, items });
    } catch (err) {
        res.status(500).send('Error loading banned users');
    }
};

// ── GET /admin/settings ───────────────────────────────────────────────────────
exports.settingsPage = async (req, res) => {
    try {
        const SiteSettings = require('../models/SiteSettings');
        const [pathwayConfigs, settingsDoc, siteSettings, totalUsers, totalXpAgg, totalUsdcAgg, totalQuests, totalEvents] = await Promise.all([
            PathwayConfig.find().lean(),
            require('../models/Settings').findOne().lean().catch(()=>null),
            SiteSettings.getSettings(),
            User.countDocuments(),
            User.aggregate([{ $group:{ _id:null, total:{ $sum:'$xp' } } }]).catch(()=>[]),
            Transaction.aggregate([{ $match:{ type:{ $in:['quest_reward','referral_bonus'] }, status:'completed' } }, { $group:{ _id:null, total:{ $sum:'$amount' } } }]).catch(()=>[]),
            Quest.countDocuments(),
            Event.countDocuments()
        ]);

        res.render('admin/pages/settings', { admin: req.user,
            user: req.user,
            pathwayConfigs,
            settings: settingsDoc || { twitterRequired: false },
            pathwayApprovalMode: siteSettings.pathwayApprovalMode || 'auto',
            platformStats: {
                'Total Users':    totalUsers,
                'Total Quests':   totalQuests,
                'Total Events':   totalEvents,
                'XP Distributed': ((totalXpAgg[0]?.total||0)/1000).toFixed(1)+'k',
                'USDC Paid Out':  '$'+(totalUsdcAgg[0]?.total||0).toFixed(2)
            }
        });
    } catch (err) {
        console.error('[Admin Settings]', err);
        res.status(500).send('Error loading settings');
    }
};

// ── POST /admin/settings/pathways ─────────────────────────────────────────────
exports.savePathways = async (req, res) => {
    try {
        const pathways = ['web3_jobs','ai'];
        for (const pw of pathways) {
            const groupLink = req.body[pw+'_groupLink'] || null;
            const xLink     = req.body[pw+'_xLink'] || null;
            await PathwayConfig.findOneAndUpdate({ pathway:pw }, { pathway:pw, groupLink, xLink }, { upsert:true });
        }
        res.redirect('/admin/settings?saved=1');
    } catch (err) {
        res.redirect('/admin/settings?error=1');
    }
};

exports.savePathwayApprovalMode = async (req, res) => {
    try {
        const { pathwayApprovalMode } = req.body;
        if (!['auto', 'manual'].includes(pathwayApprovalMode))
            return res.redirect('/admin/settings?error=1');
        const SiteSettings = require('../models/SiteSettings');
        const config = await SiteSettings.getSettings();
        config.pathwayApprovalMode = pathwayApprovalMode;
        await config.save();
        res.redirect('/admin/settings?saved=1');
    } catch (err) {
        console.error('[savePathwayApprovalMode]', err);
        res.redirect('/admin/settings?error=1');
    }
};

// ── GET /admin/pathway-applications ──────────────────────────────────────────
exports.pathwayApplicationsPage = async (req, res) => {
    try {
        const { filter = 'pending' } = req.query;
        const query = { pathway: { $ne: null } };
        if (filter !== 'all') query.pathwayStatus = filter;
        const applications = await User.find(query)
            .select('username email xp pathway pathwayStatus pathwayApplication createdAt')
            .sort({ 'pathwayApplication.appliedAt': -1 })
            .limit(200)
            .lean();
        res.render('admin/pages/pathway-applications', { user: req.user, admin: req.user, applications, filter });
    } catch (err) {
        console.error('[Pathway Applications]', err);
        res.status(500).send('Error loading pathway applications');
    }
};

// ── POST /admin/pathway-applications/:id/approve ──────────────────────────────
exports.approvePathwayApplication = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('email username pathway pathwayStatus');
        if (!user) return res.redirect('/admin/pathway-applications?error=not_found');
        user.pathwayStatus = 'approved';
        user.pathwayApplication = { ...user.pathwayApplication?.toObject?.() || {}, reviewedAt: new Date() };
        await user.save();

        // Send approval email
        const { sendEmail } = require('../utils/emailService');
        const PathwayConfig = require('../models/PathwayConfig');
        const config = await PathwayConfig.findOne({ pathway: user.pathway });
        const groupLink = config?.groupLink || '';
        const pathwayNames = { web3_jobs:'Web3 Jobs', ai:'AI & Web3', trading:'Trading', nft:'NFTs & Digital Assets' };
        const pathwayName  = pathwayNames[user.pathway] || user.pathway;
        await sendEmail({
            to: user.email,
            subject: `🎉 Your ${pathwayName} Pathway Application was Approved!`,
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#0a0a0a;color:#e5e7eb;border-radius:12px">
<h2 style="color:#10b981">You're in, ${user.username}! 🚀</h2>
<p>Your application to join the <strong style="color:#10b981">${pathwayName}</strong> pathway community has been <strong>approved</strong>.</p>
${groupLink ? `<p>Join the community now:</p><a href="${groupLink}" style="display:inline-block;background:#10b981;color:#000;padding:.75rem 1.5rem;border-radius:8px;font-weight:700;text-decoration:none">Join ${pathwayName} Group →</a>` : ''}
<p style="margin-top:1.5rem;color:#6b7280">You can also find the link on your dashboard at any time.</p>
</div>`
        }).catch(() => {});

        res.redirect('/admin/pathway-applications?success=approved');
    } catch (err) {
        console.error('[Approve pathway]', err);
        res.redirect('/admin/pathway-applications?error=server');
    }
};

// ── POST /admin/pathway-applications/:id/reject ───────────────────────────────
exports.rejectPathwayApplication = async (req, res) => {
    try {
        const { note } = req.body;
        const user = await User.findById(req.params.id).select('email username pathway pathwayStatus pathwayApplication');
        if (!user) return res.redirect('/admin/pathway-applications?error=not_found');
        user.pathwayStatus = 'rejected';
        const existing = user.pathwayApplication?.toObject?.() || {};
        user.pathwayApplication = { ...existing, reviewedAt: new Date(), reviewNote: note || '' };
        await user.save();

        const { sendEmail } = require('../utils/emailService');
        const pathwayNames = { web3_jobs:'Web3 Jobs', ai:'AI & Web3', trading:'Trading', nft:'NFTs & Digital Assets' };
        const pathwayName  = pathwayNames[user.pathway] || user.pathway;
        await sendEmail({
            to: user.email,
            subject: `Your ${pathwayName} Pathway Application`,
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#0a0a0a;color:#e5e7eb;border-radius:12px">
<h2 style="color:#f59e0b">Application Update, ${user.username}</h2>
<p>Unfortunately your application for the <strong>${pathwayName}</strong> pathway was not approved at this time.</p>
${note ? `<p><strong>Reason:</strong> ${note}</p>` : ''}
<p>You can update your pathway selection and reapply from your dashboard. Keep completing quests to level up — users with 10,000+ XP get auto-approved!</p>
<a href="https://onboard3.xyz/dashboard" style="display:inline-block;background:#10b981;color:#000;padding:.75rem 1.5rem;border-radius:8px;font-weight:700;text-decoration:none">Go to Dashboard →</a>
</div>`
        }).catch(() => {});

        res.redirect('/admin/pathway-applications?success=rejected');
    } catch (err) {
        console.error('[Reject pathway]', err);
        res.redirect('/admin/pathway-applications?error=server');
    }
};

// ── POST /admin/withdrawals/:id/approve ──────────────────────────────────────
exports.approveWithdrawal = async (req, res) => {
    try {
        await Transaction.findByIdAndUpdate(req.params.id, { status:'completed' });
        res.redirect('/admin/withdrawals');
    } catch { res.redirect('/admin/withdrawals'); }
};

exports.rejectWithdrawal = async (req, res) => {
    try {
        const txn = await Transaction.findById(req.params.id);
        if (txn && txn.user) {
            await User.findByIdAndUpdate(txn.user, { $inc:{ usdcBalance: txn.amount } });
        }
        await Transaction.findByIdAndUpdate(req.params.id, { status:'rejected' });
        res.redirect('/admin/withdrawals');
    } catch { res.redirect('/admin/withdrawals'); }
};

// ── POST /admin/users/:id/ban|unban ──────────────────────────────────────────
exports.banUser = async (req, res) => {
    try {
        const u = await User.findById(req.params.id);
        if (u) { u.isBanned = !u.isBanned; u.banReason = u.isBanned ? (req.body.reason||'Admin action') : null; u.bannedAt = u.isBanned ? new Date() : null; await u.save(); }
        res.redirect('/admin/users');
    } catch { res.redirect('/admin/users'); }
};

exports.unbanUser = async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.params.id, { isBanned:false, banReason:null, bannedAt:null });
        res.redirect('/admin/banned');
    } catch { res.redirect('/admin/banned'); }
};

// ── POST /admin/quests/create ────────────────────────────────────────────────
exports.createQuestPage = async (req, res) => {
    try {
        const { title, shortDescription, description, category, difficulty, questType, baseXpReward, usdcReward, rewardPerPerson, maxWinners, startDate, endDate, image, referralEnabled, xpPerReferralJoin, xpPerReferralComplete, topWinnersCount, winnerBonusXP, firstPlacePercent, secondPlacePercent, rankPercentages } = req.body;
        const rankCount = Math.max(1, Math.min(100, parseInt(topWinnersCount, 10) || 10));
        const rankShares = (Array.isArray(rankPercentages) ? rankPercentages : rankPercentages === undefined ? [] : [rankPercentages]).map(Number);
        if (rankShares.length !== rankCount || rankShares.some(p => !Number.isFinite(p) || p < 0 || p > 100) || Math.abs(rankShares.reduce((a, b) => a + b, 0) - 100) > 0.01) {
            return res.redirect('/admin/quests?error=rank-split');
        }
        const { broadcast } = require('../utils/notificationService');
        const quest = new Quest({
            title, shortDescription, description,
            category: category || 'learning',
            difficulty: difficulty || 'beginner',
            questType: questType || 'standard',
            baseXpReward: +baseXpReward || 0,
            usdcReward:   +usdcReward   || 0,
            rewardPlan: {
                rewardPerPerson: +rewardPerPerson || 0,
                maxWinners:      +maxWinners      || 0
            },
            referralConfig: {
                enabled: questType === 'referral_boost' || referralEnabled === 'true',
                xpPerReferralJoin: Math.max(0, parseInt(xpPerReferralJoin, 10) || 0),
                xpPerReferralComplete: Math.max(0, parseInt(xpPerReferralComplete, 10) || 0)
            },
            competitionConfig: {
                enabled: questType === 'competition',
                topWinnersCount: rankCount,
                winnerBonusXP: Math.max(0, parseInt(winnerBonusXP, 10) || 0),
                firstPlacePercent: rankShares[0] ?? 50,
                secondPlacePercent: rankShares[1] ?? 0,
                rankPercentages: rankShares
            },
            startDate: startDate || null,
            endDate:   endDate   || null,
            image:     image     || null,
            isActive:  false,  // created inactive so admin can add tasks before launching
            createdBy: req.session.userId
        });
        await quest.save();
        res.redirect('/admin/quests?created=1');
    } catch (err) { console.error(err); res.redirect('/admin/quests?error=1'); }
};

function normalizeQuestTask(body, quest, defaults) {
    const source = defaults || {};
    const title = String(body.title ?? source.title ?? '').trim();
    if (!title) throw new Error('Task title is required.');
    const allowedTypes = ['social', 'submission', 'verification', 'external', 'image_upload', 'discord_join', 'telegram_join'];
    const taskType = String(body.taskType ?? source.taskType ?? 'external');
    if (!allowedTypes.includes(taskType)) throw new Error('Choose a valid task type.');
    const buttonLink = String(body.buttonLink ?? source.buttonLink ?? '').trim();
    if (buttonLink) {
        let parsed;
        try { parsed = new URL(buttonLink); } catch { throw new Error('Enter a valid button link starting with https://.'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Button links must use http:// or https://.');
    }
    const inputLabel = String(body.inputLabel ?? source.inputLabel ?? '').trim();
    let inputName = String(body.inputName ?? source.inputName ?? '').trim();
    if (inputLabel && !inputName) {
        inputName = inputLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'task_input';
    }
    if (inputName && !/^[a-z][a-z0-9_]{0,39}$/.test(inputName)) throw new Error('Input key must start with a letter and contain only letters, numbers, and underscores.');
    const inputType = String(body.inputType ?? source.inputType ?? (taskType === 'submission' ? 'link' : 'text'));
    if (!['text', 'link', 'file', 'none'].includes(inputType)) throw new Error('Choose a valid answer format.');
    const isFcfs = quest.questType === 'fcfs';
    return {
        title,
        description: String(body.description ?? source.description ?? title).trim() || title,
        taskType,
        xpReward: Math.max(0, parseInt(body.xpReward ?? source.xpReward, 10) || 0),
        availableFromDay: Math.max(0, parseInt(body.availableFromDay ?? source.availableFromDay, 10) || 0),
        buttonLink: buttonLink || null,
        buttonText: String(body.buttonText ?? source.buttonText ?? '').trim() || (buttonLink ? 'Open task' : null),
        inputLabel: inputLabel || null,
        inputName: inputName || null,
        inputType,
        requiresApproval: !isFcfs && (body.requiresApproval === true || body.requiresApproval === 'true')
    };
}

// ── POST /admin/quests/:id/add-task ──────────────────────────────────────────
exports.addQuestTask = async (req, res) => {
    try {
        const quest = await Quest.findById(req.params.id);
        if (!quest) return res.status(404).json({ success: false, message: 'Quest not found.' });
        const task = normalizeQuestTask(req.body, quest);
        task.order = quest.tasks.length + 1;
        task.isDaily = false;
        quest.tasks.push(task);
        await quest.save();
        await syncQuestProgressForQuest(quest);
        res.json({ success: true, task: quest.tasks[quest.tasks.length - 1] });
    } catch (err) {
        console.error('[addQuestTask]', err);
        res.status(400).json({ success: false, message: err.message });
    }
};

// ── POST /admin/quests/:id/tasks/:taskId/update ──────────────────────────────
exports.updateQuestTask = async (req, res) => {
    try {
        const quest = await Quest.findById(req.params.id);
        if (!quest) return res.status(404).json({ success: false, message: 'Quest not found.' });
        const isDaily = req.body.isDaily === true || req.body.isDaily === 'true';
        const list = isDaily ? quest.dailyTasks : quest.tasks;
        const task = list.id(req.params.taskId);
        if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
        const normalized = normalizeQuestTask(req.body, quest, task.toObject());
        Object.assign(task, normalized);
        await quest.save();
        res.json({ success: true, task });
    } catch (err) {
        console.error('[updateQuestTask]', err);
        res.status(400).json({ success: false, message: err.message });
    }
};

// ── POST /admin/quests/:id/tasks/:taskId/delete ──────────────────────────────
exports.deleteQuestTask = async (req, res) => {
    try {
        const quest = await Quest.findById(req.params.id);
        if (!quest) return res.status(404).json({ success: false, message: 'Quest not found.' });
        const isDaily = req.body.isDaily === true || req.body.isDaily === 'true';
        const list = isDaily ? quest.dailyTasks : quest.tasks;
        const task = list.id(req.params.taskId);
        if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
        list.pull(req.params.taskId);
        list.forEach((item, index) => { item.order = index + 1; });
        await quest.save();
        await syncQuestProgressForQuest(quest);
        res.json({ success: true });
    } catch (err) {
        console.error('[deleteQuestTask]', err);
        res.status(400).json({ success: false, message: err.message });
    }
};
// ── GET /admin/quests/:id/entries ─────────────────────────────────────────────
exports.getQuestEntries = async (req, res) => {
    try {
        const quest = await Quest.findById(req.params.id)
            .select('questType tasks dailyTasks title shortDescription description category difficulty startDate endDate rewardPlan baseXpReward usdcReward referralConfig competitionConfig');
        if (!quest) return res.json({ success: false, message: 'Quest not found' });

        const entries = await UserQuestProgress.find({ questId: req.params.id })
            .populate('userId', 'username email xp')
            .sort({ 'xpBreakdown.totalXp': -1, completedAt: 1, startedAt: 1 })
            .lean();

        res.json({ success: true, quest, entries });
    } catch (err) {
        console.error('[getQuestEntries]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/quests/:id/users/:userId/bonus-xp ────────────────────────────
exports.awardBonusXp = async (req, res) => {
    try {
        const { id, userId } = req.params;
        const quest = await Quest.findById(id).select('questType title');
        if (!quest) return res.json({ success: false, message: 'Quest not found' });
        if (quest.questType === 'fcfs') return res.json({ success: false, message: 'Bonus XP not applicable for FCFS quests' });

        const xpAmount = Math.max(1, parseInt(req.body.xp) || 0);
        const progress = await UserQuestProgress.findOne({ questId: id, userId: userId });
        if (!progress) return res.json({ success: false, message: 'Entry not found' });

        progress.xpBreakdown.winnerBonus = (progress.xpBreakdown.winnerBonus || 0) + xpAmount;
        await progress.save(); // pre-save hook recalculates totalXp

        await User.findByIdAndUpdate(userId, { $inc: { xp: xpAmount } });

        res.json({ success: true, newTotal: progress.xpBreakdown.totalXp, bonusAdded: xpAmount });
    } catch (err) {
        console.error('[awardBonusXp]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/quests/:id/entries/:progressId/remove ────────────────────────
exports.removeQuestEntry = async (req, res) => {
    try {
        const progress = await UserQuestProgress.findById(req.params.progressId);
        if (!progress || String(progress.questId) !== req.params.id) {
            return res.json({ success: false, message: 'Entry not found' });
        }
        if (progress.status === 'abandoned') {
            return res.json({ success: false, message: 'Entry already removed' });
        }
        const xpToDeduct = progress.xpBreakdown?.totalXp || 0;
        await UserQuestProgress.updateOne({ _id: progress._id }, { $set: { status: 'abandoned' } });
        if (xpToDeduct > 0) {
            await User.findByIdAndUpdate(progress.userId, { $inc: { xp: -xpToDeduct } });
        }
        res.json({ success: true, message: 'Participant removed.' + (xpToDeduct > 0 ? ' ' + xpToDeduct + ' XP deducted.' : '') });
    } catch (err) {
        console.error('[removeQuestEntry]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/quests/:id/toggle ────────────────────────────────────────────
exports.toggleQuestPage = async (req, res) => {
    try {
        const q = await Quest.findById(req.params.id);
        if (q) { q.isActive = !q.isActive; await q.save(); }
        res.redirect('/admin/quests');
    } catch { res.redirect('/admin/quests'); }
};

// ── POST /admin/quests/:id/delete ────────────────────────────────────────────
exports.deleteQuestPage = async (req, res) => {
    try {
        await Quest.findByIdAndDelete(req.params.id);
        res.redirect('/admin/quests');
    } catch { res.redirect('/admin/quests'); }
};

// ── POST /admin/quests/:id/submissions/:progressId/review ─────────────────────
exports.reviewTaskSubmission = async (req, res) => {
    try {
        const { id, progressId } = req.params;
        const { taskId, action } = req.body; // action: 'approve' | 'reject'
        if (!['approve','reject'].includes(action)) return res.json({ success: false, message: 'Invalid action' });

        const quest = await Quest.findById(id).select('questType tasks');
        if (!quest) return res.json({ success: false, message: 'Quest not found' });

        const progress = await UserQuestProgress.findById(progressId);
        if (!progress) return res.json({ success: false, message: 'Progress not found' });

        const tp = progress.taskProgress.find(t => t.taskId.toString() === taskId);
        if (!tp) return res.json({ success: false, message: 'Task submission not found' });

        if (action === 'approve') {
            const questTask = quest.tasks.id(taskId);
            const xpReward  = questTask ? (questTask.xpReward || 0) : 0;

            tp.isCompleted    = true;
            tp.completedAt    = new Date();
            tp.approvalStatus = 'approved';
            tp.xpEarned       = xpReward;

            progress.tasksCompleted = progress.taskProgress.filter(t => t.isCompleted).length;
            progress.xpBreakdown.taskXp = (progress.xpBreakdown.taskXp || 0) + xpReward;
            progress.xpBreakdown.totalXp = (progress.xpBreakdown.taskXp || 0) +
                (progress.xpBreakdown.baseXp || 0) +
                (progress.xpBreakdown.referralJoinBonus || 0) +
                (progress.xpBreakdown.referralCompleteBonus || 0) +
                (progress.xpBreakdown.winnerBonus || 0) +
                (progress.xpBreakdown.adminAdjustmentXp || 0);
            progress.progress = Math.round((progress.tasksCompleted / (progress.totalTasks || 1)) * 100);

            if (progress.tasksCompleted >= progress.totalTasks && progress.status !== 'completed') {
                progress.status      = 'completed';
                progress.completedAt = new Date();
            }

            await progress.save();
            if (xpReward > 0) await User.findByIdAndUpdate(progress.userId, { $inc: { xp: xpReward } });

            return res.json({ success: true, message: 'Approved', xpGranted: xpReward });
        } else {
            tp.approvalStatus = 'rejected';
            await progress.save();
            return res.json({ success: true, message: 'Rejected' });
        }
    } catch (err) {
        console.error('[reviewTaskSubmission]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/quests/:id/update-settings ───────────────────────────────────
exports.updateQuestSettings = async (req, res) => {
    try {
        const quest = await Quest.findById(req.params.id);
        if (!quest) return res.json({ success: false, message: 'Quest not found' });
        const { title, shortDescription, description, category, difficulty, questType, usdcReward, rewardPerPerson, maxWinners, maxParticipants, baseXpReward, referralEnabled, xpPerReferralJoin, xpPerReferralComplete, topWinnersCount, winnerBonusXP, firstPlacePercent, secondPlacePercent, rankPercentages } = req.body;
        const targetRankCount = Math.max(1, Math.min(100, parseInt(topWinnersCount ?? quest.competitionConfig?.topWinnersCount, 10) || 1));
        const rankShares = rankPercentages === undefined ? quest.competitionConfig?.rankPercentages : (Array.isArray(rankPercentages) ? rankPercentages : [rankPercentages]).map(Number);
        if ((rankPercentages !== undefined || topWinnersCount !== undefined) && (!Array.isArray(rankShares) || rankShares.length !== targetRankCount || rankShares.some(p => !Number.isFinite(Number(p)) || Number(p) < 0 || Number(p) > 100) || Math.abs(rankShares.reduce((sum, p) => sum + Number(p), 0) - 100) > 0.01)) {
            return res.json({ success: false, message: 'Winner percentages must match the top winner count and total 100%.' });
        }
        if (title !== undefined) quest.title = String(title).trim();
        if (shortDescription !== undefined) quest.shortDescription = String(shortDescription).trim();
        if (description !== undefined) quest.description = String(description).trim();
        if (category !== undefined) quest.category = category;
        if (difficulty !== undefined) quest.difficulty = difficulty;
        if (questType !== undefined) quest.questType = questType;
        if (usdcReward       !== undefined) quest.usdcReward                  = Math.max(0, parseFloat(usdcReward) || 0);
        if (rewardPerPerson  !== undefined) quest.rewardPlan.rewardPerPerson  = Math.max(0, parseFloat(rewardPerPerson) || 0);
        if (maxWinners       !== undefined) quest.rewardPlan.maxWinners       = Math.max(0, parseInt(maxWinners) || 0);
        if (maxParticipants  !== undefined) quest.maxParticipants             = parseInt(maxParticipants) > 0 ? parseInt(maxParticipants) : null;
        if (baseXpReward     !== undefined) quest.baseXpReward                = Math.max(0, parseInt(baseXpReward) || 0);
        if (!quest.referralConfig) quest.referralConfig = {};
        if (referralEnabled !== undefined) quest.referralConfig.enabled = referralEnabled === true || referralEnabled === 'true';
        if (xpPerReferralJoin !== undefined) quest.referralConfig.xpPerReferralJoin = Math.max(0, parseInt(xpPerReferralJoin, 10) || 0);
        if (xpPerReferralComplete !== undefined) quest.referralConfig.xpPerReferralComplete = Math.max(0, parseInt(xpPerReferralComplete, 10) || 0);
        if (!quest.competitionConfig) quest.competitionConfig = {};
        if (topWinnersCount !== undefined) quest.competitionConfig.topWinnersCount = Math.max(1, parseInt(topWinnersCount, 10) || 1);
        if (winnerBonusXP !== undefined) quest.competitionConfig.winnerBonusXP = Math.max(0, parseInt(winnerBonusXP, 10) || 0);
        if (firstPlacePercent !== undefined) quest.competitionConfig.firstPlacePercent = Math.min(100, Math.max(0, parseFloat(firstPlacePercent) || 0));
        if (secondPlacePercent !== undefined) quest.competitionConfig.secondPlacePercent = Math.min(100, Math.max(0, parseFloat(secondPlacePercent) || 0));
        if (rankPercentages !== undefined) {
            quest.competitionConfig.rankPercentages = rankShares.map(Number);
            quest.competitionConfig.firstPlacePercent = rankShares[0] || 0;
            quest.competitionConfig.secondPlacePercent = rankShares[1] || 0;
        }
        await quest.save();
        res.json({ success: true, quest: { usdcReward: quest.usdcReward, rewardPlan: quest.rewardPlan, maxParticipants: quest.maxParticipants, baseXpReward: quest.baseXpReward } });
    } catch (err) {
        console.error('[updateQuestSettings]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/events/create ────────────────────────────────────────────────
exports.createEventPage = async (req, res) => {
    try {
        const { title, description, eventType, startDate, endDate, location, maxAttendees, approvalType, bannerImage } = req.body;
        const et = ['virtual', 'physical', 'hybrid'].includes(eventType) ? eventType : 'virtual';
        const loc = location?.trim() || null;
        await Event.create({
            title, description,
            eventType: et,
            startDate, endDate: endDate || startDate,
            startTime: '10:00', endTime: '17:00',
            venue: (et === 'physical' || et === 'hybrid') ? loc : null,
            virtualLink: (et === 'virtual' || et === 'hybrid') ? loc : null,
            maxAttendees: maxAttendees ? +maxAttendees : null,
            approvalType: approvalType === 'manual' ? 'manual' : 'auto',
            bannerImage: bannerImage?.trim() || null,
            isActive: true, createdBy: req.session.userId
        });
        res.redirect('/admin/events?created=1');
    } catch (err) { console.error(err); res.redirect('/admin/events?error=1'); }
};

// ── GET /admin/events/:id ────────────────────────────────────────────────────
exports.getEventDetailPage = async (req, res) => {
    try {
        const event = await Event.findById(req.params.id)
            .populate('registrations.user', 'username email profilePicture')
            .lean();
        if (!event) return res.redirect('/admin/events');
        const user = await User.findById(req.session.userId).select('username role').lean();
        res.render('admin/pages/event-detail', { event, user });
    } catch (err) { console.error(err); res.redirect('/admin/events'); }
};

// ── POST /admin/events/:id/approve/:userId ───────────────────────────────────
exports.approveEventRegistration = async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);
        if (!event) return res.json({ success: false, message: 'Event not found' });
        const reg = event.registrations.find(r => String(r.user) === req.params.userId);
        if (!reg) return res.json({ success: false, message: 'Registration not found' });
        if (event.maxAttendees && event.totalApproved >= event.maxAttendees) {
            return res.json({ success: false, message: 'Event has reached maximum capacity' });
        }
        reg.status = 'approved';
        reg.approvedAt = new Date();
        reg.approvedBy = req.session.userId;
        await event.save();
        res.json({ success: true });
    } catch (err) {
        console.error('[approveEventReg]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/events/:id/reject/:userId ────────────────────────────────────
exports.rejectEventRegistration = async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);
        if (!event) return res.json({ success: false, message: 'Event not found' });
        const reg = event.registrations.find(r => String(r.user) === req.params.userId);
        if (!reg) return res.json({ success: false, message: 'Registration not found' });
        reg.status = 'rejected';
        reg.rejectionReason = req.body.reason || null;
        await event.save();
        res.json({ success: true });
    } catch (err) {
        console.error('[rejectEventReg]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/events/:id/banner ────────────────────────────────────────────
exports.updateEventBanner = async (req, res) => {
    try {
        const { bannerImage } = req.body;
        await Event.findByIdAndUpdate(req.params.id, { bannerImage: bannerImage?.trim() || null });
        res.json({ success: true });
    } catch (err) {
        console.error('[updateEventBanner]', err);
        res.json({ success: false, message: err.message });
    }
};

// ── POST /admin/events/:id/delete ────────────────────────────────────────────
exports.deleteEventPage = async (req, res) => {
    try { await Event.findByIdAndDelete(req.params.id); res.redirect('/admin/events'); }
    catch { res.redirect('/admin/events'); }
};

// ── POST applications approve/reject ─────────────────────────────────────────
exports.approveApplication = async (req, res) => {
    try { await CourseApplication.findByIdAndUpdate(req.params.id, { status:'approved' }); res.redirect('/admin/applications'); }
    catch { res.redirect('/admin/applications'); }
};
exports.rejectApplication = async (req, res) => {
    try { await CourseApplication.findByIdAndUpdate(req.params.id, { status:'rejected' }); res.redirect('/admin/applications'); }
    catch { res.redirect('/admin/applications'); }
};

// ── POST ambassadors approve/reject ──────────────────────────────────────────
exports.approveAmbassador = async (req, res) => {
    try {
        const CampusAmbassador = require('../models/CampusAmbassador');
        await CampusAmbassador.findByIdAndUpdate(req.params.id, { status:'approved' });
        res.redirect('/admin/ambassadors');
    } catch { res.redirect('/admin/ambassadors'); }
};
exports.rejectAmbassador = async (req, res) => {
    try {
        const CampusAmbassador = require('../models/CampusAmbassador');
        await CampusAmbassador.findByIdAndUpdate(req.params.id, { status:'rejected' });
        res.redirect('/admin/ambassadors');
    } catch { res.redirect('/admin/ambassadors'); }
};

// ── POST projects approve/reject ─────────────────────────────────────────────
exports.approveProject = async (req, res) => {
    try {
        const Project = require('../models/Project');
        await Project.findByIdAndUpdate(req.params.id, { status:'approved' });
        res.redirect('/admin/projects');
    } catch { res.redirect('/admin/projects'); }
};
exports.rejectProject = async (req, res) => {
    try {
        const Project = require('../models/Project');
        await Project.findByIdAndUpdate(req.params.id, { status:'rejected' });
        res.redirect('/admin/projects');
    } catch { res.redirect('/admin/projects'); }
};

// ── GET /admin/analytics ──────────────────────────────────────────────────────
exports.analyticsPage = async (req, res) => {
    try {
        const now = new Date();
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo  = new Date(now -  7 * 24 * 60 * 60 * 1000);
        const todayStart    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        const [
            totalUsers,
            verifiedUsers,
            usersThisWeek,
            usersToday,
            dailySignups,
            dailyActiveUsers,
            pathwayBreakdown,
            roleDistribution,
            usersWithReferrals,
            recentUsers
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ isVerified: true }),
            User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
            User.countDocuments({ createdAt: { $gte: todayStart } }),

            // Daily signups last 30 days
            User.aggregate([
                { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]).catch(() => []),

            // Daily active users (lastLogin or createdAt fallback)
            User.aggregate([
                { $match: { $or: [{ lastLogin: { $gte: thirtyDaysAgo } }, { createdAt: { $gte: thirtyDaysAgo } }] } },
                { $addFields: { activeDate: { $ifNull: ['$lastLogin', '$createdAt'] } } },
                { $match: { activeDate: { $gte: thirtyDaysAgo } } },
                { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$activeDate' } }, count: { $sum: 1 } } },
                { $sort: { _id: 1 } }
            ]).catch(() => []),

            // Top 5 pathways
            User.aggregate([
                { $match: { pathway: { $ne: null } } },
                { $group: { _id: '$pathway', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 }
            ]).catch(() => []),

            // Role distribution by XP ranges
            User.aggregate([
                {
                    $bucket: {
                        groupBy: '$xp',
                        boundaries: [0, 10000, 25000, 50000, 100000],
                        default: 'legend_plus',
                        output: { count: { $sum: 1 } }
                    }
                }
            ]).catch(() => []),

            // Users with referrals
            User.countDocuments({ 'referralStats.totalReferrals': { $gt: 0 } }).catch(() => 0),

            // Recent 10 users
            User.find().sort({ createdAt: -1 }).limit(10)
                .select('username email xp isVerified pathway createdAt profilePicture').lean()
        ]);

        // Map role distribution buckets to named roles
        const roleBucketMap = { 0: 'citizen', 10000: 'contributor', 25000: 'ambassador', 100000: 'legend', 250000: 'major' };
        const roleData = roleDistribution.map(b => ({
            role: roleBucketMap[b._id] || String(b._id),
            count: b.count
        }));

        // Build a complete 30-day date array for charts (fill missing days with 0)
        const dateRange = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now - i * 24 * 60 * 60 * 1000);
            dateRange.push(d.toISOString().split('T')[0]);
        }
        const signupMap = Object.fromEntries(dailySignups.map(d => [d._id, d.count]));
        const dauMap    = Object.fromEntries(dailyActiveUsers.map(d => [d._id, d.count]));
        const signupSeries = dateRange.map(dt => signupMap[dt] || 0);
        const dauSeries    = dateRange.map(dt => dauMap[dt]    || 0);

        res.render('admin/pages/analytics', {
            admin: req.user,
            user: req.user,
            stats: {
                totalUsers,
                verifiedUsers,
                verifiedPct: totalUsers ? Math.round((verifiedUsers / totalUsers) * 100) : 0,
                usersThisWeek,
                usersToday,
                usersWithReferrals
            },
            chartLabels:    JSON.stringify(dateRange),
            signupSeries:   JSON.stringify(signupSeries),
            dauSeries:      JSON.stringify(dauSeries),
            pathwayData:    JSON.stringify(pathwayBreakdown),
            roleData:       JSON.stringify(roleData),
            recentUsers
        });
    } catch (err) {
        console.error('[Admin Analytics]', err);
        res.status(500).send('Error loading analytics');
    }
};
