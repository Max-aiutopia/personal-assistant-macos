const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DATA = {
  revision: 0,
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
    voiceShortcut: "Alt+Space",
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

function createStore(userDataPath, { onRecovery } = {}) {
  const dataPath = path.join(userDataPath, "assistant-data.json");
  let cached = null;
  let writeTimer = null;
  let writeRetryCount = 0;
  const WRITE_DEBOUNCE_MS = 350;

  function normalize(parsed) {
    return {
      ...DEFAULT_DATA,
      ...parsed,
      revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
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
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    const tempPath = `${dataPath}.tmp`;
    const fd = fs.openSync(tempPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(data), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.copyFileSync(dataPath, `${dataPath}.bak`); } catch {}
    fs.renameSync(tempPath, dataPath);
    try {
      const directoryFd = fs.openSync(path.dirname(dataPath), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch {}
  }

  function scheduleWrite(data, delay = WRITE_DEBOUNCE_MS) {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        flushToDisk(data);
        writeRetryCount = 0;
      } catch (error) {
        console.error("Failed to persist assistant data:", error);
        writeRetryCount += 1;
        if (writeRetryCount <= 3) {
          scheduleWrite(cached || data, Math.min(4000, 500 * (2 ** writeRetryCount)));
        }
      }
    }, delay);
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
        try { fs.renameSync(dataPath, `${dataPath}.corrupt-${Date.now()}`); } catch {}
        try {
          const backup = JSON.parse(fs.readFileSync(`${dataPath}.bak`, "utf8"));
          cached = normalize(backup);
          try { onRecovery?.({ restored: true, corruptPath: `${dataPath}.corrupt-*` }); } catch {}
          return structuredClone(cached);
        } catch {}
        try { onRecovery?.({ restored: false, corruptPath: `${dataPath}.corrupt-*` }); } catch {}
      }
      cached = structuredClone(DEFAULT_DATA);
      return structuredClone(cached);
    }
  }

  function write(data) {
    // Update in-memory immediately (fast path for UI + voice commands)
    const previousRevision = Number.isInteger(cached?.revision) ? cached.revision : Number(data?.revision) || 0;
    cached = { ...normalize(data), revision: previousRevision + 1 };
    // Debounce actual disk write (many quick saves during journal typing or rapid voice commands will coalesce)
    scheduleWrite(cached);
    return structuredClone(cached);
  }

  function writeDurable(data) {
    const previous = cached ? structuredClone(cached) : read();
    const previousRevision = Number.isInteger(previous?.revision)
      ? previous.revision
      : Number(data?.revision) || 0;
    const candidate = { ...normalize(data), revision: previousRevision + 1 };
    const hadPendingWrite = Boolean(writeTimer);
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    try {
      flushToDisk(candidate);
      cached = candidate;
      writeRetryCount = 0;
      return structuredClone(cached);
    } catch (error) {
      cached = previous;
      if (hadPendingWrite) scheduleWrite(cached);
      throw error;
    }
  }

  function update(updater) {
    const current = read();
    return write(updater(current));
  }

  function flush({ throwOnError = false } = {}) {
    // Force immediate persist (useful before quit or explicit sync)
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (!cached) return true;
    try {
      flushToDisk(cached);
      writeRetryCount = 0;
      return true;
    } catch (error) {
      if (throwOnError) throw error;
      console.error("Failed to persist assistant data:", error);
      return false;
    }
  }

  return { read, write, writeDurable, update, dataPath, flush };
}

module.exports = { createStore, DEFAULT_DATA };
