#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/VoiceRecognizer.app"

rm -rf "$APP"
rm -f "$ROOT/build/voice-recognizer"
mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/build/VoiceRecognizer-Info.plist" "$APP/Contents/Info.plist"
swiftc "$ROOT/native/VoiceRecognizer.swift" \
  -o "$APP/Contents/MacOS/voice-recognizer" \
  -framework Speech \
  -framework AVFoundation \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$ROOT/build/VoiceRecognizer-Info.plist"
# 用固定憑證簽章（TCC 權限綁憑證，更新不會重置）；找不到就明確失敗。
SIGN_ID="${GLOW_SIGN_ID:-Glow Secretary Local Signing}"
if ! security find-certificate -c "$SIGN_ID" >/dev/null 2>&1 ||
  ! security find-key -s -t private -l "$SIGN_ID" >/dev/null 2>&1; then
  echo "錯誤：找不到程式碼簽章憑證：$SIGN_ID" >&2
  exit 1
fi
codesign --force --deep --sign "$SIGN_ID" "$APP"
