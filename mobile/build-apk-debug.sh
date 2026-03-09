#!/bin/bash
# ─────────────────────────────────────────────────────────
# Net — Build Debug APK (faster, no signing)
# ─────────────────────────────────────────────────────────
# Usage:
#   chmod +x build-apk-debug.sh
#   ./build-apk-debug.sh
# ─────────────────────────────────────────────────────────

set -e

echo "🛠️  Net — Debug APK Builder"
echo "──────────────────────────────"

npm install

# Check if SDKMAN is installed and source it
export SDKMAN_DIR="$HOME/.sdkman"
if [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]]; then
    source "$HOME/.sdkman/bin/sdkman-init.sh"
    sdk use java 17.0.10-tem 2>/dev/null || true
fi

echo "🔧 Generating native Android project..."
npx expo prebuild --platform android --clean

echo "⚙️  Building debug APK..."
cd android
./gradlew assembleDebug

APK_PATH=$(find . -name "*.apk" -path "*/debug/*" | head -1)

if [ -n "$APK_PATH" ]; then
  FULL_PATH=$(realpath "$APK_PATH")
  SIZE=$(du -h "$FULL_PATH" | cut -f1)
  echo ""
  echo "✅ Debug APK built!"
  echo "   Path: $FULL_PATH"
  echo "   Size: $SIZE"
  echo "   Install: adb install $FULL_PATH"
else
  echo "❌ APK not found."
  exit 1
fi
