# 貼身小秘書

> 原始碼一律位於 `src/`；請勿在專案根目錄建立 `main.js`、`voice.js` 或 `index.html` 複本。

一個支援語音與手機同步的 macOS 桌面小助理。

## 功能

- 今天、明天與未來一週的待辦視圖
- 每件待辦可設定日期、提醒時間、分類與備註
- macOS 系統通知與每日早安摘要
- 每日日誌：完成事項、感受、明日提醒與心情
- 按 `⌥ Space` 呼叫語音助理，可用說話新增待辦、記日誌及查行程
- 待辦可同步到 Apple 提醒事項，行程可同步到 iCloud 或 Google 行事曆
- 平常在背景待命，不會常駐遮擋工作畫面
- 可選擇登入後自動啟動

## 行事曆與手機同步

- 一般「待辦」會同步到 Apple 提醒事項。
- 「行程／會議」會同步到設定中選定的 iCloud 或 Google 行事曆。
- Google 帳號需先加入 macOS「系統設定 → 網際網路帳號」，之後即可在小秘書設定頁選取。
- 修改後會自動同步，背景執行時每 5 分鐘也會更新一次。
- 可以從 iPhone、Apple 行事曆、提醒事項或 Google Calendar 修改內容，再同步回小秘書。

## 開發啟動

```bash
npm install
npm start
```

## 封裝 macOS 應用

```bash
# 1. 編譯原生 helper + 打包
npm run package

# 2. package 已自動使用 Glow Secretary Local Signing 簽章

# 3. 真實發佈需正式簽名 + notarization（需 Apple Developer 帳號）
npm run notarize
```

完整發佈流程（使用 Developer ID Application 憑證）：

1. `npm run build:helpers && npm run package`
2. 用正式身份簽名（取代 ad-hoc）：
   ```bash
   codesign --force --deep --sign "Developer ID Application: Your Name (TEAMID)" \
     "dist/貼身小秘書-darwin-arm64/貼身小秘書.app"
   ```
3. Notarize + staple（推薦方式）：
   ```bash
   # 需先設定環境變數或鑰匙圈
   xcrun notarytool submit "dist/貼身小秘書-darwin-arm64/貼身小秘書.app" \
     --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_PASSWORD" --wait
   xcrun stapler staple "dist/貼身小秘書-darwin-arm64/貼身小秘書.app"
   ```

目前只保留經實機驗證的 `electron-packager` 打包路徑。自動更新尚未配置正式 feed，為避免下載後無提示重啟，程式內不啟用 auto-update。

資料預設保存在 Electron 的 `userData` 目錄，可在應用程式「設定」頁按「查看資料檔案」定位。

## 進階功能：AI 語音理解（三層 fallback）

在「設定」頁的「語音理解大腦」設定。實際運作是**三層自動 fallback**（實作在 `voiceIntent.js`）：

1. **Claude API（claude-haiku-4-5，主力）**：理解最自然的中文口語（例如「把健身課改到明天晚上」）。API 金鑰以加密方式保存（`secretStore.js`，不進 renderer / 原始碼）。
2. **Ollama（本地備援）**：安裝 [Ollama](https://ollama.com/) 並執行 `ollama serve`，推薦小型快速模型 `ollama pull qwen2.5:3b` 或 `gemma2:2b`。運算全在本地，不上傳資料。
3. **規則式解析（離線保底）**：前兩層都不可用時自動退回，功能不中斷。

設定頁有「測試 AI 連線」按鈕可驗證。如果不想用 AI，保持關閉即可使用原本穩定快速的規則系統。

> 狀態註記：第 3 階段「Discord 串接（DM-to-bot → 統一收件匣）」規劃中、尚未實作。
