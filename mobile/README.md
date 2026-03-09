# Hotpot Mobile

React Native (Expo) Android app for the Hotpot Network — share your WiFi, earn ASX; use the network, pay with ASX; connect via WireGuard VPN.

## Overview

The app has two modes:

- **Connect** — browse available hotspots, top up ASX balance, connect to VPN
- **Host** — share your WiFi network and earn ASX tokens

## Stack

- **Framework**: Expo ~54 (bare workflow, Android `android/` directory)
- **Language**: JavaScript (React Native) + Kotlin (native VPN module)
- **Wallet**: Solana Mobile Wallet Adapter (Phantom, Solflare)
- **Token**: ASX on Solana (Token-2022 / Token Extensions program)
- **VPN**: In-app WireGuard via NetSepio/Erebrus — no external app required
- **WiFi**: `react-native-wifi-reborn` for scanning and auto-connecting

## Project Structure

```
mobile/
├── src/
│   ├── screens/
│   │   ├── ConnectScreen.js    # VPN connect, top-up, hotspot browser
│   │   └── HostScreen.js       # WiFi sharing, earnings, QR code
│   ├── services/
│   │   └── api.js              # All backend API calls
│   └── utils/
│       ├── WalletContext.js    # Solana wallet state + MWA integration
│       ├── VpnManager.js       # WireGuard connect/disconnect (JS side)
│       └── api.js              # (see services/)
├── android/
│   └── app/src/main/java/app/net/wifi/
│       ├── WireGuardModule.kt      # React Native bridge
│       ├── WireGuardVpnService.kt  # Android VPN service (TUN + UDP)
│       ├── WireGuardSession.kt     # Noise IKpsk2 handshake state machine
│       ├── WireGuardCrypto.kt      # BLAKE2s, X25519, ChaCha20-Poly1305
│       └── WireGuardConfig.kt      # .conf parser
├── .env                        # Environment variables (never commit)
└── app.json
```

## Environment Variables

Create `mobile/.env`:

```env
EXPO_PUBLIC_HELIUS_API_KEY=your-helius-api-key
EXPO_PUBLIC_API_BASE=https://api-hotpot.yourdomain.com
```

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_HELIUS_API_KEY` | Helius RPC key for Solana balance queries |
| `EXPO_PUBLIC_API_BASE` | Backend API base URL (defaults to production) |

`EXPO_PUBLIC_*` variables are inlined at build time by Expo — safe to use in JS, but treat them as client-visible.

## Running

```bash
cd mobile
npm install

# Start Metro bundler
npm start

# Run on connected Android device/emulator
npm run android
```

For a release APK:

```bash
cd android
./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```

## In-App WireGuard VPN

The VPN works without installing any external app. The implementation is entirely self-contained:

| Layer | File | Responsibility |
|---|---|---|
| Crypto | `WireGuardCrypto.kt` | BLAKE2s-256, HMAC, X25519 DH, ChaCha20-Poly1305, TAI64N |
| Handshake | `WireGuardSession.kt` | Noise IKpsk2 — builds initiation (148 B), processes response (92 B), derives session keys |
| Service | `WireGuardVpnService.kt` | Android `VpnService` — creates TUN, protects UDP socket, runs TUN↔UDP forwarding threads |
| Bridge | `WireGuardModule.kt` | React Native module — exposes `connect()`, `disconnect()`, `isVpnConnected()` to JS; emits `WireGuardStatus` events |
| JS API | `VpnManager.js` | `connectVpn(wgConfig)`, `disconnectVpn()`, `onVpnStatusChange(cb)` |

**VPN flow**:
1. User taps **VPN** → app calls `GET /api/vpn/netsepio/flowid` with wallet address
2. App signs the EULA with Phantom via Mobile Wallet Adapter
3. App calls `POST /api/vpn/netsepio/connect` with signature → receives WireGuard `.conf`
4. `WireGuardVpnService` performs Noise handshake and starts packet forwarding
5. Status is emitted as `WireGuardStatus` native events (`CONNECTED` / `DISCONNECTED`)

## Wallet Integration

Wallet connectivity uses [Solana Mobile Wallet Adapter](https://github.com/solana-mobile/mobile-wallet-adapter).

- `connect()` — opens Phantom/Solflare via MWA `authorize`
- `signMessage(msg)` — reauthorizes with cached token, falls back to fresh `authorize` on expiry
- `sendASX(recipient, amount)` — builds and signs a Token-2022 `TransferChecked` transaction

The `WalletContext` exposes `{ walletAddress, connect, disconnect, sendASX, signMessage }` via React context.

## Top-Up Flow

1. User enters USD amount → app fetches ASX quote from `/api/deposit/quote`
2. App calls `sendASX(treasuryWallet, asxAmount)` — sends tokens on-chain via Phantom
3. App calls `POST /api/topup/verify` with the transaction signature
4. Backend parses the transaction, confirms the transfer, credits the device balance

## Hotspot Hosting

1. Host taps **Host** → app scans available WiFi networks
2. Host selects networks to share and connects their wallet
3. App calls `POST /api/hotspot/settings` — publishes networks to the global map
4. App reports speed periodically via `POST /api/rate`
5. Earnings accumulate server-side; host claims them via `POST /api/hotspot/claim`

## Key Dependencies

| Package | Purpose |
|---|---|
| `expo ~54` | Build toolchain, dev server |
| `react-native 0.81` | Core framework |
| `@solana/web3.js` | Solana RPC + transaction building |
| `@solana-mobile/mobile-wallet-adapter-protocol-web3js` | MWA wallet signing |
| `react-native-wifi-reborn` | WiFi scanning and connection |
| `react-native-qrcode-svg` | WiFi QR code generation |
| `expo-file-system` | Balance cache persistence |
| `@react-native-async-storage/async-storage` | Local key-value storage |

## Android Permissions

Declared in `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
```

The `WireGuardVpnService` is registered with `android.permission.BIND_VPN_SERVICE` — this is what allows the app to create a system VPN tunnel without root.
