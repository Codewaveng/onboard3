const axios  = require('axios');
const Bounty               = require('../models/Bounty');
const BountySubmission     = require('../models/BountySubmission');
const ThirdPartySubmission = require('../models/ThirdPartySubmission');
const User                 = require('../models/User');
const { notify }           = require('../utils/notificationService');

const ZAD_API     = 'https://zeroauthoritydao.com/api';
const ZAD_KEY     = process.env.ZAD_API_KEY || 'za_6b32ad87454525c5dff45303fea490ca6774c1b8f7c2fe4cea48f6c4d6818b1f';
const ZAD_HEADERS = () => ({ Authorization: `Bearer ${ZAD_KEY}`, 'Content-Type': 'application/json' });

// ── Token price cache (10 min TTL) ───────────────────────────────────────────
let _priceCache   = {};
let _priceCacheAt = 0;
// Maps token symbol → CoinGecko ID (known tokens only)
// Keep keys normalized to uppercase: normalizeTokenSymbol() returns SBTC.
const GECKO_IDS = { STX: 'blockstack', BTC: 'bitcoin', SBTC: 'bitcoin', ETH: 'ethereum' };
const LEO_TENERO_TOKEN = 'https://api.tenero.io/v1/stacks/tokens/SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token';
const LEO_DIA_ASSET = 'https://api.diadata.org/v1/assetQuotation/Stacks/SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token';
// Stablecoins always $1
const STABLES   = new Set(['USDC','USDT','DAI','BUSD','TUSD']);
const normalizeTokenSymbol = (symbol) => String(symbol || '').replace(/^\$/, '').trim().toUpperCase();

async function getTokenPrices(symbols) {
  const now = Date.now();
  const needsLeoPrice = symbols.some(s => normalizeTokenSymbol(s) === 'LEO');
  const cacheCoversSymbols = symbols.every(s => {
    const symbol = normalizeTokenSymbol(s);
    return STABLES.has(symbol) || Number(_priceCache[symbol]) > 0;
  });
  if (now - _priceCacheAt < 10 * 60 * 1000 && cacheCoversSymbols && (!needsLeoPrice || _priceCache.LEO)) return _priceCache;
  const ids = [...new Set(symbols.map(s => GECKO_IDS[normalizeTokenSymbol(s)]).filter(Boolean))];
  const prices = {};
  if (ids.length) {
    try {
      const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: { ids: ids.join(','), vs_currencies: 'usd' }, timeout: 6000
      });
      for (const [sym, id] of Object.entries(GECKO_IDS)) {
        if (res.data[id]) prices[sym] = res.data[id].usd;
      }
    } catch {}
  }
  if (needsLeoPrice) {
    try {
      const leo = await axios.get(LEO_TENERO_TOKEN, { timeout: 6000 });
      const leoUSD = Number(leo.data?.data?.price_usd);
      if (Number.isFinite(leoUSD) && leoUSD > 0) prices.LEO = leoUSD;
    } catch {}
    if (!prices.LEO) {
      try {
        const leo = await axios.get(LEO_DIA_ASSET, { timeout: 6000 });
        const leoUSD = Number(leo.data?.Price ?? leo.data?.price);
        if (Number.isFinite(leoUSD) && leoUSD > 0) prices.LEO = leoUSD;
      } catch { if (_priceCache.LEO) prices.LEO = _priceCache.LEO; }
    }
  }
  _priceCache = { ..._priceCache, ...prices };
  _priceCacheAt = now;
  return _priceCache;
}

// Convert totalPayment to USD string, returns null if not possible
function toUSD(amount, symbol, prices) {
  if (!amount || !symbol) return null;
  if (STABLES.has(normalizeTokenSymbol(symbol))) return '$' + Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const price = prices[normalizeTokenSymbol(symbol)];
  if (!price) return null;
  const usd = amount * price;
  if (usd >= 1000) return '$' + Math.round(usd).toLocaleString('en-US');
  return '$' + usd.toFixed(2);
}

function toUSDAmount(amount, symbol, prices) {
  const quantity = Number(amount);
  if (!Number.isFinite(quantity) || !symbol) return 0;
  if (STABLES.has(normalizeTokenSymbol(symbol))) return quantity;
  const price = Number(prices[normalizeTokenSymbol(symbol)]);
  return Number.isFinite(price) && price > 0 ? quantity * price : 0;
}

// ZAD's bounty mechanism names (CustomSplit, XVerification, etc.) describe how
// a bounty is configured. ONBOARD3 surfaces the reward structure consistently
// as either single-winner or multiple-winner.
function getWinnerCategory(bounty) {
  const type = String(bounty?.type || '').replace(/[\s_-]/g, '').toLowerCase();
  if (['multiwinner', 'customsplit', 'top3bidder', 'xverification'].includes(type)) return 'Multiple Winners';
  if (type === 'singlewinner') return 'Single Winner';
  const count = Number(bounty?.winnerCount ?? bounty?.winnersCount ?? bounty?.maxWinners ?? 0);
  return count > 1 ? 'Multiple Winners' : 'Single Winner';
}

// ── ZAD cache (5 min TTL) ─────────────────────────────────────────────────────
let _zadLiveCache   = null; let _zadLiveCacheAt = 0;
let _zadPastCache   = null; let _zadPastCacheAt = 0;

async function getZADBounties() {
  const now = Date.now();
  const liveStale = !_zadLiveCache || now - _zadLiveCacheAt > 5 * 60 * 1000;
  const pastStale = !_zadPastCache || now - _zadPastCacheAt > 5 * 60 * 1000;

  try {
    if (liveStale) {
      // Fetch open (live) bounties — paginate up to 60
      const [p1, p2, p3] = await Promise.allSettled([
        axios.get(`${ZAD_API}/bounties`, { params: { status: 'Open', limit: 20, page: 1 }, headers: ZAD_HEADERS(), timeout: 10000 }),
        axios.get(`${ZAD_API}/bounties`, { params: { status: 'Open', limit: 20, page: 2 }, headers: ZAD_HEADERS(), timeout: 10000 }),
        axios.get(`${ZAD_API}/bounties`, { params: { status: 'Open', limit: 20, page: 3 }, headers: ZAD_HEADERS(), timeout: 10000 })
      ]);
      _zadLiveCache = [
        ...(p1.status === 'fulfilled' ? p1.value.data?.data || [] : []),
        ...(p2.status === 'fulfilled' ? p2.value.data?.data || [] : []),
        ...(p3.status === 'fulfilled' ? p3.value.data?.data || [] : [])
      ];
      _zadLiveCacheAt = now;
    }
    if (pastStale) {
      // Fetch closed/expired bounties
      const [p1, p2] = await Promise.allSettled([
        axios.get(`${ZAD_API}/bounties`, { params: { limit: 20, page: 1, includeExpired: true }, headers: ZAD_HEADERS(), timeout: 10000 }),
        axios.get(`${ZAD_API}/bounties`, { params: { limit: 20, page: 2, includeExpired: true }, headers: ZAD_HEADERS(), timeout: 10000 })
      ]);
      const all = [
        ...(p1.status === 'fulfilled' ? p1.value.data?.data || [] : []),
        ...(p2.status === 'fulfilled' ? p2.value.data?.data || [] : [])
      ];
      _zadPastCache = all.filter(b => b.isExpired || b.status !== 'Open');
      _zadPastCacheAt = now;
    }
  } catch (err) {
    console.error('[ZAD] Error fetching bounties:', err.message);
  }

  return { live: _zadLiveCache || [], past: _zadPastCache || [] };
}

async function getZADBounty(id) {
  try {
    const res = await axios.get(`${ZAD_API}/bounties/${id}`, { headers: ZAD_HEADERS(), timeout: 10000 });
    return res.data;
  } catch (err) {
    console.error('[ZAD] Error fetching bounty:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /dashboard/bounties
exports.listBounties = async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('-password').lean();

    // Internal: live = active + not ended; ended = active but endDate past OR inactive
    const allInternal    = await Bounty.find().sort({ createdAt: -1 }).lean();
    const internalLive   = allInternal.filter(b => b.isActive && (!b.endDate || new Date() < new Date(b.endDate)) && b.status !== 'winners_announced');
    const internalEnded  = allInternal.filter(b => !b.isActive || (b.endDate && new Date() > new Date(b.endDate)) || b.status === 'winners_announced');

    // ZAD partner bounties
    const { live: zadRawLive, past: zadRawPast } = await getZADBounties();

    // Re-classify: a "live" bounty is only truly active if not expired AND deadline hasn't passed
    const now = Date.now();
    const isZADEnded = (b) => {
      if (b.isExpired || b.status !== 'Open') return true;
      const ts = b.deadline || b.endDate ? new Date(b.deadline || b.endDate).getTime() : NaN;
      return !isNaN(ts) && ts < now;
    };
    const zadLive = zadRawLive.filter(b => !isZADEnded(b));
    const zadPast = [...zadRawPast, ...zadRawLive.filter(isZADEnded)];

    // Fetch token prices for all symbols seen in ZAD bounties
    const allZAD = [...zadLive, ...zadPast];
    const symbols = [...new Set([
      ...allZAD.map(b => b.token?.symbol),
      ...allInternal.map(b => b.rewardToken || 'USDC')
    ].filter(Boolean))];
    const prices   = await getTokenPrices(symbols);

    // Attach USD estimates to both internal and ZAD bounties.
    const enrichInternal = (b) => ({
      ...b,
      usdValue: toUSD(b.rewardPool, b.rewardToken || 'USDC', prices)
    });
    const enrichZAD = (b) => ({
      ...b,
      winnerCategory: getWinnerCategory(b),
      usdValue: toUSD(b.totalPayment, b.token?.symbol, prices)
    });

    const activeBountyCount = internalLive.length + zadLive.length;
    const activeBountyRewardUSD = internalLive.reduce((total, bounty) =>
      total + toUSDAmount(bounty.rewardPool, bounty.rewardToken || 'USDC', prices), 0)
      + zadLive.reduce((total, bounty) =>
        total + toUSDAmount(bounty.totalPayment, bounty.token?.symbol, prices), 0);

    res.render('dashboard/bounty', {
      title: 'Bounties — ONBOARD3', user, currentPage: 'bounties',
      internalLive: internalLive.map(enrichInternal),
      internalEnded: internalEnded.map(enrichInternal),
      zadLive: zadLive.map(enrichZAD),
      zadPast: zadPast.map(enrichZAD),
      activeBountyCount, activeBountyRewardUSD
    });
  } catch (err) {
    console.error('[Bounty] listBounties:', err);
    res.status(500).send('Error loading bounties');
  }
};

// GET /dashboard/bounties/internal/:id
exports.internalBountyDetail = async (req, res) => {
  try {
    const user   = await User.findById(req.session.userId).select('-password').lean();
    const bounty = await Bounty.findById(req.params.id).populate('createdBy', 'username').lean();
    if (!bounty || !bounty.isActive) return res.status(404).send('Bounty not found');

    const submissions = await BountySubmission.find({ bountyId: bounty._id })
      .populate('userId', 'username profilePicture')
      .sort({ createdAt: -1 }).lean();

    const mySubmission = submissions.find(s => s.userId?._id?.toString() === req.session.userId) || null;

    const prices = await getTokenPrices([bounty.rewardToken || 'USDC']);
    const bountyUsdValue = toUSD(bounty.rewardPool, bounty.rewardToken || 'USDC', prices);
    bounty.rewardSplit = (bounty.rewardSplit || []).map(split => {
      const amount = split.amount || Math.round(bounty.rewardPool * split.percentage / 100 * 100) / 100;
      return { ...split, usdValue: toUSD(amount, bounty.rewardToken || 'USDC', prices) };
    });

    res.render('dashboard/bounty-details', {
      title: bounty.title + ' — ONBOARD3', user, currentPage: 'bounties',
      bounty: { ...bounty, usdValue: bountyUsdValue }, submissions, mySubmission
    });
  } catch (err) {
    console.error('[Bounty] internalBountyDetail:', err);
    res.status(500).send('Error loading bounty');
  }
};

// POST /dashboard/bounties/internal/:id/submit
exports.submitToInternalBounty = async (req, res) => {
  try {
    const { title, description, submissionUrl } = req.body;
    const bountyId = req.params.id;

    if (!title?.trim() || !description?.trim() || !submissionUrl?.trim()) {
      return res.status(400).json({ success: false, message: 'Title, description, and work URL are required' });
    }

    const bounty = await Bounty.findById(bountyId);
    if (!bounty || !bounty.isActive) {
      return res.status(404).json({ success: false, message: 'Bounty not found' });
    }
    if (bounty.hasEnded()) {
      return res.status(400).json({ success: false, message: 'This bounty has ended. No more submissions.' });
    }

    const existing = await BountySubmission.findOne({ bountyId, userId: req.session.userId });
    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already submitted to this bounty.' });
    }

    await BountySubmission.create({
      bountyId, userId: req.session.userId,
      title: title.trim(), description: description.trim(),
      submissionUrl: submissionUrl?.trim() || null
    });
    await Bounty.findByIdAndUpdate(bountyId, { $inc: { totalSubmissions: 1 } });

    return res.json({ success: true, message: 'Submission received!' });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'You have already submitted to this bounty.' });
    console.error('[Bounty] submitInternal:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// GET /dashboard/bounties/external/:id
exports.externalBountyDetail = async (req, res) => {
  try {
    const user      = await User.findById(req.session.userId).select('-password').lean();
    const bountyId  = req.params.id;
    const zadBounty = await getZADBounty(bountyId);
    if (!zadBounty) return res.redirect('/dashboard/bounties?error=bounty_not_found');

    const mySubmission = await ThirdPartySubmission.findOne({
      externalBountyId: bountyId, userId: req.session.userId
    }).lean();

    const ourSubmissions = await ThirdPartySubmission.find({ externalBountyId: bountyId })
      .populate('userId', 'username profilePicture stacksAddress')
      .sort({ createdAt: -1 }).lean();

    // Match ZAD winners to ONBOARD3 users by wallet address
    // ZAD API returns winners with top-level fields: username, address, avatarUrl
    const rawWinners = zadBounty.winners || [];
    let enrichedWinners = rawWinners;
    if (rawWinners.length > 0) {
      const winnerAddresses = rawWinners
        .map(w => w.address || w.submitter?.walletAddress || w.submitterAddress || w.walletAddress)
        .filter(Boolean);
      const winnerUsers = winnerAddresses.length > 0
        ? await User.find({ stacksAddress: { $in: winnerAddresses } })
                    .select('username profilePicture stacksAddress').lean()
        : [];
      enrichedWinners = rawWinners.map(w => {
        const addr = w.address || w.submitter?.walletAddress || w.submitterAddress || w.walletAddress;
        const dbMatch = addr ? winnerUsers.find(u => u.stacksAddress === addr) : null;
        const subMatch = !dbMatch && addr
          ? (ourSubmissions.find(s => s.userId?.stacksAddress === addr) || null)
          : null;
        const onboardUser = dbMatch || (subMatch ? subMatch.userId : null);

        // Extract ONBOARD3 username from summary tag as final fallback
        // Handles: "Submitted by: @username (via ONBOARD3)" and legacy "[username via ONBOARD3]"
        let summaryUsername = null;
        const summary = w.summary || w.submission?.summary || '';
        const m1 = summary.match(/^Submitted by:\s*@([\w.]+)\s*\(via ONBOARD3\)/i);
        const m2 = !m1 && summary.match(/^\[([^\]]+) via ONBOARD3\]/i);
        summaryUsername = m1 ? m1[1] : (m2 ? m2[1] : null);

        const resolvedUsername = onboardUser?.username || summaryUsername;

        // Build full avatar URL for ZAD users (avatarUrl is just a filename)
        const zadAvatar = w.avatarUrl
          ? (w.avatarUrl.startsWith('http') ? w.avatarUrl : `https://zeroauthoritydao.com/uploads/avatars/${w.avatarUrl}`)
          : (w.submitter?.avatarUrl || null);

        return {
          ...w,
          onboardUserId:   onboardUser?._id || null,
          onboardUsername: resolvedUsername || null,
          onboardPfp:      onboardUser?.profilePicture || null,
          zadUsername:     w.username || w.submitter?.username || null,
          zadAvatar,
          isOnboard3:      !!(onboardUser || summaryUsername)
        };
      });

      // Fire-and-forget: sync winner status in ThirdPartySubmission + notify first-time
      ;(async () => {
        for (let ri = 0; ri < enrichedWinners.length; ri++) {
          const ew = enrichedWinners[ri];
          if (!ew.onboardUserId) continue;
          try {
            const sub = await ThirdPartySubmission.findOne({ externalBountyId: bountyId, userId: ew.onboardUserId });
            if (!sub || sub.status === 'winner') continue;
            const perWinner = zadBounty.totalPayment && enrichedWinners.length
              ? Math.round((zadBounty.totalPayment / enrichedWinners.length) * 100) / 100
              : null;
            sub.status      = 'winner';
            sub.bountyName  = sub.bountyName  || zadBounty.name || bountyId;
            sub.amountWon   = sub.amountWon   || perWinner;
            sub.tokenSymbol = sub.tokenSymbol || zadBounty.token?.symbol || null;
            await sub.save();
            const rank = ri + 1;
            const rankLabel = rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `${rank}th`;
            notify(ew.onboardUserId, {
              type: 'reward',
              title: 'You won a bounty!',
              message: `You placed ${rankLabel} in "${zadBounty.name || 'a bounty'}" on ZeroAuthorityDAO!`,
              link: `/dashboard/bounties/external/${bountyId}`
            }).catch(() => {});
          } catch (_) {}
        }
      })().catch(() => {});
    }

    const prices   = await getTokenPrices([zadBounty.token?.symbol].filter(Boolean));
    const usdValue = toUSD(zadBounty.totalPayment, zadBounty.token?.symbol, prices);

    res.render('dashboard/bounty-external', {
      title: (zadBounty.name || 'Bounty') + ' — ONBOARD3', user, currentPage: 'bounties',
      bounty: { ...zadBounty, winnerCategory: getWinnerCategory(zadBounty), usdValue }, mySubmission: mySubmission || null, ourSubmissions,
      enrichedWinners,
      userStacksAddress: user?.stacksAddress || null,
      zadBountyUrl: `https://zeroauthoritydao.com/bounty/${bountyId}`
    });
  } catch (err) {
    console.error('[Bounty] externalBountyDetail:', err);
    res.status(500).send('Error loading bounty');
  }
};

// POST /dashboard/bounties/external/:id/submit
exports.submitToExternalBounty = async (req, res) => {
  try {
    const { summary, submissionUrl } = req.body;
    const bountyId = req.params.id;

    if (!summary?.trim() || !submissionUrl?.trim()) return res.status(400).json({ success: false, message: 'Summary and work URL are required' });
    const existing = await ThirdPartySubmission.findOne({ externalBountyId: bountyId, userId: req.session.userId });
    if (existing) return res.status(400).json({ success: false, message: 'You have already submitted to this bounty.' });

    const zadBounty = await getZADBounty(bountyId);
    if (!zadBounty) return res.status(404).json({ success: false, message: 'Bounty not found on external platform' });
    if (zadBounty.isExpired || zadBounty.status !== 'Open') {
      return res.status(400).json({ success: false, message: 'This bounty is no longer accepting submissions.' });
    }
    if (String(zadBounty.type || '').toLowerCase() === 'xverification' &&
        !/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:[/?#].*)?$/i.test(submissionUrl.trim())) {
      return res.status(400).json({ success: false, message: 'Enter a public X/Twitter post link in the format x.com/username/status/123.' });
    }

    const sw = require('../utils/stacksWallet');

    // Ensure user has a custodial Stacks wallet
    const wallet = await sw.assignWallet(req.session.userId);

    // Create/update the user's ZAD profile so entries show their ONBOARD3 username
    // Done before on-chain submission so the profile exists even if submission fails
    try { await sw.ensureZADProfile(req.session.userId); } catch (e) {
      console.error('[Bounty] ensureZADProfile failed (non-blocking):', e.message);
    }

    // Prefix summary with ONBOARD3 username — visible on ZAD's submission listing
    // even when ZAD profile shows "anonymous" (profile update API is unreliable)
    const submitter = await User.findById(req.session.userId).select('username').lean();
    const taggedSummary = submitter?.username
      ? `Submitted by: @${submitter.username} (via ONBOARD3)\n\n${summary.trim()}`
      : summary.trim();

    // Submit on-chain to ZeroAuthDAO from the user's custodial wallet
    let txId = null;
    let serverSubmissionId = null;
    let serverAccepted = false;
    let relayPending = false;
    let xVerified = null;
    let onChainError = null;
    try {
      const contractHint = {
        contractAddress: zadBounty.submitContractAddress || null,
        contractName:    zadBounty.submitContractName    || null,
        functionName:    zadBounty.submitFunctionName    || null,
      };
      const onChain = await sw.submitBountyOnChain(req.session.userId, bountyId, taggedSummary, submissionUrl?.trim() || null, zadBounty.txId, zadBounty.type, contractHint);
      txId = onChain.txId;
      serverSubmissionId = onChain.zadSubId || null;
      serverAccepted = Boolean(onChain.accepted);
      relayPending = Boolean(onChain.relayPending);
      xVerified = typeof onChain.xVerified === 'boolean' ? onChain.xVerified : null;
    } catch (err) {
      onChainError = err.message;
      console.error('[Bounty] on-chain submit failed:', err.message);
    }

    if (!txId && !serverSubmissionId && !serverAccepted) {
      return res.status(502).json({ success: false, message: 'ZeroAuthDAO did not confirm acceptance. Check its bounty page before retrying to avoid a duplicate.', ...(onChainError ? { error: onChainError } : {}) });
    }

    await ThirdPartySubmission.create({
      platform: 'zeroauthoritydao', externalBountyId: bountyId,
      bountyName: zadBounty.name || '', userId: req.session.userId,
      summary: summary.trim(), submissionUrl: submissionUrl?.trim() || null,
      zadSubmissionId: serverSubmissionId || txId, status: relayPending ? 'pending' : 'submitted',
      xVerified,
    });

    _zadLiveCache = null; _zadLiveCacheAt = 0;

    if (txId || serverSubmissionId || serverAccepted) {
      return res.json({
        success: true,
        pending: relayPending,
        message: relayPending
          ? `Stacks has the sponsored transaction (${txId}), but ZeroAuthDAO has not confirmed its listing yet. We recorded it to prevent a duplicate; do not submit again.`
          : xVerified === false
            ? 'Submission accepted, but X verification was bypassed. ZAD may mark it unverified or ineligible.'
          : 'Submission confirmed by ZeroAuthDAO. Your entry is live.',
        txId,
        submissionId: serverSubmissionId,
        stacksAddress: wallet.address
      });
    } else {
      return res.json({
        success: true,
        message: 'Submission saved. On-chain relay will retry shortly.' + (onChainError ? ' (' + onChainError + ')' : ''),
        stacksAddress: wallet.address
      });
    }
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'You have already submitted to this bounty.' });
    console.error('[Bounty] submitExternal:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

exports.adminListBounties = async (req, res) => {
  try {
    const user     = await User.findById(req.session.userId).select('-password').lean();
    const bounties = await Bounty.find().sort({ createdAt: -1 }).lean();
    res.render('admin/pages/bounties', { user, page: 'bounties', bounties });
  } catch (err) {
    console.error('[Admin Bounty] list:', err);
    res.status(500).send('Error');
  }
};

exports.adminCreateBounty = async (req, res) => {
  try {
    const { title, shortDescription, description, image, category, rewardPool, rewardToken, startDate, endDate, maxSubmissionsPerUser } = req.body;

    const ranks       = [].concat(req.body['split_rank']       || []);
    const labels      = [].concat(req.body['split_label']      || []);
    const percentages = [].concat(req.body['split_percentage'] || []);

    const rewardSplit = ranks.map((r, i) => ({
      rank: parseInt(r) || i + 1, label: labels[i] || `#${i+1}`,
      percentage: parseFloat(percentages[i]) || 0
    })).filter(s => s.percentage > 0);

    const bounty = await Bounty.create({
      title, shortDescription, description, image: image || null,
      category: category || 'other',
      rewardPool: parseFloat(rewardPool) || 0, rewardToken: rewardToken || 'USDC',
      rewardSplit, startDate: startDate || null, endDate: endDate || null,
      maxSubmissionsPerUser: parseInt(maxSubmissionsPerUser) || 1,
      isActive: false, status: 'draft', createdBy: req.session.userId
    });

    res.redirect(`/admin/bounties/${bounty._id}?created=1`);
  } catch (err) {
    console.error('[Admin Bounty] create:', err);
    res.status(500).send('Error: ' + err.message);
  }
};

exports.adminBountyDetail = async (req, res) => {
  try {
    const user   = await User.findById(req.session.userId).select('-password').lean();
    const bounty = await Bounty.findById(req.params.id).lean();
    if (!bounty) return res.status(404).send('Bounty not found');

    const submissions = await BountySubmission.find({ bountyId: bounty._id })
      .populate('userId', 'username profilePicture email')
      .sort({ createdAt: -1 }).lean();

    res.render('admin/pages/bounty-detail', {
      user, page: 'bounties', bounty, submissions, created: req.query.created === '1'
    });
  } catch (err) {
    console.error('[Admin Bounty] detail:', err);
    res.status(500).send('Error');
  }
};

exports.adminToggleBounty = async (req, res) => {
  try {
    const bounty  = await Bounty.findById(req.params.id);
    if (!bounty) return res.status(404).send('Not found');
    bounty.isActive = !bounty.isActive;
    bounty.status   = bounty.isActive ? 'active' : 'ended';
    await bounty.save();
    res.redirect(`/admin/bounties/${bounty._id}`);
  } catch (err) {
    console.error('[Admin Bounty] toggle:', err);
    res.status(500).send('Error');
  }
};

exports.adminAnnounceWinners = async (req, res) => {
  try {
    const bounty = await Bounty.findById(req.params.id);
    if (!bounty) return res.status(404).json({ success: false, message: 'Not found' });

    const subIds = [].concat(req.body.winner_submission || []);
    const winners = [];

    for (let i = 0; i < subIds.length; i++) {
      const sub = await BountySubmission.findById(subIds[i]);
      if (!sub) continue;
      const rank   = i + 1;
      const split  = bounty.rewardSplit.find(s => s.rank === rank);
      const amount = split?.amount || 0;
      sub.status = 'winner'; sub.rank = rank; sub.amountWon = amount;
      await sub.save();
      winners.push({ userId: sub.userId, submissionId: sub._id, rank, amountWon: amount });
    }

    bounty.winners = winners;
    bounty.status  = 'winners_announced';
    await bounty.save();

    // Notify each winner
    for (const w of winners) {
      const rankLabel = w.rank === 1 ? '1st' : w.rank === 2 ? '2nd' : w.rank === 3 ? '3rd' : `${w.rank}th`;
      notify(w.userId, {
        type: 'reward',
        title: 'You won a bounty!',
        message: `You placed ${rankLabel} in "${bounty.title}" and earned ${w.amountWon} USDC!`,
        link: '/dashboard'
      }).catch(() => {});
    }

    return res.json({ success: true, message: 'Winners announced!' });
  } catch (err) {
    console.error('[Admin Bounty] announceWinners:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.adminDeleteBounty = async (req, res) => {
  try {
    await BountySubmission.deleteMany({ bountyId: req.params.id });
    await Bounty.findByIdAndDelete(req.params.id);
    res.redirect('/admin/bounties');
  } catch (err) {
    console.error('[Admin Bounty] delete:', err);
    res.status(500).send('Error');
  }
};
