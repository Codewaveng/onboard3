require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const authRoutes = require("./routes/authRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const questRoutes = require("./routes/questRoutes");
const referralRoutes = require("./routes/referralRoutes");
const eventRoutes = require("./routes/eventRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const courseRoutes = require("./routes/courseRoutes");
const adminRoutes = require("./routes/adminRoutes");
const withdrawalRoutes = require("./routes/withdrawal");
const campusAmbassadorRoutes = require('./routes/campusAmbassador');
const projectRoutes = require('./routes/projectRoutes');
const gamificationRoutes = require('./routes/gamificationRoutes');
const partnershipRoutes = require('./routes/partnershipRoutes');
const notificationRoutes   = require('./routes/notificationRoutes');
const telegramBot          = require('./utils/telegramBot');
const twitterAuthRoutes    = require('./routes/twitterAuthRoutes');
const discordAuthRoutes    = require('./routes/discordAuthRoutes');
const bountyRoutes              = require('./routes/bountyRoutes');
const businessDeveloperRoutes   = require('./routes/businessDevelopers');
const businessRoutes            = require('./routes/business');
const partnerApiRoutes          = require('./routes/partnerApiRoutes');
const academyRoutes             = require('./routes/academyRoutes');
const cors = require('cors');
const http = require("http");
const socketIO = require("socket.io");

const app = express();
const server = http.createServer(app);

// ✅ Setup Socket.io BEFORE any middleware
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  serveClient: true,
  path: '/socket.io',
  transports: ['websocket', 'polling']
});

console.log('✅ Socket.IO initialized with serveClient: true');

// Session configuration — MongoDB-backed store to survive server restarts
// and prevent MemoryStore memory leaks in production
app.use(session({
  secret: process.env.SESSION_SECRET || "your_secret_key_change_in_production",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    ttl: 24 * 60 * 60,        // 1 day in seconds
    autoRemove: 'native',      // Use MongoDB TTL index to clean expired sessions
    touchAfter: 60             // Only re-save session every 60s (reduces DB writes)
  }),
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000  // 1 day in ms
  }
}));

app.use(cors());
// Middleware
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));


// Lazy MongoDB connection — works for both local and Vercel serverless
const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) return;
  await mongoose.connect(process.env.MONGO_URI);
  console.log("MongoDB Connected");
};

// Ensure DB is ready before every route (critical for Vercel cold starts)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) { next(err); }
});

// Coming Soon gate — controlled from /admin/bulkmail
let _csCache = null, _csCacheAt = 0;
app.use(async (req, res, next) => {
  const p = req.path;
  // Always allow admin, auth, api, and static assets through
  if (p.startsWith('/admin') || p.startsWith('/auth') || p.startsWith('/api') ||
      p.startsWith('/css')   || p.startsWith('/js')   || p.startsWith('/img') ||
      p.startsWith('/uploads') || p.startsWith('/favicon')) return next();
  try {
    const now = Date.now();
    if (!_csCache || (now - _csCacheAt) > 20000) {
      const BulkMailJob = require('./models/BulkMailJob');
      const job = await BulkMailJob.findOne().select('comingSoonMode').lean();
      _csCache = job ? job.comingSoonMode : false;
      _csCacheAt = now;
    }
    if (_csCache) return res.render('coming-soon');
  } catch (_) {}
  next();
});

// GET /api/site-live — polled by coming-soon page to detect when admin flips the switch
app.get('/api/site-live', async (req, res) => {
  try {
    const BulkMailJob = require('./models/BulkMailJob');
    const job = await BulkMailJob.findOne().select('comingSoonMode').lean();
    const csOn = job ? job.comingSoonMode : false;
    res.json({ live: !csOn });
  } catch (e) {
    res.json({ live: false });
  }
});


// Local dev only: connect DB first, then start HTTP server + Telegram bot
if (!process.env.VERCEL) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${process.env.PORT || 5000} is already in use.`);
      process.exit(1);
    } else throw err;
  });

  connectDB()
    .then(async () => {
      telegramBot.start();
      const PORT = process.env.PORT || 5000;
      server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Socket.IO listening on ws://localhost:${PORT}`);
      });
    })
    .catch(err => {
      console.error("MongoDB connection error:", err);
      process.exit(1);
    });
}

// Make io accessible to routes
app.set('io', io);

// Auth middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  // Preserve the original URL for redirect after login
  const redirectUrl = encodeURIComponent(req.originalUrl);
  res.redirect(`/auth?redirect=${redirectUrl}`);
};

app.use("/api/events", eventRoutes);

// Routes
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/dashboard/quests", questRoutes);
app.use("/dashboard/referral", referralRoutes);
app.use("/dashboard/settings", settingsRoutes);
app.use("/api/learn", courseRoutes);
app.use("/admin", adminRoutes);
app.use("/dashboard/withdrawal", withdrawalRoutes);
app.use('/api/campus-ambassador', campusAmbassadorRoutes);
app.use('/api/projects', projectRoutes);
app.use('/dashboard', gamificationRoutes);
app.use('/dashboard/partnership', partnershipRoutes);
app.use('/api/partnership', partnershipRoutes);
app.use('/auth/twitter', twitterAuthRoutes);
app.use('/auth/discord', discordAuthRoutes);
app.use('/dashboard/bounties', bountyRoutes);
app.use('/dashboard/academy', academyRoutes);

// Public certificate verification (no login required)
app.get('/academy/verify/:certId', require('./controllers/academyController').verifyCertificate);
app.use('/api/notifications', notificationRoutes);
app.use('/business-developers', businessDeveloperRoutes);
app.use('/business', businessRoutes);
app.use('/api/public', partnerApiRoutes);


// ── Public platform stats (used on partner page) ─────────────────────────────
app.get("/api/public/stats", async (req, res) => {
  try {
    const User              = require('./models/User');
    const Event             = require('./models/Event');
    const Quest             = require('./models/Quest');
    const UserQuestProgress = require('./models/UserQuestProgress');
    const Transaction       = require('./models/Transaction');

    const [
      totalMembers,
      questsCompleted,
      totalEvents,
      activeQuests,
      attendeeAgg,
      rewardsAgg
    ] = await Promise.all([
      User.countDocuments(),
      UserQuestProgress.countDocuments({ status: 'completed' }),
      Event.countDocuments(),
      Quest.countDocuments({ isActive: true, $or: [{ endDate: null }, { endDate: { $gt: new Date() } }] }),
      Event.aggregate([{ $group: { _id: null, total: { $sum: '$totalApproved' } } }]),
      Transaction.aggregate([
        { $match: { type: { $in: ['quest_reward', 'referral_bonus'] }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    res.json({
      success: true,
      totalMembers,
      questsCompleted,
      totalEvents,
      activeQuests,
      totalAttendees: attendeeAgg[0]?.total || 0,
      totalRewardsUsd: rewardsAgg[0]?.total || 0
    });
  } catch (err) {
    console.error('Public stats error:', err);
    res.json({ success: false, totalMembers: 0, questsCompleted: 0, totalEvents: 0, activeQuests: 0, totalAttendees: 0, totalXpDistributed: 0 });
  }
});

app.get("/", async (req, res) => {
  try {
    const User             = require('./models/User');
    const Quest            = require('./models/Quest');
    const UserQuestProgress = require('./models/UserQuestProgress');
    const Transaction      = require('./models/Transaction');

    const [totalSignups, activeQuests, questsCompleted, rewardsAgg] = await Promise.all([
      User.countDocuments(),
      Quest.countDocuments({ isActive: true, $or: [{ endDate: null }, { endDate: { $gt: new Date() } }] }),
      UserQuestProgress.countDocuments({ status: 'completed' }),
      Transaction.aggregate([
        { $match: { type: { $in: ['quest_reward', 'referral_bonus'] }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    const totalUSDC = (rewardsAgg[0]?.total || 0).toFixed(0);

    res.render("index", {
      title: "Home Page",
      user: req.session.userId ? { username: req.session.username } : null,
      totalSignups,
      activeQuests,
      questsCompleted,
      totalUSDC
    });
  } catch (error) {
    console.error('Error loading home page:', error);
    res.render("index", {
      title: "Home Page",
      user: req.session.userId ? { username: req.session.username } : null,
      totalSignups: 0, activeQuests: 0, questsCompleted: 0, totalUSDC: '0'
    });
  }
});

// ── Public profile page ───────────────────────────────────────────────────────
app.get("/u/:username", async (req, res) => {
  try {
    const User              = require('./models/User');
    const Transaction       = require('./models/Transaction');
    const UserQuestProgress = require('./models/UserQuestProgress');
    const FeedEvent         = require('./models/FeedEvent');
    const Notification      = require('./models/Notification');

    const u = await User.findOne({ username: new RegExp('^' + req.params.username + '$', 'i') })
      .select('username xp usdcBalance profilePicture createdAt pathway pathwayStatus referralCode privacy bio');
    if (!u) return res.status(404).send('User not found');

    const viewerLoggedIn = !!req.session.userId;
    const viewerIsOwner  = viewerLoggedIn && req.session.userId.toString() === u._id.toString();

    // Private profile: only logged-in users can view
    if (u.privacy?.publicProfile === false && !viewerLoggedIn) {
      return res.render('profile', {
        profileUser: u, role: {key:'citizen',name:'Citizen',color:'#6b7280'},
        totalUsdc: '0.00', questsDone: 0, host: req.get('host'),
        referralCode: '', feedEvents: [], isPrivate: true, viewerLoggedIn: false,
        globalRank: null
      });
    }

    const getRoleKey = (xp) => {
      if ((xp||0) >= 250000) return { key:'major',       name:'Major',       color:'#f97316' };
      if ((xp||0) >= 100000) return { key:'legend',      name:'Legend',      color:'#eab308' };
      if ((xp||0) >= 25000)  return { key:'ambassador',  name:'Ambassador',  color:'#3b82f6' };
      if ((xp||0) >= 10000)  return { key:'contributor', name:'Contributor', color:'#10b981' };
      return                          { key:'citizen',    name:'Citizen',     color:'#6b7280' };
    };

    const viewerUserId = req.session.userId ? req.session.userId.toString() : null;

    const [usdcAgg, questsDone, feedEvents, globalRank] = await Promise.all([
      Transaction.aggregate([
        { $match: { user: u._id, type: { $in: ['quest_reward','referral_bonus'] }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      UserQuestProgress.countDocuments({ userId: u._id, status: 'completed' }),
      viewerLoggedIn
        ? FeedEvent.find({ userId: u._id }).sort({ createdAt: -1 }).limit(20).lean()
        : Promise.resolve([]),
      // Global leaderboard rank by XP
      User.countDocuments({ xp: { $gt: u.xp || 0 } }).then(n => n + 1)
    ]);

    // Annotate which events the viewer has liked
    const enrichedFeed = feedEvents.map(ev => ({
      ...ev,
      viewerLiked: viewerUserId && ev.likes && ev.likes.users
        ? ev.likes.users.some(id => id.toString() === viewerUserId)
        : false
    }));

    // Profile-view notification (logged-in, not the owner, cooldown 24h)
    if (viewerLoggedIn && !viewerIsOwner) {
      try {
        const viewer = await User.findById(req.session.userId).select('username').lean();
        if (viewer) {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const alreadyNotified = await Notification.findOne({
            userId: u._id, type: 'profile_view',
            message: { $regex: viewer.username, $options: 'i' },
            createdAt: { $gte: cutoff }
          }).lean();
          if (!alreadyNotified) {
            await Notification.create({
              userId:    u._id,
              type:      'profile_view',
              title:     'Profile View',
              message:   `@${viewer.username} viewed your profile`,
              icon:      'fa-eye',
              iconColor: '#5ec213',
              link:      `/u/${viewer.username}`
            });
          }
        }
      } catch (_) {}
    }

    res.render('profile', {
      profileUser:     u,
      role:            getRoleKey(u.xp || 0),
      totalUsdc:       (usdcAgg[0]?.total || 0).toFixed(2),
      questsDone,
      host:            req.get('host'),
      referralCode:    u.referralCode || '',
      feedEvents:      enrichedFeed,
      isPrivate:       false,
      viewerLoggedIn,
      globalRank
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.redirect('/');
  }
});

// ── Shareable member card ─────────────────────────────────────────────────────
app.get("/card/:username", async (req, res) => {
  try {
    const User        = require('./models/User');
    const Transaction = require('./models/Transaction');
    const u = await User.findOne({ username: new RegExp('^' + req.params.username + '$', 'i') })
      .select('username xp usdcBalance profilePicture createdAt pathway');
    if (!u) return res.status(404).send('User not found');

    const getRoleKey = (xp) => {
      if ((xp||0) >= 250000) return { key:'major',       name:'Major',       color:'#f97316' };
      if ((xp||0) >= 100000) return { key:'legend',      name:'Legend',      color:'#eab308' };
      if ((xp||0) >= 25000)  return { key:'ambassador',  name:'Ambassador',  color:'#3b82f6' };
      if ((xp||0) >= 10000)  return { key:'contributor', name:'Contributor', color:'#10b981' };
      return                          { key:'citizen',    name:'Citizen',     color:'#6b7280' };
    };

    const totalUsdc = await Transaction.aggregate([
      { $match: { user: u._id, type: { $in: ['quest_reward','referral_bonus'] }, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.render('share', {
      cardUser: u,
      role:     getRoleKey(u.xp || 0),
      totalUsdc: (totalUsdc[0]?.total || 0).toFixed(2),
      host:     req.get('host')
    });
  } catch (err) {
    console.error('Card error:', err);
    res.redirect('/');
  }
});

// ── Public activity feed (role upgrades + USDC earns) ────────────────────────
app.get("/api/feed", async (req, res) => {
  try {
    const FeedEvent = require('./models/FeedEvent');
    const User      = require('./models/User');
    const viewerUserId = req.session.userId ? req.session.userId.toString() : null;

    // Fetch more than we need so we can filter down to real users
    const raw = await FeedEvent.find().sort({ createdAt: -1 }).limit(40).lean();

    // Keep only events whose userId maps to a real User (removes demo/orphan events)
    const userIds = [...new Set(raw.map(ev => ev.userId?.toString()).filter(Boolean))];
    const realUsers = await User.find({ _id: { $in: userIds } }).select('_id').lean();
    const realSet   = new Set(realUsers.map(u => u._id.toString()));

    const events  = raw.filter(ev => ev.userId && realSet.has(ev.userId.toString())).slice(0, 15);
    const enriched = events.map(ev => ({
      ...ev,
      viewerLiked: viewerUserId && ev.likes && ev.likes.users
        ? ev.likes.users.some(id => id.toString() === viewerUserId)
        : false
    }));
    res.json({ success: true, events: enriched });
  } catch (err) {
    res.json({ success: true, events: [] });
  }
});

// ── Like / unlike a feed event (toggle) ─────────────────────────────────────
app.post("/api/feed/:id/like", async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: false, message: 'Login required' });
    const FeedEvent = require('./models/FeedEvent');
    const userId = req.session.userId;
    const ev = await FeedEvent.findById(req.params.id);
    if (!ev) return res.json({ success: false, message: 'Not found' });
    const idx = ev.likes.users.findIndex(id => id.toString() === userId.toString());
    if (idx >= 0) {
      ev.likes.users.splice(idx, 1);
      ev.likes.count = Math.max(0, (ev.likes.count || 1) - 1);
    } else {
      ev.likes.users.push(userId);
      ev.likes.count = (ev.likes.count || 0) + 1;
    }
    await ev.save();
    res.json({ success: true, liked: idx < 0, count: ev.likes.count });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Profile search (logged-in only) ─────────────────────────────────────────
app.get("/api/users/search", async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: false, message: 'Login required', results: [] });
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ success: true, results: [] });
    const User = require('./models/User');
    const users = await User.find({
      username: { $regex: q, $options: 'i' },
      'privacy.publicProfile': { $ne: false }
    })
    .select('username xp profilePicture pathway')
    .limit(8)
    .lean();
    const getRoleKey = (xp) => {
      if ((xp||0) >= 500000) return 'Core Team';
      if ((xp||0) >= 250000) return 'Major';
      if ((xp||0) >= 100000) return 'Legend';
      if ((xp||0) >= 50000)  return 'Maxi';
      if ((xp||0) >= 25000)  return 'Captain';
      if ((xp||0) >= 10000)  return 'Contributor';
      return 'Citizen';
    };
    res.json({ success: true, results: users.map(u => ({ ...u, roleName: getRoleKey(u.xp) })) });
  } catch (err) {
    res.json({ success: false, results: [] });
  }
});

app.get("/about", async (req, res) => {
  try {
    const User              = require('./models/User');
    const Event             = require('./models/Event');
    const ProjectSubmission = require('./models/ProjectSubmission');
    const CampusAmbassador  = require('./models/CampusAmbassador');

    const [learnersCount, irlEventsCount, projectsCount, campuses] = await Promise.all([
      User.countDocuments(),
      Event.countDocuments({ eventType: { $in: ['physical', 'hybrid'] } }),
      ProjectSubmission.countDocuments(),
      CampusAmbassador.distinct('institutionName', { status: 'approved' })
    ]);

    res.render("about", {
      title: "About Page",
      user: req.session.userId ? { username: req.session.username } : null,
      stats: {
        learners: learnersCount,
        projects: projectsCount,
        irlEvents: irlEventsCount,
        campuses: campuses.length
      }
    });
  } catch (err) {
    console.error('[about]', err);
    res.render("about", {
      title: "About Page",
      user: req.session.userId ? { username: req.session.username } : null,
      stats: { learners: 0, projects: 0, irlEvents: 0, campuses: 0 }
    });
  }
});

app.get("/ecosystem", (req, res) => {
  res.render("ecosystem", {
    title: "Ecosystem",
    user: req.session.userId ? { username: req.session.username } : null
  });
});
app.get("/pitch", (req, res) => {
  res.render("pitch", { 
    title: "Pitch Deck",
    user: req.session.userId ? { username: req.session.username } : null
  });
});

app.get("/irl", (req, res) => {
  res.render("irl", {
    title: "Events - ONBOARD3",
    user: req.session.userId ? { username: req.session.username } : null
  });
});

// Public events list page
app.get("/events", (req, res) => {
  res.render("irl", {
    title: "Events - ONBOARD3",
    user: req.session.userId ? { username: req.session.username } : null
  });
});

// Public event details page (non-auth)
app.get("/events/:eventId", (req, res) => {
  res.render("event-details-public", {
    title: "Event Details",
    eventId: req.params.eventId,
    user: req.session.userId ? { username: req.session.username, _id: req.session.userId } : null,
    isAuthenticated: !!req.session.userId
  });
});

app.get("/partner", (req, res) => {
  res.render("partner", { 
    title: "Partnership Page",
    user: req.session.userId ? { username: req.session.username } : null
  });
});
app.get("/dashboard/referral", isAuthenticated, (req, res) => {
  res.redirect('/dashboard/referral/');
});
app.get("/dashboard/quest", isAuthenticated, (req, res) => {
  res.redirect('/dashboard/quest/');
});

app.get("/dashboard/quest-details/:questId", isAuthenticated, (req, res) => {
  res.redirect(`/dashboard/quest/${req.params.questId}`);
});

app.get("/dashboard/events", (req, res) => {
  res.render("dashboard/event", {
    title: "Events",
    user: req.session.userId ? { username: req.session.username } : null
  });
});

app.get("/dashboard/learn", isAuthenticated, (req, res) => {
  res.render("dashboard/learn", { 
    title: "Learn",
    user: req.session.userId ? { username: req.session.username } : null
  });
});
app.get("/dashboard/settings", isAuthenticated, (req, res) => {
  res.render("dashboard/settings", { 
    title: "Learn",
    user: req.session.userId ? { username: req.session.username } : null
  });
});


app.get("/dashboard/events/:eventId", (req, res) => {
  res.render("dashboard/event-details", {
    title: "Event Details",
    eventId: req.params.eventId,
    user: req.session.userId ? { username: req.session.username } : null
  });
});

app.get("/dashboard/campus-ambassador", isAuthenticated, (req, res) => {
  res.render("dashboard/campus-ambassador", { 
    title: "Campus Ambassador",
    user: req.session.userId ? { username: req.session.username } : null
  });
});



app.get("/auth", (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render("auth", {
    title: "Authentication Page"
  });
});

// ── Redirect old /q/:slug links to dashboard quest details ───────────────────
app.get('/q/:slug', async (req, res) => {
  try {
    const Quest = require('./models/Quest');
    const quest = await Quest.findOne({ slug: req.params.slug }).select('_id').lean();
    if (quest) return res.redirect('/dashboard/quests/' + quest._id);
    res.redirect('/dashboard/quests');
  } catch (err) {
    res.redirect('/dashboard/quests');
  }
});

// ── Verify access code (AJAX): POST /api/quests/:questId/apply-code ──────────
app.post('/api/quests/:questId/apply-code', async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: false, message: 'Login required' });
    const Quest = require('./models/Quest');
    const quest = await Quest.findById(req.params.questId).lean();
    if (!quest || !quest.gated || !quest.accessCode) return res.json({ success: false, message: 'Quest not found' });
    const submitted = (req.body.code || '').trim().toUpperCase();
    const correct   = (quest.accessCode || '').trim().toUpperCase();
    if (submitted !== correct) return res.json({ success: false, message: 'Invalid code' });
    res.json({ success: true });
  } catch (err) {
    console.error('[apply-code] error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── Submit application (AJAX): POST /api/quests/:questId/apply ───────────────
app.post('/api/quests/:questId/apply', async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: false, message: 'Login required' });
    const Quest            = require('./models/Quest');
    const QuestApplication = require('./models/QuestApplication');
    const quest = await Quest.findById(req.params.questId).lean();
    if (!quest) return res.json({ success: false, message: 'Quest not found' });
    const existing = await QuestApplication.findOne({ questId: quest._id, userId: req.session.userId }).lean();
    if (existing) return res.json({ success: false, message: 'Already applied' });
    const { xHandle, telegramUsername } = req.body;
    await QuestApplication.create({
      questId: quest._id,
      userId: req.session.userId,
      xHandle: (xHandle || '').trim(),
      telegramUsername: (telegramUsername || '').trim(),
      status: 'pending'
    });
    res.json({ success: true, message: 'Application submitted!' });
  } catch (err) {
    console.error('[apply] error:', err);
    res.json({ success: false, message: 'Server error' });
  }
});

// ── AI Support Chat ───────────────────────────────────────────────────────────
const ChatConversation = require('./models/ChatConversation');

function getDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(require('path').join(__dirname, '.env'), 'utf8');
    const m = raw.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch(_) { return null; }
}

async function callDeepSeek(messages, systemPrompt) {
  const key = getDeepSeekKey();
  if (!key) return null;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 600,
      temperature: 1.3,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  if (!res.ok) throw new Error('DeepSeek API error: ' + res.status);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ── Tope knowledge engine ────────────────────────────────────────────────────
function topeReply(text) {
  const t = text.toLowerCase().trim();
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── Casual greetings & vibes ──
  if (/^(bro|bruh|bro\?+|bruh\?+|guy|sis|fam|g|dawg|yo+|yoo+)[\s!?.]*$/.test(t))
    return pick([
      "Yooo! What's good? I'm Tope — ask me anything about ONBOARD3 and I got you 😄",
      "Haha hey! I'm Tope, your ONBOARD3 guide. What can I help you with bro?",
      "Ayy! I'm Tope. Talk to me — what do you need to know about ONBOARD3?",
    ]);

  if (/^(hi|hey|hello|sup|hiya|howdy|ello|helo|hii+|heyyy*|wsg|what'?s? good|what is good|wassup|wazzup)[\s!?,. bro fam]*$/.test(t) ||
      /^(good (morning|afternoon|evening|day)|morning|afternoon|evening)[\s!?.bro]*$/.test(t) ||
      /^(hello|hey|hi) (bro|there|guys?|fam|friend|tope|everyone)[\s!?.]*$/.test(t))
    return pick([
      "Hey hey! 👋 I'm Tope, your ONBOARD3 guide. What can I help you with today?",
      "Heyy! Welcome — I'm Tope. Ask me anything about the platform and I've got you!",
      "Hey! I'm Tope, happy to answer anything about ONBOARD3 — what's on your mind?",
      "Hiii! Good to see you here. I'm Tope — your go-to for everything ONBOARD3. What do you need?",
    ]);

  if (/how are (you|u)|how r u|how you doing|you good|you okay|u okay|how'?s? (it going|life|things?)|what'?s? up with you/i.test(t))
    return pick([
      "I'm doing amazing — always happy when someone comes to chat! How about you? What brings you here today?",
      "Honestly great, thanks for asking! I'm here and ready to help with anything ONBOARD3. What's on your mind?",
      "Vibing! 😄 Always good when community members drop in. What can I help you with?",
      "I'm good bro, thanks! Never gets old helping people figure out this platform. What do you need?",
    ]);

  if (/^(what'?s? (good|up|new|it|happening|cracking|popping)|wsg|what'?s? the (move|vibe|deal))[\s!?.]*$/i.test(t))
    return pick([
      "Everything is good on my end! I'm Tope by the way — your ONBOARD3 guide. Got questions about the platform? Ask away!",
      "All good over here! I'm Tope — ready to help you with anything on ONBOARD3. What do you want to know?",
      "It's all good! What's up with you — anything you need help with on ONBOARD3?",
    ]);

  // ── Identity ──
  if (/who are you|what are you|your name|are you (an? )?(ai|bot|robot|human|real|person)|are you tope|who('?s| is) tope/i.test(t))
    return pick([
      "I'm Tope! ONBOARD3's in-house community guide. I know everything about this platform and I'm here to help you navigate, earn, and grow. What do you need?",
      "Ha, good question! I'm Tope — think of me as your personal ONBOARD3 assistant. Quests, bounties, XP, roles, campaigns — I know it all. What's up?",
      "I'm Tope, your guide here at ONBOARD3! Here to make sure you get the most out of the platform. Ask me anything!",
    ]);

  // ── What is ONBOARD3 ──
  if (/what (is|are|'?s) onboard3|what (is|are|'?s) this (platform|site|app|place)|tell me about onboard3|explain onboard3|onboard3 (is|mean|about)|what does onboard3 do/i.test(t))
    return pick([
      "ONBOARD3 is a Web3 community platform built to onboard people into the Stacks and Bitcoin ecosystem. You complete quests and bounties to earn XP and USDC, level up your role, and become part of a growing Web3 community. It's basically your home base for everything Web3!",
      "Okay so basically ONBOARD3 is where you learn, earn, and grow in Web3 — specifically the Stacks and Bitcoin ecosystem. You earn XP through quests and daily check-ins, claim USDC through bounties, invite friends for bonus XP, and work your way up through roles. Head to /dashboard to get started!",
      "ONBOARD3 is a Web3 onboarding community — the whole thing runs on four pillars: Learn, Earn, Build, and Onboard. The Earn side is what most people are here for — quests give you XP, bounties give you actual USDC, and there are campaigns with prize pools too. Pretty exciting honestly!",
    ]);

  // ── How to make money / earn ──
  if (/how (to|do i|can i) (make|earn) (money|cash|crypto|usdc|\$)|make money|how to earn|how to make|ways? to earn|ways? to make|how can i earn|can i (make|earn)|is there (money|earning)|how do (i|you|people|members) earn/i.test(t))
    return pick([
      "There are a few solid ways to earn on ONBOARD3! Quests earn you XP which levels up your role, bounties pay you actual USDC for completing real work tasks, and referring friends earns you bonus XP too. For real money, bounties are your best bet — check them out at /dashboard/bounties!",
      "Good question! You earn in two main ways here — XP (from quests, check-ins, referrals) which levels up your role and unlocks perks, and USDC (from bounties and campaign rewards) which is actual money. Start with quests at /dashboard/quests and check bounties at /dashboard/bounties!",
      "Honestly there are multiple ways — quests give you XP for doing social tasks, bounties pay real USDC for doing actual work like content or dev tasks, campaigns like Apex Raiders have prize pools, and referring friends earns you bonus XP. The combo of all of them is where the real value stacks up!",
    ]);

  // ── XP ──
  if (/\bxp\b|experience point|earn xp|get xp|xp work|what is xp|what'?s xp|how (does|do) xp/i.test(t))
    return pick([
      "XP is basically your score on ONBOARD3! You earn it by completing quests, checking in every day, referring friends, and doing bounties. The more XP you stack, the higher your role gets — and higher roles unlock more perks and recognition in the community.",
      "XP is what drives your progression here. Quests give the most, daily check-ins keep it flowing, referrals add a nice bonus, and bounties contribute too. Hit /dashboard/quests to start stacking!",
      "Think of XP as your community rank points. Earn it through quests (/dashboard/quests), daily check-ins, referrals, and bounties. The more you earn, the higher your role gets — Citizen all the way up to Core Team!",
    ]);

  // ── Roles ──
  if (/\brole[s]?\b|level up|rank up|citizen|contributor|captain|maxi|legend|major|core.?team|progression|rank|badge|title/i.test(t))
    return pick([
      "The role ladder goes: Citizen (0–9,999 XP) → Contributor (10,000–24,999) → Captain (25,000–49,999) → Maxi → Legend → Major → Core Team. Each step up means more status and perks in the community. Keep stacking XP!",
      "Roles are based on your XP: Citizen → Contributor → Captain → Maxi → Legend → Major → Core Team. You can check where you're at on your profile at /dashboard/profile. Higher roles unlock more opportunities — keep grinding!",
      "You level up automatically as you earn XP! The ranks go Citizen → Contributor → Captain → Maxi → Legend → Major → Core Team. Every level up gets recognised in the community. Your profile at /dashboard/profile shows your current role and XP.",
    ]);

  // ── Quests ──
  if (/\bquest[s]?\b|what (are|is) quest|how (do|does) quest|quest work|complete task[s]?|social task[s]?/i.test(t) && !/bounty|apex|campaign|gated|access code/i.test(t))
    return pick([
      "Quests are ONBOARD3's main earning activity! Each quest has a set of tasks — things like following on X, joining Telegram, or creating content. Complete each task and earn XP, finish the whole quest and get a bonus. Browse everything at /dashboard/quests!",
      "So quests are basically structured task lists — you follow accounts, join communities, create content, all that. Each completed task earns you XP and some quests even have leaderboards with prizes for top performers. Head to /dashboard/quests to see what's live right now!",
      "Quests are how most members earn XP. Pick a quest, complete the tasks inside (social follows, content creation, engagement, etc.), and XP gets added for each one you finish. Some quests also give USDC on top. Check /dashboard/quests to get started!",
    ]);

  // ── Bounties ──
  if (/\bbount(y|ies)\b|what (are|is) bount|how (do|does) bount|\busdc\b|real (money|work|cash)|paid (work|task|gig)|how (to|do i|can i) (get paid|earn usdc|earn \$)/i.test(t))
    return pick([
      "Bounties are where you earn actual USDC! They're real tasks posted by Web3 projects — design work, content writing, development, research, whatever. You claim a bounty, do the work, submit proof, and get paid in USDC when it's approved. Check them at /dashboard/bounties!",
      "Bounties are paid gigs from partner projects — the best way to earn real money on ONBOARD3. Claim one, do the work, submit your proof, and collect USDC on approval. If you have skills to offer this is 100% worth exploring. Go to /dashboard/bounties to see what's available!",
      "So bounties are actual paying tasks from Web3 companies on the platform. You claim a task, complete it, submit evidence, and get USDC paid to your wallet once the team approves it. Way more lucrative than quests if you've got skills. Check /dashboard/bounties!",
    ]);

  // ── Referrals ──
  if (/refer(r(al|ed|ing)?)?|invite (friend|people|someone|others)|my (referral |invite )?link|bring (friend|people)|referral code|share (my |your )?(link|code)/i.test(t))
    return pick([
      "Your referral link is your personal invite link — every time someone signs up through it, you earn bonus XP automatically. It's passive earning at its finest! Find your link and track signups at /dashboard/referral.",
      "Referrals are honestly one of the easiest ways to earn XP. You get a unique link at /dashboard/referral — share it and every person who joins through it gives you bonus XP. The more people you bring in the more you earn!",
      "Every member gets a unique referral code — grab yours at /dashboard/referral and start sharing. Each signup through your link earns you XP without you having to do anything extra. Great passive income strategy on this platform!",
    ]);

  // ── Check-in / streak ──
  if (/check.?in|daily (check|reward|xp|bonus)|streak|log.?in (every|daily)|daily login/i.test(t))
    return pick([
      "Daily check-ins are one of the easiest XP sources on the platform! Just hit the check-in button on your main dashboard every day. The longer your streak, the bigger the bonus. Don't skip days or you'll reset it!",
      "Check-in every day from /dashboard and your streak builds up. Each day you maintain the streak adds more XP than the last. Takes literally 2 seconds and adds up massively over time — don't sleep on it!",
      "The daily check-in is on your main dashboard — one click per day builds your streak and earns you XP. Consistent daily check-ins stack up way faster than you'd think. Keep the streak alive!",
    ]);

  // ── Apex / campaigns ──
  if (/apex|apex raider|campaign|gated quest|access code|special (quest|campaign)|raider/i.test(t))
    return pick([
      "The Apex Raiders Campaign is ONBOARD3's exclusive gated competition — big prize pool, daily tasks, and a leaderboard where top performers win real rewards. To join: get an access code → go to the quest page → enter your code + X handle + Telegram → wait for approval. Once approved, start completing tasks and climbing the leaderboard!",
      "Apex Raiders is our premium invite-only campaign with a real prize pool. You need an access code to apply, enter it with your socials (X and Telegram), then wait for approval. After that it's daily tasks and leaderboard grinding — top raiders split the prize pool at the end!",
    ]);

  // ── Leaderboard ──
  if (/leaderboard|leader.?board|ranking[s]?|top (user|member|raider|player)|who('?s| is) (winning|top|number one|#1|leading|ahead)/i.test(t))
    return pick([
      "The main leaderboard is at /leaderboard — it ranks members by XP. The more active you are with quests, daily check-ins, and referrals, the higher you climb. Campaign leaderboards live inside the quest itself!",
      "Check the leaderboard at /leaderboard to see where you stand! It's all XP-based so keep completing quests, doing daily check-ins, and referring people to climb the ranks. The top members there are grinding hard!",
    ]);

  // ── Profile / settings ──
  if (/profile|setting[s]?|username|wallet (address)?|connect (x|twitter|telegram|socials?)|profile pic(ture)?|avatar|change (my|name|username)|update (my|profile)/i.test(t))
    return pick([
      "Your profile is at /dashboard/profile — shows your XP, role, quest history and stats. Head to /dashboard/settings to connect your X (Twitter) and Telegram accounts (needed for most quest tasks!), update your profile pic, and save your wallet address.",
      "Settings at /dashboard/settings is where you link your socials (X and Telegram — required for a lot of quests), add your wallet address, and customise your profile. Your full stats and history live at /dashboard/profile!",
    ]);

  // ── Events ──
  if (/event[s]?|meetup|irl (event)?|community event|web3 event|workshop|conference/i.test(t))
    return pick([
      "ONBOARD3 runs community events — IRL meetups, Web3 workshops, online sessions and more. See everything coming up at /dashboard/events. Attending events earns you XP too!",
      "Events are a big part of the community! Check /dashboard/events for what's coming up. There are both online sessions and IRL meetups, and showing up earns you XP on top of the experience itself.",
    ]);

  // ── Withdrawal / payout ──
  if (/withdraw|cash out|pay(ment|out|check)|how do i get paid|when (do i get|will i get|am i) paid|payout|transfer (my )?(usdc|money|earnings)/i.test(t))
    return pick([
      "For USDC payouts, make sure your wallet address is saved in Settings (/dashboard/settings) first. Then reach out to the team through this chat and they'll walk you through the withdrawal process — it's handled manually right now!",
      "Withdrawals are processed by the ONBOARD3 team. Save your wallet address at /dashboard/settings and then send a message here. They'll get back to you and sort out the payout. Make sure your address is correct before requesting!",
    ]);

  // ── Ambassador ──
  if (/ambassador|campus (ambassador|rep|program)|university (rep|program)|represent onboard|student (rep|program)/i.test(t))
    return pick([
      "The Campus Ambassador program is for university students who want to represent ONBOARD3 and onboard others into Web3. If you're interested, reach out to the team through this chat and they'll give you the details on how to apply!",
    ]);

  // ── Getting started / new user ──
  if (/where (do i|to) start|how (do i|to) (start|begin|get started|use (this|onboard))|new (here|user|member|to (this|onboard))|just (joined|signed up|registered)|getting started|first (time|step[s]?)|what (do i|should i) do (first|now)/i.test(t))
    return pick([
      "Welcome to ONBOARD3! Best first moves: 1) Do your daily check-in on /dashboard, 2) Connect your X and Telegram in /dashboard/settings (needed for most quest tasks), 3) Browse quests at /dashboard/quests and pick one to start. That'll get your XP rolling from day one!",
      "Great time to get started! Head to /dashboard and do your first check-in, then connect your socials in Settings (/dashboard/settings) — that unlocks most quest tasks. After that browse /dashboard/quests and grab your first quest. Your referral link is at /dashboard/referral too — start sharing it!",
      "If you're new, here's the quick path: do your daily check-in (/dashboard), connect X and Telegram in Settings, jump into a quest (/dashboard/quests), and share your referral link (/dashboard/referral) to earn passive XP. Boom — you're earning from day one!",
    ]);

  // ── Help / what can you do ──
  if (/^(help|help me|i need help)[\s!?.]*$|what can (you|tope) (do|help|tell|answer)|what (should|can) i ask|what do you know|what questions can i ask/i.test(t))
    return pick([
      "I can answer pretty much anything about ONBOARD3! Ask me about quests, bounties, how to earn XP, roles and progression, the Apex Raiders campaign, referrals, daily check-ins, events, profile settings, withdrawals — you name it. What do you want to know?",
      "Ask away! I know everything about ONBOARD3 — how to earn, what quests and bounties are, the role progression system, the Apex campaign, referrals, events, settings, all of it. What's on your mind?",
    ]);

  // ── Web3 confusion / what is Web3 / Bitcoin / Stacks ──
  if (/what (is|are|'?s) web3|what (is|are|'?s) (blockchain|crypto|bitcoin|stacks|defi|nft)|web3 (explained|meaning|basics?)|crypto (basics?|explained|beginner)/i.test(t))
    return pick([
      "Web3 is basically the next version of the internet — one that's built on blockchain technology and gives users more ownership and control over their data and money. Stacks is a layer built on top of Bitcoin that enables smart contracts and apps. ONBOARD3 is built to help people learn and get involved in this space!",
      "So Web3 is the decentralised internet era — blockchains, digital ownership, crypto, all of that. Bitcoin is the OG cryptocurrency and Stacks is a blockchain that builds on top of Bitcoin. ONBOARD3 is here to onboard you into this ecosystem through quests, bounties, events and community. It's a great place to start!",
    ]);

  // ── Positive reactions / thanks ──
  if (/^(thank(s| you)+|thx|ty|cheers|appreciate (it|that|you)|you'?re? (the best|amazing|great|helpful|awesome)|that('?s? | )(helped|great|perfect|awesome|cool|nice|fire)|got it|understood|makes? sense|okay (cool|got it|thanks)|alright cool)[\s!.😊🙏]*$/i.test(t))
    return pick([
      "Of course! That's what I'm here for 😊 Feel free to come back anytime.",
      "Anytime! Good luck out there — go stack that XP 🚀",
      "Happy to help! If you ever need anything else, just shout.",
      "Always! You've got this — the community is rooting for you 🙌",
    ]);

  // ── Boredom / just chatting ──
  if (/^(bored|nothing|just (chatting|talking|here|browsing|checking)|just wanted to say|testing|test)[\s!?.]*$/i.test(t))
    return pick([
      "Ha, well since you're here — have you done your daily check-in yet? Takes 2 seconds and keeps your XP streak going! Also check /dashboard/quests if you want something to do 😄",
      "Nothing wrong with a vibe check! While you're here though — /dashboard/quests has some active quests you can jump into and start earning. Just saying 😄",
      "Haha fair enough! Well I'm always here if you have questions. But if you're bored, /dashboard/quests is calling your name — easy XP waiting for you!",
    ]);

  // ── Complaints / bugs ──
  if (/complain|issue|problem|bug|broken|wrong|error|not working|can'?t|glitch|stuck|something('?s)? (wrong|off|broken)|it'?s? (broken|not working)/i.test(t))
    return pick([
      "Ah, sorry to hear that! Can you tell me more about what's happening? The more detail the better — what page are you on, what were you trying to do, and what exactly went wrong? I'll make sure the team sees it.",
      "Ugh that's not ideal — thanks for flagging it though! What's the issue exactly? If you give me more details I can pass it on to the team and they'll get it sorted for you.",
    ]);

  // ── General smart fallback — try to redirect to platform value ──
  return pick([
    "Hmm, I might not have a specific answer for that one — but if it's about earning, quests are at /dashboard/quests, bounties at /dashboard/bounties, and referrals at /dashboard/referral. If it's something account-specific, just describe the issue and I'll do my best to help!",
    "Not 100% sure on that but let me try — are you asking about how to earn here, how quests work, or something with your account? Give me a bit more context and I'll answer as best I can!",
    "Could you say a bit more? I know everything about ONBOARD3 — quests, bounties, XP, roles, campaigns, referrals, you name it — so if you rephrase I'll definitely have an answer for you 😄",
    "I want to make sure I give you the right answer! Are you asking about earning, your account, quests, bounties, the Apex campaign, or something else? Hit me with more details!",
  ]);
}

const ONBOARD3_SYSTEM = `You are Tope — ONBOARD3's in-house community guide and AI friend. You live inside the ONBOARD3 platform and your whole job is to make every member feel supported, informed, and excited to grow on the platform.

Your personality and style — READ THIS CAREFULLY:
- You are warm, upbeat, and genuinely enthusiastic. You love the community and it shows.
- You talk exactly like a real human friend texting someone. Casual, natural, no stiffness.
- NEVER use markdown formatting. No **bold**, no *italics*, no bullet points with dashes or asterisks, no headers, no numbered lists with dots. Just plain conversational sentences.
- Write the way people actually talk. Use commas and "and" instead of bullet points. Say things like "okay so basically...", "honestly though", "the cool thing is", "so here's how it works —". Natural flow only.
- You vary how you phrase things every single time. Never give a copy-paste reply.
- Keep it short and human — 2 to 4 sentences usually. Only go longer if the question is genuinely complex, and even then keep it conversational, not a list.
- You are always honest. If you don't know something, say so warmly and suggest contacting the team.
- No corporate speak. No robotic phrasing. Sound like a real person who actually uses and loves the platform.

ONBOARD3 Platform — Full Knowledge Base:

IDENTITY & MISSION:
ONBOARD3 is a Web3 community platform that onboards people into the Stacks / Bitcoin ecosystem. The four pillars of the ecosystem are LEARN → EARN → BUILD → ONBOARD.

THE FOUR PILLARS:
1. LEARN — Education hub. Academy and Courses are coming soon. This is where members will build Web3 knowledge.
2. EARN — The active earning engine:
   - Quests: Tasks that reward XP and sometimes USDC. Go to /dashboard/quests
   - Bounties: Real work tasks posted by partner companies, rewarded in USDC. Go to /dashboard/bounties
   - Referrals: Invite friends with your referral link to earn bonus XP. Go to /dashboard/referral
3. BUILD — Coming soon. Will let members build and launch Web3 projects within the community.
4. ONBOARD — The IRL and community layer:
   - Events: Community meetups and Web3 events. Go to /dashboard/events
   - Partnership: Businesses and projects can partner with ONBOARD3. Go to /dashboard/partnership
   - Campus Ambassador program: For university reps who onboard students

XP & ROLE SYSTEM:
- XP is earned through Quests, daily Check-ins, completing Bounties, and Referrals
- Role progression (XP thresholds): Citizen (0–9,999) → Contributor (10,000–24,999) → Captain (25,000–49,999) → Maxi → Legend → Major → Core Team
- Your role unlocks new opportunities and shows your status in the community
- Check in daily from your Dashboard home to build your streak and earn bonus XP

QUESTS:
- Regular Quests have tasks like following on X, joining Telegram, creating content, etc.
- Each task earns XP. Completing all tasks in a quest gives bonus XP
- Special Campaigns (like Apex Raiders) are exclusive gated quests — you need an access code and admin approval to join
- Quest leaderboards exist — top performers are recognised
- Go to /dashboard/quests to see all available quests

BOUNTIES:
- Bounties are real tasks posted by Web3 projects and partner companies
- You claim a bounty, complete the work, submit proof, and earn USDC on approval
- Great for people who want to earn while contributing to real projects
- Go to /dashboard/bounties

SPECIAL CAMPAIGNS (e.g. Apex Raiders):
- These are exclusive gated campaigns with big prize pools
- To join: get an access code → enter it on the quest page → provide your X handle and Telegram → wait for admin approval
- Once approved, you can participate and compete for prizes
- Apex Raiders ran for one week, so its $100 pool is shared equally among ranks 1 through 20 ($5 each). Rewards have not yet been disbursed.

REFERRALS:
- Every member has a unique referral link/code
- When someone signs up using your link, you earn bonus XP
- Check your referral stats and link at /dashboard/referral

PROFILE & SETTINGS:
- Your profile shows your XP, role, quest progress, and activity — /dashboard/profile
- In Settings (/dashboard/settings), you can connect your X (Twitter) and Telegram accounts — this is required for many quests
- You can also update your profile picture, username, and wallet address in Settings

ACTIVITY FEED:
- See what's happening across the whole community at /dashboard/activity
- Role upgrades, USDC earned, quest completions from other members show up here

LEADERBOARD:
- Track your rank against other community members at /leaderboard

SUPPORT & COMPLAINTS:
- If a user has a complaint, bug report, or serious issue: acknowledge it warmly and empathetically, thank them for flagging it, ask for any extra details that would help the team investigate, and let them know the team will review it within 24–48 hours
- Never dismiss complaints — they matter and the team takes them seriously

THINGS TO NEVER DO:
- Never invent features, policies, or numbers that aren't in this knowledge base
- Never be dismissive or rushed
- Never give the exact same phrasing twice in a conversation
- Never answer off-topic questions unrelated to ONBOARD3 — redirect warmly

Quick navigation cheatsheet you can share:
Dashboard → /dashboard | Quests → /dashboard/quests | Bounties → /dashboard/bounties | Referral → /dashboard/referral | Events → /dashboard/events | Profile → /dashboard/profile | Settings → /dashboard/settings | Activity → /dashboard/activity | Leaderboard → /leaderboard`;


app.get('/api/support/history', async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: false, messages: [] });
    const convo = await ChatConversation.findOne({ userId: req.session.userId }).lean();
    res.json({ success: true, messages: convo ? convo.messages : [] });
  } catch (err) {
    res.json({ success: false, messages: [] });
  }
});

app.get('/api/support/unread', async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ count: 0 });
    const convo = await ChatConversation.findOne({ userId: req.session.userId }).select('unreadByAdmin').lean();
    res.json({ count: convo ? (convo.unreadByAdmin || 0) : 0 });
  } catch (err) {
    res.json({ count: 0 });
  }
});

app.post('/api/support/message', async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: false, message: 'Login required' });
    const text = (req.body.message || '').trim().slice(0, 500);
    if (!text) return res.json({ success: false, message: 'Empty message' });

    let convo = await ChatConversation.findOne({ userId: req.session.userId });
    if (!convo) convo = new ChatConversation({ userId: req.session.userId, messages: [] });

    const isComplaint = /complain|issue|problem|bug|broken|wrong|error|not working|cant|can't|frustrated|upset/i.test(text);
    convo.messages.push({ role: 'user', content: text, isComplaint });
    if (isComplaint) convo.hasComplaint = true;
    convo.unreadByAdmin += 1;

    // Build message history for Claude (last 10 exchanges)
    const history = convo.messages.slice(-20)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const reply = topeReply(text, convo.messages);
    convo.messages.push({ role: 'assistant', content: reply });
    convo.lastMessageAt = new Date();
    await convo.save();

    res.json({ success: true, reply });
  } catch (err) {
    console.error('[support chat]', err);
    res.json({ success: false, message: 'Server error', reply: 'Sorry, I\'m having trouble right now. Please try again shortly.' });
  }
});

// Global error handler — catches any unhandled error thrown in route handlers
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ success: false, message: err.message || 'Internal server error' });
  }
  res.status(status).send('Internal server error');
});

module.exports = app;
