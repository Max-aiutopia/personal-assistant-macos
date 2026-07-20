const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const {
  app,
  BrowserWindow,
  crashReporter,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray
} = require("electron");

crashReporter.start({ uploadToServer: false });
const logDirectory = path.join(app.getPath("userData"), "logs");
const logPath = path.join(logDirectory, "main.log");
const voiceHelperLogPath = path.join(logDirectory, "voice-helper.log");
try { fs.mkdirSync(logDirectory, { recursive: true }); } catch {}
function writeDiagnostic(kind, detail) {
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
    const rendered = detail instanceof Error ? detail.stack : String(detail);
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${kind}] ${rendered}\n`);
  } catch {}
}
function writeVoiceHelperLog(detail) {
  try {
    if (fs.existsSync(voiceHelperLogPath) && fs.statSync(voiceHelperLogPath).size > 1024 * 1024) {
      fs.renameSync(voiceHelperLogPath, `${voiceHelperLogPath}.1`);
    }
    fs.appendFileSync(voiceHelperLogPath, `${new Date().toISOString()} ${String(detail)}\n`);
  } catch {}
}
let handlingUncaughtException = false;
process.on("uncaughtException", (error) => {
  writeDiagnostic("uncaughtException", error);
  if (handlingUncaughtException) return;
  handlingUncaughtException = true;
  try {
    new Notification({ title: "貼身小秘書發生錯誤", body: "現場紀錄已保存，正在安全重新啟動。" }).show();
  } catch {}
  if (!process.argv.includes("--recovery-relaunch")) {
    try { app.relaunch({ args: [...process.argv.slice(1), "--recovery-relaunch"] }); } catch {}
  }
  setTimeout(() => app.exit(1), 150);
});
process.on("unhandledRejection", (reason) => writeDiagnostic("unhandledRejection", reason));
const { createStore } = require("./store");
const { eventOccursOnDate } = require("./utils");
const { handleVoiceCommand } = require("./voiceCommands");
const { parseVoiceIntent, applyIntent, testClaude } = require("./voiceIntent");
const { normalizeVoiceHistory, contextFallbackResponse } = require("./voiceContext");
const { createSecretStore } = require("./secretStore");
const {
  dedupeSyncedTasks,
  finalizeExpiredTrash,
  mergeSyncResult,
  runCalendarBridge
} = require("./calendarSync");
const { dateKey, addDays } = require("./utils");
const { processJsonLines } = require("./nativeBridge");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const ALLOWED_ROUTES = ["today", "tasks", "week", "month", "journal", "settings"];

let mainWindow;
let voiceWindow;
let tray;
let store;
let secretStore;
let reminderTimer;
let calendarSyncTimer;
let calendarSyncDebounce;
let calendarSyncPromise;
let trashCleanupTimer;
let shortcutRetryTimer;
let isQuitting = false;
let voiceShortcut = "Alt+Space";
let shortcutTestResolver;
let hasShownBackgroundNotification = false;
let voiceRecognizerSession;

function getAppIcon() {
  const iconPath = path.join(__dirname, "..", "assets", "app-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

// Electron 安全基線：禁止彈出新視窗與離開本地頁面的導航；外部連結一律走 shell.openExternal
function hardenWebContents(contents) {
  contents.on("render-process-gone", (_, details) => writeDiagnostic("render-process-gone", JSON.stringify(details)));
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "貼身小秘書",
    backgroundColor: "#f7f4ff",
    icon: getAppIcon(),
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require 本地模組（./utils 等）；沙箱化會讓其失敗導致 assistantAPI 無法注入。
      // contextIsolation 仍為 true，安全隔離維持不變。
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  hardenWebContents(mainWindow.webContents);
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createVoiceWindow() {
  voiceWindow = new BrowserWindow({
    width: 430,
    height: 510,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "voice-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  voiceWindow.setAlwaysOnTop(true, "floating");
  voiceWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  voiceWindow.loadFile(path.join(__dirname, "voice.html"));
  hardenWebContents(voiceWindow.webContents);
  voiceWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      voiceWindow.hide();
    }
  });
  voiceWindow.on("closed", () => {
    voiceWindow = null;
  });
}

function showMainWindow(route = "today") {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("navigate", route);
}

function showVoiceWindow() {
  if (shortcutTestResolver) {
    shortcutTestResolver(true);
    shortcutTestResolver = null;
  }
  if (!voiceWindow) createVoiceWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width, height] = voiceWindow.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + Math.min(100, (display.workArea.height - height) / 3));
  voiceWindow.setPosition(x, y, false);
  voiceWindow.show();
  voiceWindow.focus();
  if (voiceWindow.webContents.isLoading()) {
    voiceWindow.webContents.once("did-finish-load", () => {
      voiceWindow?.webContents.send("voice:start");
    });
  } else {
    voiceWindow.webContents.send("voice:start");
  }
}

function hideVoiceWindow() {
  voiceWindow?.webContents.send("voice:stop");
  stopNativeVoiceRecognition();
  voiceWindow?.hide();
}

function bundledVoiceRecognizerAppPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "VoiceRecognizer.app")
    : path.join(__dirname, "..", "build", "VoiceRecognizer.app");
}

function voiceRecognizerAppPath() {
  // Helper 保留在已簽章的主 App 內，避免 Launchpad 出現額外 App 或殘留舊版本。
  return bundledVoiceRecognizerAppPath();
}

function voiceRecognizerExecutablePath() {
  return path.join(voiceRecognizerAppPath(), "Contents", "MacOS", "voice-recognizer");
}

function bundledCalendarBridgeAppPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "CalendarBridge.app")
    : path.join(__dirname, "..", "build", "CalendarBridge.app");
}

function calendarBridgeAppPath() {
  return bundledCalendarBridgeAppPath();
}

function calendarBridgeExecutablePath() {
  const appPath = calendarBridgeAppPath();
  return path.join(appPath, "Contents", "MacOS", "calendar-bridge");
}

function ensureCalendarBridgeAvailable() {
  const executable = calendarBridgeExecutablePath();
  if (!fs.existsSync(executable)) throw new Error(`找不到行事曆元件：${executable}`);
  return calendarBridgeAppPath();
}

async function requestCalendarAccess() {
  ensureCalendarBridgeAvailable();
  return runCalendarBridge(calendarBridgeExecutablePath(), "request-access", null, 180_000);
}

function calendarSyncEnabled(data) {
  return Boolean(data.settings.calendarSyncEnabled || data.settings.reminderSyncEnabled);
}

class CalendarSyncTimeoutError extends Error {
  constructor() {
    super("行事曆同步仍在背景進行");
    this.name = "CalendarSyncTimeoutError";
  }
}

function withCalendarVoiceTimeout(promise, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CalendarSyncTimeoutError()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function syncBroadcastSignature(data) {
  return JSON.stringify({
    tasks: data.tasks,
    trash: data.trash,
    pendingDeletes: data.sync?.pendingDeletes,
    pendingEventActions: data.sync?.pendingEventActions,
    deletedExternalItems: data.sync?.deletedExternalItems,
    warnings: data.sync?.warnings,
    lastSyncError: data.sync?.lastSyncError
  });
}

function persistedContentSignature(data) {
  const { revision, ...content } = data || {};
  return JSON.stringify(content);
}

function shouldUseDeterministicQuery(transcript, intent) {
  if (intent?.action !== "query") return false;
  const text = String(transcript || "");
  return (
    /(今天|明天).*(待辦|行程|什麼|哪些|安排|有什麼)/.test(text) ||
    /(這週|本週|一週|這星期).*(什麼|哪些|待辦|行程|安排)/.test(text) ||
    /本週行程|今天有什麼|明天有什麼/.test(text)
  );
}

function eventSyncSignature(task) {
  return [
    task.title || "",
    task.date || "",
    task.reminderTime || "",
    task.endDate || "",
    task.endTime || "",
    task.responseStatus || task.external?.responseStatus || ""
  ].join("|");
}

function calendarVoiceMutation(previous, next) {
  const previousEvents = new Map((previous.tasks || []).filter((task) => task.kind === "event").map((task) => [task.id, task]));
  const nextEvents = new Map((next.tasks || []).filter((task) => task.kind === "event").map((task) => [task.id, task]));
  const previousActions = previous.sync?.pendingEventActions?.length || 0;
  const nextActions = next.sync?.pendingEventActions?.length || 0;

  if (nextActions > previousActions) {
    const latest = next.sync.pendingEventActions.at(-1);
    if (latest?.action === "respond") return "respond";
    if (latest?.action === "reschedule") return "reschedule";
    return "event";
  }
  for (const id of previousEvents.keys()) {
    if (!nextEvents.has(id)) return "delete";
  }
  for (const [id, task] of nextEvents.entries()) {
    const previousTask = previousEvents.get(id);
    if (!previousTask) return "add";
    if (eventSyncSignature(previousTask) !== eventSyncSignature(task)) return "reschedule";
  }
  return "";
}

function quotedTitle(text) {
  const match = String(text || "").match(/「([^」]+)」/);
  return match ? match[1] : "";
}

function appendCalendarSynced(original) {
  const text = String(original || "").trim();
  if (!text) return "好，已經同步到行事曆了。";
  if (/同步到行事曆|加到行事曆|從行事曆刪掉/.test(text)) return text;
  return `${text.replace(/[。.!！]+$/u, "")}，也同步到行事曆了。`;
}

function naturalCalendarResponse(original, mutation, data) {
  const title = quotedTitle(original);
  const pendingWarnings = data.sync?.warnings || [];
  const rsvpWarning = pendingWarnings.find((warning) => /EventKit.*RSVP|無法代送正式回覆/.test(warning));
  if (mutation === "add") {
    return appendCalendarSynced(original);
  }
  if (mutation === "delete") {
    return title ? `好，「${title}」我已經幫你從行事曆刪掉了。` : "好，這個行程我已經幫你從行事曆刪掉了。";
  }
  if (mutation === "reschedule") {
    return title ? `可以，「${title}」的時間已經幫你改好了。` : "可以，時間已經幫你改好了。";
  }
  if (mutation === "respond") {
    if (rsvpWarning) {
      return `${original} 這次先在小秘書裡標好；macOS 目前不開放我代送正式 RSVP，所以雲端會等行事曆自己同步回來。`;
    }
    return original;
  }
  return original;
}

function calendarNotReadyResponse(original, mutation, data) {
  const action = mutation === "delete" ? "刪除" : mutation === "reschedule" ? "改時間" : "新增";
  if (!data.settings.calendarSyncEnabled) {
    return `${original} 不過現在還沒開啟行事曆同步，所以我只能先改小秘書裡的資料；要真的${action} Google 或 Apple 行事曆，需要先到設定連接行事曆。`;
  }
  if (!data.settings.calendarId) {
    return `${original} 不過目前還沒選定要同步的 Google 或 Apple 行事曆，我先帶你到設定選一下。`;
  }
  return original;
}

async function performCalendarSync() {
  if (calendarSyncPromise) return calendarSyncPromise;
  const beforeFinalize = store.read();
  let current = finalizeExpiredTrash(beforeFinalize);
  if (syncBroadcastSignature(beforeFinalize) !== syncBroadcastSignature(current)) {
    current = store.write(current);
  } else {
    current = beforeFinalize;
  }
  if (!calendarSyncEnabled(current)) return current;

  calendarSyncPromise = (async () => {
    try {
      const result = await runCalendarBridge(calendarBridgeExecutablePath(), "sync", {
        settings: current.settings,
        tasks: current.tasks,
        pendingDeletes: current.sync?.pendingDeletes || [],
        pendingEventActions: current.sync?.pendingEventActions || []
      }, 30_000);
      const latest = store.read();
      const merged = mergeSyncResult(latest, result);
      const saved = store.write(merged);
      if (syncBroadcastSignature(latest) !== syncBroadcastSignature(saved)) sendDataChanged(saved);
      return saved;
    } catch (error) {
      const latest = store.read();
      latest.sync = {
        ...(latest.sync || {}),
        lastSyncError: error.message,
        warnings: []
      };
      const saved = store.write(latest);
      sendDataChanged(saved);
      throw error;
    } finally {
      calendarSyncPromise = null;
    }
  })();

  return calendarSyncPromise;
}

function scheduleCalendarSync(delay = 800) {
  clearTimeout(calendarSyncDebounce);
  if (!calendarSyncEnabled(store.read())) return;
  calendarSyncDebounce = setTimeout(() => {
    performCalendarSync().catch((error) => console.error("Calendar sync:", error.message));
  }, delay);
}

function cleanExpiredTrash() {
  const current = store.read();
  const cleaned = finalizeExpiredTrash(current);
  const changed =
    cleaned.trash.length !== (current.trash || []).length ||
    cleaned.sync.pendingDeletes.length !== (current.sync?.pendingDeletes || []).length;
  if (!changed) return;
  const saved = store.write(cleaned);
  sendDataChanged(saved);
  scheduleCalendarSync(0);
}

function sendNativeVoiceEvent(payload) {
  voiceWindow?.webContents.send("voice:native-event", payload);
}

function cleanUpVoiceSession(session) {
  if (!session) return;
  // No more poll timer or temp file (now using direct stdout streaming)
  if (voiceRecognizerSession === session) voiceRecognizerSession = null;
}

function stopNativeVoiceRecognition() {
  const session = voiceRecognizerSession;
  if (!session) return;
  session.stopped = true;
  if (session.helperPid) {
    try {
      process.kill(session.helperPid, "SIGTERM");
    } catch {}
  }
  try {
    session.process?.kill("SIGTERM");
  } catch {}
  cleanUpVoiceSession(session);
}

function startNativeVoiceRecognition(isSilenceRetry = false) {
  stopNativeVoiceRecognition();
  const executable = voiceRecognizerExecutablePath();
  if (!fs.existsSync(executable)) {
    sendNativeVoiceEvent({
      type: "error",
      message: "找不到語音辨識元件，請重新安裝貼身小秘書。"
    });
    return false;
  }

  // Spawn the native binary directly and stream events over stdout (no temp file, no 50ms polling)
  const preferOnDevice = Boolean(store.read().settings.voicePrivacyMode);
  const child = spawn(executable, preferOnDevice ? ["--on-device"] : [], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const session = {
    process: child,
    bufferedOutput: "",
    receivedTerminalEvent: false,
    helperPid: null,
    stopped: false
  };
  voiceRecognizerSession = session;

  child.stdout.on("data", (chunk) => {
    if (!voiceRecognizerSession || voiceRecognizerSession !== session) return;
    session.bufferedOutput += chunk.toString("utf8");
    session.bufferedOutput = processJsonLines(session.bufferedOutput, (payload) => {
      if (payload.pid) session.helperPid = Number(payload.pid);
      if (payload.type === "final" || payload.type === "error") {
        session.receivedTerminalEvent = true;
      }
      sendNativeVoiceEvent(payload);
    });
  });

  child.stderr.on("data", (chunk) => writeVoiceHelperLog(chunk.toString("utf8").trim()));

  child.on("error", (error) => {
    writeDiagnostic("voice-helper-error", error);
    cleanUpVoiceSession(session);
    sendNativeVoiceEvent({ type: "error", message: "無法啟動 macOS 語音辨識。" });
  });

  child.on("exit", (code, signal) => {
    writeVoiceHelperLog(`exit code=${code} signal=${signal || ""}`);
    // Process any remaining buffered lines using shared helper
    if (session.bufferedOutput.trim()) {
      session.bufferedOutput = processJsonLines(session.bufferedOutput, (payload) => {
        if (payload.pid) session.helperPid = Number(payload.pid);
        if (payload.type === "final" || payload.type === "error") {
          session.receivedTerminalEvent = true;
        }
        sendNativeVoiceEvent(payload);
      });
    }
    const shouldReportFailure = !session.stopped && !session.receivedTerminalEvent;
    cleanUpVoiceSession(session);
    if (code === 7 && !session.stopped && !isSilenceRetry && voiceWindow?.isVisible()) {
      setTimeout(() => startNativeVoiceRecognition(true), 400);
      return;
    }
    if (shouldReportFailure) {
      const messages = {
        2: "需要允許語音辨識權限。",
        3: "需要允許麥克風權限。",
        4: "macOS 語音辨識目前無法使用。",
        5: "無法啟動麥克風。",
        6: "這次沒有辨識到語音，請再試一次。",
        7: "沒有聽到聲音，請再說一次。"
      };
      sendNativeVoiceEvent({
        type: "error",
        message: messages[code] || "macOS 語音元件啟動失敗，請再試一次。"
      });
    }
  });

  return true;
}

// 啟動時先請求麥克風／語音辨識權限（在主視窗前面跳，避免之後被浮動語音視窗擋住對話框）。
// 已授權時 macOS 會直接回快取、不再跳窗，所以每次啟動呼叫都安全。
function warmUpVoicePermission() {
  try {
    const executable = voiceRecognizerExecutablePath();
    if (!fs.existsSync(executable)) return;
    const child = spawn(executable, ["--request-permission"], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref?.();
  } catch {}
}

function voiceShortcutCallback() {
  showVoiceWindow();
}

function validAccelerator(value) {
  return typeof value === "string" && value.length <= 80 && /^(?=.*(?:Command|CommandOrControl|Control|Alt|Option|Shift|Super|Meta|CmdOrCtrl|F\d+))[-+A-Za-z0-9]+$/i.test(value);
}

function registerVoiceShortcut(preferred = store?.read().settings.voiceShortcut || "Alt+Space") {
  const previousShortcut = voiceShortcut && globalShortcut.isRegistered(voiceShortcut) ? voiceShortcut : "";
  const candidates = [...new Set([
    validAccelerator(preferred) ? preferred : "Alt+Space",
    "Alt+Space",
    "CommandOrControl+Shift+Space"
  ])];
  for (const accelerator of candidates) {
    if (accelerator === previousShortcut) {
      voiceShortcut = accelerator;
      return;
    }
    let registered = false;
    try { registered = globalShortcut.register(accelerator, voiceShortcutCallback); } catch {}
    if (registered) {
      if (previousShortcut && previousShortcut !== accelerator) globalShortcut.unregister(previousShortcut);
      voiceShortcut = accelerator;
      if (accelerator !== preferred) {
        new Notification({
          title: "快捷鍵已變更",
          body: `${preferred} 目前無法使用，暫時改用 ${accelerator} 呼叫。若仍沒反應，請檢查 ChatGPT 等 App 的快捷鍵設定。`
        }).show();
      }
      return;
    }
  }
  voiceShortcut = "";
  console.error("Unable to register a global voice shortcut.");
  new Notification({ title: "快捷鍵無法使用", body: "請用選單列圖示呼叫，並檢查其他 App 的快捷鍵設定。" }).show();
}

function retryPreferredShortcut() {
  if ((store?.read().settings.voiceShortcut || "Alt+Space") !== "Alt+Space") return;
  if (voiceShortcut === "Alt+Space") return;
  if (!globalShortcut.register("Alt+Space", voiceShortcutCallback)) return;
  if (voiceShortcut) globalShortcut.unregister(voiceShortcut);
  voiceShortcut = "Alt+Space";
  buildTray();
  voiceWindow?.webContents.send("shortcut-changed", shortcutLabel());
}

function shortcutLabel() {
  if (voiceShortcut === "Alt+Space") return "⌥ Space";
  if (voiceShortcut === "CommandOrControl+Shift+Space") return "⌘ ⇧ Space";
  if (voiceShortcut) return voiceShortcut.replace(/CommandOrControl|CmdOrCtrl/g, "⌘").replace(/Alt|Option/g, "⌥").replace(/Shift/g, "⇧").replace(/Control/g, "⌃").replaceAll("+", " ");
  return "選單列";
}

function rebuildShortcut(preferred) {
  registerVoiceShortcut(preferred);
  buildTray();
  voiceWindow?.webContents.send("shortcut-changed", shortcutLabel());
  return { accelerator: voiceShortcut, label: shortcutLabel(), registered: Boolean(voiceShortcut) };
}

function buildTray() {
  const icon = getAppIcon();
  if (!icon) return;

  const assistantName = store.read().settings.assistantName || "小光";
  if (!tray) tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip("貼身小秘書");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `呼叫${assistantName}（${shortcutLabel()}）`, click: showVoiceWindow },
      { label: "隱藏語音視窗", click: hideVoiceWindow },
      { type: "separator" },
      { label: "打開今日行程", click: () => showMainWindow("today") },
      { label: "快速新增待辦", click: () => showMainWindow("tasks") },
      { label: "寫今天的日誌", click: () => showMainWindow("journal") },
      { label: "立即同步行事曆", click: () => performCalendarSync().catch(() => showMainWindow("settings")) },
      { type: "separator" },
      { label: "結束貼身小秘書", click: () => app.quit() }
    ])
  );
  tray.removeAllListeners("click");
  tray.on("click", showVoiceWindow);
}

function buildApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "貼身小秘書", submenu: [
      { label: "關於貼身小秘書", role: "about" },
      { type: "separator" },
      { label: "隱藏視窗", accelerator: "Command+Q", click: () => {
        mainWindow?.hide();
        hideVoiceWindow();
        if (!hasShownBackgroundNotification) {
          hasShownBackgroundNotification = true;
          new Notification({ title: "貼身小秘書仍在背景待命", body: `${shortcutLabel()} 隨時召喚；要完全結束請用選單列圖示。` }).show();
        }
      } },
      { label: "結束貼身小秘書", accelerator: "Command+Option+Q", click: () => app.quit() }
    ] },
    { label: "編輯", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }
    ] },
    { label: "視窗", submenu: [{ role: "minimize" }, { role: "close" }] }
  ]));
}

function sendDataChanged(data) {
  mainWindow?.webContents.send("data-changed", data);
  voiceWindow?.webContents.send("settings-changed", data.settings);
}

function getDueTasks(data, now = new Date()) {
  const today = dateKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;

  return data.tasks.filter((task) => {
    if (
      task.kind !== "reminder" ||
      task.completed ||
      task.date !== today ||
      !task.reminderTime
    ) {
      return false;
    }
    return task.reminderTime <= currentTime;
  });
}

function checkReminders() {
  const data = store.read();
  if (!data.settings.notificationsEnabled) return;

  const today = dateKey();
  const dueTasks = getDueTasks(data);
  const notifications = [];

  for (const task of dueTasks) {
    const key = `task:${task.id}:${task.date}:${task.reminderTime}`;
    if (!data.notifiedKeys.includes(key)) {
      notifications.push({ key, title: "待辦時間到了", body: task.title });
    }
  }

  const briefKey = `brief:${today}:${data.settings.dailyBriefTime}`;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  if (
    data.settings.dailyBriefTime &&
    currentTime >= data.settings.dailyBriefTime &&
    !data.notifiedKeys.includes(briefKey)
  ) {
    const reminderCount = data.tasks.filter(
      (task) => task.kind === "reminder" && task.date === today && !task.completed
    ).length;
    const eventCount = data.tasks.filter(
      (task) => eventOccursOnDate(task, today)
    ).length;
    const details = [
      reminderCount ? `${reminderCount} 件待辦` : "",
      eventCount ? `${eventCount} 個行程` : ""
    ].filter(Boolean);
    notifications.push({
      key: briefKey,
      title: `${data.settings.assistantName || "小光"}的早安提醒`,
      body: details.length
        ? `今天有${details.join("、")}。`
        : "今天暫時沒有待辦或行程，好好安排自己的節奏。"
    });
  }

  if (!notifications.length) return;

  for (const item of notifications) {
    const notification = new Notification({
      title: item.title,
      body: item.body,
      icon: getAppIcon(),
      silent: false
    });
    notification.on("click", () => showMainWindow("today"));
    notification.show();
    data.notifiedKeys.push(item.key);
  }

  data.notifiedKeys = data.notifiedKeys.filter((key) => key.includes(today)).slice(-100);
  const saved = store.write(data);
  sendDataChanged(saved);
}

function registerIpc() {
  ipcMain.handle("data:get", () => store.read());
  ipcMain.handle("data:save", (_, data) => {
    const previous = store.read();
    if (Number(data?.revision) !== previous.revision) {
      return { ...previous, _saveConflict: true };
    }
    const saved = store.write(data);
    sendDataChanged(saved);
    scheduleCalendarSync();
    return saved;
  });
  ipcMain.handle("data:path", () => store.dataPath);
  ipcMain.handle("settings:login", (_, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled)
    });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("notification:test", () => {
    const notification = new Notification({
      title: "提醒功能正常",
      body: "之後有重要事項，我會像這樣提醒你。",
      icon: getAppIcon()
    });
    notification.on("click", () => showMainWindow("today"));
    notification.show();
    return true;
  });
  ipcMain.handle("window:open-main", (_, route) => {
    showMainWindow(ALLOWED_ROUTES.includes(route) ? route : "today");
    return true;
  });
  ipcMain.handle("voice:show", () => {
    showVoiceWindow();
    return true;
  });
  ipcMain.handle("voice:hide", () => {
    hideVoiceWindow();
    return true;
  });
  ipcMain.handle("voice:shortcut", () => shortcutLabel());
  ipcMain.handle("voice:shortcut-set", (_, accelerator) => {
    const preferred = String(accelerator || "").trim();
    if (!validAccelerator(preferred)) {
      return { registered: false, error: "快捷鍵格式不正確。" };
    }
    const current = store.read();
    current.settings.voiceShortcut = preferred;
    const saved = store.write(current);
    sendDataChanged(saved);
    return rebuildShortcut(preferred);
  });
  ipcMain.handle("voice:shortcut-test", () => new Promise((resolve) => {
    if (shortcutTestResolver) shortcutTestResolver(false);
    let finished = false;
    const finish = (triggered) => {
      if (finished) return;
      finished = true;
      shortcutTestResolver = null;
      resolve({ triggered, message: triggered ? "快捷鍵測試成功。" : "沒有收到快捷鍵；可能被其他 App 攔截。" });
    };
    shortcutTestResolver = finish;
    setTimeout(() => finish(false), 10_000);
  }));
  ipcMain.handle("voice:listen-start", () => startNativeVoiceRecognition());
  ipcMain.handle("voice:listen-stop", () => {
    stopNativeVoiceRecognition();
    return true;
  });
  ipcMain.handle("voice:process", async (_, transcript, voiceContext = {}) => {
    const conversationHistory = normalizeVoiceHistory(voiceContext);
    // 1) 解析：用最聰明可用的「大腦」把語音轉成結構化意圖（Claude → Ollama → null）
    const snapshot = store.read();
    const apiKey = secretStore.getSecret("claudeApiKey");
    let intent = null;
    let aiFallback = false;
    try {
      intent = await parseVoiceIntent(snapshot, transcript, snapshot.settings, apiKey, new Date(), conversationHistory);
    } catch (error) {
      console.warn("[voice] AI 解析失敗，改用規則式：", error.message);
      aiFallback = true;
      intent = null;
    }

    // 2) 重新讀取最新資料（避免上面 await 期間被其他寫入覆蓋造成丟資料）
    const current = store.read();

    // 3) 執行：AI 有結構化意圖就走獨立執行層；否則走離線規則式保底
    let result;
    const contextualFallback = contextFallbackResponse(conversationHistory, transcript);
    if (shouldUseDeterministicQuery(transcript, intent)) {
      result = handleVoiceCommand(current, transcript);
    } else if (intent && intent.action && intent.action !== "none") {
      result = applyIntent(current, { ...intent, _transcript: transcript });
    } else if (contextualFallback) {
      result = { data: current, response: contextualFallback };
    } else {
      result = handleVoiceCommand(current, transcript, new Date(), { requireAddConfirmation: aiFallback });
    }

    if (aiFallback) {
      result.response = `（AI 沒回應，我先用基本模式處理）${result.response || ""}`;
    }

    if (
      contextualFallback &&
      /要.*(確認|處理|什麼)|不確定|不太清楚|沒有聽懂/.test(result.response || "")
    ) {
      result.response = contextualFallback;
    }

    const mutation = calendarVoiceMutation(current, result.data);
    const didChangeData = persistedContentSignature(current) !== persistedContentSignature(result.data);
    const saved = didChangeData ? store.write(result.data) : current;
    if (didChangeData) sendDataChanged(saved);

    let response = result.response;
    let finalData = saved;
    let route = ALLOWED_ROUTES.includes(result.route) ? result.route : null;
    if (mutation) {
      if (!saved.settings.calendarSyncEnabled || !saved.settings.calendarId) {
        response = calendarNotReadyResponse(response, mutation, saved);
        route ||= "settings";
      } else {
        try {
          finalData = await withCalendarVoiceTimeout(performCalendarSync());
          response = naturalCalendarResponse(response, mutation, finalData);
        } catch (error) {
          response = error instanceof CalendarSyncTimeoutError
            ? `${response} 同步比較久，我先記下來，稍後會在背景完成。`
            : `${response} 但同步到 Google 或 Apple 行事曆時失敗：${error.message}`;
          finalData = store.read();
        }
      }
    } else if (didChangeData) {
      scheduleCalendarSync();
    }

    if (route && intent?.action === "navigate") showMainWindow(route);
    else if (route) mainWindow?.showInactive();
    return {
      response,
      hide: Boolean(result.hide),
      settings: finalData.settings
    };
  });
  ipcMain.handle("voice:test", () => {
    showVoiceWindow();
    voiceWindow?.webContents.send("voice:preview");
    return true;
  });
  ipcMain.handle("calendar:status", () => runCalendarBridge(calendarBridgeExecutablePath(), "status", null, 15_000));
  ipcMain.handle("calendar:request-access", () => requestCalendarAccess());
  ipcMain.handle("calendar:sync", () => performCalendarSync());
  ipcMain.handle("calendar:open-accounts", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension")
  );
  ipcMain.handle("shell:show-data", () => shell.showItemInFolder(store.dataPath));


  ipcMain.handle("ai:test-connection", async () => {
    // Placeholder - will be replaced by real implementation in aiVoice module
    const current = store.read();
    if (!current.settings.aiVoiceEnabled) {
      return { success: false, error: "AI 語音理解未啟用" };
    }
    try {
      // Simple fetch test to Ollama /api/tags
      const url = current.settings.ollamaUrl || "http://localhost:11434";
      const res = await fetch(`${url.replace(/\/$/, "")}/api/tags`, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      return { success: true, model: current.settings.aiModel, availableModels: models };
    } catch (e) {
      return { success: false, error: e.message || "無法連線到 Ollama" };
    }
  });

  // ---- Claude API 金鑰（安全儲存，永不經由一般資料流到 renderer）----
  ipcMain.handle("ai:claude-status", () => ({
    hasKey: secretStore.hasSecret("claudeApiKey"),
    secure: secretStore.encryptionAvailable()
  }));
  ipcMain.handle("ai:set-claude-key", (_, key) => {
    const trimmed = typeof key === "string" ? key.trim() : "";
    const result = secretStore.setSecret("claudeApiKey", trimmed);
    return { ...result, hasKey: Boolean(trimmed) };
  });
  ipcMain.handle("ai:test-claude", async () => {
    const key = secretStore.getSecret("claudeApiKey");
    const current = store.read();
    return testClaude(key, current.settings.claudeModel);
  });
}

app.whenReady().then(() => {
  app.setName("貼身小秘書");
  if (process.platform === "darwin" && getAppIcon()) {
    app.dock.setIcon(getAppIcon());
  }

  store = createStore(app.getPath("userData"), {
    onRecovery: ({ restored }) => new Notification({
      title: "主資料檔損毀",
      body: restored
        ? "已從備份還原；損毀檔已保留為 .corrupt-*。"
        : "損毀檔已保留，但備份也無法讀取；目前以空白資料安全啟動。"
    }).show()
  });
  secretStore = createSecretStore(app.getPath("userData"));
  registerIpc();
  createMainWindow();
  createVoiceWindow();
  registerVoiceShortcut();
  buildTray();
  buildApplicationMenu();
  shortcutRetryTimer = setInterval(retryPreferredShortcut, 60_000);

  try {
    ensureCalendarBridgeAvailable();
  } catch (error) {
    writeDiagnostic("calendar-helper-load", error);
    new Notification({ title: "行事曆元件暫時無法載入", body: "其他功能仍可使用；詳細資訊已寫入診斷日誌。" }).show();
  }
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false;
    if (!details) return true;
    return details.mediaType === "audio" || details.mediaTypes?.includes("audio");
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isAudioRequest =
      permission === "media" &&
      (!details || details.mediaTypes?.includes("audio") || details.mediaType === "audio");
    callback(Boolean(isAudioRequest));
  });
  // 手動啟動時自動顯示主視窗；只有「登入自動啟動（openAsHidden）」時才維持背景待命
  const isLoginLaunch = app.getLoginItemSettings().openAtLogin && os.uptime() < 120;
  if (!isLoginLaunch) {
    showMainWindow("today");
  }
  // 在主視窗前面預先取得語音權限（避免日後被浮動語音視窗擋住授權對話框）
  setTimeout(warmUpVoicePermission, 1200);
  checkReminders();
  reminderTimer = setInterval(checkReminders, 30_000);
  calendarSyncTimer = setInterval(() => scheduleCalendarSync(0), 5 * 60_000);
  trashCleanupTimer = setInterval(cleanExpiredTrash, 30_000);
  scheduleCalendarSync(2_000);

  if (process.argv.includes("--calendar-access")) {
    showMainWindow("settings");
    setTimeout(async () => {
      try {
        const status = await requestCalendarAccess();
        mainWindow?.webContents.send("calendar-status-changed", status);
      } catch (error) {
        console.error("Calendar access:", error.message);
      }
    }, 700);
  }

  app.on("activate", () => showMainWindow("today"));
}).catch((error) => {
  writeDiagnostic("whenReady", error);
  try {
    new Notification({ title: "貼身小秘書啟動不完整", body: "正在嘗試自動重新啟動；詳細資訊已寫入診斷日誌。" }).show();
  } catch {}
  if (!process.argv.includes("--recovery-relaunch")) {
    app.relaunch({ args: [...process.argv.slice(1), "--recovery-relaunch"] });
  }
  isQuitting = true;
  app.exit(1);
});

app.on("second-instance", () => {
  showMainWindow("today");
});

app.on("before-quit", () => {
  isQuitting = true;
  clearInterval(reminderTimer);
  clearInterval(calendarSyncTimer);
  clearInterval(trashCleanupTimer);
  clearInterval(shortcutRetryTimer);
  clearTimeout(calendarSyncDebounce);
  stopNativeVoiceRecognition();
  try {
    store?.flush?.();
  } catch {}
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
