import { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
  ScrollView,
  ImageBackground,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { updateHostSettings, geolocateSelf } from '../services/api';
import { useWallet } from '../utils/WalletContext';

const TREASURY_WALLET = '6bvB3PTz48wozyPJeuTB77axexWu9MfUSjBYbQzEgK88';
const PUBLISH_FEE_ASX = 100_000;

const { width } = require('react-native').Dimensions.get('window');

function getDeviceId() {
  return (
    Constants.installationId ||
    `${Device.modelName}-${Device.osVersion}-${Math.random().toString(36).slice(2)}`
  );
}

const ENCRYPTION_OPTIONS = ['WPA2', 'WPA3', 'WEP', 'Open'];

function NetworkEntry({ index, network, onChange, onRemove, showRemove }) {
  const [showPass, setShowPass] = useState(false);
  return (
    <View style={styles.networkEntry}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryLabel}>NETWORK {index + 1}</Text>
        {showRemove && (
          <TouchableOpacity onPress={onRemove} style={styles.removeBtn}>
            <Text style={styles.removeBtnText}>✕ Remove</Text>
          </TouchableOpacity>
        )}
      </View>
      <TextInput
        style={styles.input}
        placeholder="SSID (WiFi Name)"
        placeholderTextColor="rgba(255,255,255,0.3)"
        value={network.ssid}
        onChangeText={v => onChange({ ...network, ssid: v })}
        autoCapitalize="none"
      />
      <View style={styles.passRow}>
        <TextInput
          style={[styles.input, { flex: 1, marginBottom: 0 }]}
          placeholder="Password"
          placeholderTextColor="rgba(255,255,255,0.3)"
          value={network.password}
          onChangeText={v => onChange({ ...network, password: v })}
          secureTextEntry={!showPass}
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPass(p => !p)}>
          <Text style={styles.eyeText}>{showPass ? '🙈' : '👁️'}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.encRow}>
        {ENCRYPTION_OPTIONS.map(enc => (
          <TouchableOpacity
            key={enc}
            style={[styles.encChip, network.encryption === enc && styles.encChipActive]}
            onPress={() => onChange({ ...network, encryption: enc })}
          >
            <Text style={[styles.encChipText, network.encryption === enc && styles.encChipTextActive]}>
              {enc}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function HostScreen() {
  const { walletAddress, connect, sendASX } = useWallet();
  const [networks, setNetworks] = useState([{ ssid: '', password: '', encryption: 'WPA2' }]);
  const [country, setCountry] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const deviceIdRef = useRef(getDeviceId());

  const handleDetectLocation = useCallback(async () => {
    setDetecting(true);
    try {
      const geo = await geolocateSelf();
      if (geo.country) {
        setCountry(geo.country);
        setCountryCode(geo.countryCode || '');
      } else {
        Alert.alert('Detection Failed', 'Could not detect location from IP (local network). Enter your country manually.');
      }
    } catch (e) {
      Alert.alert('Detection Failed', e.message);
    } finally {
      setDetecting(false);
    }
  }, []);

  const handleAddNetwork = () => {
    setNetworks(prev => [...prev, { ssid: '', password: '', encryption: 'WPA2' }]);
  };

  const handleRemoveNetwork = (index) => {
    setNetworks(prev => prev.filter((_, i) => i !== index));
  };

  const handleChangeNetwork = (index, updated) => {
    setNetworks(prev => prev.map((n, i) => i === index ? updated : n));
  };

  const handleSubmit = async () => {
    const valid = networks.filter(n => n.ssid.trim() && (n.encryption === 'Open' || n.password.trim()));
    if (valid.length === 0) {
      Alert.alert('Invalid', 'At least one network with SSID and Password is required.');
      return;
    }
    if (!country.trim()) {
      Alert.alert('Country Required', 'Please detect or enter your country so users can find your network.');
      return;
    }
    if (!walletAddress) {
      Alert.alert('Wallet Required', 'Connect your Solana wallet to publish. Your wallet address will be shown as the tip address for your network.');
      return;
    }
    Alert.alert(
      'Confirm Publish',
      `Publishing ${valid.length} network(s) costs ${PUBLISH_FEE_ASX.toLocaleString()} ASX.\n\nYour wallet address will be shown as the tip address on your network listing.\n\nApprove the transaction to continue.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay & Publish',
          onPress: async () => {
            setUpdating(true);
            try {
              await sendASX(TREASURY_WALLET, PUBLISH_FEE_ASX);
              await updateHostSettings(deviceIdRef.current, valid, country.trim(), countryCode.trim().toUpperCase() || 'XX', walletAddress);
              Alert.alert('Published!', `${valid.length} network(s) listed on the global Hotpot network in ${country}.\nYour wallet is set as the tip address.`);
            } catch (e) {
              Alert.alert('Publish Failed', e.message || 'Transaction rejected or update failed.');
            } finally {
              setUpdating(false);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <ImageBackground
        source={require('../../assets/hotpot-bg.png')}
        style={styles.bgImage}
        imageStyle={{ opacity: 0.3 }}
      >
        <View style={styles.overlay} />
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.subtitle}>NETWORK CONFIGURATION</Text>
          <Text style={styles.title}>HOTPOT NODE</Text>

          {/* Wallet bar */}
          <View style={styles.walletBar}>
            {walletAddress ? (
              <View style={styles.walletConnected}>
                <View style={styles.walletDot} />
                <Text style={styles.walletAddr}>
                  {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                </Text>
                <Text style={styles.walletLabel}> · Tip Address</Text>
              </View>
            ) : (
              <TouchableOpacity style={styles.connectWalletBtn} onPress={connect}>
                <Text style={styles.connectWalletText}>◎ Connect Wallet (required)</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Country section */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>YOUR LOCATION</Text>
            <Text style={styles.cardHint}>Used to show your networks to nearby users.</Text>
            <View style={styles.countryRow}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                placeholder="Country (e.g. United States)"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={country}
                onChangeText={setCountry}
              />
              <TouchableOpacity style={styles.detectBtn} onPress={handleDetectLocation} disabled={detecting}>
                {detecting
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.detectBtnText}>📍 Detect</Text>
                }
              </TouchableOpacity>
            </View>
            <TextInput
              style={[styles.input, { marginTop: 8, marginBottom: 0 }]}
              placeholder="2-letter country code (e.g. US)"
              placeholderTextColor="rgba(255,255,255,0.3)"
              value={countryCode}
              onChangeText={v => setCountryCode(v.toUpperCase())}
              maxLength={2}
              autoCapitalize="characters"
            />
          </View>

          {/* Networks section */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>WIFI NETWORKS</Text>
            <Text style={styles.cardHint}>Share your hotspot credentials. Users auto-connect when in range.</Text>

            {networks.map((net, i) => (
              <NetworkEntry
                key={i}
                index={i}
                network={net}
                onChange={updated => handleChangeNetwork(i, updated)}
                onRemove={() => handleRemoveNetwork(i)}
                showRemove={networks.length > 1}
              />
            ))}

            <TouchableOpacity style={styles.addNetworkBtn} onPress={handleAddNetwork}>
              <Text style={styles.addNetworkBtnText}>+ Add Another Network</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.submitBtn, updating && styles.disabledBtn]}
            onPress={handleSubmit}
            disabled={updating}
          >
            {updating
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.submitBtnText}>PUBLISH TO HOTPOT LIST</Text>
            }
          </TouchableOpacity>

          <Text style={styles.hint}>
            Networks are visible to users in your country.{'\n'}
            Earn ASX tokens when others use your connection.
          </Text>
        </ScrollView>
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050000' },
  bgImage: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,0,0,0.82)' },
  scroll: { padding: 24, paddingBottom: 60 },

  subtitle: { color: '#ff2a2a', fontWeight: '800', letterSpacing: 2, fontSize: 12, marginBottom: 6, textAlign: 'center' },
  title: { color: '#fff', fontSize: 30, fontWeight: '900', marginBottom: 24, letterSpacing: 1, textAlign: 'center' },

  card: {
    width: '100%', backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 20, padding: 20, borderWidth: 1,
    borderColor: 'rgba(255,42,42,0.2)', marginBottom: 16,
  },
  cardTitle: { color: '#ff2a2a', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 4 },
  cardHint: { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginBottom: 16, lineHeight: 17 },

  countryRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  detectBtn: {
    backgroundColor: 'rgba(255,42,42,0.2)', paddingHorizontal: 14,
    paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,42,42,0.4)',
  },
  detectBtnText: { color: '#ff6666', fontWeight: '800', fontSize: 12 },
  ccText: { color: '#ff9f1c', fontSize: 12, fontWeight: '700', marginTop: 8 },

  networkEntry: {
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 14,
    padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,42,42,0.15)',
  },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  entryLabel: { color: '#ff9f1c', fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  removeBtn: { backgroundColor: 'rgba(255,42,42,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  removeBtnText: { color: '#ff5e5e', fontSize: 11, fontWeight: '700' },

  passRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: 2 },
  eyeBtn: { paddingHorizontal: 10, paddingVertical: 12 },
  eyeText: { fontSize: 18 },

  encRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  encChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  encChipActive: { backgroundColor: 'rgba(255,159,28,0.2)', borderColor: '#ff9f1c' },
  encChipText: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '700' },
  encChipTextActive: { color: '#ff9f1c' },

  addNetworkBtn: {
    borderWidth: 1, borderColor: 'rgba(255,42,42,0.3)', borderRadius: 12,
    padding: 12, alignItems: 'center', borderStyle: 'dashed',
  },
  addNetworkBtnText: { color: 'rgba(255,42,42,0.7)', fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },

  input: {
    backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 10, color: '#fff',
    padding: 12, marginBottom: 10, fontSize: 14, borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },

  submitBtn: {
    backgroundColor: '#ff9f1c', padding: 18, borderRadius: 16,
    alignItems: 'center', marginBottom: 16,
    shadowColor: '#ff9f1c', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 10,
  },
  disabledBtn: { opacity: 0.5 },
  submitBtnText: { color: '#000', fontWeight: '900', fontSize: 15, letterSpacing: 1 },

  hint: { color: 'rgba(255,255,255,0.35)', textAlign: 'center', fontSize: 12, lineHeight: 18 },

  walletBar: { width: '100%', marginBottom: 16 },
  walletConnected: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(153,69,255,0.15)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(153,69,255,0.4)' },
  walletDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#9945FF', marginRight: 8 },
  walletAddr: { color: '#c084fc', fontSize: 12, fontWeight: '700', fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier' },
  walletLabel: { color: 'rgba(153,69,255,0.6)', fontSize: 11, fontWeight: '600' },
  connectWalletBtn: { backgroundColor: 'rgba(153,69,255,0.15)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: 'rgba(153,69,255,0.5)', alignItems: 'center' },
  connectWalletText: { color: '#9945FF', fontSize: 13, fontWeight: '800' },
});
