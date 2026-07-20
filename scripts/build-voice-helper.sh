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
# 用固定憑證簽章（TCC 權限綁憑證，更新不會重置）；找不到憑證才退回臨時簽章
SIGN_ID="${GLOW_SIGN_ID:-Glow Secretary Local Signing}"
security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_ID" || SIGN_ID="-"
codesign --force --deep --sign "$SIGN_ID" "$APP"
