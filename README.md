# Personal Assistant for macOS（貼身小秘書）

A small macOS desktop assistant for to-dos, schedule and a daily journal, with a voice shortcut and sync to Apple Reminders and iCloud / Google Calendar. The UI is in Traditional Chinese.

- **Voice:** press `⌥ Space` and say what you want: add a to-do, write a journal entry, ask what's on today. By default, commands are parsed with built-in rules. In settings you can switch to a local model through Ollama (default `qwen2.5:3b`), so voice text still stays on the machine.
- **Native helpers in Swift:** `native/VoiceRecognizer.swift` (speech recognition) and `native/CalendarBridge.swift` (EventKit for Reminders and Calendar), bundled inside the Electron app.
- **Sync that doesn't overwrite your edits:** when the UI, voice and background sync change the same item, fields are merged one by one (three-way). A real conflict on the same field is reported instead of silently overwritten. Saves are atomic, with a backup and recovery from a corrupted file.
- **Everyday details:** global search (`⌘F`), keyboard navigation, screen-reader labels, reduced motion, a daily morning summary, launch at login.

**Stack:** Electron, vanilla JS (about 11,000 lines in `src/`), Swift (about 1,100 lines), Ollama.

**Tests:** seven Node test scripts under `scripts/` (voice commands, calendar sync, store durability, month view performance, journal merge, sync coordinator, concurrent merge). Run them with `npm run test:voice`, `npm run test:calendar` and so on.

**History:** the git history starts at a v1.3.1 baseline. It then shows a full code health check (`CODEX_修復指令書.md`: 52 findings, each checked by a separate reviewer), the P0–P3 fixes, and the v1.4 → v1.6 upgrades. I directed the work and checked it against the tests. Most of the code was written with AI coding tools (Claude Code, Codex).

```bash
npm install
npm run build:helpers   # builds the Swift helpers (needs Xcode command line tools)
npm start
```

License: MIT

---

# 貼身小秘書

> 原始碼一律位於 `src/`；請勿在專案根目錄建立 `main.js`、`voice.js` 或 `index.html` 複本。

一個支援語音與手機同步的 macOS 桌面小助理。

## 功能

- `⌘F` 全域搜尋所有待辦、行程、備註、日期與分類
- `⌘N` 快速新增，`⌘1`～`⌘6` 切換主要頁面
- 待辦預設只顯示未完成，並依逾期、今天與之後分組
- 今天、明天與未來一週的待辦視圖
- 七天行程會完整顯示；點日期可開啟當日完整清單
- 每件待辦可設定日期、提醒時間、分類與備註
- macOS 系統通知與每日早安摘要
- 每日日誌：完成事項、感受、明日提醒與心情
- 按 `⌥ Space` 呼叫語音助理，可用說話新增待辦、記日誌及查行程
- 待辦可同步到 Apple 提醒事項，行程可同步到 iCloud 或 Google 行事曆
- 平常在背景待命，不會常駐遮擋工作畫面
- 可選擇登入後自動啟動

## 1.4.0 介面與操作升級

- 首頁縮短焦點卡與統計區，讓行程更快進入視線。
- 本週固定顯示完整七天，每天先顯示四項，再由完整日清單查看其餘安排。
- 月曆日期、行程與「＋N」都可用滑鼠或鍵盤操作；「＋N」會打開完整日清單。
- 行事曆邀請狀態改為「已接受／待回覆／暫定／已婉拒」。
- 補齊可見鍵盤焦點、讀屏名稱、減少動態效果與語音小視窗狀態回饋。
- 畫面只重繪目前頁面，避免每次資料變更重建所有隱藏頁面。

## 1.5.0 順暢度與可靠性升級

- 設定改成「一般／同步／語音／進階」四個分類，一次只顯示一區；分類支援方向鍵、Home 與 End。
- 未儲存的設定草稿不會再被背景同步狀態覆蓋，儲存失敗時會保留畫面內容並回復系統狀態。
- 日誌改為統一自動保存：輸入後立即保留草稿、可靠落盤，切頁或隱藏視窗時也會立即嘗試保存。
- 畫面與語音同時更新日誌時會逐欄位合併；不能安全合併時會明確提示，不會靜默覆寫。
- 月曆新增「重點／全部」模式；重點模式只收合經嚴格辨識的高頻固定外部行程，日期清單永遠保留完整原始內容。
- 月曆資料先建立單次日期索引，避免每一天重複掃描全部行程；跨午夜延續會顯示正確的結束時間。

## 1.6.0 同步安全與行程編輯升級

- 同步期間收到的新變更會在同一輪完成前自動補跑；明確保存與同步完成後，資料都已真正寫入磁碟。
- Apple 提醒事項讀取逾時採取安全保留，不會再把尚未讀回的本機提醒誤判為已刪除。
- 畫面、語音與背景同步同時修改同一事項時，會逐欄位合併；同一欄位衝突則停止覆寫並提示重試。
- 行程編輯新增開始日期、結束日期與全天切換，可直接查看及保留跨午夜、多日與全天行程。
- 今天頁會主動顯示逾期待辦並帶到整理檢視；月曆改成單一 Tab 入口，支援方向鍵、Home、End、Enter 與 Space。
- 窄視窗改用 80px 圖示側欄，星期日至星期六維持等寬完整顯示；主畫面異常退出時會自動恢復原頁面。

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
