/**
 * VpnManager — JS bridge for the in-app WireGuard VPN service.
 *
 * The native side (WireGuardModule.kt + WireGuardVpnService.kt) performs the
 * full WireGuard Noise IKpsk2 handshake and packet forwarding inside the app.
 * No external app required.
 *
 * Events emitted on "WireGuardStatus":
 *   "CONNECTED"        — tunnel is up
 *   "DISCONNECTED"     — tunnel was stopped
 *   "ERROR:<message>"  — setup failed
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { WireGuardModule } = NativeModules;
const emitter = WireGuardModule ? new NativeEventEmitter(WireGuardModule) : null;

/** Start the in-app WireGuard tunnel with a .conf string. */
export async function connectVpn(wgConfig) {
  if (Platform.OS !== 'android') {
    return { success: false, error: 'VPN only supported on Android' };
  }
  if (!WireGuardModule) {
    return { success: false, error: 'WireGuard native module not available' };
  }
  try {
    await WireGuardModule.connect(wgConfig);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to start VPN' };
  }
}

/** Stop the in-app WireGuard tunnel. */
export async function disconnectVpn() {
  if (Platform.OS !== 'android' || !WireGuardModule) return;
  try {
    await WireGuardModule.disconnect();
  } catch { /* ignore */ }
}

/** Synchronous check: returns true if the service reports it is running. */
export async function isVpnConnected() {
  if (Platform.OS !== 'android' || !WireGuardModule) return false;
  try {
    return await WireGuardModule.isVpnConnected();
  } catch {
    return false;
  }
}

/**
 * Subscribe to VPN status events.
 * callback(status) — status is "CONNECTED", "DISCONNECTED", or "ERROR:<msg>"
 * Returns an unsubscribe function.
 */
export function onVpnStatusChange(callback) {
  if (!emitter) return () => {};
  const subscription = emitter.addListener('WireGuardStatus', callback);
  return () => subscription.remove();
}

/**
 * Returns cumulative WireGuard traffic statistics for the active tunnel.
 * Shape: { rxBytes, txBytes, totalBytes, totalGB }
 * All values are 0 when no tunnel is active or on non-Android platforms.
 */
export async function getVpnTrafficStats() {
  if (Platform.OS !== 'android' || !WireGuardModule) {
    return { rxBytes: 0, txBytes: 0, totalBytes: 0, totalGB: 0 };
  }
  try {
    return await WireGuardModule.getTrafficStats();
  } catch {
    return { rxBytes: 0, txBytes: 0, totalBytes: 0, totalGB: 0 };
  }
}
