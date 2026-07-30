const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { waitForFile, runDirectBinary } = require("./nativeBridge");
const { addDays, dateKey, eventEndDate } = require("./utils");

function parseBridgeResult(output) {
  const lines = output.trim().split("\n").filter(Boolean);
  const result = JSON.parse(lines.at(-1) || "{}");
  if (!result.ok) throw new Error(result.error || "行事曆同步失敗。");
  return result;
}

async function runCalendarApp(appPath, command, payload, timeoutMs) {
  const runId = crypto.randomUUID();
  const resultPath = path.join(os.tmpdir(), `personal-assistant-calendar-${runId}.json`);
  const inputPath = payload
    ? path.join(os.tmpdir(), `personal-assistant-calendar-${runId}-input.json`)
    : "";
  if (payload) fs.writeFileSync(inputPath, JSON.stringify(payload), "utf8");

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/open",
        ["-n", appPath, "--args", command, resultPath, ...(inputPath ? [inputPath] : [])],
        { stdio: "ignore" }
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`無法啟動行事曆同步 App，代碼 ${code}。`));
      });
    });
    await waitForFile(resultPath, timeoutMs || 30_000);
    return parseBridgeResult(fs.readFileSync(resultPath, "utf8"));
  } finally {
    fs.rmSync(resultPath, { force: true });
    if (inputPath) fs.rmSync(inputPath, { force: true });
  }
}

function runCalendarBridge(target, command, payload, timeoutMs = 30_000) {
  if (target.endsWith(".app")) return runCalendarApp(target, command, payload, timeoutMs);

  // Direct binary path - unified with voice streaming (stdout)
  return runDirectBinary(target, [command], payload, timeoutMs).then(result => {
    if (!result.ok) {
      throw new Error(result.error || "行事曆同步失敗。");
    }
    return result;
  });
}

function syncScope(data = {}) {
  const settings = data.settings || {};
  return {
    calendarSyncEnabled: Boolean(settings.calendarSyncEnabled),
    reminderSyncEnabled: Boolean(settings.reminderSyncEnabled),
    calendarId: settings.calendarId || "",
    reminderListId: settings.reminderListId || ""
  };
}

function sameSyncScope(startedData, latestData) {
  return JSON.stringify(syncScope(startedData)) === JSON.stringify(syncScope(latestData));
}

function mergeSyncResultIfCurrent(startedData, latestData, result) {
  if (!sameSyncScope(startedData, latestData)) {
    return { data: structuredClone(latestData), stale: true };
  }
  return { data: mergeSyncResult(latestData, result), stale: false };
}

function externalKey(external) {
  if (!external?.id || !external?.type) return "";
  return `${external.type}:${external.id}`;
}

function stableExternalItemKey(item) {
  const external = item?.external || item;
  if (!external?.id || !external?.type) return "";
  return [external.type, external.calendarId || "", external.id].join(":");
}

function recurringEventBaseId(external) {
  if (external?.type !== "event" || !external.id) return "";
  return external.id.replace(/\/RID=\d+$/, "");
}

function syncedItemKey(item) {
  const external = item?.external || item;
  const key = externalKey(external);
  if (!key || external.type !== "event") return key;
  return [
    "event",
    external.calendarId || "",
    recurringEventBaseId(external),
    item.date || "",
    item.reminderTime || ""
  ].join(":");
}

function syncedTaskKey(task) {
  const key = syncedItemKey(task);
  if (!key) return `local:${task.id}`;
  return key;
}

function eventActionKey(action) {
  const externalId = action?.externalId || action?.external?.id || action?.id || "";
  return `${action?.action || ""}:${externalId || action?.localId || ""}`;
}

function syncWindow(result, now) {
  return {
    eventsStart: result.syncWindow?.eventsStart || dateKey(addDays(now, -30)),
    eventsEnd: result.syncWindow?.eventsEnd || dateKey(addDays(now, 365))
  };
}

function eventWithinSyncWindow(task, window) {
  const start = task.date || "";
  if (!start) return false;
  const end = eventEndDate(task) || start;
  return start <= window.eventsEnd && end >= window.eventsStart;
}

function selectedExternalCalendarId(data, type) {
  return type === "event" ? data.settings?.calendarId || "" : data.settings?.reminderListId || "";
}

function isSyncedExternalTaskInScope(task, data, result, window) {
  const external = task.external || {};
  if (external.provider !== "eventkit" || !external.id || !external.type) return false;

  if (external.type === "event") {
    if (!result.synced?.events) return false;
    const selectedId = selectedExternalCalendarId(data, "event");
    if (!selectedId || external.calendarId !== selectedId) return false;
    return eventWithinSyncWindow(task, window);
  }

  if (external.type === "reminder") {
    if (!result.synced?.reminders) return false;
    const selectedId = selectedExternalCalendarId(data, "reminder");
    return Boolean(selectedId && external.calendarId === selectedId);
  }

  return false;
}

function preferSyncedTask(current, candidate) {
  const currentIsOccurrence = /\/RID=\d+$/.test(current.external?.id || "");
  const candidateIsOccurrence = /\/RID=\d+$/.test(candidate.external?.id || "");
  if (currentIsOccurrence !== candidateIsOccurrence) {
    return candidateIsOccurrence ? candidate : current;
  }

  const currentModified = Date.parse(current.updatedAt || current.createdAt || 0);
  const candidateModified = Date.parse(candidate.updatedAt || candidate.createdAt || 0);
  return candidateModified > currentModified ? candidate : current;
}

function dedupeSyncedTasks(tasks) {
  const output = [];
  const positions = new Map();
  for (const task of tasks || []) {
    const key = syncedTaskKey(task);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, output.length);
      output.push(task);
      continue;
    }
    output[position] = preferSyncedTask(output[position], task);
  }
  return output;
}

function importedTaskId(item) {
  const hash = crypto
    .createHash("sha1")
    .update(stableExternalItemKey(item))
    .digest("hex")
    .slice(0, 14);
  return `eventkit-${hash}`;
}

function deletionRecord(task, deletedAt = new Date().toISOString()) {
  return {
    id: task.external.id,
    type: task.external.type,
    calendarId: task.external.calendarId || "",
    title: task.title || "",
    date: task.date || "",
    reminderTime: task.reminderTime || "",
    endTime: task.endTime || "",
    deletedAt
  };
}

function enqueueDeletedTasks(previous, next) {
  const nextIds = new Set((next.tasks || []).map((task) => task.id));
  const trashedIds = new Set((next.trash || []).map((entry) => entry.task?.id).filter(Boolean));
  const pending = [...(next.sync?.pendingDeletes || [])];
  const known = new Set(pending.map(stableExternalItemKey));
  const deletedExternalItems = [...(next.sync?.deletedExternalItems || [])];
  const knownDeleted = new Set(deletedExternalItems.map(stableExternalItemKey));
  const deletedAt = new Date().toISOString();

  for (const task of previous.tasks || []) {
    if (
      nextIds.has(task.id) ||
      trashedIds.has(task.id) ||
      task.external?.provider !== "eventkit"
    ) {
      continue;
    }
    const key = stableExternalItemKey(task);
    if (!key) continue;
    const deletion = deletionRecord(task, deletedAt);
    if (!known.has(key)) {
      pending.push(deletion);
      known.add(key);
    }
    if (!knownDeleted.has(key)) {
      deletedExternalItems.push(deletion);
      knownDeleted.add(key);
    }
  }

  return {
    ...next,
    sync: {
      ...(next.sync || {}),
      pendingDeletes: pending,
      deletedExternalItems
    }
  };
}

function finalizeExpiredTrash(inputData, now = new Date()) {
  const data = structuredClone(inputData);
  data.trash = Array.isArray(data.trash) ? data.trash : [];
  data.sync = data.sync || {};
  const pending = [...(data.sync.pendingDeletes || [])];
  const deletedExternalItems = [...(data.sync.deletedExternalItems || [])];
  const knownPending = new Set(pending.map(stableExternalItemKey));
  const knownDeleted = new Set(deletedExternalItems.map(stableExternalItemKey));
  const remaining = [];

  for (const entry of data.trash) {
    if (Date.parse(entry.expiresAt || 0) > now.getTime()) {
      remaining.push(entry);
      continue;
    }
    const task = entry.task;
    if (task?.external?.provider !== "eventkit") continue;
    const deletion = deletionRecord(task, entry.deletedAt || now.toISOString());
    const key = stableExternalItemKey(deletion);
    if (!knownPending.has(key)) {
      pending.push(deletion);
      knownPending.add(key);
    }
    if (!knownDeleted.has(key)) {
      deletedExternalItems.push(deletion);
      knownDeleted.add(key);
    }
  }

  data.trash = remaining;
  data.sync.pendingDeletes = pending;
  data.sync.deletedExternalItems = deletedExternalItems;
  return data;
}

function mergeSyncResult(inputData, result, now = new Date()) {
  const data = structuredClone(inputData);
  data.sync = data.sync || {};
  data.tasks = dedupeSyncedTasks(Array.isArray(data.tasks) ? data.tasks : []);
  const tombstoneCutoff = now.getTime() - 30 * 24 * 60 * 60 * 1_000;
  data.sync.deletedExternalItems = (data.sync.deletedExternalItems || []).filter((item) => {
    const deletedAt = Date.parse(item.deletedAt || 0);
    return !deletedAt || deletedAt >= tombstoneCutoff;
  });
  const deletedKeys = new Set([
    ...data.sync.deletedExternalItems.map(stableExternalItemKey),
    ...(data.sync.pendingDeletes || []).map(stableExternalItemKey),
    ...(data.trash || []).map((entry) => stableExternalItemKey(entry.task || {}))
  ]);

  const byLocalId = new Map(data.tasks.map((task) => [task.id, task]));
  for (const link of result.links || []) {
    const task = byLocalId.get(link.localId);
    if (task && link.external) task.external = link.external;
  }

  const byExternal = new Map();
  const byStableExternal = new Map();
  for (const task of data.tasks) {
    const key = syncedTaskKey(task);
    if (key) byExternal.set(key, task);
    const stableKey = stableExternalItemKey(task);
    if (stableKey) byStableExternal.set(stableKey, [...(byStableExternal.get(stableKey) || []), task]);
  }

  const remoteStableCounts = new Map();
  for (const item of result.externalItems || []) {
    const stableKey = stableExternalItemKey(item);
    remoteStableCounts.set(stableKey, (remoteStableCounts.get(stableKey) || 0) + 1);
  }
  const usedIds = new Set(data.tasks.map((task) => task.id));

  for (const item of result.externalItems || []) {
    const key = syncedItemKey(item);
    const stableKey = stableExternalItemKey(item);
    if (!key || deletedKeys.has(stableKey)) continue;
    let task = byExternal.get(key);
    if (!task && remoteStableCounts.get(stableKey) === 1) {
      const candidates = byStableExternal.get(stableKey) || [];
      if (candidates.length === 1) task = candidates[0];
    }
    if (!task) {
      const baseId = importedTaskId(item);
      let id = baseId;
      if (usedIds.has(id)) {
        const occurrenceSuffix = crypto.createHash("sha1").update(key).digest("hex").slice(0, 8);
        id = `${baseId}-${occurrenceSuffix}`;
      }
      task = {
        id,
        category: item.kind === "event" ? "工作" : "其他",
        createdAt: item.updatedAt || now.toISOString()
      };
      data.tasks.push(task);
      usedIds.add(id);
      byExternal.set(key, task);
    }

    const localModified = Date.parse(task.updatedAt || task.createdAt || 0);
    const remoteModified = Date.parse(item.updatedAt || 0);
    if (localModified && remoteModified && localModified > remoteModified + 2_000) {
      task.external = item.external;
      if (!task.responseStatus && item.responseStatus) task.responseStatus = item.responseStatus;
      continue;
    }

    Object.assign(task, {
      title: item.title,
      date: item.date,
      reminderTime: item.reminderTime || "",
      endDate: item.endDate || "",
      endTime: item.endTime || "",
      isAllDay: Boolean(item.isAllDay),
      kind: item.kind || "reminder",
      notes: item.notes || "",
      completed: Boolean(item.completed),
      completedAt: item.completedAt || null,
      responseStatus: item.responseStatus || "",
      updatedAt: item.updatedAt || now.toISOString(),
      external: item.external
    });
  }

  const presentExternalKeys = new Set((result.externalItems || []).map(syncedItemKey).filter(Boolean));
  const window = syncWindow(result, now);
  data.tasks = data.tasks.filter((task) => {
    if (
      task.external?.provider === "eventkit" &&
      task.kind === "event" &&
      eventEndDate(task) < window.eventsStart
    ) return false;
    if (!isSyncedExternalTaskInScope(task, data, result, window)) return true;
    const key = syncedTaskKey(task);
    if (!key || deletedKeys.has(stableExternalItemKey(task))) return true;
    return presentExternalKeys.has(key);
  });

  const removed = new Set((result.removedDeletes || []).map(stableExternalItemKey));
  data.sync.pendingDeletes = (data.sync.pendingDeletes || []).filter(
    (item) => !removed.has(stableExternalItemKey(item))
  );
  const removedEventActions = new Set((result.removedEventActions || []).map(eventActionKey));
  data.sync.pendingEventActions = (data.sync.pendingEventActions || []).filter(
    (item) => !removedEventActions.has(eventActionKey(item))
  );
  data.sync.lastSyncAt = now.toISOString();
  if (result.synced?.events) data.sync.lastEventSyncAt = now.toISOString();
  if (result.synced?.reminders) data.sync.lastReminderSyncAt = now.toISOString();
  data.sync.lastSyncError = "";
  data.sync.warnings = result.warnings || [];
  data.tasks = dedupeSyncedTasks(data.tasks);
  return data;
}

module.exports = {
  dedupeSyncedTasks,
  mergeSyncResultIfCurrent,
  sameSyncScope,
  enqueueDeletedTasks,
  externalKey,
  stableExternalItemKey,
  finalizeExpiredTrash,
  mergeSyncResult,
  runCalendarBridge,
  syncedItemKey,
  eventActionKey
};
