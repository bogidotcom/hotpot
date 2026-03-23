const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

// ─── 1. AndroidManifest: FOREGROUND_SERVICE permission + VPN services ───────
function withWireGuardManifest(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const manifestPath = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/AndroidManifest.xml'
      );
      let xml = fs.readFileSync(manifestPath, 'utf8');

      // Add xmlns:tools to <manifest> tag if missing
      if (!xml.includes('xmlns:tools')) {
        xml = xml.replace(
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">'
        );
      }

      // Add FOREGROUND_SERVICE permission if missing
      if (!xml.includes('android.permission.FOREGROUND_SERVICE')) {
        xml = xml.replace(
          '<uses-permission android:name="android.permission.INTERNET"/>',
          '<uses-permission android:name="android.permission.INTERNET"/>\n  <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>'
        );
      }

      // Override GoBackend$VpnService (from wireguard library) with android:exported="true"
      const goBackendOverride = `    <service android:name="com.wireguard.android.backend.GoBackend$VpnService" android:exported="true" android:permission="android.permission.BIND_VPN_SERVICE" tools:node="merge"><intent-filter><action android:name="android.net.VpnService"/></intent-filter></service>`;
      if (!xml.includes('GoBackend$VpnService')) {
        xml = xml.replace('</application>', `${goBackendOverride}\n  </application>`);
      }

      // Add our WireGuardVpnService if missing
      const ourService = `    <service android:name=".WireGuardVpnService" android:exported="false" android:permission="android.permission.BIND_VPN_SERVICE"><intent-filter><action android:name="android.net.VpnService"/></intent-filter></service>`;
      if (!xml.includes('.WireGuardVpnService')) {
        xml = xml.replace('</application>', `${ourService}\n  </application>`);
      }

      fs.writeFileSync(manifestPath, xml);
      return cfg;
    },
  ]);
}

// ─── 2. app/build.gradle: wireguard dependency ───────────────────────────────
function withWireGuardGradle(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('wireguard.android:tunnel')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        'implementation("com.facebook.react:react-android")',
        'implementation("com.facebook.react:react-android")\n    implementation("com.wireguard.android:tunnel:1.0.20211029")'
      );
    }
    return cfg;
  });
}

// ─── 3. MainApplication.kt: register WireGuardPackage ───────────────────────
function withWireGuardMainApp(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const mainAppPath = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/java/app/net/wifi/MainApplication.kt'
      );
      if (!fs.existsSync(mainAppPath)) return cfg;

      let contents = fs.readFileSync(mainAppPath, 'utf8');
      if (contents.includes('WireGuardPackage')) return cfg; // already patched

      contents = contents.replace(
        /PackageList\(this\)\.packages\.apply \{[^}]*\}/,
        'PackageList(this).packages.apply {\n              add(WireGuardPackage())\n            }'
      );
      fs.writeFileSync(mainAppPath, contents);
      return cfg;
    },
  ]);
}

// ─── 4. Copy Kotlin source files (survives clean prebuild) ──────────────────
const KOTLIN_FILES = {
  'WireGuardVpnService.kt': `package app.net.wifi

import com.wireguard.android.backend.GoBackend

class WireGuardVpnService : GoBackend.VpnService()
`,

  'WireGuardPackage.kt': `package app.net.wifi

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class WireGuardPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(WireGuardModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`,

  'WireGuardModule.kt': `package app.net.wifi

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.wireguard.android.backend.BackendException
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.io.StringReader
import java.util.concurrent.Executors

class WireGuardModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        const val NAME = "WireGuardModule"
        private const val VPN_REQUEST_CODE = 0x0F4
    }

    private val backend: GoBackend by lazy { GoBackend(reactContext) }
    private val executor = Executors.newSingleThreadExecutor()
    private var activeTunnel: WgTunnel? = null
    private var pendingPromise: Promise? = null
    private var pendingConfig: Config? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName() = NAME

    private inner class WgTunnel(private val name: String) : Tunnel {
        override fun getName() = name
        override fun onStateChange(newState: Tunnel.State) {
            val event = when (newState) {
                Tunnel.State.UP -> "CONNECTED"
                Tunnel.State.DOWN -> "DISCONNECTED"
                else -> return
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("WireGuardStatus", event)
        }
    }

    @ReactMethod
    fun connect(configStr: String, promise: Promise) {
        try {
            val config = Config.parse(java.io.BufferedReader(StringReader(configStr)))
            val prepareIntent = VpnService.prepare(reactContext)
            if (prepareIntent != null) {
                pendingPromise = promise
                pendingConfig = config
                reactContext.currentActivity?.startActivityForResult(prepareIntent, VPN_REQUEST_CODE)
                    ?: promise.reject("NO_ACTIVITY", "No activity available")
            } else {
                startTunnel(config, promise)
            }
        } catch (e: Exception) {
            promise.reject("CONFIG_ERROR", e.message)
        }
    }

    private fun startTunnel(config: Config, promise: Promise) {
        executor.execute {
            try {
                val tunnel = WgTunnel("hotpot")
                backend.setState(tunnel, Tunnel.State.UP, config)
                activeTunnel = tunnel
                promise.resolve(null)
            } catch (e: BackendException) {
                promise.reject("CONNECT_ERROR", "VPN error: \${e.reason.name}")
            } catch (e: Exception) {
                promise.reject("CONNECT_ERROR", e.message ?: "Failed to start VPN")
            }
        }
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        try {
            activeTunnel?.let { backend.setState(it, Tunnel.State.DOWN, null) }
            activeTunnel = null
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DISCONNECT_ERROR", e.message)
        }
    }

    @ReactMethod
    fun isVpnConnected(promise: Promise) {
        try {
            val state = activeTunnel?.let { backend.getState(it) } ?: Tunnel.State.DOWN
            promise.resolve(state == Tunnel.State.UP)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getTrafficStats(promise: Promise) {
        try {
            val stats = activeTunnel?.let { backend.getStatistics(it) }
            var rx = 0L
            var tx = 0L
            stats?.peers()?.forEach { key ->
                rx += stats.peerRx(key)
                tx += stats.peerTx(key)
            }
            val total = rx + tx
            val result = Arguments.createMap().apply {
                putDouble("rxBytes", rx.toDouble())
                putDouble("txBytes", tx.toDouble())
                putDouble("totalBytes", total.toDouble())
                putDouble("totalGB", total / 1_073_741_824.0)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.resolve(Arguments.createMap())
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == VPN_REQUEST_CODE) {
            if (resultCode == Activity.RESULT_OK) {
                pendingConfig?.let { config ->
                    pendingPromise?.let { startTunnel(config, it) }
                }
            } else {
                pendingPromise?.reject("PERMISSION_DENIED", "VPN permission denied by user")
            }
            pendingPromise = null
            pendingConfig = null
        }
    }

    override fun onNewIntent(intent: Intent) {}
}
`,
};

function withWireGuardKotlinFiles(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const javaDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app/src/main/java/app/net/wifi'
      );
      fs.mkdirSync(javaDir, { recursive: true });
      for (const [filename, content] of Object.entries(KOTLIN_FILES)) {
        fs.writeFileSync(path.join(javaDir, filename), content);
      }
      return cfg;
    },
  ]);
}

// ─── Compose all modifiers ───────────────────────────────────────────────────
module.exports = function withWireGuard(config) {
  config = withWireGuardManifest(config);
  config = withWireGuardGradle(config);
  config = withWireGuardKotlinFiles(config); // write files before patching MainApplication
  config = withWireGuardMainApp(config);
  return config;
};
