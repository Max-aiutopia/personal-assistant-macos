# 貼身小秘書 v1.3.1 — 系統健檢與修復指令書

> **給 Codex 的交接文件**。這份是診斷結果 + 逐項修復指令，不是需求討論。
> 健檢方式：7 個面向並行深讀原始碼 → 每項發現由獨立驗證員對抗式覆核（試圖推翻）。
> 結果：**52 項發現 → 47 項確認、3 項推測、2 項實測推翻（不要修）**。
> 健檢日期：2026-07-20 ｜ 對象：/Applications/貼身小秘書.app v1.3.1

---

## 零、先做這件事（動任何一行程式前）

專案**沒有版本控制**（有 .gitignore 但沒有 .git）。934 行的 main.js 要動刀，沒有 git 就沒有 diff、沒有回滾點。

```bash
cd "/Users/max/claude code/人工智能小秘書"
git init && git add -A && git commit -m "baseline v1.3.1（修復前基準）"
```

之後每個修復點各自 commit，方便逐項驗證與回退。

---

## 一、兩個回報症狀的診斷結論

### 症狀 A：「講話講到一半，它會突然閃退」→ **不是閃退，是語音視窗自己收掉**

**關鍵證據**：過去 14 天 `~/Library/Logs/DiagnosticReports` **零 .ips 崩潰報告**、userData 下**零 Crashpad**。App 本體從頭到尾活著。

實際發生的事是三段連鎖：

1. **語音辨識被提前切斷**。`native/VoiceRecognizer.swift:6` 的 `silenceTimeout = 3`，而且計時器**只在「辨識文字有變化」時才重置**（swift:126-130）。所以「講話中途停下來想 3 秒」「思考中的嗯…」「辨識引擎延遲」全部被判定成「他講完了」，半句話直接送出。
   UI 上寫的是「說完停頓 3 秒，我就會自動送出」（voice.js:243），但**實際語義是「partial 文字 3 秒沒變就送出」**——兩者差異就是所有句中停頓都會被誤判。
2. **另有一道更硬的閘門**：swift:7 `maximumListeningTime = 30`。**連續講超過 30 秒必定被硬切**，這比 Apple 伺服器端的 1 分鐘上限更早觸發。
3. **半句話被處理完，視窗就自己消失**。`voice.js:165-171` 回覆唸完後 `scheduleAutoHide(1800)`（或錯誤時 3000、閒置 8000）→ `voice.js:59` 呼叫 `api.hideVoice()`。這個視窗是 frameless + transparent + alwaysOnTop（main.js:114-134），**消失時毫無動畫、毫無痕跡**。
   若這半句剛好被解析成會議操作，`voiceIntent.js:452` 的 `hide: intent.hide !== false` + `route || "week"` 還會**額外把主視窗彈出來搶焦點**。

> 從你的視角：正在講話 → 突然被切斷 → 小光快速講了一句（可能答非所問）→ 主視窗無預警彈出 → 語音窗消失。
> **沒有任何一步是 crash，但整體感知就是「它閃退了」。**

### 症狀 B：「沒開啟時按 Option+Space 沒反應」→ **兩個獨立成因**

**成因 1：App 根本沒在跑。** `Cmd+Q` 會真的把 App 整個關掉——程式對「常駐」的唯一防線是視窗 close 攔截（main.js:102-107、137-142），但 `Cmd+Q` 走的是 `app.quit()`，close 攔截救不了。而且因為 `wasOpenedAsHidden` 在 macOS 13+ 恆為 false（本機是 macOS 26/Darwin 25，登入項走新制 SMAppService），**每次開機都會把主視窗彈到臉上** → 你自然會隨手 Cmd+Q → 背景待命和快捷鍵一起消失。

**成因 2：快捷鍵被搶走，而 App 靜默降級不告訴你。** `main.js:537-547` 只在啟動時試一次 Alt+Space，失敗就默默改用 Cmd+Shift+Space，只留一行 console.error（打包後沒人看得到）。

查證到的環境事實（重要）：
- **ChatGPT 桌面版預設快捷鍵就是 Option+Space**；Claude 桌面版的 Option+Space 是官方提供的第二選項。
- Wispr Flow、Typeless 預設用 fn 鍵，不直接衝突，但它們是 event-tap 型工具，可在按鍵到達前攔截。
- **macOS 上 `globalShortcut.register()` 撞鍵時仍回傳 `true`**（Carbon 非排他註冊）——所以 App **根本偵測不到自己被搶**，這是平台限制，不是 bug。

---

## 二、修復清單

優先級：**P0 = 直接解釋兩個症狀** ｜ **P1 = 卡死與資料安全** ｜ **P2 = 品質** ｜ **P3 = 清理**

---

## P0-1　語音不要再中途切斷 【症狀 A 主因 · 已確認】

**檔案**：`native/VoiceRecognizer.swift`、`src/voice.js`

1. **開口寬限與句中停頓分開**（swift:111-117、126-130、157-174）
   - `emit(ready)` 之後立刻開始倒數是錯的——此時使用者還沒開口。改成：ready 後給 **8-10 秒開口寬限**，**收到第一個 partial 之後**才啟用句中靜音判定。
   - 句中靜音判定改用 **installTap buffer 的 RMS 音量**偵測真正無聲，而不是「partial 文字有沒有變」。文字沒變但音量還在，就繼續重置計時器。
   - 若不做 RMS，至少把 `silenceTimeout` 從 3 提到 **5 秒**，並做成啟動參數 `--silence <秒>`，由 main.js:467 spawn 時從 settings 帶入。

2. **放寬 30 秒硬上限**（swift:7）
   `maximumListeningTime = 30` 一併拉長或做成 `--max-listen` 參數（建議 60）。
   ⚠️ **只改 silenceTimeout 修不完整**——連續講超過 30 秒仍會被硬切。

3. **同步修正三處寫死的文案**（否則承諾與行為不一致）
   `voice.js:243-244`（「說完停頓 3 秒」）、`swift:133`、`swift:168`（「3 秒內沒有聽到聲音」）。

---

## P0-2　視窗不要再自己消失 【症狀 A 感知來源 · 已確認】

**檔案**：`src/voice.js`、`src/voiceIntent.js`、`src/main.js`

1. **錯誤狀態一律不自動隱藏**（voice.js:256-261、173-178）
   拿掉 `scheduleAutoHide(3000)`，改成保留視窗 + 顯示錯誤原因 + 「再試一次」按鈕，只允許手動關閉或 Esc。

2. **成功回覆後不要急著收窗**（voice.js:165-172）
   - 若 `settings.voiceAutoListen` 為 true → **onDone 裡自動重新 startListening**（續聽模式），而不是收窗。這同時解掉「回覆完 8 秒收窗但麥克風已停、使用者以為還在聽」的問題。
   - 若維持不續聽 → `scheduleAutoHide(1800)` 至少拉到 **5000**，收窗前顯示倒數或淡出動畫。
   - `scheduleAutoHide` 執行前檢查 `isListening`，**聆聽中絕不隱藏**。

   ⚠️ 驗證員補充：伺服器辨識中途出錯**且已有部分文字**時，swift:149 走的是 `emit "final"` 而非 `"error"`——所以第 1 點擋不住這條路，**第 2 點才是正解，兩點都要做**。

3. **不要因為 route 就強制收窗＋搶焦點**
   - `voiceIntent.js:452、486`：`hide: intent.hide !== false` → 改成 `hide: Boolean(intent.hide)`（預設不收窗）；`route: route || "week"` → 改成 `route: route || null`。
   - `main.js:772`：不要每次有 route 就 `showMainWindow` 搶焦點。改成**只在 action 為 navigate**（使用者明確要求開頁面）時才呼叫，其餘用 `mainWindow.showInactive()`。
   - `main.js:775`：`hide: Boolean(result.hide || route)` → 改成 `hide: Boolean(result.hide)`，不要因 route 連帶 hide。
   - 規則式同路徑一併改：`voiceCommands.js:772、814`。

4. **停止聆聽要有視覺回饋**（voice.js:62-66）
   `stopListening()` 末尾加 `setState("idle", "已停止，按一下小光繼續說")`，目前點了 orb 停止後畫面仍顯示「正在聆聽」。

---

## P0-3　讓 App 真正常駐 【症狀 B 主因 · 已確認】

**檔案**：`src/main.js`

1. **Cmd+Q 改為隱藏，不要真退出**（main.js:102-107、137-142、574、916-930）

   ⚠️ **不要用 before-quit + preventDefault** 的做法。驗證員實測指出兩個坑：Electron 的 `preventDefault()` **不會阻止同一事件的其他 listener 執行**，現有 916-926 的 handler 仍會跑，一次被取消的 Cmd+Q 就會靜默殺掉三個計時器（提醒/同步/垃圾桶）並中斷語音辨識——反而製造出類似症狀 A 的體感。而且 powerMonitor 的 shutdown 事件在 macOS「登出」不保證觸發，會卡登出流程。

   **改用自訂應用選單重新映射 Cmd+Q**：
   ```js
   Menu.setApplicationMenu(Menu.buildFromTemplate([
     { label: "貼身小秘書", submenu: [
       { label: "隱藏視窗", accelerator: "Command+Q",
         click: () => { mainWindow?.hide(); voiceWindow?.hide(); } },
       // 其餘標準項目…
     ]},
     // 編輯選單務必保留（中文輸入法與剪貼簿需要）
   ]));
   ```
   真正退出只留 tray 的「結束貼身小秘書」（main.js:574），可另配 Cmd+Option+Q。
   如此 `before-quit` 完全不需 preventDefault，登出/關機/quitAndInstall 全部照常走原生流程，**916-926 行一行都不用改**。
   隱藏時發一次性 Notification：「已縮到背景，Option+Space 隨時召喚；要完全結束請用選單列圖示」。

2. **開機自啟不要彈視窗**（main.js:885-888）

   ⚠️ **不要純刪除 885-888**（會造成首次手動啟動無視窗的回歸）。改成偵測開機時間差：
   ```js
   // 手動啟動時顯示主視窗；登入自啟維持背景待命
   // 註：macOS 13+ 走 SMAppService，wasOpenedAsHidden 恆為 false，不可再用
   const isLoginLaunch = app.getLoginItemSettings().openAtLogin && os.uptime() < 120;
   if (!isLoginLaunch) showMainWindow("today");
   ```
   檔頭加 `const os = require("os")`。順手刪掉 main.js:680 的 `openAsHidden: true`（macOS 13+ 是 no-op，留著誤導維護者）。

---

## P0-4　快捷鍵搶輸要說話、要搶回來 【症狀 B 成因 2 · 已確認】

**檔案**：`src/main.js:537-547`

1. **主動告知**：落到備援或全滅時 `new Notification({ title: "快捷鍵已變更", body: "⌥Space 被其他 App（如 ChatGPT 桌面版）佔用，暫時改用 ⌘⇧Space 呼叫" }).show()`。專案已在 main.js:651、685 用過同模式。

2. **定時搶回——順序必須是「先註冊成功、才解除備援」**
   ⚠️ 原始建議的「先 unregister 再 register」有兩個坑：若重註冊仍失敗，備援鍵已被解除，App 從「降級可用」變成「完全不可用」；且 `voiceShortcut === ""` 時 `unregister("")` 會拋錯。
   正確做法：
   ```js
   setInterval(() => {
     if (voiceShortcut === "Alt+Space") return;
     if (globalShortcut.register("Alt+Space", showVoiceWindow)) {
       if (voiceShortcut) globalShortcut.unregister(voiceShortcut); // 成功後才解除
       voiceShortcut = "Alt+Space";
       tray.setContextMenu(/* 重建 */);        // 標籤在 buildTray 時烤死，不重建不會變
       voiceWindow?.webContents.send("shortcut-changed", shortcutLabel());
     }
   }, 60_000);
   ```
   `voice.js:220` 只在載入時讀一次快捷鍵，要補一個 IPC 監聽更新 `#shortcut-label`。

3. **設定頁加「呼叫快捷鍵」自訂欄位**（存進 settings，經 IPC 重新註冊）。
   ⚠️ **重要限制**：`globalShortcut.isRegistered` 只回報「本 App 是否註冊成功」，對 event-tap 型上游攔截（register 回 true 但事件到不了）**完全偵測不到**。設定頁顯示「已註冊」不等於「按了有反應」。
   → 建議加一顆**「測試快捷鍵」按鈕**：按下後 N 秒內等 `showVoiceWindow` 被觸發，逾時就提示「可能被其他 App 攔截」。這是唯一能診斷這種情況的方法。
   → 同理，第 2 點的定時重試也只救得回「register 回 false」那種，通知文案要涵蓋「若按了仍沒反應，請檢查 ChatGPT／Wispr Flow／Typeless 的快捷鍵設定」。

---

## P0-5　補上診斷基建 【沒有這個，下次出事還是瞎子 · 已確認】

**檔案**：`src/main.js`

現況：無 crashReporter、無 uncaughtException/unhandledRejection、無 render-process-gone、**無任何檔案日誌**。打包後 console 全進黑洞。這正是這次健檢只能靠推理、拿不到現場證據的原因。

1. `crashReporter.start({ uploadToServer: false })` 放在 **main.js 頂部 require 之後**（越早越好，涵蓋所有子程序）。Electron 42 在 `uploadToServer:false` 時不需 submitURL。

2. **檔案 logger**：`fs.mkdirSync(path.join(app.getPath("userData"), "logs"), { recursive: true })`，handler 內一律用 `fs.appendFileSync`（同步寫，確保程序異常時日誌落盤），自行輪替 1MB。

3. **註冊位置在 require("electron") 之後、require 本地模組之前**——這樣本地模組載入期間的同步例外（MODULE_NOT_FOUND、語法錯誤）也接得到。
   ```js
   process.on("uncaughtException", (err) => {
     try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${err.stack}\n`); } catch {}
     // 註冊自訂 handler 後，Electron 內建的模態錯誤框會自動停用（listenerCount > 1）
     // 這正是消除「凍結模態框」的關鍵
   });
   process.on("unhandledRejection", (reason) => { /* 記 log 不退出 */ });
   ```
   ⚠️ **關鍵語義**：一旦註冊自訂 handler，Electron 會抑制內建錯誤框——原本「至少看得見的錯誤」會變成無聲，**所以 handler 必須自己負責完整收尾**，不可只記 log 就 return。log 寫入本身必須包 try/catch（fs 可能正是故障源）。

4. **縮小「半初始化殭屍」窗口**：把 `registerVoiceShortcut()`（:883）與 `buildTray()`（:884）**提早**到 autoUpdater 區塊（:854-868）與 session handlers（:869-879）之前，並把 autoUpdater 整塊、`ensureCalendarBridgeInstalled()`（:851）各自包 try/catch。
   whenReady 鏈尾補 `.catch()`，且不要只記錄——殭屍程序持有 single-instance lock，會讓使用者手動重開也打不開新實例，應在 catch 內跳 Notification 並考慮 `app.relaunch()`。

5. **helper 的死因要記下來**（main.js:492-494 目前把 stderr 整段丟棄、501-520 不看 exit code）
   把 stderr 寫進 `userData/logs/voice-helper.log`，exit handler 帶入 `(code, signal)` 分流文案。
   **exit code 本身就有語意**（swift:59/66/79/107/151/169）：
   `2`=語音辨識權限 ｜ `3`=麥克風權限 ｜ `4`=辨識器不可用 ｜ `5`=AudioEngine 啟動失敗 ｜ `6`=錯誤且無文字 ｜ `7`=靜音逾時無文字
   目前**所有異常死法都被貼上「請重新允許麥克風權限」**，誤導使用者。
   建議：exit code 7 時不要顯示錯誤後收窗，改成**自動重啟聆聽一輪**。

---

## P1-1　行事曆同步逾時（會讓語音永久卡死）【已確認】

**檔案**：`src/nativeBridge.js:63-101`、`src/calendarSync.js`、`src/main.js:761`

`runDirectBinary` **完全沒有 timeout**，只在子程序 exit 時 resolve。CalendarBridge 卡住（EventKit 無回應、TCC 對話框沒人按）時：
- `voice:process` 的 IPC 永不回覆 → orb 永遠停在「正在整理」
- `calendarSyncPromise` 永不清空 → **之後所有定時同步與手動同步全部拿到同一顆卡死的 promise**，整個同步子系統癱瘓到重開 App
- 之後每次 Option+Space 視窗會出現但永不聆聽（被 isProcessing 擋住）→ 被感知為「快捷鍵沒反應」

⚠️ **不可一律預設 30 秒逾時**——`request-access`（main.js:276）合法情境下就是要等使用者回應權限對話框，常超過 30 秒，殺掉它會弄壞首次授權流程。

```js
// nativeBridge.js：增加第 4 參數 timeoutMs（預設 30000）
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3000);  // EventKit 卡住可能忽略 SIGTERM
  reject(new Error("行事曆同步逾時"));
}, timeoutMs);
// "exit" 與 "error" 兩個 handler 都要 clearTimeout；用 settled 旗標確保只 settle 一次
```
`calendarSync.js` 的 `runCalendarBridge` 增加 timeoutMs 透傳，由呼叫端按指令別指定：
**sync = 30000**（main.js:380）｜ **status = 15000**（main.js:784）｜ **request-access = 180000 或不設**（main.js:276）

`main.js:761` 用 `Promise.race` 包 15 秒上限，逾時回覆「同步比較久，我先記下來，稍後自動再同步」。逾時分支要能與一般同步失敗區分（用自訂 Error 型別），避免誤報。

---

## P1-2　語音狀態機卡死 【已確認】

**檔案**：`src/voice.js`

`isProcessing` 在 151 行設 true，唯一解除點是 `speak()` 的 onDone（掛在 utterance.onend/onerror）。兩條卡死路徑：Chromium 已知的 utterance 被 GC 導致 onend/onerror 都不觸發；以及 P1-1 的 IPC 永不 resolve。卡死後 `startListening` 在 184 行直接 return——**視窗開著、寫著「準備開始聆聽」，但永遠不會開麥克風，也沒有任何錯誤提示**。

1. **speak() watchdog**：utterance 存到模組層變數防 GC；onDone 包成 once wrapper；加 `Math.min(4000 + text.length * 250, 20000)` ms 的強制 watchdog；正常 onend 觸發時 `clearTimeout`。

2. **session 世代權杖**（⚠️ 沒有這個，光重置 isProcessing 會引入新 bug）
   若 `voice:process` 只是慢而非卡死，強制把 isProcessing 設 false 後舊 promise 稍後 resolve，仍會**覆寫新 session 的畫面並開口朗讀舊回應**。
   ```js
   let sessionGeneration = 0;
   // prepareVoice(): sessionGeneration++; 並歸零 isProcessing/isListening
   // processTranscript(): const gen = sessionGeneration;
   //   await 回來後 if (gen !== sessionGeneration) return;  ← speak 前檢查
   ```

3. **prepareVoice 強制歸零**：`isProcessing=false`、`isListening=false`、`stopSpeaking()`、`api.stopVoiceListening()` 清掉殘留 helper，再開新 session。
   同時修 `onVoiceStop`（voice.js:224-229）——目前不重置 isProcessing，Esc 關窗再開一樣卡死。

4. **renderer 端看門狗**：processTranscript 45 秒沒結果就強制 `isProcessing=false` 並顯示「處理逾時，請再說一次」。

5. **聆聽中再按快捷鍵的競態**（voice.js:181-193）：`prepareVoice` 開頭若 `isListening` → 先 `api.stopVoiceListening()` 再重啟，確保 native session 與 UI 同步歸零。目前 native helper 完全沒被重啟，會抱著舊的 latestText 繼續累積。

---

## P1-3　資料安全：資料檔損毀會無聲丟光 【已確認】

**檔案**：`src/store.js:71-105`

`read()` 把 JSON 解析失敗與 ENOENT 一視同仁 → 回傳 DEFAULT_DATA。而 `main.js:895` 啟動 2 秒就觸發同步 → `store.write` → 350ms 後**把預設空資料原子寫回**，714 筆 tasks 就地覆滅，**連壞檔副本都不留**。
（userData 下已有 4 個手動備份檔，顯示這類事故過去就發生過。）

⚠️ 驗證員指出三個實作陷阱，必須照做：

```js
// (1) read() 的搶救動作本身要包 try/catch——若失敗原因是 EACCES/EPERM，
//     renameSync 也會丟例外，未包裹會讓 read() 直接炸掉、App 啟動失敗（比現況更糟）
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error("Failed to read assistant data:", error);
    try { fs.renameSync(dataPath, `${dataPath}.corrupt-${Date.now()}`); } catch {}
    try {
      const bak = JSON.parse(fs.readFileSync(`${dataPath}.bak`, "utf8"));
      cached = normalize(bak);
      // 通知使用者「主資料檔損毀，已從備份還原，壞檔保留為 .corrupt-*」
      return structuredClone(cached);
    } catch {}
  }
  cached = structuredClone(DEFAULT_DATA);
  return structuredClone(cached);
}
```

```
(2) flushToDisk 的 .bak 備份必須容錯，否則造成持久化死循環：
    首次寫入或壞檔剛被改名走時 dataPath 不存在，copyFileSync 丟 ENOENT
    → 被外層 try/catch 吞掉 → renameSync 永遠執行不到 → 資料永遠寫不進去。
    正確順序：write tmp → fsyncSync(fd) → closeSync → try{copy dataPath→.bak}catch{} → renameSync

(3) 寫入沒有 fsync：writeFileSync 後沒 fsync 檔案、rename 後沒 fsync 目錄。
    APFS 斷電時 rename 的 metadata 可能先於資料塊落盤 → 空檔或半截 JSON。

(4) 順手：JSON.stringify 不縮排，641KB → 473KB，全量重寫成本降 26%。
```

---

## P1-4　資料安全：真實行事曆事件可能被誤刪 【已確認 · 不可逆後果】

**檔案**：`src/calendarSync.js:157-164, 188-207, 275-277`、`src/main.js:669-675`

兩個機制疊加成誤刪路徑：
1. `mergeSyncResult` 每次都把 external 事件的 **task.id 改寫**成 importedTaskId（:275-277），而 importedTaskId 的 hash 材料**含 date 與 reminderTime** → **任何一次改期都會讓 id 變動**。
2. `enqueueDeletedTasks`（:188-207）用**「previous 有、next 沒有」就判定使用者刪除**，推入 pendingDeletes → 下次 sync **真的從 Google/Apple 行事曆刪掉**，且 30 天 tombstone 讓它不會再匯入。

競態：5 分鐘定時 sync 改寫了某事件 id → renderer 手上還是舊快照 → 使用者點一下觸發 persist → main 拿新 id 對舊快照比對 → **id 對不上 = 判定使用者刪除** → 真行事曆事件被刪，全程無聲。
本地 task 因 deletedKeys 反而留著——**App 裡還在、行事曆上消失**。

修法（三管齊下，至少做 1+2）：
1. **讓 importedTaskId 穩定**：hash 材料只用 `external.type + calendarId + recurringEventBaseId`，把 date/reminderTime 拿掉，改期不再變 id。
2. **不要用「id 缺席」推斷刪除**：renderer 的 deleteTask 已經把 task 放進 trash，刪除意圖走 trash 即可。把 main.js:671 的 `enqueueDeletedTasks` 拿掉，或改成只比對明確 tombstone。
3. **加世代防護**：store 加 `revision` 遞增欄位，persist 時 renderer 附上所本 revision，main 發現落後就拒收整包、回傳最新資料讓 renderer 重放。

---

## P1-5　stdin EPIPE 會炸主程序 【已確認】

**檔案**：`src/nativeBridge.js:95-99`

同步時把 ~503KB payload 灌進 helper 的 stdin（遠超 64KB pipe buffer），但 **stdin 這條 Writable stream 沒有 'error' listener**。helper 起動後立即死亡（Gatekeeper 攔、換檔到一半、dyld 失敗）時，排隊中的寫入收到 EPIPE，在無 listener 的 stream 上直接 throw 成 uncaughtException。

三行保命修補：
```js
child.stdin.on("error", (err) => { /* 記 log，結果交由 exit handler reject */ });
```
同時把 `child.on("exit")` 的 reject 訊息附上 stderr 與 code。與 P0-5 的全域守門員互為雙保險。

---

## P2　品質與效能（依序處理）

| # | 問題 | 檔案 | 修法要點 |
|---|---|---|---|
| P2-1 | **tasks 無限成長**：714 筆佔 641KB 的 99.5%，滾出 -30 天視窗的事件永遠不會被清除，每天續增 | `calendarSync.js:98-103, 326-331` | `isSyncedExternalTaskInScope` 對出窗事件回 false → filter 一律保留。加歸檔規則：`provider==="eventkit" && kind==="event" && eventEndDate < window.eventsStart` 直接移除（行事曆本身就是正本）。另把 Swift 匯入視窗從 +365 天縮到 +90 天 |
| P2-2 | **renderer 單點故障**：init/wireEvents 零防護，任一步 throw 就整頁按什麼都沒反應 | `renderer.js:743-1069` | 開頭加 `if (!window.assistantAPI)` 檢查；寫容錯掛載 helper `on(sel,evt,fn)`；init 包 try/catch |
| P2-3 | **一筆壞日期凍結整個 UI**：parseDate 遇非法日期 throw RangeError，render() 七個子畫面串成一條 | `renderer.js:43-46, 654-669` | parseDate 加 `/^\d{4}-\d{2}-\d{2}$/` 與 isNaN 守衛；render() 內各子畫面各自 try/catch |
| P2-4 | **雙重全量重繪**：一次點擊 = 641KB 走 IPC ×2 視窗 + 兩次全量 render（約 3 萬次判斷 ×2） | `renderer.js:75-77`、`main.js:580-583, 386-389` | 刪掉 `await persist(); render();` 中的顯式 render（靠 data-changed 即可）；語音視窗改送輕量 `settings-changed`；同步無變更就不廣播 |
| P2-5 | **AI 失敗靜默降級寫垃圾資料**：Claude 401/逾時後退回規則式，寬鬆關鍵字把閒聊句寫成待辦並同步上行事曆，全程不告知 | `main.js:718-723`、`voiceCommands.js:837-901` | 記降級旗標，response 前加「（AI 沒回應，我先用基本模式處理）」；AI 失敗時 add 類改回問句確認；收窄 add 觸發條件（要求句首祈使動詞） |
| P2-6 | **對使用者說謊**：applyIntent 早退分支照唸模型預寫的成功台詞，沒寫入資料卻說「已新增」 | `voiceIntent.js:342, 348-352, 511-512` | 拿掉 342 行的 response 預設值，各分支自行決定 fallback；add 分支 title 為空時強制追問；action 白名單驗證 |
| P2-7 | **主 App 是 ad-hoc 簽章**（已實測 `flags=0x2(adhoc)`）：TCC 四筆授權以 cdhash 綁死，**每次重打包都會重置語音權限** | `package.json:17, 21` | `"sign": "codesign --force --sign \"Glow Secretary Local Signing\" 'dist/…/貼身小秘書.app'"`（去掉 --deep、去掉 `-`）；並在 `package` script 尾端串 `&& npm run sign`，避免打包後忘記簽 |
| P2-8 | **auto-rehome 非原子**：remove 成功、save 失敗 → 事件從舊日曆消失、新日曆沒建成，且之後永不重建 | `CalendarBridge.swift:409-421, 443` | 順序反過來：先 save 新事件成功才 remove 舊的；save 失敗不動舊事件；失敗時清空 external.modifiedAt 讓下次能重試 |
| P2-9 | **寬鬆比對可能刪錯事件**：matchingEvent 用「標題+日期」且時間可空就不比對，掃描窗還跨 2 天 | `CalendarBridge.swift:267-302, 345` | 改成 id 優先、比對為輔；刪除路徑要求日期時間完全相等且 isAllDay 一致；掃描窗縮回當日；多個候選就不動手、改發 warning |
| P2-10 | **衝突判定偏向本地覆蓋**：時間戳缺失/解析失敗一律當本地較新 → iPhone 剛改的事件被舊資料覆寫 | `CalendarBridge.swift:385-399`、`calendarSync.js:299-306` | 預設反轉：缺失或解析失敗時回 false（不動作）+ warning；isoFormatter 失敗時用不含毫秒的第二個 formatter 重試；兩端容差統一常數 |

---

## P3　清理（低風險，順手做）

| # | 項目 | 動作 |
|---|---|---|
| P3-1 | **根目錄死檔** `main.js` / `voice.js` / `index.html` | 目前與 src/ 內容相同（已 diff 確認），從未被載入也從未被打包。**這是改錯檔的頭號陷阱**——刪除或移入 `_archive/`，並在 README 註明「原始碼一律在 src/」 |
| P3-2 | **autoUpdater 是死路徑但留著未來炸彈** | publish 是佔位符 `your-github-username`、安裝包無 app-update.yml，checkForUpdates 每次立即失敗被空 catch 吞掉。真正的雷在 `main.js:860-863`：下載完 **1.5 秒後不問使用者直接 quitAndInstall**——哪天 feed 修通，正在講話就是貨真價實的閃退。**建議直接移除 853-868 整段與 package.json 的 publish 區塊**；若要留，改成通知 + `autoInstallOnAppQuit = true` |
| P3-3 | **兩套打包並存且產物不一致** | 實際安裝的是 electron-packager 那套；electron-builder 設定**缺 extendInfo**（7 個 TCC 用途說明 key 不會進 Info.plist，授權流程會失敗）、缺 icon、notarize:true 但沒 Apple 帳號。**擇一**：保留 packager，刪除 build 區塊與 dist script；或補齊 builder 設定後才切換 |
| P3-4 | **helper 建置腳本靜默退回 ad-hoc** | `build-*.sh` 找不到憑證就 fallback 到 `-`，權限重置毫無警告。改成 fail-loud：echo 明確錯誤 + `exit 1` |
| P3-5 | **月檢視語音到不了** | `main.js:43` 的 ALLOWED_ROUTES 漏掉 `"month"`，`voiceIntent.js:77、178` 的 route enum 同樣缺。三處補上 |
| P3-6 | **設定頁 5 處原生 alert()** | `renderer.js:940, 942, 972, 986, 988`。改用頁內狀態 span（檔案裡已有 `btn.textContent = "已儲存 ✓"` 的模式可抄），避免同步阻塞與 macOS 焦點遺失 |
| P3-7 | **改期會捏造結束時間** | `voiceCommands.js:543-551`：原本沒 endTime 的行程被改期時自動加 +1 小時並推上行事曆。改成 `else if (task.endTime) nextEnd = …`（比照 offset 路徑的守門） |
| P3-8 | **舊設定遷移是死碼** | `voiceIntent.js:220-226`：normalize 一定會補上 `voiceBrain="rules"`，所以 `aiVoiceEnabled→ollama` 的遷移永遠執行不到。調整判斷順序，並讓 voice.js:154 的「正在用 AI 思考」文案依 resolveBrain 結果顯示 |
| P3-9 | **CSP 可收斂** | index.html 的 `unsafe-inline` 只為 4 個 inline width 而存在（搬進 styles.css 即可移除）；voice.html 根本沒有 inline style 卻也放了 |
| P3-10 | **preload 權限過寬** | 兩個視窗共用同一份 preload：語音視窗拿得到 `saveData`（可整份覆寫資料庫）。拆成兩份，或在敏感 channel 加 sender 白名單檢查 |

---

## 三、⚠️ 這兩項不要修（驗證員實測推翻）

### ❌ single-instance lock 的「第二實例閃現視窗」— **不存在**
`main.js:40-41` 的寫法確實偏離官方 else-guard 樣板，但驗證員用專案內嵌的 Electron 42.4.0 實測 6 次：ready 之前呼叫 `app.quit()` 會**保證 whenReady 永不發射**，第二實例不會建立視窗、不註冊快捷鍵。且 macOS 上從 Dock 點擊執行中的 App 只會 activate 既有程序，根本不產生第二程序。
原建議的「補 `app.exit(0)` 硬退」**不要做**——它跳過正常退出流程，解決一個不存在的問題。

### ❌ `npm run sign` 的 `--deep` 會摧毀 helper 憑證 — **不成立**
驗證員實機做了兩輪對照實驗：對 dist 複本執行相同的 `codesign --force --deep --sign -` 後，`Contents/Resources/` 下兩個 helper **仍保持 Glow 憑證簽章**，完全未被覆蓋；控制組把 `Frameworks/Squirrel.framework` 改簽後再跑 deep，framework 立刻被翻成 adhoc 而 Resources 下的 helper 依然完好。
原因：`--deep` 只作用於標準巢狀程式碼位置（Frameworks/PlugIns/Helpers/XPCServices），`Contents/Resources/` 下一律封存為資源資料。
**但 P2-7 仍要做**——理由不同：目的是讓**外層主程式自己**的 TCC 綁定從 adhoc cdhash 改綁憑證。

---

## 四、三項「推測」等級（程式碼缺口屬實，但需執行期條件才會發作）

| 項目 | 說明 | 建議 |
|---|---|---|
| **AVAudioEngine 未處理裝置變更** | swift:96-100 只在啟動時取一次格式裝 tap，全檔無 `AVAudioEngineConfigurationChange` 監聽。AirPods 接上並被設為預設輸入時，引擎會自行停止 → partial 凍結 → 3 秒後送出殘句 | ⚠️ **採「提前收尾」而非「重建 tap」**：裝置消失瞬間 `outputFormat` 可能回 0Hz/0聲道，用它重新 installTap 會拋出 Swift **無法 catch 的 NSException，讓 helper 真的硬崩**（反而製造出目前不存在的原生 crash）。註冊通知時務必帶 `object: audioEngine` 並指定 `.main` queue |
| **主程序無守門＝永久下線** | 守門缺席是事實，但「一次 JS 例外 = 必然退出」與 Electron 預設行為不符——內建 handler 是彈框後**不退出**（原始碼註解即 "Don't quit on fatal error"）。實際裸露面也比想像窄：ipcMain.handle 的 async 例外會變成回傳 renderer 的 rejection、store.js 讀寫都有 try/catch。真正無防護的只剩 setInterval 回呼與 globalShortcut/tray 回呼 | 照 P0-5 做即可，但**不要把它當成症狀 A 的根因** |
| **設定頁 alert 導致焦點遺失** | 5 處 alert 屬實、同步阻塞必然成立；但「macOS 焦點不回復」是 Electron 長年反覆出現又修復的回歸，Electron 42 是否仍帶此問題無法靜態斷定 | 照 P3-6 做，成本低 |

---

## 五、修完後的驗收方式

1. **症狀 A**：開語音，講一句中間**故意停頓 5 秒**再繼續講完 → 應該完整收到整句，視窗不消失。連續講 45 秒 → 不應被中途硬切。
2. **症狀 B**：按 Cmd+Q → App 應縮到背景（選單列圖示還在），此時按 Option+Space 應該叫得出來。重開機後不應彈出主視窗，但 Option+Space 要有反應。
3. **快捷鍵衝突**：開著 ChatGPT 桌面版（預設佔用 Option+Space）啟動小秘書 → 應該跳通知告知改用哪個鍵，而不是靜默失效。
4. **卡死自癒**：設定頁測試 Claude 連線時拔網路 → orb 不應永久卡在「正在整理」，45 秒內要有逾時提示。
5. **日誌**：出任何問題後 `~/Library/Application Support/personal-glow-assistant/logs/` 應該要有可讀的現場紀錄。
6. **簽章**：`codesign -dv /Applications/貼身小秘書.app` 應顯示 `Authority=Glow Secretary Local Signing`，而不是 `adhoc`。重新打包安裝後**不應再要求重新授權麥克風**（第一次改簽會要求一次，之後就穩定）。

---

## 六、給 Codex 的執行建議順序

```
0. git init + baseline commit
1. P0-5（診斷基建）   ← 先做這個，後面每一步出錯才有 log 可看
2. P0-1 + P0-2        ← 症狀 A，一起做一起測
3. P0-3 + P0-4        ← 症狀 B，一起做一起測
4. P1-1 ~ P1-5        ← 卡死與資料安全（P1-3、P1-4 涉及資料，改完先備份 assistant-data.json 再測）
5. P2                 ← 品質，可分批
6. P3                 ← 清理，P3-1 建議提早做（避免改錯檔）
```

每個 P 各自 commit。P1-3、P1-4 動到資料層，測試前先：
```bash
cp ~/Library/Application\ Support/personal-glow-assistant/assistant-data.json ~/Desktop/glow-backup-$(date +%Y%m%d).json
```
