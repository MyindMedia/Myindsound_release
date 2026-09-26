#!/usr/bin/env bash
# The rack's screenshots (RACK-1..3) on the iPhone 17 Pro simulator, all with -mock:
# grid (full, one disc, empty), focus front and back, the sleeve mid-pull, and the loaded player.
# Usage: apps/ios/scripts/rack-screenshots.sh [--no-build]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IOS="$ROOT/apps/ios"
DD="${DERIVED_DATA:-/tmp/myind-dd}"
DEVICE="${SIM_DEVICE:-iPhone 17 Pro}"
BUNDLE_ID="com.myindsound.app"

if [ "${1:-}" != "--no-build" ]; then
  xcodebuild -project "$IOS/MyindSound.xcodeproj" -scheme MyindSound \
    -destination "platform=iOS Simulator,name=$DEVICE" -derivedDataPath "$DD" build -quiet
fi
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl install booted "$DD/Build/Products/Debug-iphonesimulator/MyindSound.app"
mkdir -p "$IOS/screens"

# name | delay seconds | launch arguments
SHOTS=(
  "rack-grid|4|-screen library -rack full"
  "rack-grid-one|4|-screen library -rack one"
  "rack-empty|4|-screen library -rack empty"
  "rack-focus-front|${FOCUS_DELAY:-7}|-screen rack-focus"
  "rack-focus-back|${BACK_DELAY:-10}|-screen rack-focus-back"
  "rack-pull|${PULL_DELAY:-8.6}|-screen rack-pull"
  "rack-loaded|${LOADED_DELAY:-17}|-screen rack-loaded"
)
for shot in "${SHOTS[@]}"; do
  IFS='|' read -r name delay args <<<"$shot"
  [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $name "* ]] && continue
  xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
  # shellcheck disable=SC2086
  xcrun simctl launch booted "$BUNDLE_ID" -mock $args >/dev/null
  sleep "$delay"
  xcrun simctl io booted screenshot "$IOS/screens/$name.png" >/dev/null
  echo "wrote apps/ios/screens/$name.png"
done
