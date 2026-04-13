/**
 * Hotpot — API client
 *
 * All requests route through the Hotpot backend API.
 * Set API_BASE to the production URL for release builds.
 */

const API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://api-hotpot.assetux.com';
const DEFAULT_TIMEOUT_MS = 10_000;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => { clearTimeout(timer); return res; })
    .catch(err => {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Request timed out. Check your connection.');
      throw err;
    });
}

async function parseError(res) {
  const body = await res.json().catch(() => ({}));
  return body.error || body.message || `HTTP ${res.status}`;
}

// ── Network stats ─────────────────────────────────────────────────────────────

export async function fetchStats() {
  const res = await fetchWithTimeout(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`Stats error: ${res.status}`);
  return res.json();
}

export async function pingServer(deviceId, walletAddress) {
  const res = await fetchWithTimeout(`${API_BASE}/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, ...(walletAddress && { walletAddress }) }),
  });
  if (!res.ok) throw new Error(`Ping error: ${res.status}`);
  return res.json();
}

export async function fetchNetworksJSON(countryCode) {
  const url = countryCode
    ? `${API_BASE}/api/config/json?country=${countryCode}`
    : `${API_BASE}/api/config/json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Config error: ${res.status}`);
  return res.json();
}

export async function fetchCountries() {
  const res = await fetchWithTimeout(`${API_BASE}/api/countries`);
  if (!res.ok) throw new Error(`Countries error: ${res.status}`);
  return res.json();
}

export async function geolocateSelf() {
  // Try backend first
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/geolocate`);
    if (res.ok) {
      const data = await res.json();
      if (data.country) return data;
    }
  } catch {}
  // Fallback: call ip-api.com directly from the device (detects public IP automatically)
  const res = await fetchWithTimeout('https://ip-api.com/json/?fields=country,countryCode,city', {}, DEFAULT_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Geolocate error: ${res.status}`);
  const data = await res.json();
  if (!data.country) throw new Error('Could not detect location. Please enter your country manually.');
  return { country: data.country, countryCode: data.countryCode, city: data.city };
}

export function getConfigDownloadURL() {
  return `${API_BASE}/api/config`;
}

// ── Pricing ───────────────────────────────────────────────────────────────────

/**
 * Returns the current ASX/USD rate and cost per GB.
 * Shape: { asxPriceUsd, usdPerGb, asxPerGb }
 */
export async function getAsxRate() {
  const res = await fetchWithTimeout(`${API_BASE}/api/rate/asx`);
  if (!res.ok) throw new Error(`Rate error: ${res.status}`);
  return res.json();
}

/**
 * Returns an ASX quote for a given USD deposit amount.
 * Shape: { usdAmount, asxAmount, asxPriceUsd, gbAvailable, breakdown }
 */
export async function getDepositQuote(usdAmount) {
  const res = await fetchWithTimeout(`${API_BASE}/api/deposit/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usdAmount }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Balance ───────────────────────────────────────────────────────────────────

/**
 * Look up the ASX balance for a Solana wallet address.
 * Shape: { balance, deviceId, found }
 */
export async function fetchBalanceByWallet(walletAddress) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/balance?walletAddress=${encodeURIComponent(walletAddress)}`
  );
  if (!res.ok) throw new Error(`Balance error: ${res.status}`);
  return res.json();
}

// ── Top-up ────────────────────────────────────────────────────────────────────

/**
 * Verify an on-chain ASX transfer and credit the device balance.
 * Shape: { success, amountAdded, newBalance }
 */
export async function verifyTopup(deviceId, txSignature) {
  const res = await fetchWithTimeout(`${API_BASE}/api/topup/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, txSignature }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── VPN ───────────────────────────────────────────────────────────────────────

/**
 * Report VPN data usage and deduct from ASX balance.
 * Shape: { success, balance, deducted, asxPerGb }
 */
export async function reportVpnUsage(deviceId, gbUsed) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, gbUsed }),
  });
  if (!res.ok) throw new Error(`VPN usage error: ${res.status}`);
  return res.json();
}

/**
 * Record a completed VPN session on the server.
 * Shape: { success, session }
 */
export async function reportVpnDisconnect(deviceId, gbUsed, hostWalletAddress = null, hostDeviceId = null) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, gbUsed, hostWalletAddress, hostDeviceId }),
  });
  if (!res.ok) throw new Error(`VPN disconnect error: ${res.status}`);
  return res.json();
}

/**
 * Step 1 of the NetSepio VPN flow: obtain a flow ID and EULA for wallet signing.
 * Shape: { flowId, eula, hexWalletAddress }
 */
export async function getNetSepioFlowId(walletAddress) {
  const res = await fetchWithTimeout(
    `${API_BASE}/api/vpn/netsepio/flowid?walletAddress=${encodeURIComponent(walletAddress)}`
  );
  if (!res.ok) throw new Error(`FlowID error: ${res.status}`);
  return res.json();
}

/**
 * Step 2 of the NetSepio VPN flow: authenticate and receive a WireGuard config.
 * Shape: { success, wgConfig, balance, protocol }
 */
export async function connectVpnNetSepio(deviceId, flowId, signature, pubKey, walletAddress, message) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, flowId, signature, pubKey, walletAddress, message }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Get NetSepio subscription status.
 */
export async function getNetSepioSubscription(deviceId) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/subscription?deviceId=${deviceId}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Start NetSepio trial subscription.
 */
export async function startNetSepioTrial(deviceId) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/subscription/trial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Get NetSepio nodes.
 */
export async function getNetSepioNodes(deviceId) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/nodes?deviceId=${deviceId}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Create Erebrus VPN client.
 */
export async function createNetSepioClient(deviceId, region, name, presharedKey, publicKey) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/client/${region}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, name, presharedKey, publicKey }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Get Erebrus VPN clients.
 */
export async function getNetSepioClients(deviceId) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/clients?deviceId=${deviceId}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Get client blobId.
 */
export async function getNetSepioClientBlobId(deviceId, uuid) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/client/${uuid}/blobId?deviceId=${deviceId}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Delete Erebrus VPN client.
 */
export async function deleteNetSepioClient(deviceId, uuid) {
  const res = await fetchWithTimeout(`${API_BASE}/api/vpn/netsepio/client/${uuid}?deviceId=${deviceId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Hotspot hosting ───────────────────────────────────────────────────────────

export async function reportSpeed(deviceId, speed) {
  const res = await fetchWithTimeout(`${API_BASE}/api/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, speed }),
  });
  if (!res.ok) throw new Error(`Speed report error: ${res.status}`);
  return res.json();
}

/**
 * Publish hotspot network details so they appear on the global map.
 */
export async function updateHostSettings(deviceId, networks, country, countryCode, walletAddress) {
  const res = await fetchWithTimeout(`${API_BASE}/api/hotspot/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, networks, country, countryCode, walletAddress }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Report data shared by a host and credit earnings accordingly.
 */
export async function reportHotspotUsage(hostDeviceId, clientDeviceId, gbUsed) {
  const res = await fetchWithTimeout(`${API_BASE}/api/hotspot/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostDeviceId, clientDeviceId, gbUsed }),
  });
  if (!res.ok) throw new Error(`Hotspot usage error: ${res.status}`);
  return res.json();
}

/**
 * Claim accumulated hosting earnings to a Solana wallet.
 * Shape: { success, claimed, remainingEarned }
 */
export async function claimEarnings(deviceId, walletAddress) {
  const res = await fetchWithTimeout(`${API_BASE}/api/hotspot/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, walletAddress }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Live location ─────────────────────────────────────────────────────────────

export async function updateLiveLocation(deviceId, ssid, lat, lon, walletAddress) {
  const res = await fetchWithTimeout(`${API_BASE}/api/hotspot/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, ssid, lat, lon, walletAddress: walletAddress || null }),
  });
  if (!res.ok) throw new Error(`Live location error: ${res.status}`);
  return res.json();
}

export async function removeLiveLocation(deviceId, ssid) {
  const res = await fetchWithTimeout(`${API_BASE}/api/hotspot/live`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, ssid: ssid || null }),
  });
  if (!res.ok) throw new Error(`Remove live error: ${res.status}`);
  return res.json();
}

export async function fetchLiveLocations() {
  const res = await fetchWithTimeout(`${API_BASE}/api/hotspot/live`);
  if (!res.ok) throw new Error(`Fetch live error: ${res.status}`);
  return res.json();
}

// reportPay is a fire-and-forget analytics stub
export async function reportPay(amount) {
  try {
    await fetchWithTimeout(`${API_BASE}/api/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
  } catch { /* non-critical */ }
}
