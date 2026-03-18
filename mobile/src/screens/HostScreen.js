import { useState, useRef, useCallback, useEffect } from 'react';
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
  Modal,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { updateHostSettings } from '../services/api';
import { useWallet } from '../utils/WalletContext';

const TREASURY_WALLET = '6bvB3PTz48wozyPJeuTB77axexWu9MfUSjBYbQzEgK88';
const PUBLISH_FEE_ASX = 100_000;

function getDeviceId() {
  return (
    Constants.installationId ||
    `${Device.modelName}-${Device.osVersion}-${Math.random().toString(36).slice(2)}`
  );
}

const ENCRYPTION_OPTIONS = ['WPA2', 'WPA3', 'WEP', 'Open'];

// ── Inline Leaflet map HTML ───────────────────────────────────────────────────

function buildMapHtml(initialLat, initialLon, markerLat, markerLon) {
  const lat = initialLat || 20;
  const lon = initialLon || 0;
  const zoom = initialLat ? 13 : 2;
  const markerJs = (markerLat && markerLon)
    ? `addMarker(${markerLat}, ${markerLon});`
    : '';
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>html,body,#map{margin:0;padding:0;width:100%;height:100%;background:#111}
#hint{position:absolute;top:10px;left:50%;transform:translateX(-50%);
  background:rgba(0,0,0,0.75);color:#fff;padding:8px 16px;border-radius:20px;
  font-size:13px;z-index:999;pointer-events:none;white-space:nowrap;}
#confirm{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
  background:#ff2a2a;color:#fff;padding:12px 32px;border-radius:24px;
  font-size:15px;font-weight:bold;z-index:999;border:none;cursor:pointer;display:none;}
</style></head>
<body>
<div id="hint">Tap on the map to mark WiFi location</div>
<button id="confirm" onclick="confirmLocation()">Confirm Location ✓</button>
<div id="map"></div>
<script>
var map = L.map('map').setView([${lat},${lon}],${zoom});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
var marker=null;
function addMarker(lat,lon){
  if(marker)map.removeLayer(marker);
  marker=L.marker([lat,lon]).addTo(map);
  document.getElementById('confirm').style.display='block';
}
map.on('click',function(e){addMarker(e.latlng.lat,e.latlng.lng);});
function confirmLocation(){
  if(!marker)return;
  var ll=marker.getLatLng();
  window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(
    JSON.stringify({type:'location',lat:ll.lat,lon:ll.lng}));
}
${markerJs}
// Try to get GPS location and center map
if(navigator.geolocation){
  navigator.geolocation.getCurrentPosition(function(p){
    if(!marker)map.setView([p.coords.latitude,p.coords.longitude],14);
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(
      JSON.stringify({type:'gps',lat:p.coords.latitude,lon:p.coords.longitude}));
  },function(){},{enableHighAccuracy:true,timeout:8000});
}
<\/script></body></html>`;
}

// ── Per-network location picker component ─────────────────────────────────────

function LocationPicker({ network, onChange }) {
  const [mapVisible, setMapVisible] = useState(false);
  const [liveTracking, setLiveTracking] = useState(false);
  const liveSubRef = useRef(null);
  const webviewRef = useRef(null);

  const stopLive = useCallback(() => {
    if (liveSubRef.current) {
      liveSubRef.current.remove();
      liveSubRef.current = null;
    }
    setLiveTracking(false);
  }, []);

  const toggleLive = useCallback(async () => {
    if (liveTracking) { stopLive(); return; }
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Denied', 'Location permission is required for live tracking.');
      return;
    }
    setLiveTracking(true);
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        onChange({ ...network, lat, lon });
      }
    );
    liveSubRef.current = sub;
  }, [liveTracking, network, onChange, stopLive]);

  // Clean up live tracking when component unmounts
  useEffect(() => () => stopLive(), [stopLive]);

  const handleWebViewMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'location') {
        onChange({ ...network, lat: msg.lat, lon: msg.lon });
        setMapVisible(false);
      }
    } catch {}
  }, [network, onChange]);

  const hasLocation = network.lat && network.lon;

  return (
    <View style={locStyles.container}>
      <Text style={locStyles.label}>LOCATION</Text>
      <View style={locStyles.row}>
        <TouchableOpacity
          style={locStyles.locateBtn}
          onPress={() => setMapVisible(true)}
        >
          <Text style={locStyles.locateBtnText}>📍 Locate on Map</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[locStyles.liveBtn, liveTracking && locStyles.liveBtnActive]}
          onPress={toggleLive}
        >
          <Text style={[locStyles.liveBtnText, liveTracking && locStyles.liveBtnTextActive]}>
            {liveTracking ? '⏹ Stop Live' : '🛰 Share Live'}
          </Text>
        </TouchableOpacity>
      </View>
      {hasLocation && (
        <Text style={locStyles.coordText}>
          📌 {network.lat.toFixed(5)}, {network.lon.toFixed(5)}
        </Text>
      )}

      {/* Map picker modal */}
      <Modal visible={mapVisible} animationType="slide" onRequestClose={() => setMapVisible(false)}>
        <View style={locStyles.mapModal}>
          <View style={locStyles.mapHeader}>
            <Text style={locStyles.mapTitle}>Mark WiFi Location</Text>
            <TouchableOpacity onPress={() => setMapVisible(false)} style={locStyles.mapClose}>
              <Text style={locStyles.mapCloseText}>✕ Close</Text>
            </TouchableOpacity>
          </View>
          <WebView
            ref={webviewRef}
            style={{ flex: 1 }}
            source={{ html: buildMapHtml(network.lat, network.lon, network.lat, network.lon) }}
            onMessage={handleWebViewMessage}
            javaScriptEnabled
            geolocationEnabled
          />
        </View>
      </Modal>
    </View>
  );
}

const locStyles = StyleSheet.create({
  container: { marginTop: 10 },
  label: { color: '#ff9f1c', fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 6 },
  row: { flexDirection: 'row', gap: 8 },
  locateBtn: {
    flex: 1, backgroundColor: 'rgba(255,42,42,0.15)', paddingVertical: 10,
    paddingHorizontal: 12, borderRadius: 10, borderWidth: 1,
    borderColor: 'rgba(255,42,42,0.4)', alignItems: 'center',
  },
  locateBtnText: { color: '#ff6666', fontWeight: '800', fontSize: 12 },
  liveBtn: {
    flex: 1, backgroundColor: 'rgba(255,159,28,0.1)', paddingVertical: 10,
    paddingHorizontal: 12, borderRadius: 10, borderWidth: 1,
    borderColor: 'rgba(255,159,28,0.3)', alignItems: 'center',
  },
  liveBtnActive: { backgroundColor: 'rgba(255,42,42,0.25)', borderColor: '#ff2a2a' },
  liveBtnText: { color: '#ff9f1c', fontWeight: '800', fontSize: 12 },
  liveBtnTextActive: { color: '#ff6666' },
  coordText: { color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 6 },
  mapModal: { flex: 1, backgroundColor: '#0a0a0a' },
  mapHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#111',
    borderBottomWidth: 1, borderBottomColor: '#222',
  },
  mapTitle: { color: '#fff', fontWeight: '800', fontSize: 15 },
  mapClose: { backgroundColor: 'rgba(255,42,42,0.2)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  mapCloseText: { color: '#ff5e5e', fontWeight: '700', fontSize: 12 },
});

// ── NetworkEntry component ─────────────────────────────────────────────────────

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

      {/* Per-network country section */}
      <View style={styles.countrySeparator} />
      <Text style={styles.countryLabel}>COUNTRY</Text>
      <TextInput
        style={[styles.input, { marginBottom: 6 }]}
        placeholder="Country (e.g. United States)"
        placeholderTextColor="rgba(255,255,255,0.3)"
        value={network.country || ''}
        onChangeText={v => onChange({ ...network, country: v })}
      />
      <TextInput
        style={[styles.input, { marginBottom: 6 }]}
        placeholder="2-letter code (e.g. US)"
        placeholderTextColor="rgba(255,255,255,0.3)"
        value={network.countryCode || ''}
        onChangeText={v => onChange({ ...network, countryCode: v.toUpperCase() })}
        maxLength={2}
        autoCapitalize="characters"
      />

      <LocationPicker network={network} onChange={onChange} />
    </View>
  );
}

// ── HostScreen ────────────────────────────────────────────────────────────────

export default function HostScreen() {
  const { walletAddress, connect, sendASX } = useWallet();
  const [networks, setNetworks] = useState([{
    ssid: '', password: '', encryption: 'WPA2',
    country: '', countryCode: '', lat: null, lon: null,
  }]);
  const [updating, setUpdating] = useState(false);
  const deviceIdRef = useRef(getDeviceId());

  const handleAddNetwork = () => {
    setNetworks(prev => [...prev, {
      ssid: '', password: '', encryption: 'WPA2',
      country: '', countryCode: '', lat: null, lon: null,
    }]);
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
    const missingCountry = valid.find(n => !n.country.trim());
    if (missingCountry) {
      Alert.alert('Country Required', `Please set a country for "${missingCountry.ssid || 'Network'}" so users can find it.`);
      return;
    }
    if (!walletAddress) {
      Alert.alert('Wallet Required', 'Connect your Solana wallet to publish.');
      return;
    }
    Alert.alert(
      'Confirm Publish',
      `Publishing ${valid.length} network(s) costs ${PUBLISH_FEE_ASX.toLocaleString()} ASX.\n\nApprove the transaction to continue.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay & Publish',
          onPress: async () => {
            setUpdating(true);
            try {
              await sendASX(TREASURY_WALLET, PUBLISH_FEE_ASX);
              // Use the country of the first valid network for legacy compat;
              // per-network country is stored inside the networks array.
              const primaryCountry = valid[0].country.trim();
              const primaryCC = valid[0].countryCode.trim().toUpperCase() || 'XX';
              await updateHostSettings(
                deviceIdRef.current, valid, primaryCountry, primaryCC, walletAddress
              );
              Alert.alert('Published!', `${valid.length} network(s) listed on the global Hotpot network.`);
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

          {/* Networks section — country card is now inside each NetworkEntry */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>WIFI NETWORKS</Text>
            <Text style={styles.cardHint}>Each network has its own country and location. Users auto-connect when in range.</Text>

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

  countrySeparator: { height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginVertical: 12 },
  countryLabel: { color: '#ff2a2a', fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 6 },

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
