const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
  const handler = (_, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("assistantAPI", {
  getData: () => ipcRenderer.invoke("data:get"),
  hideVoice: () => ipcRenderer.invoke("voice:hide"),
  getVoiceShortcut: () => ipcRenderer.invoke("voice:shortcut"),
  startVoiceListening: () => ipcRenderer.invoke("voice:listen-start"),
  stopVoiceListening: () => ipcRenderer.invoke("voice:listen-stop"),
  processVoice: (transcript, context) => ipcRenderer.invoke("voice:process", transcript, context),
  onVoiceStart: (callback) => on("voice:start", callback),
  onVoiceStop: (callback) => on("voice:stop", callback),
  onVoicePreview: (callback) => on("voice:preview", callback),
  onNativeVoiceEvent: (callback) => on("voice:native-event", callback),
  onVoiceShortcutChanged: (callback) => on("shortcut-changed", callback),
  onSettingsChanged: (callback) => on("settings-changed", callback)
});
