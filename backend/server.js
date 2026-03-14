'use strict';

const dotenv       = require('dotenv')
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
const { v4: uuidv4 } = require('uuid');

dotenv.config()

const app  = express();
app.set('trust proxy', 1); // trust first proxy (nginx) so X-Forwarded-For is used for client IP
const PORT = process.env.PORT || 3000;

console.log(process.env)

// ── Configuration ─────────────────────────────────────────────────────────────

const ASX_MINT       = 'cyaiYgJhfSuFY7yz8iNeBwsD1XNDzZXVBEGubuuxdma';
const TREASURY_WALLET = process.env.TREASURY_WALLET || '6bvB3PTz48wozyPJeuTB77axexWu9MfUSjBYbQzEgK88';
const RPC_URL        = process.env.RPC_URL
  || (process.env.HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`)
  || 'https://api.mainnet-beta.solana.com';
const NETSEPIO_BASE  = 'https://gateway.netsepio.com/api/v1.0';

// DexScreener pool address for ASX/SOL pricing
const DEXSCREENER_PAIR = 'haif1csuuvcggq4syudzqdtvz1esyxjuiw9y3jk7av55';
const DEXSCREENER_URL  = `https://api.dexscreener.com/latest/dex/pairs/solana/${DEXSCREENER_PAIR}`;

// Pricing: 1 GB of VPN/hotspot data costs $0.10 USD worth of ASX
const USD_PER_GB = 0.10;

// ── ASX price cache ───────────────────────────────────────────────────────────

let cachedAsxPriceUsd = 0.001; // conservative fallback
let lastRateFetch     = 0;
const RATE_CACHE_MS   = 60_000;

async function fetchAsxRate() {
  const now = Date.now();
  if (now - lastRateFetch < RATE_CACHE_MS) return cachedAsxPriceUsd;
  try {
    const res  = await fetch(DEXSCREENER_URL);
    const data = await res.json();
    const price = parseFloat(data?.pairs?.[0]?.priceUsd || data?.pair?.priceUsd || 0);
    if (price > 0) {
      cachedAsxPriceUsd = price;
      lastRateFetch     = now;
      console.log(`[Rate] ASX price updated: $${price}`);
    }
  } catch (err) {
    console.warn('[Rate] DexScreener fetch failed:', err.message);
  }
  return cachedAsxPriceUsd;
}

async function getAsxPerGb() {
  const rate = await fetchAsxRate();
  return USD_PER_GB / rate; // e.g. $0.10 / $0.001 = 100 ASX/GB
}

// Pre-warm rate cache on startup
fetchAsxRate();
setInterval(fetchAsxRate, RATE_CACHE_MS);

// ── Flat-file database ────────────────────────────────────────────────────────

const DB_FILE = path.join(__dirname, 'data', 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch { /* corrupt file — start fresh */ }
  return { devices: {}, processedTxHashes: {}, hostSettings: {}, networkTreasuryASX: 0, vpnSessions: [] };
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();
// Initialise missing top-level keys
if (!db.vpnSessions)  db.vpnSessions  = [];
if (!db.hostSettings) db.hostSettings = {};

function getDeviceDB(deviceId) {
  if (!db.devices[deviceId]) db.devices[deviceId] = { balance: 0, earned: 0, vpnCredential: null };
  return db.devices[deviceId];
}

// Persist DB every minute
setInterval(() => saveDB(db), 60_000);

// ── Hotspot device registry (in-memory) ──────────────────────────────────────

const DEVICE_TTL_MS          = 15 * 60 * 1000; // 15 minutes
const COVERAGE_PER_DEVICE_M2 = 25;
const devices                = new Map();

function cleanExpiredDevices() {
  const now = Date.now();
  for (const [id, info] of devices) {
    if (now - info.lastPing > DEVICE_TTL_MS) devices.delete(id);
  }
}
setInterval(cleanExpiredDevices, 60_000);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

// ── IP geolocation helper ─────────────────────────────────────────────────────

const PRIVATE_IP_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$)/;

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  return raw.split(',')[0].trim().replace('::ffff:', '');
}

async function geolocateIp(ip) {
  if (PRIVATE_IP_RE.test(ip)) return null;
  try {
    const res  = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode,city`);
    return await res.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── Stats ─────────────────────────────────────────────────────────────────────

function getStats() {
  cleanExpiredDevices();
  let totalSpeed = 0, devicesWithSpeed = 0;
  for (const info of devices.values()) {
    if (info.speed) { totalSpeed += info.speed; devicesWithSpeed++; }
  }
  const totalNetworks = Object.values(db.hostSettings)
    .reduce((sum, s) => sum + (s.networks?.length || 1), 0);

  return {
    activeHotspots:    devices.size,
    totalCoverageM2:   totalNetworks * COVERAGE_PER_DEVICE_M2,
    avgSpeed:          devicesWithSpeed > 0 ? `${(totalSpeed / devicesWithSpeed).toFixed(1)} Mbps` : '–',
    networkTreasuryASX: db.networkTreasuryASX.toFixed(2),
    treasuryWallet:    TREASURY_WALLET,
    asxMint:           ASX_MINT,
    asxPriceUsd:       cachedAsxPriceUsd,
    usdPerGb:          USD_PER_GB,
    lastUpdated:       new Date().toISOString(),
  };
}

app.get('/api/stats', (_req, res) => res.json(getStats()));

// ── ASX rate ──────────────────────────────────────────────────────────────────

app.get('/api/rate/asx', async (_req, res) => {
  const price    = await fetchAsxRate();
  const asxPerGb = USD_PER_GB / price;
  res.json({ asxPriceUsd: price, usdPerGb: USD_PER_GB, asxPerGb });
});

// ── Ping / heartbeat ──────────────────────────────────────────────────────────

app.post('/api/ping', (req, res) => {
  const { deviceId, walletAddress } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const existing = devices.get(deviceId) || {};
  devices.set(deviceId, { ...existing, lastPing: Date.now(), coverageM2: COVERAGE_PER_DEVICE_M2 });

  const dev = getDeviceDB(deviceId);
  if (walletAddress) {
    dev.walletAddress = walletAddress;
    if (!db.walletBalances) db.walletBalances = {};
    db.walletBalances[walletAddress] = { deviceId, balance: dev.balance, updatedAt: new Date().toISOString() };
    saveDB(db);
  }

  res.json({ pong: true, deviceId, balance: dev.balance, earned: dev.earned, ...getStats() });
});

// ── Balance lookup by wallet address ──────────────────────────────────────────

app.get('/api/balance', (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });

  const entry  = db.walletBalances?.[walletAddress];
  if (!entry) return res.json({ balance: 0, found: false });

  const dev     = db.devices[entry.deviceId];
  const balance = dev?.balance ?? entry.balance;
  res.json({ balance, deviceId: entry.deviceId, found: true });
});

// ── Speed report ──────────────────────────────────────────────────────────────

app.post('/api/rate', (req, res) => {
  const { deviceId, speed } = req.body;
  if (!deviceId || typeof speed !== 'number') return res.status(400).json({ error: 'Invalid payload' });

  const info = devices.get(deviceId) || { lastPing: Date.now(), coverageM2: COVERAGE_PER_DEVICE_M2 };
  info.speed    = speed;
  info.lastPing = Date.now();
  devices.set(deviceId, info);
  res.json({ success: true, avgSpeed: getStats().avgSpeed });
});

// ── On-chain top-up verification ──────────────────────────────────────────────

app.post('/api/topup/verify', async (req, res) => {
  const { deviceId, txSignature } = req.body;
  if (!deviceId || !txSignature) return res.status(400).json({ error: 'deviceId and txSignature are required' });
  if (db.processedTxHashes[txSignature]) return res.status(400).json({ error: 'Transaction already processed.' });

  try {
    const connection = new Connection(RPC_URL, 'confirmed');

    // Poll up to 8 s to allow RPC propagation
    let tx = null;
    for (let i = 0; i < 8; i++) {
      tx = await connection.getParsedTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!tx || tx.meta?.err) return res.status(400).json({ error: 'Transaction not found or failed on-chain.' });

    // Find an SPL token transfer to the treasury for the ASX mint
    const instructions      = tx.transaction.message.instructions || [];
    const innerInstructions = (tx.meta?.innerInstructions || []).flatMap(ii => ii.instructions);
    const allInstructions   = [...instructions, ...innerInstructions];

    let amountASX    = 0;
    let transferFound = false;

    for (const ix of allInstructions) {
      // Only ParsedInstruction has a .program string; skip PartiallyDecodedInstruction
      if (!('program' in ix) || ix.program !== 'spl-token') continue;
      const type = ix.parsed?.type;
      if (type !== 'transfer' && type !== 'transferChecked') continue;

      const info = ix.parsed.info;
      if (info.mint !== ASX_MINT) continue;

      try {
        const destInfo  = await connection.getParsedAccountInfo(new PublicKey(info.destination));
        const destOwner = destInfo?.value?.data?.parsed?.info?.owner;
        if (destOwner === TREASURY_WALLET) {
          amountASX     = parseFloat(info.tokenAmount?.uiAmount || info.amount || 0);
          transferFound = true;
          break;
        }
      } catch { /* skip unreadable accounts */ }
    }

    if (!transferFound || amountASX <= 0) {
      return res.status(400).json({ error: 'No valid ASX transfer to treasury found in this transaction.' });
    }

    const dev = getDeviceDB(deviceId);
    dev.balance += amountASX;
    db.processedTxHashes[txSignature] = { deviceId, amountASX, verifiedAt: new Date().toISOString() };
    if (dev.walletAddress && db.walletBalances?.[dev.walletAddress]) {
      db.walletBalances[dev.walletAddress].balance   = dev.balance;
      db.walletBalances[dev.walletAddress].updatedAt = new Date().toISOString();
    }
    saveDB(db);

    console.log(`[TopUp] +${amountASX} ASX → device ${deviceId} (tx: ${txSignature})`);
    res.json({ success: true, amountAdded: amountASX, newBalance: dev.balance });
  } catch (err) {
    console.error('[TopUp]', err.message);
    res.status(500).json({ error: `Verification failed: ${err.message}` });
  }
});

// ── VPN usage / disconnect ────────────────────────────────────────────────────

app.post('/api/vpn/usage', async (req, res) => {
  const { deviceId, gbUsed } = req.body;
  if (!deviceId || typeof gbUsed !== 'number') return res.status(400).json({ error: 'Invalid payload' });

  const asxPerGb = await getAsxPerGb();
  const dev      = getDeviceDB(deviceId);
  dev.balance    = Math.max(0, dev.balance - gbUsed * asxPerGb);
  res.json({ success: true, balance: dev.balance, deducted: gbUsed * asxPerGb, asxPerGb });
});

app.post('/api/vpn/disconnect', async (req, res) => {
  const { deviceId, gbUsed, hostWalletAddress, hostDeviceId } = req.body;
  if (!deviceId || typeof gbUsed !== 'number') return res.status(400).json({ error: 'Invalid payload' });

  const asxPerGb     = await getAsxPerGb();
  const totalCostASX = gbUsed * asxPerGb;

  const session = {
    id:               uuidv4(),
    deviceId,
    gbUsed,
    totalCostASX,
    asxPerGb,
    hostWalletAddress: hostWalletAddress || null,
    hostDeviceId:      hostDeviceId      || null,
    disconnectedAt:    new Date().toISOString(),
  };

  db.vpnSessions.push(session);
  saveDB(db);
  console.log(`[VPN] Session ended — device ${deviceId}, ${gbUsed.toFixed(4)} GB, ${totalCostASX.toFixed(4)} ASX`);
  res.json({ success: true, session });
});

// ── Hotspot hosting ───────────────────────────────────────────────────────────

app.post('/api/hotspot/usage', async (req, res) => {
  const { hostDeviceId, clientDeviceId, gbUsed } = req.body;
  if (!hostDeviceId || typeof gbUsed !== 'number') return res.status(400).json({ error: 'Invalid payload' });

  const asxPerGb  = await getAsxPerGb();
  const host      = getDeviceDB(hostDeviceId);
  const hostEarns = gbUsed * asxPerGb * 0.45;
  const platform  = gbUsed * asxPerGb * 0.45;

  if (clientDeviceId) {
    const client  = getDeviceDB(clientDeviceId);
    client.balance = Math.max(0, client.balance - gbUsed * asxPerGb);
  }

  host.earned            += hostEarns;
  db.networkTreasuryASX  += platform;
  res.json({ success: true, hostEarned: host.earned, platformFee: platform, asxPerGb });
});

app.post('/api/hotspot/claim', (req, res) => {
  const { deviceId, walletAddress } = req.body;
  if (!deviceId || !walletAddress) return res.status(400).json({ error: 'Invalid payload' });

  const dev = getDeviceDB(deviceId);
  if (dev.earned <= 0) return res.status(400).json({ error: 'No earnings to claim.' });

  const claimed = dev.earned;
  dev.earned    = 0;
  saveDB(db);

  console.log(`[Claim] ${claimed.toFixed(4)} ASX → ${walletAddress} (device: ${deviceId})`);
  res.json({ success: true, claimed, remainingEarned: 0 });
});

// ── Hotspot settings ──────────────────────────────────────────────────────────

app.post('/api/hotspot/settings', async (req, res) => {
  const { deviceId, networks, country, countryCode, walletAddress } = req.body;
  if (!deviceId || !Array.isArray(networks) || networks.length === 0) {
    return res.status(400).json({ error: 'deviceId and networks[] are required' });
  }

  // Auto-detect country from client IP when not supplied
  let resolvedCountry = country   || null;
  let resolvedCC      = countryCode || null;
  if (!resolvedCountry) {
    const ip  = getClientIp(req);
    const geo = await geolocateIp(ip);
    resolvedCountry = geo?.country     || null;
    resolvedCC      = geo?.countryCode || null;
  }

  db.hostSettings[deviceId] = {
    networks: networks.map(n => ({
      ssid:       n.ssid,
      password:   n.password,
      encryption: n.encryption || 'WPA2',
    })),
    country:     resolvedCountry || 'Unknown',
    countryCode: resolvedCC      || 'XX',
    updatedAt:   new Date().toISOString(),
  };

  if (walletAddress) {
    if (!db.devices[deviceId]) db.devices[deviceId] = { balance: 0, earned: 0 };
    db.devices[deviceId].walletAddress = walletAddress;
    if (!db.walletBalances) db.walletBalances = {};
    db.walletBalances[walletAddress] = {
      deviceId,
      balance:   db.devices[deviceId].balance,
      updatedAt: new Date().toISOString(),
    };
  }

  saveDB(db);
  console.log(`[Host] ${deviceId} in ${resolvedCountry || 'Unknown'}: ${networks.length} network(s)`);
  res.json({ success: true, settings: db.hostSettings[deviceId] });
});

// ── Countries list ────────────────────────────────────────────────────────────

app.get('/api/countries', (_req, res) => {
  const counts = {};
  for (const settings of Object.values(db.hostSettings)) {
    const cc   = settings.countryCode || 'XX';
    const name = settings.country     || 'Unknown';
    if (!counts[cc]) counts[cc] = { countryCode: cc, country: name, networkCount: 0 };
    counts[cc].networkCount += (settings.networks || []).length || 1;
  }
  res.json({ countries: Object.values(counts).sort((a, b) => b.networkCount - a.networkCount) });
});

// ── Geolocate client ──────────────────────────────────────────────────────────

app.get('/api/geolocate', async (req, res) => {
  const ip  = getClientIp(req);
  const geo = await geolocateIp(ip);
  res.json({
    country:     geo?.country     || null,
    countryCode: geo?.countryCode || null,
    city:        geo?.city        || null,
    ip,
    ...(PRIVATE_IP_RE.test(ip) && { note: 'private IP — set country manually' }),
  });
});

// ── Deposit quote ─────────────────────────────────────────────────────────────

app.post('/api/deposit/quote', async (req, res) => {
  const { usdAmount } = req.body;
  if (typeof usdAmount !== 'number' || usdAmount <= 0) {
    return res.status(400).json({ error: 'Valid usdAmount required' });
  }

  const asxPriceUsd = await fetchAsxRate();
  const asxAmount   = usdAmount / asxPriceUsd;
  const gbAvailable = usdAmount / USD_PER_GB;

  res.json({
    usdAmount,
    asxAmount,
    asxPriceUsd,
    gbAvailable,
    breakdown: {
      burned:            asxAmount * 0.10,
      toTreasury:        asxAmount * 0.90, // when no host is involved
      toHostIfHotspot:   asxAmount * 0.45,
      toTreasuryIfHotspot: asxAmount * 0.45,
    },
  });
});

// ── NetSepio VPN (WireGuard via Erebrus) ──────────────────────────────────────

/**
 * Step 1 — Get NetSepio flow ID and EULA text for a wallet address.
 * The wallet address must be provided as Solana base58; we convert it to
 * the 0x-hex format that the NetSepio API expects.
 */
app.get('/api/vpn/netsepio/flowid', async (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/flowid?walletAddress=${walletAddress}&chain=sol`);
    if (!r.ok) throw new Error(`NetSepio flowid: ${r.status}`);

    const data   = await r.json();
    const flowId = data.payload?.flowId || data.flowId;
    const eula   = data.payload?.eula   || data.eula || '';
    res.json({ flowId, eula, walletAddress });
  } catch (err) {
    console.error('[NetSepio FlowID]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Step 2 — Authenticate with NetSepio and subscribe to Erebrus VPN.
 * Returns a WireGuard .conf string ready for use by the in-app VPN service.
 */
app.post('/api/vpn/netsepio/connect', async (req, res) => {
  const { deviceId, flowId, signature, pubKey, walletAddress, message } = req.body;
  if (!deviceId || !flowId || !signature || !pubKey || !walletAddress || !message) {
    return res.status(400).json({ error: 'deviceId, flowId, signature, pubKey, walletAddress and message are required' });
  }

  const dev = getDeviceDB(deviceId);
  if (dev.balance <= 0) return res.status(402).json({ error: 'Insufficient ASX balance.' });

  try {
    // Authenticate → receive a PASETO bearer token
    const authRes = await fetch(`${NETSEPIO_BASE}/authenticate?walletAddress=${walletAddress}&chain=sol`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ flowId, signature, pubKey, walletAddress, message, chainName: 'sol' }),
    });
    if (!authRes.ok) {
      const body = await authRes.json().catch(() => ({}));
      throw new Error(body.message || body.error || `NetSepio auth: ${authRes.status}`);
    }

    const authData = await authRes.json();
    const token    = authData.payload?.token || authData.token;
    if (!token) throw new Error('No token in NetSepio auth response');

    // Store the token for future API calls
    dev.token = token;
    saveDB(db);

    // Subscribe → receive Erebrus WireGuard credentials
    const subRes  = await fetch(`${NETSEPIO_BASE}/subscription/trial?walletAddress=${walletAddress}&chain=sol`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ wallet: walletAddress }),
    });
    const subData = await subRes.json().catch(() => ({}));

    const wgConfig = buildWireGuardConfig(subData);
    if (!wgConfig) {
      console.error('[NetSepio] Unrecognised Erebrus response:', JSON.stringify(subData).slice(0, 400));
      throw new Error('Erebrus did not return WireGuard credentials.');
    }

    dev.wgConfig   = wgConfig;
    dev.wgConfigAt = new Date().toISOString();
    saveDB(db);

    console.log(`[NetSepio] WireGuard config issued for device ${deviceId}`);
    res.json({ success: true, wgConfig, balance: dev.balance, protocol: 'wireguard' });
  } catch (err) {
    console.error('[NetSepio Connect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get NetSepio subscription status.
 */
app.get('/api/vpn/netsepio/subscription', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/subscription`, {
      headers: { 'Authorization': `Bearer ${dev.token}` },
    });
    if (!r.ok) throw new Error(`NetSepio subscription: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[NetSepio Subscription]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Start NetSepio trial subscription.
 */
app.post('/api/vpn/netsepio/subscription/trial', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/subscription/trial`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${dev.token}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error(`NetSepio trial: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[NetSepio Trial]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get NetSepio nodes for regions.
 */
app.get('/api/vpn/netsepio/nodes', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/nodes/all`, {
      headers: { 'Authorization': `Bearer ${dev.token}` },
    });
    if (!r.ok) throw new Error(`NetSepio nodes: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[NetSepio Nodes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create Erebrus VPN client.
 */
app.post('/api/vpn/netsepio/client/:region', async (req, res) => {
  const { region } = req.params;
  const { deviceId, name, presharedKey, publicKey } = req.body;
  if (!deviceId || !name || !presharedKey || !publicKey) {
    return res.status(400).json({ error: 'deviceId, name, presharedKey, publicKey required' });
  }

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/erebrus/client/${region}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${dev.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, presharedKey, publicKey }),
    });
    if (!r.ok) throw new Error(`NetSepio create client: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[NetSepio Create Client]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get Erebrus VPN clients.
 */
app.get('/api/vpn/netsepio/clients', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/erebrus/clients`, {
      headers: { 'Authorization': `Bearer ${dev.token}` },
    });
    if (!r.ok) throw new Error(`NetSepio clients: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[NetSepio Clients]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get client blobId for config download.
 */
app.get('/api/vpn/netsepio/client/:uuid/blobId', async (req, res) => {
  const { uuid } = req.params;
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/erebrus/client/${uuid}/blobId`, {
      headers: { 'Authorization': `Bearer ${dev.token}` },
    });
    if (!r.ok) throw new Error(`NetSepio blobId: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[NetSepio BlobId]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete Erebrus VPN client.
 */
app.delete('/api/vpn/netsepio/client/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const dev = getDeviceDB(deviceId);
  if (!dev.token) return res.status(401).json({ error: 'Not authenticated with NetSepio' });

  try {
    const r = await fetch(`${NETSEPIO_BASE}/erebrus/client/${uuid}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${dev.token}` },
    });
    if (!r.ok) throw new Error(`NetSepio delete client: ${r.status}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[NetSepio Delete Client]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Parse an Erebrus subscription response into a WireGuard .conf string.
 *
 * Erebrus API versions return credentials in varying shapes:
 *   A) payload.WireGuardConfig  — complete .conf text
 *   B) payload.client_config    — complete .conf text
 *   C) payload with individual fields (PrivateKey, ServerPublicKey, …)
 *   D) payload.SubscriptionDetails with individual fields
 *
 * Returns null if the shape is unrecognised.
 */
function buildWireGuardConfig(subData) {
  const p = subData?.payload || subData;

  // Complete .conf string already present
  const fullConf = p?.WireGuardConfig || p?.wireguard_config || p?.client_config || p?.Config || p?.config;
  if (typeof fullConf === 'string' && fullConf.includes('[Interface]')) return fullConf.trim();

  // Individual credential fields
  const d          = p?.SubscriptionDetails || p?.subscription_details || p;
  const privateKey = d?.PrivateKey      || d?.private_key      || d?.ClientPrivateKey;
  const publicKey  = d?.ServerPublicKey || d?.server_public_key || d?.PublicKey;
  const endpoint   = d?.ServerEndpoint  || d?.server_endpoint   || d?.Endpoint;
  const clientIp   = d?.ClientIPAddress || d?.client_ip_address || d?.Address;
  const dns        = d?.DNSAddress      || d?.dns_address       || d?.DNS        || '1.1.1.1';
  const allowedIPs = d?.AllowedIPs      || d?.allowed_ips       || '0.0.0.0/0, ::/0';
  const psk        = d?.PresharedKey    || d?.preshared_key     || null;

  if (!privateKey || !publicKey || !endpoint) return null;

  const address = (clientIp || '').includes('/') ? clientIp : `${clientIp}/32`;
  let conf = `[Interface]
PrivateKey = ${privateKey}
Address = ${address}
DNS = ${dns}

[Peer]
PublicKey = ${publicKey}
AllowedIPs = ${allowedIPs}
Endpoint = ${endpoint}
PersistentKeepalive = 25`;

  if (psk) conf += `\nPresharedKey = ${psk}`;
  return conf;
}

// ── Config file download ──────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  const configPath = path.join(__dirname, 'configs', 'networks.mobileconf');
  if (!fs.existsSync(configPath)) return res.status(404).json({ error: 'Config not found.' });
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="networks.mobileconf"');
  res.sendFile(configPath);
});

app.get('/api/config/json', (_req, res) => {
  const countryFilter = (_req.query.country || '').toUpperCase() || null;
  const networks      = [];

  // Static networks from the mobileconf file (global, no country filter)
  const configPath = path.join(__dirname, 'configs', 'networks.mobileconf');
  if (fs.existsSync(configPath) && !countryFilter) {
    const xml        = fs.readFileSync(configPath, 'utf-8');
    const dictRegex  = /<dict>([\s\S]*?)<\/dict>/g;
    let match;
    while ((match = dictRegex.exec(xml)) !== null) {
      const block    = match[1];
      const ssid     = block.match(/<key>SSID_STR<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      const password = block.match(/<key>Password<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      const enc      = block.match(/<key>EncryptionType<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (ssid && password) {
        networks.push({ ssid, password, encryption: enc || 'WPA2', autoJoin: true });
      }
    }
  }

  // Dynamic hotspots registered by hosts
  for (const [deviceId, settings] of Object.entries(db.hostSettings)) {
    if (countryFilter && settings.countryCode !== countryFilter) continue;
    const hostNets   = settings.networks || (settings.ssid ? [{ ssid: settings.ssid, password: settings.password, encryption: 'WPA2' }] : []);
    const hostWallet = db.devices?.[deviceId]?.walletAddress || null;
    for (const n of hostNets) {
      networks.push({
        ssid:        n.ssid,
        password:    n.password,
        encryption:  n.encryption || 'WPA2',
        autoJoin:    true,
        deviceId,
        walletAddress: hostWallet,
        country:     settings.country,
        countryCode: settings.countryCode,
      });
    }
  }

  res.json({ profileName: 'Hotpot WiFi Network', networkCount: networks.length, networks });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:              'ok',
    uptime:              process.uptime(),
    connectedDevices:    devices.size,
    registeredDevices:   Object.keys(db.devices).length,
    networkTreasuryASX:  db.networkTreasuryASX,
    asxPriceUsd:         cachedAsxPriceUsd,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nHotpot backend listening on port ${PORT}`);
  console.log(`  ASX token:       ${ASX_MINT}`);
  console.log(`  Treasury wallet: ${TREASURY_WALLET}`);
  console.log(`  RPC endpoint:    ${RPC_URL}\n`);
});
