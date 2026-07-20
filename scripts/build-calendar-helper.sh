#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/CalendarBridge.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/build/CalendarBridge-Info.plist" "$APP/Contents/Info.plist"
swiftc "$ROOT/native/CalendarBridge.swift" \
  -o "$APP/Contents/MacOS/calendar-bridge" \
  -framework EventKit \
  -framework AppKit \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$ROOT/build/CalendarBridge-Info.plist"
# 用固定憑證簽章（TCC 權限綁憑證，更新不會重置）；找不到就明確失敗。
SIGN_ID="${GLOW_SIGN_ID:-Glow Secretary Local Signing}"
if ! security find-certificate -c "$SIGN_ID" >/dev/null 2>&1 ||
  ! security find-key -s -t private -l "$SIGN_ID" >/dev/null 2>&1; then
  echo "錯誤：找不到程式碼簽章憑證：$SIGN_ID" >&2
  exit 1
fi
codesign --force --deep --sign "$SIGN_ID" --entitlements "$ROOT/build/CalendarBridge.entitlements" "$APP"
