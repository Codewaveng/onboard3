const bip32   = require('@scure/bip32');
const bip39   = require('@scure/bip39');
const crypto  = require('crypto');
const { wordlist } = require('@scure/bip39/wordlists/english');
const { makeSTXTokenTransfer, makeContractCall, broadcastTransaction, sponsorTransaction, AnchorMode, getAddressFromPrivateKey, stringAsciiCV, uintCV, standardPrincipalCV, noneCV, signWithKey, Pc } = require('@stacks/transactions');
const { signatureVrsToRsv } = require('@stacks/common');
const { STACKS_MAINNET } = require('@stacks/network');
const { getPublicKeyFromPrivate, hashMessage } = require('@stacks/encryption');
const axios  = require('axios');

const HIRO_API    = 'https://api.mainnet.hiro.so';
const STACKS_PATH = "m/44'/5757'/0'/0";
const NETWORK_FEE = BigInt(2000); // 0.002 STX
const USDCX_CONTRACT_ADDRESS = 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE';
const USDCX_CONTRACT_NAME = 'usdcx';
const USDCX_ASSET_PREFIX = `${USDCX_CONTRACT_ADDRESS}.${USDCX_CONTRACT_NAME}::`;
const LEO_CONTRACT_ADDRESS = 'SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6';
const LEO_CONTRACT_NAME = 'leo-token';
const LEO_ASSET_PREFIX = `${LEO_CONTRACT_ADDRESS}.${LEO_CONTRACT_NAME}::`;

// Cache parent HD key in memory — derived once, used for all users
let _parent    = null;
let _parentAt  = 0;

async function getParent() {
  if (_parent) return _parent;
  const mnemonic = process.env.STACKS_MASTER_SEED;
  if (!mnemonic) throw new Error('STACKS_MASTER_SEED not set in environment');
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.HDKey.fromMasterSeed(seed);
  _parent = root.derive(STACKS_PATH);
  return _parent;
}

function derivePrivKey(parent, index) {
  const child = parent.deriveChild(index);
  return Buffer.from(child.privateKey).toString('hex') + '01'; // compressed
}

async function getAddress(index) {
  const parent = await getParent();
  return getAddressFromPrivateKey(derivePrivKey(parent, index));
}

async function getBalance(address, retries = 2) {
  const headers = {};
  if (process.env.HIRO_API_KEY) headers['x-api-key'] = process.env.HIRO_API_KEY;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(`${HIRO_API}/extended/v1/address/${address}/balances`, { timeout: 10000, headers });
      const locked = parseInt(res.data.stx?.locked  || '0');
      const total  = parseInt(res.data.stx?.balance || '0');
      return Math.max(0, total - locked);
    } catch (err) {
      const status = err.response?.status;
      const errMsg = status || err.code || err.message;
      console.error(`[getBalance] attempt ${attempt+1}/${retries+1} failed for ${address.slice(0,10)}...: ${errMsg}`);
      if (attempt < retries) {
        // Wait longer on rate-limit, shorter on other errors
        await new Promise(r => setTimeout(r, status === 429 ? 2500 : 1000));
      }
    }
  }
  return -1;
}

async function getFungibleBalances(address) {
  const headers = {};
  if (process.env.HIRO_API_KEY) headers['x-api-key'] = process.env.HIRO_API_KEY;
  const res = await axios.get(`${HIRO_API}/extended/v1/address/${address}/balances`, { timeout: 10000, headers });
  return Object.entries(res.data.fungible_tokens || {}).map(([assetId, token]) => {
    const parts = assetId.split('::');
    const contract = parts[0] || '';
    const assetName = parts[1] || '';
    const match = /^([A-Z0-9]{30,41})\.([a-zA-Z][a-zA-Z0-9-]{0,39})$/.exec(contract);
    const balance = String(token.balance || '0');
    if (!match || !/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/.test(assetName) || !/^\d+$/.test(balance) || BigInt(balance) <= 0n) return null;
    return { assetId, contractAddress: match[1], contractName: match[2], assetName, balance };
  }).filter(Boolean);
}

async function getUSDCxBalance(address) {
  const tokens = await getFungibleBalances(address);
  const token = tokens.find(t => t.assetId.startsWith(USDCX_ASSET_PREFIX));
  return token ? token.balance : '0';
}
async function getTransactionStatus(txId) {
  const headers = {};
  if (process.env.HIRO_API_KEY) headers['x-api-key'] = process.env.HIRO_API_KEY;
  try {
    const res = await axios.get(`${HIRO_API}/extended/v1/tx/${txId}`, { timeout: 10000, headers });
    return res.data.tx_status || 'pending';
  } catch (err) {
    if (err.response?.status === 404) return 'pending';
    throw err;
  }
}

async function findTransaction(txId, attempts = 3, delayMs = 1500) {
  const headers = {};
  if (process.env.HIRO_API_KEY) headers['x-api-key'] = process.env.HIRO_API_KEY;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios.get(`${HIRO_API}/extended/v1/tx/${txId}`, { timeout: 10000, headers });
      return res.data;
    } catch (err) {
      if (err.response?.status !== 404) throw err;
      if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

async function waitForTransaction(txId, attempts = 24, delayMs = 5000) {
  for (let i = 0; i < attempts; i++) {
    const status = await getTransactionStatus(txId);
    if (status === 'success' || status.startsWith('abort_')) return status;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return 'pending';
}

// STX price cache (10 min TTL)
let _stxPrice = 0, _stxPriceAt = 0;
async function getSTXPrice() {
  if (_stxPrice && Date.now() - _stxPriceAt < 600000) return _stxPrice;
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=blockstack&vs_currencies=usd', { timeout: 6000 });
    _stxPrice   = r.data.blockstack?.usd || 0;
    _stxPriceAt = Date.now();
  } catch {}
  return _stxPrice;
}

// Sweep the supported USDCx SIP-010 token and native STX to the main wallet.
async function sweepWallet(userId) {
  const User = require('../models/User');
  const mainWallet = process.env.STACKS_MAIN_WALLET;
  if (!mainWallet) throw new Error('STACKS_MAIN_WALLET not set');

  const user = await User.findById(userId);
  if (!user || user.stacksWalletIndex == null) throw new Error('User has no Stacks wallet');
  if (user.stacksPendingUSDCxSweep?.txId) {
    const pending = user.stacksPendingUSDCxSweep;
    const status = await getTransactionStatus(pending.txId);
    if (status === 'success') {
      const amount = Number(pending.amount);
      user.usdcBalance = Math.round(((user.usdcBalance || 0) + amount) * 100) / 100;
      if (!user.recentActivity) user.recentActivity = [];
      user.recentActivity.unshift({ action: `USDCx bounty drop swept: $${amount.toFixed(2)} USDC credited`, timestamp: new Date() });
      if (user.recentActivity.length > 10) user.recentActivity = user.recentActivity.slice(0, 10);
      user.usdcxBalance = 0;
      user.stacksPendingUSDCxSweep = null;
      await user.save();
      return { txId: pending.txId, txIds: [pending.txId], sweptTokens: [{ assetId: `${USDCX_ASSET_PREFIX}usdcx-token`, amount: String(Math.round(amount * 1_000_000)), txId: pending.txId }], errors: [], usdcxCredit: amount, pending: false, totalSTX: 0, totalUSD: 0, platformCut: 0, userCredit: 0 };
    }
    if (status.startsWith('abort_')) {
      user.stacksPendingUSDCxSweep = null;
      await user.save();
      throw new Error(`Previous USDCx sweep failed on-chain (${status}); no USDCx balance was credited`);
    }
    return { txId: pending.txId, txIds: [pending.txId], sweptTokens: [], errors: [], usdcxCredit: 0, pending: true, totalSTX: 0, totalUSD: 0, platformCut: 0, userCredit: 0 };
  }
  if (user.stacksPendingLEOSweep?.txId) {
    const pending = user.stacksPendingLEOSweep;
    const status = await getTransactionStatus(pending.txId);
    if (status === 'success') { user.stacksPendingLEOSweep = null; await user.save(); return { txId: pending.txId, txIds: [pending.txId], sweptTokens: [{ assetId: pending.assetId, amount: pending.amount, txId: pending.txId }], errors: [], usdcxCredit: 0, pending: false, totalSTX: 0, totalUSD: 0, platformCut: 0, userCredit: 0 }; }
    if (status.startsWith('abort_')) { user.stacksPendingLEOSweep = null; await user.save(); throw new Error(`Previous LEO sweep failed on-chain (${status})`); }
    return { txId: pending.txId, txIds: [pending.txId], sweptTokens: [], errors: [], usdcxCredit: 0, pending: true, totalSTX: 0, totalUSD: 0, platformCut: 0, userCredit: 0 };
  }
  const privKey = derivePrivKey(await getParent(), user.stacksWalletIndex);
  const address = getAddressFromPrivateKey(privKey);
  const network = STACKS_MAINNET;
  const txIds = [];
  const sweptTokens = [];
  const errors = [];
  let usdcxCredit = 0;
  // Sweep only explicitly supported SIP-010 assets.
  const allTokenBalances = await getFungibleBalances(address);
  const tokenBalances = allTokenBalances.filter(token => token.assetId.startsWith(USDCX_ASSET_PREFIX) || token.assetId.startsWith(LEO_ASSET_PREFIX));
  let nonce;
  if (tokenBalances.length) {
    const headers = {};
    if (process.env.HIRO_API_KEY) headers['x-api-key'] = process.env.HIRO_API_KEY;
    const nonceResponse = await axios.get(`${HIRO_API}/extended/v1/address/${address}/nonces`, { timeout: 10000, headers });
    nonce = BigInt(nonceResponse.data.possible_next_nonce ?? (Number(nonceResponse.data.last_executed_tx_nonce || -1) + 1));
  }
  for (const token of tokenBalances) {
    try {
      const isUSDCx = token.assetId.startsWith(USDCX_ASSET_PREFIX);
      const contractAddress = isUSDCx ? USDCX_CONTRACT_ADDRESS : LEO_CONTRACT_ADDRESS;
      const contractName = isUSDCx ? USDCX_CONTRACT_NAME : LEO_CONTRACT_NAME;
      const unsignedTx = await makeContractCall({
        contractAddress,
        contractName,
        functionName: 'transfer',
        functionArgs: [uintCV(BigInt(token.balance)), standardPrincipalCV(address), standardPrincipalCV(mainWallet), noneCV()],
        senderKey: privKey,
        network,
        anchorMode: AnchorMode.Any,
        nonce,
        sponsored: true,
        postConditions: [Pc.principal(address).willSendEq(BigInt(token.balance)).ft(`${contractAddress}.${contractName}`, token.assetName)],
      });
      // The user's wallet pays no STX: sponsor USDCx transfer gas from the
      // existing ONBOARD3 fee wallet.
      const tx = await sponsorTransaction({
        transaction: unsignedTx,
        sponsorPrivateKey: await getFeeKey(),
        fee: SPONSOR_FEE,
        network,
      });
      const result = await broadcastTransaction({ transaction: tx, network });
      if (result.error) throw new Error(result.error);
      const tokenCredit = Number(token.balance) / 1_000_000;
      if (isUSDCx) user.stacksPendingUSDCxSweep = { txId: result.txid, amount: tokenCredit, createdAt: new Date() };
      else user.stacksPendingLEOSweep = { txId: result.txid, assetId: token.assetId, amount: token.balance, createdAt: new Date() };
      await user.save();
      const status = await waitForTransaction(result.txid);
      if (status === 'pending') {
        return { txId: result.txid, txIds: [result.txid], sweptTokens: [{ assetId: token.assetId, amount: token.balance, txId: result.txid }], errors, usdcxCredit: 0, pending: true, totalSTX: 0, totalUSD: 0, platformCut: 0, userCredit: 0 };
      }
      if (status !== 'success') {
        if (isUSDCx) user.stacksPendingUSDCxSweep = null; else user.stacksPendingLEOSweep = null;
        await user.save();
        throw new Error(`${isUSDCx ? 'USDCx' : 'LEO'} transfer failed on-chain (${status})`);
      }
      txIds.push(result.txid);
      sweptTokens.push({ assetId: token.assetId, amount: token.balance, txId: result.txid });
      if (!isUSDCx) { user.stacksPendingLEOSweep = null; nonce += 1n; continue; }
      usdcxCredit += tokenCredit;
      user.usdcBalance = Math.round(((user.usdcBalance || 0) + tokenCredit) * 100) / 100;
      if (!user.recentActivity) user.recentActivity = [];
      user.recentActivity.unshift({ action: `USDCx bounty drop swept: ${tokenCredit.toFixed(2)} USDC credited`, timestamp: new Date() });
      if (user.recentActivity.length > 10) user.recentActivity = user.recentActivity.slice(0, 10);
      user.stacksPendingUSDCxSweep = null;
      user.usdcxBalance = 0;
      nonce += 1n;
    } catch (err) {
      errors.push({ assetId: token.assetId, message: err.message });
      // Avoid nonce conflicts after a failed contract-call broadcast.
      break;
    }
  }

  let totalSTX = 0;
  let totalUSD = 0;
  let platformCut = 0;
  let userCredit = 0;
  const microSTX = await getBalance(address);
  if (microSTX < 0) errors.push({ assetId: 'STX', message: 'Could not read STX balance' });
  else if (errors.length === 0 && BigInt(microSTX) > NETWORK_FEE) {
    const sendAmount = BigInt(microSTX) - NETWORK_FEE;
    try {
      const tx = await makeSTXTokenTransfer({ recipient: mainWallet, amount: sendAmount, senderKey: privKey, network, anchorMode: AnchorMode.Any, fee: NETWORK_FEE, ...(nonce === undefined ? {} : { nonce }) });
      const result = await broadcastTransaction({ transaction: tx, network });
      if (result.error) throw new Error(result.error);
      txIds.push(result.txid);
      totalSTX = Number(sendAmount) / 1_000_000;
      const stxPrice = await getSTXPrice();
      totalUSD = totalSTX * stxPrice;
      platformCut = totalUSD * 0.10;
      userCredit = Math.round((totalUSD - platformCut) * 100) / 100;
      user.usdcBalance = Math.round(((user.usdcBalance || 0) + userCredit) * 100) / 100;
      if (!user.recentActivity) user.recentActivity = [];
      user.recentActivity.unshift({
        action: `Bounty reward swept: $${userCredit} USDC credited (${totalSTX.toFixed(4)} STX, 10% platform fee deducted)`,
        timestamp: new Date()
      });
      if (user.recentActivity.length > 10) user.recentActivity = user.recentActivity.slice(0, 10);
    } catch (err) {
      errors.push({ assetId: 'STX', message: err.message });
    }
  }

  if (txIds.length === 0) throw new Error(errors[0]?.message || 'Wallet has no sweepable balance or token transfer fees are not funded');
  user.stacksBalance = 0;
  user.stacksBalanceUSD = 0;
  user.usdcxBalance = 0;
  user.stacksCheckedAt = new Date();
  await user.save();
  return { txId: txIds[txIds.length - 1], txIds, sweptTokens, errors, usdcxCredit, totalSTX, totalUSD, platformCut, userCredit };
}

// Assign a wallet to a user (on first bounty submission)
async function assignWallet(userId) {
  const User    = require('../models/User');
  const Counter = require('../models/Counter');

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (user.stacksAddress) return { address: user.stacksAddress, index: user.stacksWalletIndex };

  const counter = await Counter.findByIdAndUpdate(
    'stacksWalletIndex',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const index   = counter.seq - 1;
  const address = await getAddress(index);

  user.stacksWalletIndex = index;
  user.stacksAddress     = address;
  await user.save();

  // Immediately register the ZAD account in background so the profile has the
  // user's name from day one — long before their first bounty submission.
  // Non-blocking: wallet assignment still returns instantly even if ZAD is slow.
  setImmediate(() =>
    ensureZADProfile(userId).catch(e =>
      console.error('[ZAD] Initial account setup failed (non-blocking):', e.message)
    )
  );

  return { address, index };
}

const ZAD_CONTRACT_ADDRESS = 'SP2GW18TVQR75W1VT53HYGBRGKFRV5BFYNAF5SS5J';

async function resolveBountyContractName(bountyId, creationTxId) {
  const txId = String(creationTxId || "").replace(/^0x/i, "");
  if (!/^[a-f0-9]{64}$/i.test(txId)) throw new Error("Missing valid ZeroAuthDAO bounty creation transaction ID.");
  const headers = {};
  if (process.env.HIRO_API_KEY) headers["x-api-key"] = process.env.HIRO_API_KEY;
  // ZAD can expose a bounty before Hiro has indexed its creation transaction.
  // Retry briefly so indexing/confirmation latency doesn't block valid entries.
  let tx = null;
  let lookupError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await axios.get(HIRO_API + "/extended/v1/tx/" + txId, { timeout: 8000, headers });
      tx = response.data;
      lookupError = null;
      if (tx?.tx_status === "success" || (tx?.tx_status && tx.tx_status.startsWith('abort_'))) break;
    } catch (err) {
      if (err.response?.status !== 404) lookupError = err;
    }
    if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 2500));
  }
  if (lookupError && !tx) throw new Error(`Could not verify ZeroAuthDAO bounty transaction ${txId}: ${lookupError.message}`);
  if (!tx || tx.tx_status !== "success") {
    throw new Error(`ZeroAuthDAO bounty transaction ${txId} is not confirmed on Stacks after waiting (status: ${tx?.tx_status || 'not indexed'}).`);
  }

  let contractId = null;
  const call = tx.contract_call;
  if (call?.function_name === "create-bounty") {
    const arg = (call.function_args || []).find(item => item.name === "bounty-id");
    let createdBountyId = arg?.repr;
    try { createdBountyId = JSON.parse(createdBountyId); } catch {
      if (typeof createdBountyId === 'string') createdBountyId = createdBountyId.replace(/^"|"$/g, '');
    }
    if (createdBountyId !== bountyId) throw new Error("ZeroAuthDAO bounty creation transaction does not match this bounty ID.");
    contractId = call.contract_id;
  } else if (tx.tx_type === 'smart_contract') {
    // ZAD's API can point at the wrapper contract deployment transaction. In
    // that case Hiro exposes the create-bounty call in its Clarity source, not
    // in `contract_call`.
    const source = tx.smart_contract?.source_code || '';
    const deployedCall = source.match(/\(contract-call\?\s+'?(SP[A-Z0-9]+\.[A-Za-z0-9-]+)\s+create-bounty\b/);
    if (!deployedCall || !source.includes(JSON.stringify(bountyId))) {
      throw new Error(`Stacks transaction ${txId} is a contract deployment, but it does not contain this ZeroAuthDAO bounty creation call.`);
    }
    contractId = deployedCall[1];
  } else {
    throw new Error(`Stacks transaction ${txId} is ${tx.tx_type || 'not a contract call'}; it is not a supported ZeroAuthDAO bounty creation transaction.`);
  }

  const parts = String(contractId || "").split(".");
  const address = parts.shift(), name = parts.join(".");
  const supportedContract = /^ZADAO-V\d+-[A-Za-z0-9-]+$/i.test(name) || /^ZaDAO-Custom-Bounty$/i.test(name);
  if (address !== ZAD_CONTRACT_ADDRESS || !supportedContract) throw new Error(`Unsupported ZeroAuthDAO bounty contract: ${contractId || 'unknown'}.`);
  return name;
}

const FEE_WALLET_PATH      = "m/44'/5757'/1'/0/0"; // separate account, never used for user wallets
const SPONSOR_FEE          = BigInt(3000); // 0.003 STX for existing sponsored transfers
const MAX_ZAD_SUBMISSION_SPONSOR_FEE = BigInt(20000); // cap ONBOARD3's ZAD submission fee at 0.02 STX

// Derive the ONBOARD3 fee wallet key (used to sponsor tx fees)
async function getFeeKey() {
  const mnemonic = process.env.STACKS_MASTER_SEED;
  if (!mnemonic) throw new Error('STACKS_MASTER_SEED not set');
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.HDKey.fromMasterSeed(seed);
  const child = root.derive(FEE_WALLET_PATH);
  return Buffer.from(child.privateKey).toString('hex') + '01';
}

// Submit a bounty entry on-chain to ZeroAuthDAO from the user's custodial wallet.
// ONBOARD3 sponsors only the network fee; ZeroAuthDAO's contract remains the
// destination and bounty/reward fund. ZeroAuthDAO's action broadcasts the tx.
async function submitBountyOnChain(userId, bountyId, summary, submissionUrl, creationTxId, bountyType = null, contractHint = {}) {
  const User = require('../models/User');
  const user = await User.findById(userId).select('stacksWalletIndex stacksAddress username profilePicture').lean();
  if (!user || user.stacksWalletIndex == null) throw new Error('User has no Stacks wallet assigned');

  const parent  = await getParent();
  const userKey = derivePrivKey(parent, user.stacksWalletIndex);
  const network = STACKS_MAINNET;

  // Prefer contract fields provided directly by ZAD API over the Hiro chain lookup.
  // ZAD now exposes submitContractAddress, submitContractName, submitFunctionName on
  // each bounty — using them avoids slow Hiro lookups that can timeout or fail.
  let contractAddress, contractName, functionName;
  if (contractHint.contractName && contractHint.contractAddress) {
    contractAddress = contractHint.contractAddress;
    contractName    = contractHint.contractName;
    functionName    = contractHint.functionName || 'submit-entry';
    console.log('[ZAD] Using contract from API hint:', contractAddress + '.' + contractName);
  } else {
    contractName    = await resolveBountyContractName(bountyId, creationTxId);
    contractAddress = ZAD_CONTRACT_ADDRESS;
    functionName    = 'submit-entry';
    console.log('[ZAD] Resolved contract via Hiro:', contractAddress + '.' + contractName);
  }

  // Build an origin-signed transaction that permits a separate fee sponsor.
  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName,
    functionArgs:    [stringAsciiCV(bountyId)],
    senderKey:       userKey,
    network,
    anchorMode:      AnchorMode.Any,
    sponsored:       true,
  });
  const originRaw = tx.serialize();
  const originSignedTxHex = typeof originRaw === 'string' ? originRaw : Buffer.from(originRaw).toString('hex');

  // Sponsor with ONBOARD3's dedicated fee wallet, using the SDK's current fee
  // estimate. ZeroAuthDAO still receives and broadcasts the signed tx; this
  // wallet pays only the Stacks network fee, never the bounty reward.
  const feeKey = await getFeeKey();
  const feeAddress = getAddressFromPrivateKey(feeKey);
  const sponsoredTx = await sponsorTransaction({
    transaction: tx,
    sponsorPrivateKey: feeKey,
    network,
  });
  const sponsorFee = BigInt(sponsoredTx.auth.sponsorSpendingCondition.fee);
  if (sponsorFee > MAX_ZAD_SUBMISSION_SPONSOR_FEE) {
    throw new Error(`Estimated Stacks sponsor fee exceeds the 0.02 STX limit (${sponsorFee} microSTX).`);
  }
  const feeBalance = await getBalance(feeAddress);
  if (feeBalance < Number(sponsorFee)) {
    throw new Error(`ONBOARD3 fee wallet has insufficient STX for the estimated submission fee (${sponsorFee} microSTX).`);
  }
  const txId = sponsoredTx.txid();
  console.log(`[ZAD] ONBOARD3 sponsor attached | wallet ${feeAddress.slice(0, 10)}… | fee ${sponsorFee} microSTX | tx ${txId}`);

  const raw = sponsoredTx.serialize();
  const signedTxHex = typeof raw === 'string' ? raw : Buffer.from(raw).toString('hex');

  // Call ZAD's Server Action (broadcasts + creates DB record so it appears on their platform)
  const webResult = await submitToZADWebAPI(userKey, bountyId, summary || '', submissionUrl || null, signedTxHex, {
    username: user.username || null,
    avatarUrl: user.profilePicture || null,
    bountyType,
  });
  console.log('[ZAD] Web2 result:', webResult);

  if (!webResult.success) {
    // The ZAD action can fail after broadcasting. Check the deterministic txid
    // before allowing a retry, because the ONBOARD3 sponsor fee may be spent.
    let chainTx;
    try {
      chainTx = await findTransaction(txId, 12, 2500);
    } catch (lookupError) {
      throw new Error(`ZeroAuthDAO action failed and Stacks status for ${txId} could not be checked. Check the bounty page before retrying. ${webResult.error || lookupError.message}`);
    }
    if (chainTx && ['pending', 'success'].includes(chainTx.tx_status)) {
      console.warn(`[ZAD] Transaction ${txId} is ${chainTx.tx_status} on Stacks, but ZAD did not confirm its listing. Blocking duplicate retry.`);
      return {
        txId,
        address: user.stacksAddress,
        zadSubId: null,
        accepted: false,
        relayPending: true,
        chainStatus: chainTx.tx_status,
        relayError: webResult.error || null,
        xVerified: webResult.xVerified,
      };
    }
    if (chainTx) {
      throw new Error(`Stacks transaction ${txId} was found with status ${chainTx.tx_status || 'unknown'}; ZeroAuthDAO did not confirm the submission. Do not retry until this transaction is reviewed.`);
    }
    if (/X verification failed|did not run its X verification/i.test(webResult.error || '')) {
      throw new Error(webResult.error);
    }

    // The live ZAD site sponsors accepted submissions with its own sponsor
    // wallet. If ZAD rejects an ONBOARD3-sponsored transaction before it
    // reaches Stacks, retry the same origin-signed call through ZAD's native
    // sponsorship path. The prior txid was checked above to prevent duplicates.
    console.warn('[ZAD] ONBOARD3-sponsored transaction was not broadcast; retrying with ZAD native sponsorship.');
    const nativeResult = await submitToZADWebAPI(
      userKey, bountyId, summary || '', submissionUrl || null, originSignedTxHex,
      { username: user.username || null, avatarUrl: user.profilePicture || null, bountyType, skipXVerification: true }
    );
    console.log('[ZAD] Native sponsorship fallback result:', nativeResult);
    if (!nativeResult.success) {
      const status = nativeResult.status ? ` (HTTP ${nativeResult.status})` : '';
      const detail = nativeResult.error ? `: ${nativeResult.error}` : '';
      throw new Error(`ZeroAuthDAO rejected both ONBOARD3 and native sponsorship${status}${detail}. Check the bounty page before retrying.`);
    }
    return {
      txId: nativeResult.txId || null,
      address: user.stacksAddress,
      zadSubId: nativeResult.zadSubId || null,
      accepted: Boolean(nativeResult.accepted || nativeResult.success),
      xVerified: nativeResult.xVerified ?? webResult.xVerified ?? null,
    };
  }
  const confirmedTxId = webResult.txId || txId;
  if (!webResult.txId && !webResult.zadSubId && !webResult.accepted) {
    throw new Error('ZeroAuthDAO returned no submission confirmation. Check its bounty page before retrying.');
  }

  return { txId: confirmedTxId || null, address: user.stacksAddress, zadSubId: webResult.zadSubId, accepted: Boolean(webResult.accepted), xVerified: webResult.xVerified ?? null };
}

async function getFeeWalletInfo() {
  const feeKey  = await getFeeKey();
  const address = getAddressFromPrivateKey(feeKey);
  const microSTX = await getBalance(address);
  const stxPrice = await getSTXPrice();
  const stx = microSTX > 0 ? microSTX / 1_000_000 : 0;
  return { address, microSTX: Math.max(0, microSTX), stx, usd: Math.round(stx * stxPrice * 100) / 100 };
}

const ZAD_BASE = 'https://zeroauthoritydao.com';
function cloudinaryCredentials() {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  let apiKey = process.env.CLOUDINARY_API_KEY;
  let apiSecret = process.env.CLOUDINARY_API_SECRET;
  if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
    try {
      const parsed = new URL(process.env.CLOUDINARY_URL);
      cloudName = cloudName || parsed.hostname;
      apiKey = apiKey || decodeURIComponent(parsed.username);
      apiSecret = apiSecret || decodeURIComponent(parsed.password);
    } catch {}
  }
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

async function getZADAvatarUrl(avatarData, walletAddress) {
  if (typeof avatarData === 'string' && /^https?:\/\//i.test(avatarData)) return avatarData;
  if (typeof avatarData !== 'string' || !walletAddress) return null;
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(avatarData)) return null;

  const credentials = cloudinaryCredentials();
  if (!credentials) {
    console.warn('[Cloudinary] Avatar sync skipped; configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
    return null;
  }

  const sourceHash = crypto.createHash('sha256').update(avatarData).digest('hex');
  const User = require('../models/User');
  const user = await User.findOne({ stacksAddress: walletAddress })
    .select('_id zeroAuthAvatarHash zeroAuthAvatarUrl').lean();
  if (!user) return null;
  if (user.zeroAuthAvatarHash === sourceHash && user.zeroAuthAvatarUrl) return user.zeroAuthAvatarUrl;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `onboard3/stacks-avatars/${walletAddress}`;
  const signedParams = { overwrite: 'true', public_id: publicId, timestamp };
  const signaturePayload = Object.keys(signedParams).sort()
    .map(key => `${key}=${signedParams[key]}`).join('&') + credentials.apiSecret;
  const signature = crypto.createHash('sha1').update(signaturePayload).digest('hex');
  const form = new URLSearchParams({ file: avatarData, api_key: credentials.apiKey, signature, ...signedParams });

  try {
    const response = await axios.post(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(credentials.cloudName)}/image/upload`,
      form.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000, maxBodyLength: 2000000 }
    );
    const secureUrl = response.data?.secure_url;
    if (!secureUrl) throw new Error('Cloudinary response did not include secure_url');
    await User.updateOne({ _id: user._id }, {
      $set: { zeroAuthAvatarHash: sourceHash, zeroAuthAvatarUrl: secureUrl }
    });
    return secureUrl;
  } catch (error) {
    console.warn('[Cloudinary] Avatar upload failed:', error.response?.status || error.message);
    return null;
  }
}
// Build a SIWE/SIWS message exactly as ZeroAuthDAO's frontend does
// They use: new SiweMessage({ statement:"Cerulean Marketplace", domain: origin, address, uri: origin, ... })
function buildSiwsMessage(address, nonce) {
  const origin   = 'https://zeroauthoritydao.com';
  const issuedAt = new Date().toISOString();
  // Standard EIP-4361 prepareMessage() output format
  return [
    `${origin} wants you to sign in with your Stacks account:`,
    address,
    '',
    'Cerulean Marketplace',
    '',
    `URI: ${origin}`,
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

// Sign a UTF-8 message using Stacks personal sign (Leather wallet RSV format)
// Leather's stx_signMessage returns RSV: compact(r+s 64 bytes) + recovery(1 byte)
function stacksPersonalSign(privKeyHex, message) {
  const hash    = hashMessage(message);
  const hashHex = Buffer.from(hash).toString('hex');
  // signWithKey produces VRS; convert to RSV to match Leather wallet output
  return signatureVrsToRsv(signWithKey(privKeyHex + '01', hashHex));
}

// Authenticate a custodial wallet with ZeroAuthDAO using SIWS
// Returns session cookies to use in subsequent requests
async function authenticateWithZAD(privKey, profile = {}) {
  const privKeyHex = privKey.slice(0, 64);
  const address    = getAddressFromPrivateKey(privKey);
  const pubKey     = getPublicKeyFromPrivate(privKeyHex);

  const nonceRes = await axios.get(`${ZAD_BASE}/api/auth/nonce`, { timeout: 8000 });
  const nonce    = nonceRes.data.nonce;

  const message   = buildSiwsMessage(address, nonce);
  const signature = await stacksPersonalSign(privKeyHex, message);
  const zadAvatarUrl = await getZADAvatarUrl(profile.avatarUrl, address);

  let res;
  try {
    res = await axios.post(`${ZAD_BASE}/api/auth/wallet-signin`, {
      message,
      signature,
      walletType: 'leather',
      chain:      'Stacks',
      nonce,
      publicKey:  pubKey,
      // Pass username on signin — ZAD sets display name on first account creation
      ...(typeof profile.username === 'string' && profile.username.trim() ? { username: profile.username.trim() } : {}),
      // Only pass avatarUrl if it's a real hosted URL (not a base64 data URI which ZAD can't use)
      ...(zadAvatarUrl ? { image: zadAvatarUrl, avatarUrl: zadAvatarUrl } : {}),
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 12000,
    });
  } catch (authErr) {
    const status = authErr.response?.status;
    const body   = authErr.response?.data;
    console.error('[ZAD] wallet-signin failed:', status, typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
    console.error('[ZAD] message was:', message.slice(0, 200));
    console.error('[ZAD] signature was:', signature.slice(0, 20) + '...');
    throw authErr;
  }

  const setCookie = res.headers['set-cookie'] || [];
  const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
  const signinData = typeof res.data === 'object' ? res.data : {};
  // ZAD may return {user:{...}} nested or flat {id, username, ...}
  const signinUser = signinData?.user || signinData;
  console.log('[ZAD] Auth OK | user from signin:', JSON.stringify(signinData).slice(0, 300));
  return { cookieStr, address, signinUser };
}

// Try to update the ZAD user profile — attempts session-based Server Actions,
// REST endpoints, and admin-API-key approaches (in order of reliability)
// Update a ZAD user's profile through the documented session-authenticated API.
async function tryUpdateZADProfile(cookieStr, username, avatarUrl, walletAddress, signinUser) {
  if (!walletAddress) return;
  const displayName = typeof username === 'string' ? username.trim() : '';
  const existingName = signinUser?.username || signinUser?.name || signinUser?.displayName;
  const shouldSetName = !!displayName && !(typeof existingName === 'string' && existingName.trim());
  const safeAvatar = await getZADAvatarUrl(avatarUrl, walletAddress);
  const body = {
    ...(shouldSetName ? { username: displayName } : {}),
    ...(safeAvatar ? { avatarUrl: safeAvatar } : {}),
  };
  if (!Object.keys(body).length) return;
  if (!shouldSetName && existingName) console.log('[ZAD] Existing profile name retained:', existingName);
  try {
    const response = await axios.put(
      `${ZAD_BASE}/api/users/${encodeURIComponent(walletAddress)}`,
      body,
      { headers: { 'Content-Type': 'application/json', Cookie: cookieStr }, timeout: 8000 }
    );
    console.log('[ZAD] Profile updated:', response.status, JSON.stringify(response.data || {}).slice(0, 200));
  } catch (error) {
    const status = error.response?.status;
    const responseBody = error.response?.data;
    const detail = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody || error.message);
    if ([400, 401, 403, 404].includes(status)) {
      console.warn(`[ZAD] Profile update rejected (${status}):`, detail.slice(0, 200));
      return;
    }
    console.warn('[ZAD] Profile update failed:', status || error.message, detail.slice(0, 200));
  }
}
// Submit a bounty via ZAD's Next.js Server Action — this broadcasts the tx AND creates the DB record
// signedTxHex: hex of the origin- and ONBOARD3-sponsor-signed transaction
// profile: { username, avatarUrl } — optional, used to update ZAD account name so it shows instead of Anonymous
async function submitToZADWebAPI(privKey, bountyId, summary, submissionUrl, signedTxHex, profile = {}) {
  let xVerificationBypassed = false;
  try {
    if (!privKey) {
      const parent = await getParent();
      privKey = derivePrivKey(parent, 0);
    }
    const { cookieStr, address, signinUser } = await authenticateWithZAD(privKey, profile);

    // Update ZAD profile with ONBOARD3 username so submissions don't show as Anonymous
    await tryUpdateZADProfile(cookieStr, profile.username, profile.avatarUrl, address, signinUser);

    // ZAD uses a Next.js Server Action for submissions (not a REST endpoint).
    // Build the router state for /bounty/[slug]; Next uses it to render the
    // action response against the page that submitted the entry.
    const bountyPath = `/bounty/${bountyId}`;
    const routerStateTree = [
      '',
      { children: ['bounty', { children: [['slug', bountyId, 'd'], { children: ['__PAGE__', {}, bountyPath, 'refresh'] }] }] },
      null,
      null,
      true,
    ];
    const headers = {
      'Content-Type':            'text/plain;charset=UTF-8',
      'Accept':                  'text/x-component',
      'Cookie':                  cookieStr,
      'Next-Action':             '0bd627de766e4d198a9751b22027e546295e1c5d',
      'Next-Router-State-Tree':  encodeURIComponent(JSON.stringify(routerStateTree)),
      'Next-Url':                bountyPath,
      'Origin':                  ZAD_BASE,
      'Referer':                 `${ZAD_BASE}${bountyPath}`,
    };

    // ONBOARD3 accepts a public X status URL without requiring users to link
    // their X account to ZAD. ZAD receives the URL and entry, but we never
    // claim that X ownership/activity was verified.
    if (String(profile.bountyType || '').toLowerCase() === 'xverification') {
      xVerificationBypassed = true;
      console.warn('[ZAD] X account verification bypassed for ONBOARD3 submission; the entry remains unverified.');
    }

    // Match the object sent by ZeroAuthDAO's live bounty submission action.
    const payload = [{
      bountyId, submitterAddress: address, signedTxHex, summary, submissionUrl: submissionUrl || null, answers: null,
    }];

    const subRes = await axios.post(`${ZAD_BASE}/bounty/${bountyId}`, payload, { headers, timeout: 30000 });
    console.log('[ZAD] Server Action status:', subRes.status);

    const contentType = String(subRes.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new Error('ZeroAuthorityDAO returned the bounty page instead of a Server Action response; verify the action ID.');
    }
    const responseText = typeof subRes.data === 'string' ? subRes.data : JSON.stringify(subRes.data);
    console.log('[ZAD] Server Action response:', responseText.slice(0, 500));
    if (/(?:^|\n)\d+:E/.test(responseText)) {
      throw new Error(`ZeroAuthDAO server action returned an error: ${responseText.slice(0, 500)}`);
    }

    // Parse RSC (React Server Components) streaming response
    // Format: "0:[...]\n1:{...}\n" — look for submission id and txId in all lines
    let zadSubId = null;
    let txId = null;
    let accepted = false;
    try {
      const responseLines = /^[\[{]/.test(responseText.trim()) ? [`0:${responseText.trim()}`] : responseText.split('\n');
      for (const line of responseLines) {
        const match = line.match(/^\d+:(.*)/s);
        if (!match) continue;
        try {
          const parsed = JSON.parse(match[1]);
          const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
          const seen = new Set();
          while (queue.length) {
            const obj = queue.shift();
            if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
            seen.add(obj);
            if (obj.success === true || obj.ok === true || obj.accepted === true) accepted = true;
            if (typeof obj.status === 'string' && obj.status.toLowerCase() === 'success') accepted = true;
            if (obj.id && !zadSubId) zadSubId = obj.id;
            if ((obj.txId || obj.txid || obj.transactionId) && !txId) txId = obj.txId || obj.txid || obj.transactionId;
            for (const value of Object.values(obj)) {
              if (value && typeof value === 'object') queue.push(value);
              else if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
                try { queue.push(JSON.parse(value)); } catch {}
              }
            }
          }
        } catch {}
      }
    } catch {}

    return { success: Boolean(zadSubId || txId || accepted), accepted, zadSubId, txId, address, xVerified: xVerificationBypassed ? false : null };
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const detail = (typeof body === 'string' ? body : JSON.stringify(body || err.message)).slice(0, 500);
    console.error('[ZAD] Server Action failed:', status, detail);
    return {
      success: false,
      zadSubId: null,
      txId: null,
      error: status ? `ZeroAuthorityDAO returned HTTP ${status}: ${detail}` : err.message,
      status,
      xVerified: xVerificationBypassed ? false : null,
    };
  }
}

// Ensure a ZAD profile exists for the user with their ONBOARD3 username.
// Called explicitly before on-chain submission so the profile is created
// even if the on-chain step fails (preventing entries from appearing as "anonymous").
async function ensureZADProfile(userId) {
  const User = require('../models/User');
  const user = await User.findById(userId)
    .select('stacksWalletIndex username profilePicture').lean();
  if (!user || user.stacksWalletIndex == null) return;
  const parent  = await getParent();
  const privKey = derivePrivKey(parent, user.stacksWalletIndex);
  const { cookieStr, address, signinUser } = await authenticateWithZAD(privKey, {
    username:  user.username  || null,
    avatarUrl: user.profilePicture || null,
  });
  await tryUpdateZADProfile(cookieStr, user.username, user.profilePicture, address, signinUser);
  console.log('[ZAD] Profile ensured for:', user.username, address);
}

module.exports = { getAddress, getBalance, getFungibleBalances, getUSDCxBalance, getSTXPrice, sweepWallet, assignWallet, submitBountyOnChain, getFeeWalletInfo, submitToZADWebAPI, ensureZADProfile };
