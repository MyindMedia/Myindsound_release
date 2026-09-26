#!/usr/bin/env bash
# Build, install and screenshot every `-screen` of the app on the iPhone 17 Pro simulator.
# Every run uses -mock (MockAPI + a sample signed-in fan), so no backend or account is needed.
# Usage: apps/ios/scripts/screenshots.sh [screen ...]
#   (default: library listen leaderboard store store-loading signin player gallery)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IOS="$ROOT/apps/ios"
DD="${DERIVED_DATA:-/tmp/myind-dd}"
DEVICE="${SIM_DEVICE:-iPhone 17 Pro}"
BUNDLE_ID="com.myindsound.app"
SCREENS=("$@")
[ ${#SCREENS[@]} -eq 0 ] && SCREENS=(library listen leaderboard store store-loading signin player gallery)

xcodebuild -project "$IOS/MyindSound.xcodeproj" -scheme MyindSound \
  -destination "platform=iOS Simulator,name=$DEVICE" -derivedDataPath "$DD" build -quiet

xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
APP="$DD/Build/Products/Debug-iphonesimulator/MyindSound.app"
xcrun simctl install booted "$APP"
mkdir -p "$IOS/screens"

for screen in "${SCREENS[@]}"; do
  xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch booted "$BUNDLE_ID" -mock -screen "$screen" >/dev/null
  sleep "${SHOT_DELAY:-3.5}"
  xcrun simctl io booted screenshot "$IOS/screens/$screen.png" >/dev/null
  echo "wrote apps/ios/screens/$screen.png"
done
