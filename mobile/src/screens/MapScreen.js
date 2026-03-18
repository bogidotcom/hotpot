import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { fetchNetworksJSON } from '../services/api';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://api-hotpot.assetux.com';

// ── Build Leaflet HTML with network coverage circles ──────────────────────────

function buildMapHtml(networks) {
  // Filter networks that have coordinates
  const pinned = networks.filter(n => n.lat && n.lon);

  const markersJs = pinned.map((n, i) => {
    const label = (n.ssid || 'Hidden Network').replace(/'/g, "\\'");
    const country = (n.country || '').replace(/'/g, "\\'");
    const enc = (n.encryption || 'WPA2').replace(/'/g, "\\'");
    return `addNetwork(${n.lat},${n.lon},'${label}','${country}','${enc}',${i});`;
  }).join('\n');

  const networksJson = JSON.stringify(pinned.map(n => ({
    ssid: n.ssid,
    password: n.password,
    encryption: n.encryption,
    country: n.country,
    countryCode: n.countryCode,
    walletAddress: n.walletAddress,
  })));

  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
html,body,#map{margin:0;padding:0;width:100%;height:100%;background:#111;}
.leaflet-container{background:#1a1a1a;}
.leaflet-tile{filter:brightness(0.7) saturate(0.6);}
</style></head>
<body>
<div id="map"></div>
<script>
var map=L.map('map',{zoomControl:true}).setView([20,0],2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap',maxZoom:19,
  subdomains:'abc'}).addTo(map);

var networksData=${networksJson};

function addNetwork(lat,lon,ssid,country,enc,idx){
  // Coverage circle (~200m radius, semi-transparent)
  var circle=L.circle([lat,lon],{
    radius:200,
    color:'#ff2a2a',
    fillColor:'#ff2a2a',
    fillOpacity:0.18,
    weight:2,
    opacity:0.7
  }).addTo(map);

  // Pulsing dot marker
  var dotIcon=L.divIcon({
    html:'<div style="width:12px;height:12px;border-radius:50%;background:#ff2a2a;border:2px solid #fff;box-shadow:0 0 8px rgba(255,42,42,0.8);"></div>',
    iconSize:[12,12],
    iconAnchor:[6,6],
    className:''
  });
  var marker=L.marker([lat,lon],{icon:dotIcon}).addTo(map);

  function openNetwork(){
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(
      JSON.stringify({type:'openNetwork',index:idx}));
  }
  circle.on('click',openNetwork);
  marker.on('click',openNetwork);

  // Label
  marker.bindTooltip(ssid,{permanent:false,direction:'top',offset:[0,-8],
    className:'',opacity:0.9});
}

${markersJs}

// Show user's own location
if(navigator.geolocation){
  navigator.geolocation.getCurrentPosition(function(p){
    var ll=[p.coords.latitude,p.coords.longitude];
    var userIcon=L.divIcon({
      html:'<div style="width:14px;height:14px;border-radius:50%;background:#4f8ef7;border:3px solid #fff;box-shadow:0 0 10px rgba(79,142,247,0.9);"></div>',
      iconSize:[14,14],iconAnchor:[7,7],className:''
    });
    L.marker(ll,{icon:userIcon}).addTo(map).bindTooltip('You',{permanent:false,direction:'top'});
    if(${pinned.length}===0)map.setView(ll,13);
  },function(){},{enableHighAccuracy:true,timeout:8000});
}

// Fit map to show all networks
var bounds=${pinned.length > 0 ? `[${pinned.map(n=>`[${n.lat},${n.lon}]`).join(',')}]` : 'null'};
if(bounds&&bounds.length>0){
  try{map.fitBounds(bounds,{padding:[40,40],maxZoom:13});}catch(e){}
}
<\/script></body></html>`;
}

// ── Add Network Modal ─────────────────────────────────────────────────────────

function AddNetworkModal({ network, visible, onClose }) {
  if (!network) return null;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>📶 {network.ssid || 'Hidden Network'}</Text>
          {network.country ? (
            <Text style={styles.modalMeta}>🌍 {network.country}</Text>
          ) : null}
          {network.encryption ? (
            <Text style={styles.modalMeta}>🔒 {network.encryption}</Text>
          ) : null}
          {network.walletAddress ? (
            <Text style={styles.modalWallet}>
              ◎ {network.walletAddress.slice(0, 6)}...{network.walletAddress.slice(-4)}
            </Text>
          ) : null}

          <Text style={styles.modalHint}>
            Open your phone's WiFi settings and connect to this network using the QR code or credentials below.
          </Text>

          <View style={styles.credBox}>
            <Text style={styles.credLabel}>SSID</Text>
            <Text style={styles.credValue}>{network.ssid}</Text>
            {network.password ? (
              <>
                <Text style={styles.credLabel}>PASSWORD</Text>
                <Text style={styles.credValue}>{network.password}</Text>
              </>
            ) : (
              <Text style={styles.credOpenText}>Open Network — no password needed</Text>
            )}
          </View>

          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── MapScreen ─────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const [networks, setNetworks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [networkModalVisible, setNetworkModalVisible] = useState(false);
  const webviewRef = useRef(null);

  const loadNetworks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchNetworksJSON();
      setNetworks(data.networks || []);
    } catch (e) {
      Alert.alert('Error', 'Could not load network data. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNetworks();
  }, [loadNetworks]);

  const handleWebViewMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'openNetwork') {
        const net = networks.filter(n => n.lat && n.lon)[msg.index];
        if (net) {
          setSelectedNetwork(net);
          setNetworkModalVisible(true);
        }
      }
    } catch {}
  }, [networks]);

  const pinnedCount = networks.filter(n => n.lat && n.lon).length;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🗺️ Hotpot Map</Text>
        <View style={styles.headerRight}>
          <Text style={styles.headerCount}>{pinnedCount} networks</Text>
          <TouchableOpacity onPress={loadNetworks} style={styles.refreshBtn} disabled={loading}>
            {loading
              ? <ActivityIndicator size="small" color="#ff2a2a" />
              : <Text style={styles.refreshText}>↻</Text>
            }
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color="#ff2a2a" />
          <Text style={styles.loadingText}>Loading networks...</Text>
        </View>
      ) : (
        <WebView
          ref={webviewRef}
          style={styles.webview}
          source={{ html: buildMapHtml(networks) }}
          onMessage={handleWebViewMessage}
          javaScriptEnabled
          geolocationEnabled
          domStorageEnabled
          originWhitelist={['*']}
        />
      )}

      {pinnedCount === 0 && !loading && (
        <View style={styles.emptyBanner}>
          <Text style={styles.emptyText}>
            No networks with locations yet.{'\n'}Host a network and mark its location!
          </Text>
        </View>
      )}

      <AddNetworkModal
        network={selectedNetwork}
        visible={networkModalVisible}
        onClose={() => setNetworkModalVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: '#111', borderBottomWidth: 1, borderBottomColor: '#222',
  },
  headerTitle: { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerCount: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  refreshBtn: { padding: 6 },
  refreshText: { color: '#ff2a2a', fontSize: 20, fontWeight: '700' },

  webview: { flex: 1, backgroundColor: '#111' },

  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },

  emptyBanner: {
    position: 'absolute', bottom: 20, left: 20, right: 20,
    backgroundColor: 'rgba(255,42,42,0.12)', borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: 'rgba(255,42,42,0.25)',
  },
  emptyText: { color: 'rgba(255,255,255,0.6)', textAlign: 'center', fontSize: 13, lineHeight: 20 },

  // Add network modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#1a1a1a', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, borderTopWidth: 1, borderColor: 'rgba(255,42,42,0.3)',
  },
  modalTitle: { color: '#fff', fontSize: 20, fontWeight: '900', marginBottom: 8 },
  modalMeta: { color: 'rgba(255,255,255,0.55)', fontSize: 13, marginBottom: 4 },
  modalWallet: { color: '#9945FF', fontSize: 12, fontWeight: '700', marginBottom: 12 },
  modalHint: {
    color: 'rgba(255,255,255,0.4)', fontSize: 12, lineHeight: 18, marginBottom: 16,
  },
  credBox: {
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12,
    padding: 14, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  credLabel: { color: '#ff2a2a', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 2, marginTop: 8 },
  credValue: {
    color: '#fff', fontSize: 14, fontWeight: '700',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },
  credOpenText: { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 4 },
  closeBtn: {
    backgroundColor: '#ff2a2a', borderRadius: 14, padding: 14, alignItems: 'center',
  },
  closeBtnText: { color: '#fff', fontWeight: '900', fontSize: 15 },
});
