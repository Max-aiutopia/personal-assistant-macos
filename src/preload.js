const { contextBridge, ipcRenderer } = require("electron");
const { dateKey, addDays } = require("./utils");

contextBridge.exposeInMainWorld("assistantAPI", {
  getData: () => ipcRenderer.invoke("data:get"),
  saveData: (data) => ipcRenderer.invoke("data:save", data),
  getDataPath: () => ipcRenderer.invoke("data:path"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("settings:login", enabled),
  testNotification: () => ipcRenderer.invoke("notification:test"),
  openMain: (route) => ipcRenderer.invoke("window:open-main", route),
  showVoice: () => ipcRenderer.invoke("voice:show"),
  hideVoice: () => ipcRenderer.invoke("voice:hide"),
  getVoiceShortcut: () => ipcRenderer.invoke("voice:shortcut"),
  startVoiceListening: () => ipcRenderer.invoke("voice:listen-start"),
  stopVoiceListening: () => ipcRenderer.invoke("voice:listen-stop"),
  processVoice: (transcript, context) => ipcRenderer.invoke("voice:process", transcript, context),
  testVoice: () => ipcRenderer.invoke("voice:test"),
  testAIConnection: () => ipcRenderer.invoke("ai:test-connection"),
  getClaudeStatus: () => ipcRenderer.invoke("ai:claude-status"),
  setClaudeKey: (key) => ipcRenderer.invoke("ai:set-claude-key", key),
  testClaude: () => ipcRenderer.invoke("ai:test-claude"),
  checkForUpdate: () => ipcRenderer.invoke("app:check-update"),
  getCalendarStatus: () => ipcRenderer.invoke("calendar:status"),
  requestCalendarAccess: () => ipcRenderer.invoke("calendar:request-access"),
  syncCalendars: () => ipcRenderer.invoke("calendar:sync"),
  openInternetAccounts: () => ipcRenderer.invoke("calendar:open-accounts"),
  showDataFile: () => ipcRenderer.invoke("shell:show-data"),
  dateUtils: { dateKey, addDays },
  onDataChanged: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("data-changed", handler);
    return () => ipcRenderer.removeListener("data-changed", handler);
  },
  onNavigate: (callback) => {
    const handler = (_, route) => callback(route);
    ipcRenderer.on("navigate", handler);
    return () => ipcRenderer.removeListener("navigate", handler);
  },
  onCalendarStatusChanged: (callback) => {
    const handler = (_, status) => callback(status);
    ipcRenderer.on("calendar-status-changed", handler);
    return () => ipcRenderer.removeListener("calendar-status-changed", handler);
  },
  onVoiceStart: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("voice:start", handler);
    return () => ipcRenderer.removeListener("voice:start", handler);
  },
  onVoiceStop: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("voice:stop", handler);
    return () => ipcRenderer.removeListener("voice:stop", handler);
  },
  onVoicePreview: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("voice:preview", handler);
    return () => ipcRenderer.removeListener("voice:preview", handler);
  },
  onNativeVoiceEvent: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on("voice:native-event", handler);
    return () => ipcRenderer.removeListener("voice:native-event", handler);
  }
});
