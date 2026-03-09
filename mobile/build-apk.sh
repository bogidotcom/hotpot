#!/bin/bash
# ─────────────────────────────────────────────────────────
# Net — Build Android APK
# ─────────────────────────────────────────────────────────
# Prerequisites:
#   - Android SDK installed
#   - ANDROID_HOME / ANDROID_SDK_ROOT set
#   - Java 17+ installed
#
# Usage:
#   chmod +x build-apk.sh
#   ./build-apk.sh
# ─────────────────────────────────────────────────────────

set -e

# ── Detect Android SDK ──────────────────────────────────────
# Check ANDROID_HOME, then common install paths
if [ -z "$ANDROID_HOME" ]; then
  for candidate in "$HOME/android-sdk" "$HOME/Android/Sdk" "/usr/lib/android-sdk"; do
    if [ -d "$candidate/platforms" ]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi

if [ -z "$ANDROID_HOME" ]; then
  echo "❌ Android SDK not found. Set ANDROID_HOME or install the SDK to ~/android-sdk"
  exit 1
fi

export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
echo "🔍 Using Android SDK at: $ANDROID_HOME"

echo "🛠️  Net — Android APK Builder"
echo "──────────────────────────────"

# Step 1: Install dependencies
echo "📦 Installing dependencies..."
npm install

# Check if SDKMAN is installed and source it
export SDKMAN_DIR="$HOME/.sdkman"
if [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]]; then
    source "$HOME/.sdkman/bin/sdkman-init.sh"
    sdk use java 17.0.10-tem 2>/dev/null || true
fi

# Step 2: Prebuild native project
echo "🔧 Generating native Android project..."
npx expo prebuild --platform android --clean

# ── IMPORTANT: local.properties must be written AFTER prebuild since --clean wipes android/
echo "📝 Writing android/local.properties..."
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# Step 3: Build the APK
echo "⚙️  Building APK (release)..."
cd android
./gradlew assembleRelease

# Step 4: Find and report the APK
APK_PATH=$(find . -name "*.apk" -path "*/release/*" | head -1)

if [ -n "$APK_PATH" ]; then
  FULL_PATH=$(realpath "$APK_PATH")
  SIZE=$(du -h "$FULL_PATH" | cut -f1)
  echo ""
  echo "✅ APK built successfully!"
  echo "   Path: $FULL_PATH"
  echo "   Size: $SIZE"
  echo ""
  echo "📲 Install on device:"
  echo "   adb install $FULL_PATH"
else
  echo "❌ APK not found. Check build logs above."
  exit 1
fi
