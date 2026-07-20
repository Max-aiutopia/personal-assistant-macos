const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DATA = {
  tasks: [],
  trash: [],
  journal: {},
  settings: {
    assistantName: "小光",
    userName: "",
    dailyBriefTime: "09:00",
    notificationsEnabled: true,
    launchAtLogin: false,
    voiceReplyEnabled: true,
    voiceAutoListen: true,
    voiceAutoHide: true,
    calendarSyncEnabled: false,
    reminderSyncEnabled: false,
    calendarId: "",
    reminderListId: "",
    aiVoiceEnabled: false,
    aiModel: "qwen2.5:3b",
    ollamaUrl: "http://localhost:11434",
    voiceBrain: "rules",
    claudeModel: "claude-haiku-4-5",
    voicePrivacyMode: false
  },
  notifiedKeys: [],
  sync: {
    pendingDeletes: [],
    pendingEventActions: [],
    deletedExternalItems: [],
    lastSyncAt: "",
    lastEventSyncAt: "",
    lastReminderSyncAt: "",
    lastSyncError: "",
    warnings: []
  }
};

function createStore(userDataPath) {
  const dataPath = path.join(userDataPath, "assistant-data.json");
  let cached = null;
  let writeTimer = null;
  const WRITE_DEBOUNCE_MS = 350;

  function normalize(parsed) {
    return {
      ...DEFAULT_DATA,
      ...parsed,
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      trash: Array.isArray(parsed.trash) ? parsed.trash : [],
      journal: parsed.journal && typeof parsed.journal === "object" ? parsed.journal : {},
      notifiedKeys: Array.isArray(parsed.notifiedKeys) ? parsed.notifiedKeys : [],
      sync: {
        ...DEFAULT_DATA.sync,
        ...(parsed.sync || {}),
        pendingDeletes: Array.isArray(parsed.sync?.pendingDeletes) ? parsed.sync.pendingDeletes : [],
        pendingEventActions: Array.isArray(parsed.sync?.pendingEventActions)
          ? parsed.sync.pendingEventActions
          : [],
        deletedExternalItems: Array.isArray(parsed.sync?.deletedExternalItems)
          ? parsed.sync.deletedExternalItems
          : [],
        warnings: Array.isArray(parsed.sync?.warnings) ? parsed.sync.warnings : []
      }
    };
  }

  function flushToDisk(data) {
    try {
      fs.mkdirSync(path.dirname(dataPath), { recursive: true });
      const tempPath = `${dataPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tempPath, dataPath);
    } catch (error) {
      console.error("Failed to persist assistant data:", error);
    }
  }

  function scheduleWrite(data) {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushToDisk(data);
    }, WRITE_DEBOUNCE_MS);
  }

  function read() {
    if (cached) {
      return structuredClone(cached);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
      cached = normalize(parsed);
      return structuredClone(cached);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Failed to read assistant data:", error);
      }
      cached = structuredClone(DEFAULT_DATA);
      return structuredClone(cached);
    }
  }

  function write(data) {
    // Update in-memory immediately (fast path for UI + voice commands)
    cached = normalize(data);
    // Debounce actual disk write (many quick saves during journal typing or rapid voice commands will coalesce)
    scheduleWrite(cached);
    return data;
  }

  function update(updater) {
    const current = read();
    return write(updater(current));
  }

  function flush() {
    // Force immediate persist (useful before quit or explicit sync)
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (cached) flushToDisk(cached);
  }

  return { read, write, update, dataPath, flush };
}

module.exports = { createStore, DEFAULT_DATA };
