import { useState, useEffect, useCallback, useRef } from 'react';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
  Linking,
  Animated,
  Dimensions,
  ActivityIndicator,
  Platform,
  ImageBackground,
  Modal,
  TextInput,
  PermissionsAndroid,
  ScrollView,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Device from 'expo-device';
import WifiManager from 'react-native-wifi-reborn';
import Constants from 'expo-constants';
import {
  fetchStats, pingServer, fetchNetworksJSON, getConfigDownloadURL,
  reportPay, verifyTopup, reportVpnUsage,
  reportVpnDisconnect, getAsxRate, getDepositQuote,
  getNetSepioFlowId, connectVpnNetSepio, fetchCountries,
  fetchBalanceByWallet,
} from '../services/api';
import { useWallet } from '../utils/WalletContext';
import {
  connectVpn, disconnectVpn, onVpnStatusChange, getVpnTrafficStats, isVpnConnected,
} from '../utils/VpnManager';

const TREASURY_WALLET = '6bvB3PTz48wozyPJeuTB77axexWu9MfUSjBYbQzEgK88';
const BALANCE_CACHE_URI = FileSystem.documentDirectory + 'asx_balance.json';
const DEVICE_ID_URI = FileSystem.documentDirectory + 'device_id.txt';
const { width, height } = Dimensions.get('window');
const PING_INTERVAL_MS = 60_000;
const STATS_POLL_MS = 15_000;
// Android system nav bar height offset
const ANDROID_NAV_OFFSET = Platform.OS === 'android' ? 56 : 0;

async function getOrCreateDeviceId() {
  try {
    const stored = await FileSystem.readAsStringAsync(DEVICE_ID_URI);
    if (stored) return stored;
  } catch {}
  const id = Constants.installationId ||
    `${Device.modelName}-${Device.osVersion}-${Math.random().toString(36).slice(2)}`;
  await FileSystem.writeAsStringAsync(DEVICE_ID_URI, id).catch(() => {});
  return id;
}

async function copyToClipboard(text) {
  await Clipboard.setStringAsync(text);
}


function shortenAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// Escape special chars in WiFi QR fields: \ ; " , must be backslash-escaped
function wifiEscape(str = '') {
  return str.replace(/[\\;",]/g, c => '\\' + c);
}

function wifiQrValue(ssid, password, encryption) {
  const type = encryption === 'Open' ? 'nopass' : (encryption || 'WPA');
  const pass  = type === 'nopass' ? '' : wifiEscape(password);
  return `WIFI:T:${type};S:${wifiEscape(ssid)};P:${pass};;`;
}

export default function ConnectScreen() {
  const { walletAddress, connect, disconnect, sendASX, signMessage } = useWallet();

  const [stats, setStats] = useState({
    activeHotspots: 0,
    totalCoverageM2: 0,
    avgSpeed: '–',
    treasuryWallet: TREASURY_WALLET,
    asxPriceUsd: 0,
    usdPerGb: 0.1,
  });
  const [asxPerGb, setAsxPerGb] = useState(0);
  const [loading, setLoading] = useState(false);       // "Dip In" button
  const [vpnLoading, setVpnLoading] = useState(false); // VPN button
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [vpnConnected, setVpnConnected] = useState(false);
  const [vpnDataGB, setVpnDataGB] = useState(0);
  const [asxBalance, setAsxBalance] = useState(0);

  // Persist balance across reloads (local cache)
  useEffect(() => {
    FileSystem.readAsStringAsync(BALANCE_CACHE_URI)
      .then(raw => { const v = parseFloat(raw); if (!isNaN(v)) setAsxBalance(v); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (asxBalance > 0) FileSystem.writeAsStringAsync(BALANCE_CACHE_URI, String(asxBalance)).catch(() => {});
  }, [asxBalance]);

  // Restore balance whenever the wallet address changes
  useEffect(() => {
    if (!walletAddress) {
      setAsxBalance(0);
      FileSystem.writeAsStringAsync(BALANCE_CACHE_URI, '0').catch(() => {});
      return;
    }
    fetchBalanceByWallet(walletAddress)
      .then(data => { if (data.found) setAsxBalance(data.balance ?? 0); })
      .catch(() => {});
  }, [walletAddress]);
  const [error, setError] = useState(null);

  // Top-up modal
  const [showTopupModal, setShowTopupModal] = useState(false);
  const [topupUsd, setTopupUsd] = useState('');
  const [topupQuote, setTopupQuote] = useState(null);
  const [verifyingPayment, setVerifyingPayment] = useState(false);
  const [topupStep, setTopupStep] = useState('quote'); // 'quote' | 'verify'

  const [statsModalVisible, setStatsModalVisible] = useState(false);
  const [tipModalNetwork, setTipModalNetwork] = useState(null);
  const [tipAmount, setTipAmount] = useState('');
  const [networksModalVisible, setNetworksModalVisible] = useState(false);
  const [hotpotNetworks, setHotpotNetworks] = useState([]);
  const [allHotpotNetworks, setAllHotpotNetworks] = useState([]);
  const [availableCountries, setAvailableCountries] = useState([]);
  const [selectedCountry, setSelectedCountry] = useState(null); // null = all
  const [qrNetwork, setQrNetwork] = useState(null); // { ssid, password, encryption }
  const [qrAllNetworks, setQrAllNetworks] = useState([]); // paginated "add all" QR flow
  const [qrAllIndex, setQrAllIndex] = useState(0);
  const deviceIdRef    = useRef(null);
  const vpnDataGBRef   = useRef(0);
  /** Cumulative GB as of the last billing tick — used to compute the delta. */
  const lastTotalGBRef = useRef(0);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;

  // Load stable deviceId from FileSystem on mount, then re-ping so balance loads correctly
  useEffect(() => {
    getOrCreateDeviceId().then(id => {
      deviceIdRef.current = id;
      // Re-ping now that deviceId is ready (first ping on mount may have had null deviceId)
      if (walletAddress) sendPing();
    });
  }, []);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.05, duration: 1500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const data = await fetchStats();
      setStats(prev => ({ ...prev, ...data }));
      setError(null);
    } catch (e) {
      setError('Unable to reach server');
    }
  }, []);

  const loadAsxRate = useCallback(async () => {
    try {
      const rate = await getAsxRate();
      setAsxPerGb(rate.asxPerGb);
      setStats(prev => ({ ...prev, asxPriceUsd: rate.asxPriceUsd, usdPerGb: rate.usdPerGb }));
    } catch {}
  }, []);

  const sendPing = useCallback(async () => {
    try {
      const data = await pingServer(deviceIdRef.current, walletAddress);
      setStats(prev => ({ ...prev, ...data }));
      if (data.balance !== undefined) setAsxBalance(data.balance);
      setError(null);
    } catch {}
  }, [walletAddress]);

  useEffect(() => {
    loadStats();
    loadAsxRate();
    sendPing();
    const statsInterval = setInterval(loadStats, STATS_POLL_MS);
    const pingInterval = setInterval(sendPing, PING_INTERVAL_MS);
    const rateInterval = setInterval(loadAsxRate, 60_000);
    return () => {
      clearInterval(statsInterval);
      clearInterval(pingInterval);
      clearInterval(rateInterval);
    };
  }, [loadStats, sendPing, loadAsxRate]);

  // Bill VPN usage based on real WireGuard traffic bytes (polled every 5 s).
  useEffect(() => {
    if (!vpnConnected) return;
    lastTotalGBRef.current = 0; // reset per session

    const interval = setInterval(async () => {
      const stats = await getVpnTrafficStats();
      const currentGB = stats.totalGB ?? 0;
      const deltaGB   = Math.max(0, currentGB - lastTotalGBRef.current);
      lastTotalGBRef.current = currentGB;

      // Always update displayed counter
      vpnDataGBRef.current = currentGB;
      setVpnDataGB(currentGB);

      if (deltaGB <= 0) return; // no new traffic this tick

      // Check balance before billing
      const cost = deltaGB * asxPerGb;
      if (asxBalance < cost) {
        setVpnConnected(false);
        disconnectVpn();
        reportVpnDisconnect(deviceIdRef.current, vpnDataGBRef.current, null, null).catch(console.warn);
        Alert.alert('Balance Empty', 'Your ASX balance is too low. Please top up.');
        return;
      }

      try {
        const res = await reportVpnUsage(deviceIdRef.current, deltaGB);
        if (res.success) setAsxBalance(res.balance);
      } catch {}
    }, 5000);

    return () => clearInterval(interval);
  }, [vpnConnected, asxBalance, asxPerGb]);

  const handleWalletConnect = async () => {
    setWalletConnecting(true);
    try {
      await connect();
    } catch (e) {
      Alert.alert('Wallet Error', e.message || 'Could not connect wallet.');
    } finally {
      setWalletConnecting(false);
    }
  };

  const handleConnect = async () => {
    setLoading(true);
    try {
      // Fetch networks + available countries in parallel
      const [networkData, countriesData] = await Promise.all([
        fetchNetworksJSON(),
        fetchCountries().catch(() => ({ countries: [] })),
      ]);
      const networks = networkData.networks || [];
      const countries = countriesData.countries || [];

      if (Platform.OS === 'android') {
        setAllHotpotNetworks(networks);
        setHotpotNetworks(networks);
        setAvailableCountries(countries);
        setSelectedCountry(null);
        setNetworksModalVisible(true);
        setConnected(true);
        reportPay(0.05).catch(() => {});
      } else {
        // iOS: download and share .mobileconfig profile
        const fileUri = FileSystem.documentDirectory + 'networks.mobileconf';
        const downloadResult = await FileSystem.downloadAsync(getConfigDownloadURL(), fileUri);
        if (downloadResult.status !== 200) throw new Error('Download failed');

        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: 'application/x-apple-aspen-config',
            dialogTitle: 'Install Hotpot Ingredients',
            UTI: 'com.apple.mobileconfig',
          });
        }
        setConnected(true);
        reportPay(0.05).catch(() => {});
      }
    } catch (e) {
      Alert.alert('Connection Stalled', e.message || 'Could not download config.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCountry = (cc) => {
    const next = cc === selectedCountry ? null : cc;
    setSelectedCountry(next);
    if (next) {
      setHotpotNetworks(allHotpotNetworks.filter(n => n.countryCode === next || (!n.countryCode && next === 'XX')));
    } else {
      setHotpotNetworks(allHotpotNetworks);
    }
  };

  const handleOpenWifiSettings = () => {
    Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() =>
      Linking.openSettings()
    );
  };

  const ensureLocationPermission = async () => {
    if (Platform.OS !== 'android') return true;
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    if (granted) return true;
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Location Permission',
        message: 'Hotpot needs location access to suggest nearby WiFi networks.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      }
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  };

  const handleConnectToNetwork = async (network) => {
    if (Platform.OS === 'android') {
      if (Platform.Version >= 29) {
        // Android 10+: WifiNetworkSpecifier — shows native "Connect to [SSID]?" dialog
        const ok = await ensureLocationPermission();
        if (!ok) return;
        try {
          await WifiManager.connectToProtectedSSID(
            network.ssid,
            network.encryption === 'Open' ? '' : network.password,
            false,
            false,
          );
        } catch (e) {
          // connectToProtectedSSID on Android 10+ requires the network to be in range.
          // Fall back to suggesting the network for auto-connect when in range.
          try {
            await WifiManager.suggestWifiNetwork([{
              ssid: network.ssid,
              password: network.encryption === 'Open' ? undefined : network.password,
              isWpa3: network.encryption === 'WPA3',
            }]);
            Alert.alert('Network Saved', `"${network.ssid}" was added. Your device will connect automatically when in range.`);
          } catch (e2) {
            Alert.alert('Could not add network', e2.message || 'Failed to add network.');
          }
        }
      } else {
        // Android <10: legacy addNetwork API requires location permission
        const ok = await ensureLocationPermission();
        if (!ok) return;
        try {
          await WifiManager.connectToProtectedSSID(
            network.ssid,
            network.encryption === 'Open' ? '' : network.password,
            false,
            false,
          );
          handleOpenWifiSettings();
        } catch (e) {
          Alert.alert('Could not connect', e.message || 'Failed to connect to network.');
        }
      }
    } else {
      // iOS: use NEHotspotConfiguration API
      try {
        await WifiManager.connectToProtectedSSID(
          network.ssid,
          network.encryption === 'Open' ? null : network.password,
          network.encryption === 'WEP',
          false,
        );
      } catch (e) {
        Alert.alert('Could not connect', e.message || 'Failed to connect to network.');
      }
    }
  };

  const handleTipNetwork = (network) => {
    if (!walletAddress) {
      Alert.alert('Wallet Required', 'Connect your Solana wallet to send a tip.');
      return;
    }
    if (!network.walletAddress) {
      Alert.alert('No Wallet', 'This hotspot host has not linked a wallet address.');
      return;
    }
    if (network.walletAddress === walletAddress) {
      Alert.alert('Cannot Tip Yourself', 'This is your own hotspot.');
      return;
    }
    setTipAmount('');
    setTipModalNetwork(network);
  };

  const handleSendTip = async () => {
    const amount = parseFloat(tipAmount);
    if (!amount || amount <= 0) {
      Alert.alert('Invalid Amount', 'Enter a valid ASX amount.');
      return;
    }
    const network = tipModalNetwork;
    setTipModalNetwork(null);
    try {
      const sig = await sendASX(network.walletAddress, amount);
      Alert.alert('Tip Sent!', `Transaction confirmed.\n${sig.slice(0, 16)}...`);
    } catch (e) {
      Alert.alert('Tip Failed', e.message || 'Transaction rejected.');
    }
  };

  const handleAddAllNetworks = async (networks) => {
    if (networks.length === 0) return;
    if (Platform.Version < 29) {
      // Legacy: connect directly to first network
      try {
        const ok = await ensureLocationPermission();
        if (!ok) return;
        await WifiManager.connectToProtectedSSID(networks[0].ssid, networks[0].password, false, false);
      } catch {}
      Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => Linking.openSettings());
      return;
    }
    // Android 10+: show QR codes one by one — Android natively prompts "Save network" on scan
    setNetworksModalVisible(false);
    setQrAllNetworks(networks);
    setQrAllIndex(0);
  };

  // Sync vpnConnected with the actual native service state on mount.
  // The service can survive an app restart (START_STICKY), so we must check.
  useEffect(() => {
    isVpnConnected().then(active => { if (active) setVpnConnected(true); });
  }, []);

  // Subscribe to VPN status events from the native service.
  // Empty deps — subscribe once on mount so the listener is never torn down
  // mid-connection (which would cause the loading state to get stuck).
  useEffect(() => {
    const unsub = onVpnStatusChange((status) => {
      if (status === 'CONNECTED') {
        vpnDataGBRef.current   = 0;
        lastTotalGBRef.current = 0;
        setVpnConnected(true);
        setVpnDataGB(0);
        setVpnLoading(false);
      } else if (status === 'DISCONNECTED') {
        // Always report — this callback only fires when the service stops
        reportVpnDisconnect(deviceIdRef.current, vpnDataGBRef.current, null, null).catch(console.warn);
        setVpnConnected(false);
        vpnDataGBRef.current   = 0;
        lastTotalGBRef.current = 0;
        setVpnDataGB(0);
        setVpnLoading(false);
      } else if (status?.startsWith('ERROR:')) {
        const msg = status.slice(6) || 'VPN error';
        Alert.alert('VPN Failed', msg);
        setVpnConnected(false);
        setVpnLoading(false);
      }
    });
    return unsub;
  }, []);

  const handleVpnConnect = async () => {
    // If already connected → disconnect
    if (vpnConnected) {
      disconnectVpn();
      return;
    }

    if (asxBalance <= 0) {
      Alert.alert('Top Up Required', 'You need ASX balance to start the VPN connection.');
      return;
    }
    if (!walletAddress) {
      Alert.alert('Wallet Required', 'Connect your Solana wallet to use the VPN.');
      return;
    }

    setVpnLoading(true);
    try {
      // 1. Get NetSepio flow ID + EULA for this wallet
      const { flowId, eula } = await getNetSepioFlowId(walletAddress);

      // 2. Sign eula+flowId with Phantom (user approves in wallet)
      const messageToSign = (eula || '') + flowId;
      const SIGN_TIMEOUT_MS = 90_000;
      const { signature, pubKey } = await Promise.race([
        signMessage(messageToSign),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Wallet signing timed out. Please try again.')), SIGN_TIMEOUT_MS)
        ),
      ]);

      // 3. Backend authenticates with NetSepio + gets real WireGuard config from Erebrus
      const credData = await connectVpnNetSepio(deviceIdRef.current, flowId, signature, pubKey, walletAddress, messageToSign);
      if (!credData.success || !credData.wgConfig) {
        throw new Error('No WireGuard config returned from Erebrus.');
      }
      console.log('[VPN] WireGuard config:\n', credData.wgConfig);

      // 4. Start in-app WireGuard tunnel.
      // connectVpn() awaits the native promise, which is resolved only after the
      // CONNECTED broadcast arrives — so the tunnel is already UP when we return.
      const result = await connectVpn(credData.wgConfig);
      if (!result.success) {
        throw new Error(result.error || 'Failed to start VPN service.');
      }
      // Belt-and-suspenders: set state here in case the JS event was missed
      // (e.g. rapid re-subscribe during VPN permission dialog lifecycle).
      // Check handshake health: if rx is still 0 after 8 s the peer isn't responding.
      setTimeout(async () => {
        const s = await getVpnTrafficStats();
        if (s.txBytes > 0 && s.rxBytes === 0) {
          disconnectVpn();
          Alert.alert(
            'VPN Unreachable',
            'Connected to the tunnel but the server is not responding.\n\nThe VPN server may be offline or its firewall is blocking UDP traffic.',
          );
        }
      }, 8000);
      vpnDataGBRef.current   = 0;
      lastTotalGBRef.current = 0;
      setVpnConnected(true);
      setVpnDataGB(0);
      setVpnLoading(false);
    } catch (e) {
      const isCancelled =
        (e.message || '').includes('CancellationException') ||
        (e.message || '').includes('timed out') ||
        (e.message || '').includes('cancelled');
      if (!isCancelled) console.warn('[VPN]', e.message);
      const msg = isCancelled
        ? 'Signing cancelled. Please try again.'
        : (e.message || 'Could not connect to VPN.');
      Alert.alert('VPN Failed', msg);
      setVpnLoading(false);
    }
  };

  const handleQuoteTopup = async () => {
    const usd = parseFloat(topupUsd);
    if (!usd || usd <= 0) {
      Alert.alert('Invalid Amount', 'Enter a valid USD amount.');
      return;
    }
    setVerifyingPayment(true);
    try {
      const quote = await getDepositQuote(usd);
      setTopupQuote(quote);
      setTopupStep('verify');
    } catch (e) {
      Alert.alert('Quote Failed', e.message);
    } finally {
      setVerifyingPayment(false);
    }
  };

  const handleAutomatedPayment = async () => {
    if (!walletAddress) {
      Alert.alert('Wallet Not Connected', 'Please connect your wallet first.');
      return;
    }
    setVerifyingPayment(true);
    try {
      // 1. Execute transfer via MWA
      const signature = await sendASX(TREASURY_WALLET, topupQuote.asxAmount);
      
      // 2. Verify on backend
      const data = await verifyTopup(deviceIdRef.current, signature);
      if (data.success) {
        setAsxBalance(data.newBalance);
        setShowTopupModal(false);
        setTopupUsd('');
        setTopupQuote(null);
        setTopupStep('quote');
        Alert.alert('Success', `${data.amountAdded.toFixed(2)} ASX added to your balance!`);
      }
    } catch (e) {
      console.error('[PAYMENT] Error:', e);
      Alert.alert('Payment Error', e.message || 'Transaction failed or rejected.');
    } finally {
      setVerifyingPayment(false);
    }
  };

  const formatNumber = (n) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#050000" />

      <ImageBackground
        source={require('../../assets/hotpot-bg.png')}
        style={styles.bgImage}
        imageStyle={{ opacity: 0.4 }}
      >
        <View style={styles.overlay} />

        <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

          {/* ── Wallet connect bar ── */}
          <View style={styles.walletBar}>
            {walletAddress ? (
              <View style={styles.walletConnected}>
                <View style={styles.walletDot} />
                <Text style={styles.walletAddr}>{shortenAddress(walletAddress)}</Text>
                <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
                  <Text style={styles.disconnectBtnText}>Disconnect</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.connectWalletBtn}
                onPress={handleWalletConnect}
                disabled={walletConnecting}
              >
                {walletConnecting
                  ? <ActivityIndicator color="#9945FF" size="small" />
                  : <Text style={styles.connectWalletText}>◎ Connect Wallet</Text>
                }
              </TouchableOpacity>
            )}
          </View>

          {/* ── Logo ── */}
          <View style={styles.logoContainer}>
            <Text style={styles.logoIcon}>🍲</Text>
            <Text style={styles.logoText}>HOTPOT</Text>
            <TouchableOpacity onPress={() => setStatsModalVisible(true)} style={styles.statsButton}>
              <Text style={styles.statsButtonText}>📊 Stats</Text>
            </TouchableOpacity>
          </View>

          {/* ── Stats Cards ── */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statEmoji}>🛡️</Text>
              <Text style={styles.statValue}>{vpnDataGB.toFixed(1)} GB</Text>
              <Text style={styles.statLabel}>VPN Data</Text>
              <Text style={styles.statDetail}>${stats.usdPerGb?.toFixed(2) || '0.10'}/GB</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statEmoji}>💸</Text>
              <Text style={styles.statValue}>{asxBalance.toFixed(2)}</Text>
              <Text style={styles.statLabel}>ASX Balance</Text>
              <TouchableOpacity style={styles.topUpBtn} onPress={() => { setTopupStep('quote'); setShowTopupModal(true); }} disabled={loading}>
                <Text style={styles.topUpBtnText}>+ TOP UP</Text>
              </TouchableOpacity>
            </View>
          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          )}

          {/* ── Action Buttons ── */}
          <Animated.View style={[styles.actionRow, { transform: [{ scale: pulseAnim }] }]}>
            <TouchableOpacity
              style={[styles.connectButton, connected && styles.connectedButton]}
              onPress={handleConnect}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading
                ? <ActivityIndicator color="#fff" size="large" />
                : <>
                    <Text style={styles.connectIcon}>{connected ? '😋' : '⚡'}</Text>
                    <Text style={styles.connectText}>{connected ? 'Full' : 'DIP IN'}</Text>
                  </>
              }
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.connectButton, styles.vpnButton, vpnConnected && styles.vpnConnectedButton]}
              onPress={handleVpnConnect}
              disabled={vpnLoading}
              activeOpacity={0.85}
            >
              {vpnLoading
                ? <ActivityIndicator color="#fff" size="large" />
                : <>
                    <Text style={styles.connectIcon}>{vpnConnected ? '🔒' : '🔓'}</Text>
                    <Text style={styles.connectText}>{vpnConnected ? 'SECURE' : 'VPN'}</Text>
                  </>
              }
            </TouchableOpacity>
          </Animated.View>

          <Text style={styles.connectHint}>
            {connected ? 'You are sharing the meal · ' : 'Tap to add ingredients · '}
            {vpnConnected ? 'VPN Active' : 'VPN Offline'}
          </Text>

          <TouchableOpacity style={styles.termsLink} onPress={() => Linking.openURL('https://assetux.gitbook.io/assetux/legal/terms-of-use')}>
            <Text style={styles.termsText}>Kitchen Rules (T&C)</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* ── Top Up Modal ── */}
        <Modal visible={showTopupModal} transparent animationType="slide" onRequestClose={() => setShowTopupModal(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>TOP UP ASX</Text>

              {topupStep === 'quote' ? (
                <>
                  <Text style={styles.modalDesc}>
                    Enter how much USD you want to deposit. We'll calculate the ASX amount at the current rate.
                  </Text>
                  {stats.asxPriceUsd > 0 && (
                    <Text style={styles.rateText}>
                      1 ASX = ${stats.asxPriceUsd.toFixed(5)} · 1 GB = $0.10
                    </Text>
                  )}
                  <View style={styles.inputRow}>
                    <Text style={styles.inputPrefix}>$</Text>
                    <TextInput
                      style={styles.txInput}
                      placeholder="10.00"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={topupUsd}
                      onChangeText={setTopupUsd}
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <TouchableOpacity style={[styles.verifyBtn, verifyingPayment && styles.verifyBtnDisabled]} onPress={handleQuoteTopup} disabled={verifyingPayment}>
                    {verifyingPayment ? <ActivityIndicator color="#000" /> : <Text style={styles.verifyBtnText}>GET QUOTE</Text>}
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {topupQuote && (
                    <View style={styles.quoteBox}>
                      <Text style={styles.quoteRow}>💵 USD: <Text style={styles.quoteVal}>${topupQuote.usdAmount.toFixed(2)}</Text></Text>
                      <Text style={styles.quoteRow}>🪙 ASX: <Text style={styles.quoteVal}>{topupQuote.asxAmount.toFixed(4)}</Text></Text>
                      <Text style={styles.quoteRow}>📶 GB: <Text style={styles.quoteVal}>{topupQuote.gbAvailable.toFixed(2)} GB</Text></Text>
                      <Text style={styles.quoteRow}>🔥 Burn (10%): <Text style={styles.quoteVal}>{topupQuote.breakdown.burned.toFixed(4)}</Text></Text>
                    </View>
                  )}
                  <Text style={styles.modalDesc}>
                    Approve the transaction in your wallet to automatically top up your balance.
                  </Text>
                  <View style={styles.addressBox}>
                    <Text style={styles.addressLabel}>TREASURY</Text>
                    <Text style={styles.addressText} selectable>{TREASURY_WALLET}</Text>
                  </View>
                  <TouchableOpacity 
                    style={[styles.verifyBtn, verifyingPayment && styles.verifyBtnDisabled]} 
                    onPress={handleAutomatedPayment} 
                    disabled={verifyingPayment}
                  >
                    {verifyingPayment ? <ActivityIndicator color="#000" /> : <Text style={styles.verifyBtnText}>AUTHORIZE & PAY</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.backBtn} onPress={() => setTopupStep('quote')}>
                    <Text style={styles.closeBtnText}>← BACK</Text>
                  </TouchableOpacity>
                </>
              )}

              <TouchableOpacity style={styles.closeBtn} onPress={() => setShowTopupModal(false)}>
                <Text style={styles.closeBtnText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Networks Modal (Android) ── */}
        <Modal animationType="slide" transparent visible={networksModalVisible} onRequestClose={() => setNetworksModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>🍲 Hotpot Networks</Text>
              <Text style={styles.modalDesc}>
                {Platform.Version >= 29
                  ? 'Tap a network to suggest it, or add all at once. Your device auto-connects when in range.'
                  : 'Tap a network to connect directly.'}
              </Text>

              {/* Country filter chips — only shown if hosts from multiple countries exist */}
              {availableCountries.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.countryScroll} contentContainerStyle={styles.countryScrollContent}>
                  <TouchableOpacity
                    style={[styles.countryChip, !selectedCountry && styles.countryChipActive]}
                    onPress={() => handleSelectCountry(null)}
                  >
                    <Text style={[styles.countryChipText, !selectedCountry && styles.countryChipTextActive]}>🌍 All</Text>
                  </TouchableOpacity>
                  {availableCountries.map(c => (
                    <TouchableOpacity
                      key={c.countryCode}
                      style={[styles.countryChip, selectedCountry === c.countryCode && styles.countryChipActive]}
                      onPress={() => handleSelectCountry(c.countryCode)}
                    >
                      <Text style={[styles.countryChipText, selectedCountry === c.countryCode && styles.countryChipTextActive]}>
                        {c.country} ({c.networkCount})
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}

              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                <TouchableOpacity style={[styles.wifiSettingsBtn, { flex: 1 }]} onPress={handleOpenWifiSettings}>
                  <Text style={styles.wifiSettingsBtnText}>⚙️ WiFi Settings</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.wifiSettingsBtn, { flex: 1, backgroundColor: '#ff2a2a' }]} onPress={() => handleAddAllNetworks(hotpotNetworks)}>
                  <Text style={styles.wifiSettingsBtnText}>⚡ Add All</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={true} nestedScrollEnabled>
                {hotpotNetworks.length === 0 ? (
                  <Text style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginVertical: 20 }}>No networks available nearby.</Text>
                ) : (
                  hotpotNetworks.map((net, i) => (
                    <View key={i} style={styles.networkRow}>
                      <View style={styles.networkField}>
                        <Text style={styles.networkSSID}>📡 {net.ssid}</Text>
                        <TouchableOpacity style={styles.copyBtn} onPress={() => copyToClipboard(net.ssid)}>
                          <Text style={styles.copyBtnText}>Copy</Text>
                        </TouchableOpacity>
                      </View>
                      <View style={styles.networkField}>
                        <Text style={styles.networkPass} numberOfLines={1}>🔑 {net.password}</Text>
                        <TouchableOpacity style={styles.copyBtn} onPress={() => copyToClipboard(net.password)}>
                          <Text style={styles.copyBtnText}>Copy</Text>
                        </TouchableOpacity>
                      </View>
                      {net.walletAddress && (
                        <View style={styles.networkField}>
                          <Text style={styles.networkWallet} numberOfLines={1}>💰 {net.walletAddress.slice(0, 8)}...{net.walletAddress.slice(-6)}</Text>
                          <TouchableOpacity style={styles.copyBtn} onPress={() => copyToClipboard(net.walletAddress)}>
                            <Text style={styles.copyBtnText}>Copy</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      <View style={styles.networkActions}>
                        <View style={styles.securityBadge}>
                          <Text style={styles.securityBadgeText}>🔒 {net.encryption || 'WPA2'}</Text>
                        </View>
                        <TouchableOpacity style={styles.addBtn} onPress={() => handleConnectToNetwork(net)}>
                          <Text style={styles.addBtnText}>+ Add</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.qrSmallBtn} onPress={() => setQrNetwork(net)}>
                          <Text style={styles.qrSmallBtnText}>QR</Text>
                        </TouchableOpacity>
                      </View>
                      <TouchableOpacity style={styles.tipBtn} onPress={() => handleTipNetwork(net)}>
                        <Text style={styles.tipBtnText}>🪙 Send Tip</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </ScrollView>
              <TouchableOpacity style={styles.closeBtnPrimary} onPress={() => setNetworksModalVisible(false)}>
                <Text style={styles.closeBtnPrimaryText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── QR Code Modal ── */}
        <Modal animationType="fade" transparent visible={!!qrNetwork} onRequestClose={() => setQrNetwork(null)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { alignItems: 'center' }]}>
              <Text style={styles.modalTitle}>📶 Scan to Connect</Text>
              {qrNetwork && (
                <>
                  <Text style={styles.modalDesc}>
                    Point your camera at this QR code. Android will prompt you to add{' '}
                    <Text style={{ color: '#fff', fontWeight: '800' }}>{qrNetwork.ssid}</Text> to your saved networks.
                  </Text>
                  <View style={styles.qrWrapper}>
                    <QRCode
                      value={wifiQrValue(qrNetwork.ssid, qrNetwork.password, qrNetwork.encryption)}
                      size={220}
                      backgroundColor="#fff"
                      color="#000"
                    />
                  </View>
                  {/* <Text style={styles.qrSsid}>📡 {qrNetwork.ssid}</Text>
                  <Text style={styles.qrPass}>🔑 {qrNetwork.password}</Text> */}
                </>
              )}
              <TouchableOpacity style={styles.closeBtnPrimary} onPress={() => setQrNetwork(null)}>
                <Text style={styles.closeBtnPrimaryText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Add All QR Modal ── */}
        <Modal animationType="fade" transparent visible={qrAllNetworks.length > 0} onRequestClose={() => setQrAllNetworks([])}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { alignItems: 'center' }]}>
              <Text style={styles.modalTitle}>📶 Scan to Save</Text>
              <Text style={styles.modalDesc}>
                Network <Text style={{ color: '#fff', fontWeight: '800' }}>{qrAllIndex + 1} of {qrAllNetworks.length}</Text>
                {' '}— Point your camera at the QR code. Android will prompt you to save the network.
              </Text>
              {qrAllNetworks[qrAllIndex] && (
                <>
                  <View style={styles.qrWrapper}>
                    <QRCode
                      value={wifiQrValue(qrAllNetworks[qrAllIndex].ssid, qrAllNetworks[qrAllIndex].password, qrAllNetworks[qrAllIndex].encryption)}
                      size={220}
                      backgroundColor="#fff"
                      color="#000"
                    />
                  </View>
                  <Text style={styles.qrSsid}>📡 {qrAllNetworks[qrAllIndex].ssid}</Text>
                  <Text style={styles.qrPass}>🔑 {qrAllNetworks[qrAllIndex].password}</Text>
                </>
              )}
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                {qrAllIndex > 0 && (
                  <TouchableOpacity style={[styles.closeBtnPrimary, { flex: 1 }]} onPress={() => setQrAllIndex(i => i - 1)}>
                    <Text style={styles.closeBtnPrimaryText}>← Prev</Text>
                  </TouchableOpacity>
                )}
                {qrAllIndex < qrAllNetworks.length - 1 ? (
                  <TouchableOpacity style={[styles.closeBtnPrimary, { flex: 1, backgroundColor: '#ff2a2a' }]} onPress={() => setQrAllIndex(i => i + 1)}>
                    <Text style={styles.closeBtnPrimaryText}>Next →</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={[styles.closeBtnPrimary, { flex: 1, backgroundColor: '#32CD32' }]} onPress={() => setQrAllNetworks([])}>
                    <Text style={[styles.closeBtnPrimaryText, { color: '#000' }]}>Done ✓</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity style={styles.closeBtn} onPress={() => setQrAllNetworks([])}>
                <Text style={styles.closeBtnText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Tip Modal ── */}
        <Modal visible={!!tipModalNetwork} transparent animationType="slide" onRequestClose={() => setTipModalNetwork(null)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>🪙 Send Tip</Text>
              <Text style={styles.modalDesc}>
                To: {tipModalNetwork?.walletAddress?.slice(0, 6)}...{tipModalNetwork?.walletAddress?.slice(-4)}
              </Text>
              <Text style={[styles.modalDesc, { color: '#9945FF', marginBottom: 8 }]}>
                Your balance: {asxBalance.toFixed(2)} ASX
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.txInput}
                  placeholder="Amount (ASX)"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  keyboardType="numeric"
                  value={tipAmount}
                  onChangeText={setTipAmount}
                />
              </View>
                                                                                  {/* onPress={handleSendTip} */}
              <TouchableOpacity style={[styles.closeBtnPrimary, { backgroundColor: '#9945FF', marginTop: 0 }]}>
                <Text style={styles.closeBtnPrimaryText}>TIP (soon)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.closeBtn} onPress={() => setTipModalNetwork(null)}>
                <Text style={styles.closeBtnText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Stats Modal ── */}
        <Modal animationType="slide" transparent visible={statsModalVisible} onRequestClose={() => setStatsModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Network Stats</Text>
              <View style={styles.statsRow}>
                <View style={styles.statCard}>
                  <Text style={styles.statEmoji}>🍜</Text>
                  <Text style={styles.statValue}>soon</Text>
                  <Text style={styles.statLabel}>HOTPOT Price</Text>
                  <Text style={styles.statDetail}>per token</Text>
                </View>
              </View>
              <View style={styles.statsRow}>
                <View style={styles.statCard}>
                  <Text style={styles.statEmoji}>🪙</Text>
                  <Text style={styles.statValue}>${stats.asxPriceUsd?.toFixed(6) || '–'}</Text>
                  <Text style={styles.statLabel}>ASX Price</Text>
                  <Text style={styles.statDetail}>per token</Text>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statEmoji}>🌐</Text>
                  <Text style={styles.statValue}>{formatNumber(stats.totalCoverageM2)}</Text>
                  <Text style={styles.statLabel}>Coverage</Text>
                  <Text style={styles.statDetail}>m² area</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.closeBtnPrimary} onPress={() => setStatsModalVisible(false)}>
                <Text style={styles.closeBtnPrimaryText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050000' },
  bgImage: { flex: 1, width, height, justifyContent: 'center', alignItems: 'center' },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5, 0, 0, 0.75)' },
  content: {
    width: '100%',
    paddingHorizontal: 24,
    alignItems: 'center',
    // Push content up so buttons sit above Android nav bar
    paddingBottom: ANDROID_NAV_OFFSET,
    marginTop: -ANDROID_NAV_OFFSET,
  },

  // Wallet bar
  walletBar: {
    width: '100%',
    alignItems: 'flex-end',
    marginBottom: 10,
    marginTop: 8,
  },
  walletConnected: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(153, 69, 255, 0.15)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(153, 69, 255, 0.4)',
  },
  walletDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#9945FF' },
  walletAddr: { color: '#c084fc', fontSize: 12, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  disconnectBtn: { marginLeft: 6, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(255,42,42,0.2)', borderRadius: 8 },
  disconnectBtnText: { color: '#ff6666', fontSize: 10, fontWeight: '700' },
  connectWalletBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(153, 69, 255, 0.15)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(153, 69, 255, 0.5)',
  },
  connectWalletText: { color: '#9945FF', fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },

  // Logo
  logoContainer: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24, marginTop: 4 },
  logoIcon: { fontSize: 32 },
  logoText: {
    color: '#ff2a2a',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 2,
    textShadowColor: 'rgba(255, 42, 42, 0.5)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 15,
  },

  // Stats
  statsRow: { flexDirection: 'row', gap: 16, marginBottom: 24, width: '100%' },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(20, 5, 5, 0.6)',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 42, 42, 0.3)',
  },
  statEmoji: { fontSize: 24, marginBottom: 6 },
  statValue: { color: '#fff', fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: '#ff9f1c', fontSize: 11, fontWeight: '700', marginTop: 4, textTransform: 'uppercase' },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 50,
    backgroundColor: 'rgba(255,42,42,0.15)', borderWidth: 1, borderColor: 'rgba(255,42,42,0.4)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#ff2a2a' },
  liveText: { color: '#ff2a2a', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  statDetail: { color: 'rgba(255, 200, 200, 0.5)', fontSize: 10, marginTop: 6, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  errorBanner: {
    backgroundColor: 'rgba(255,42,42,0.15)', borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 14, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(255,42,42,0.4)',
  },
  errorText: { color: '#ff5e5e', fontSize: 12, fontWeight: '600' },

  // Action buttons
  actionRow: { flexDirection: 'row', gap: 16, marginTop: 4 },
  connectButton: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: '#ff2a2a',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#ff2a2a',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 20,
    borderWidth: 2,
    borderColor: '#ff5e5e',
  },
  connectedButton: { backgroundColor: '#ff9f1c', borderColor: '#ffbf69', shadowColor: '#ff9f1c' },
  vpnButton: { backgroundColor: '#1E90FF', borderColor: '#00BFFF', shadowColor: '#1E90FF' },
  vpnConnectedButton: { backgroundColor: '#32CD32', borderColor: '#7CFC00', shadowColor: '#32CD32' },
  connectIcon: { fontSize: 34, marginBottom: 2 },
  connectText: { color: '#fff', fontSize: 16, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' },
  connectHint: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 20, fontWeight: '500' },

  termsLink: { marginTop: 24, paddingVertical: 10 },
  termsText: { color: '#ff9f1c', fontSize: 11, textDecorationLine: 'underline', fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  topUpBtn: { marginTop: 10, backgroundColor: '#32CD32', paddingVertical: 5, paddingHorizontal: 14, borderRadius: 8 },
  topUpBtnText: { color: '#000', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  statsButton: {
    marginLeft: 8,
    backgroundColor: 'rgba(255,42,42,0.2)',
    paddingHorizontal: 8, paddingVertical: 5,
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,42,42,0.4)',
  },
  statsButtonText: { color: '#ff2a2a', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: {
    width: '100%', backgroundColor: '#0a0000', borderRadius: 28, padding: 28,
    borderWidth: 1.5, borderColor: '#ff2a2a', elevation: 20, alignItems: 'stretch',
  },
  modalTitle: {
    color: '#fff', fontSize: 26, fontWeight: '900', marginBottom: 16,
    textAlign: 'center', textTransform: 'uppercase', letterSpacing: 2,
  },
  modalDesc: { color: 'rgba(255,255,255,0.85)', fontSize: 14, textAlign: 'center', marginBottom: 20, lineHeight: 20 },
  rateText: { color: '#9945FF', fontSize: 12, textAlign: 'center', marginBottom: 14, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  inputPrefix: { color: '#fff', fontSize: 20, fontWeight: '800', marginRight: 8 },
  addressBox: { backgroundColor: 'rgba(255,42,42,0.12)', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: 'rgba(255,42,42,0.4)', marginBottom: 20 },
  addressLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 9, fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  addressText: { color: '#ff2a2a', fontSize: 11, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Courier-Bold' : 'monospace', textAlign: 'center' },
  highlightText: { color: '#9945FF', fontWeight: '800' },
  quoteBox: {
    backgroundColor: 'rgba(153,69,255,0.1)', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: 'rgba(153,69,255,0.3)', marginBottom: 16,
  },
  quoteRow: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 },
  quoteVal: { color: '#fff', fontWeight: '800' },
  txInput: {
    backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, color: '#fff',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', padding: 14,
    fontSize: 14, marginBottom: 20, fontWeight: '500', flex: 1,
  },
  verifyBtn: { backgroundColor: '#32CD32', padding: 16, borderRadius: 14, alignItems: 'center', elevation: 8 },
  verifyBtnDisabled: { backgroundColor: '#444', elevation: 0 },
  verifyBtnText: { color: '#000', fontWeight: '900', fontSize: 16, letterSpacing: 1 },
  backBtn: { padding: 12, alignItems: 'center', marginTop: 6 },
  closeBtn: { padding: 14, alignItems: 'center', marginTop: 8 },
  closeBtnText: { color: 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  closeBtnPrimary: { backgroundColor: 'rgba(255,255,255,0.1)', padding: 14, borderRadius: 12, alignItems: 'center', marginTop: 16 },
  closeBtnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  wifiSettingsBtn: { backgroundColor: '#1E90FF', padding: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  wifiSettingsBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  networkRow: {
    backgroundColor: 'rgba(255,42,42,0.08)', borderRadius: 10,
    padding: 14, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(255,42,42,0.25)',
  },
  networkField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  networkSSID: { color: '#fff', fontWeight: '800', fontSize: 14, flex: 1 },
  networkPass: { color: 'rgba(255,255,255,0.6)', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 12, flex: 1 },
  copyBtn: { backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, marginLeft: 8 },
  copyBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  networkActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  securityBadge: { backgroundColor: 'rgba(255,159,28,0.15)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(255,159,28,0.3)' },
  securityBadgeText: { color: '#ff9f1c', fontSize: 10, fontWeight: '700' },
  addBtn: { flex: 1, backgroundColor: '#32CD32', borderRadius: 8, paddingVertical: 7, alignItems: 'center' },
  addBtnText: { color: '#000', fontWeight: '900', fontSize: 12 },
  qrSmallBtn: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 14, alignItems: 'center' },
  qrSmallBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  networkWallet: { color: 'rgba(153,69,255,0.9)', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 11, flex: 1 },
  tipBtn: { marginTop: 8, backgroundColor: 'rgba(153,69,255,0.2)', borderRadius: 8, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(153,69,255,0.5)' },
  tipBtnText: { color: '#c084fc', fontWeight: '800', fontSize: 12 },

  countryScroll: { marginBottom: 14 },
  countryScrollContent: { gap: 8, paddingHorizontal: 2 },
  countryChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  countryChipActive: { backgroundColor: 'rgba(255,42,42,0.2)', borderColor: '#ff2a2a' },
  countryChipText: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '700' },
  countryChipTextActive: { color: '#ff6666', fontWeight: '900' },

  qrWrapper: {
    padding: 16, backgroundColor: '#fff', borderRadius: 16, marginVertical: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 10, elevation: 10,
  },
  qrSsid: { color: '#fff', fontWeight: '800', fontSize: 15, marginBottom: 6 },
  qrPass: { color: 'rgba(255,255,255,0.6)', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 13, marginBottom: 16 },
});