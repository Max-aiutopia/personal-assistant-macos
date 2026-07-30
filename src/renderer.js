if (!window.assistantAPI) {
  console.error("初始化失敗：assistantAPI 未載入。");
}
const api = window.assistantAPI || null;
const { addDateDays, eventOccursOnDate, eventTimeLabel } = window.eventDates || {};
const dateUtils = (api && api.dateUtils) || {};

let data = {
  tasks: [],
  trash: [],
  journal: {},
  settings: {},
  notifiedKeys: []
};
let activeRoute = "today";
let taskFilter = "open";
let monthCursor = new Date(); // 月檢視目前顯示的月份（任一日即可）
let monthViewMode = "focus";
let selectedMood = "";
let journalAutosaveTimer = null;
let journalSaveInFlight = null;
let activeJournalDate = "";
const journalDrafts = new Map();
let undoCountdownTimer;
let calendarStatus = null;
let lastPersistedData = null;
let persistQueue = Promise.resolve();
let pendingPersistCount = 0;
let taskDialogReturnFocus = null;
let searchDialogReturnFocus = null;
let dayDialogReturnFocus = null;
let agendaDate = "";
let searchResultIds = [];
let searchActiveIndex = -1;
let monthActiveDate = "";
const SETTINGS_SECTIONS = ["general", "sync", "voice", "advanced"];
let activeSettingsSection = "general";
let settingsDirty = false;
let settingsHydrated = false;
const UNDO_WINDOW_MS = 10_000;
const ROUTES = ["today", "tasks", "week", "month", "journal", "settings"];

// Lightweight render batching for data-changed broadcasts (reduces redundant full re-renders)
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    renderPending = false;
    render();
  }, 0);
}

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function on(target, eventName, handler, options) {
  const element = typeof target === "string" ? $(target) : target;
  if (!element) {
    console.warn(`略過事件掛載：找不到 ${String(target)}`);
    return false;
  }
  try {
    element.addEventListener(eventName, handler, options);
    return true;
  } catch (error) {
    console.error(`事件掛載失敗：${String(target)} ${eventName}`, error);
    return false;
  }
}

function listenApi(methodName, callback) {
  if (!api || typeof api[methodName] !== "function") {
    console.warn(`略過 IPC 監聽：${methodName} 不可用`);
    return false;
  }
  try {
    api[methodName](callback);
    return true;
  } catch (error) {
    console.error(`IPC 監聽掛載失敗：${methodName}`, error);
    return false;
  }
}

function showRendererError(message, error) {
  console.error(message, error || "");
  document.body.dataset.initError = "true";
  const status = $("#renderer-status");
  if (status) {
    status.textContent = message;
    status.hidden = false;
  }
}

function showActionError(message, error) {
  console.error(message, error || "");
  const status = $("#renderer-status");
  if (!status) return;
  status.textContent = message;
  status.hidden = false;
  setTimeout(() => {
    if (document.body.dataset.initError !== "true" && status.textContent === message) {
      status.hidden = true;
    }
  }, 4500);
}

function localDateKey(date = new Date()) {
  if (dateUtils.dateKey) return dateUtils.dateKey(date);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    ? null
    : date;
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function formatDate(value, options = {}) {
  const date = typeof value === "string" ? parseDate(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "日期格式錯誤";
  return new Intl.DateTimeFormat("zh-TW", options).format(date);
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const isReminder = (task) => task.kind !== "event";
const isEvent = (task) => task.kind === "event";

function cloneData(value) {
  return structuredClone(value);
}

function withoutSaveConflict(value) {
  const clean = cloneData(value || {});
  delete clean._saveConflict;
  return clean;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replayArrayDelta(baseItems = [], intendedItems = [], latestItems = []) {
  if (typeof dateUtils.mergeArrayDelta === "function") {
    const result = dateUtils.mergeArrayDelta(baseItems, intendedItems, latestItems);
    if (result.conflicts.length) {
      throw new Error("同一事項同時被其他操作更新，請確認後再試一次。");
    }
    return result.items;
  }
  const baseById = new Map(baseItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const intendedById = new Map(intendedItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const deletedIds = new Set(
    [...baseById.keys()].filter((id) => !intendedById.has(id))
  );
  const changedById = new Map(
    [...intendedById.entries()].filter(([id, item]) => !baseById.has(id) || !valuesEqual(item, baseById.get(id)))
  );
  const appliedIds = new Set();
  const merged = latestItems
    .filter((item) => !item?.id || !deletedIds.has(item.id))
    .map((item) => {
      if (!item?.id || !changedById.has(item.id)) return item;
      appliedIds.add(item.id);
      return cloneData(changedById.get(item.id));
    });

  for (const item of intendedItems) {
    if (item?.id && changedById.has(item.id) && !appliedIds.has(item.id)) {
      merged.push(cloneData(item));
    }
  }
  return merged;
}

function replayObjectDelta(baseObject = {}, intendedObject = {}, latestObject = {}) {
  const merged = { ...latestObject };
  for (const key of Object.keys(baseObject)) {
    if (!Object.prototype.hasOwnProperty.call(intendedObject, key)) delete merged[key];
  }
  for (const [key, value] of Object.entries(intendedObject)) {
    if (!Object.prototype.hasOwnProperty.call(baseObject, key) || !valuesEqual(value, baseObject[key])) {
      merged[key] = cloneData(value);
    }
  }
  return merged;
}

function replayJournalDelta(baseJournal = {}, intendedJournal = {}, latestJournal = {}) {
  const merged = { ...latestJournal };
  for (const date of Object.keys(baseJournal)) {
    if (!Object.prototype.hasOwnProperty.call(intendedJournal, date)) delete merged[date];
  }
  for (const [date, entry] of Object.entries(intendedJournal)) {
    if (!Object.prototype.hasOwnProperty.call(baseJournal, date)) {
      merged[date] = cloneData(entry);
      continue;
    }
    if (!valuesEqual(entry, baseJournal[date])) {
      const patch = {};
      for (const field of ["done", "feeling", "tomorrow", "mood"]) {
        if (!valuesEqual(entry?.[field] || "", baseJournal[date]?.[field] || "")) {
          patch[field] = entry?.[field] || "";
        }
      }
      const merge = dateUtils.mergeJournalPatch || fallbackMergeJournalPatch;
      const result = merge(baseJournal[date], patch, latestJournal[date] || {});
      if (result.conflicts.length) {
        throw new Error("日誌內容同時被其他操作更新，請確認後再保存。");
      }
      merged[date] = result.entry;
    }
  }
  return merged;
}

function replayRendererDelta(base, intended, latest) {
  const merged = withoutSaveConflict(latest);
  merged.tasks = replayArrayDelta(base.tasks, intended.tasks, merged.tasks);
  merged.trash = replayArrayDelta(base.trash, intended.trash, merged.trash);
  merged.journal = replayJournalDelta(base.journal, intended.journal, merged.journal);
  merged.settings = replayObjectDelta(base.settings, intended.settings, merged.settings);
  return merged;
}

function rememberServerData(nextData) {
  if (!nextData || typeof nextData !== "object") {
    throw new Error("主程式回傳了無效資料。");
  }
  const clean = withoutSaveConflict(nextData);
  const nextRevision = Number(clean.revision) || 0;
  const currentRevision = Number(lastPersistedData?.revision) || 0;
  if (!lastPersistedData || nextRevision >= currentRevision) {
    lastPersistedData = cloneData(clean);
  }
  return cloneData(lastPersistedData || clean);
}

function applyJournalPatch(entry = {}, patch = {}) {
  return {
    ...entry,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

function overlayJournalDrafts(targetData) {
  const result = cloneData(targetData || data);
  result.journal = { ...(result.journal || {}) };
  for (const [date, draft] of journalDrafts) {
    result.journal[date] = applyJournalPatch(result.journal[date] || {}, draft.patch);
  }
  return result;
}

function journalStatusMessage(state) {
  if (state === "dirty") return "正在等待自動保存…";
  if (state === "saving") return "正在保存…";
  if (state === "error") return "保存失敗，內容仍保留";
  if (state === "conflict") return "內容同時被更新，請確認後再保存";
  return "所有內容都已保存";
}

function setJournalStatus(date, state = "saved", messageOverride = "") {
  const message = messageOverride || journalStatusMessage(state);
  const selectors = [];
  if (date === localDateKey()) selectors.push("#journal-save-status");
  if (date === activeJournalDate) selectors.push("#full-journal-status");
  for (const selector of selectors) {
    const status = $(selector);
    if (!status) continue;
    status.textContent = message;
    status.classList.toggle("saving", state === "dirty" || state === "saving");
    status.classList.toggle("saved", state === "saved");
    status.classList.toggle("error", state === "error");
    status.classList.toggle("conflict", state === "conflict");
    status.setAttribute("aria-live", state === "error" || state === "conflict" ? "assertive" : "polite");
  }
  if (date === activeJournalDate) {
    const button = $("#save-journal-button");
    if (button) {
      button.disabled = state === "saving";
      button.textContent = state === "conflict"
        ? "保留我的版本並保存"
        : state === "error"
          ? "重新嘗試"
          : "立即保存";
    }
  }
}

function getOrCreateJournalDraft(date) {
  let draft = journalDrafts.get(date);
  if (draft) return draft;
  const baseEntry =
    lastPersistedData?.journal?.[date] ||
    data.journal?.[date] ||
    {};
  draft = {
    baseEntry: cloneData(baseEntry),
    patch: {},
    version: 0,
    state: "saved",
    conflicts: []
  };
  journalDrafts.set(date, draft);
  return draft;
}

function scheduleJournalAutosave(delay = 650) {
  clearTimeout(journalAutosaveTimer);
  journalAutosaveTimer = setTimeout(() => {
    journalAutosaveTimer = null;
    void flushJournalAutosave();
  }, delay);
}

function stageJournalPatch(date, patch) {
  if (!parseDate(date) || !patch || typeof patch !== "object") return;
  const draft = getOrCreateJournalDraft(date);
  for (const [field, value] of Object.entries(patch)) {
    if (!["done", "feeling", "tomorrow", "mood"].includes(field)) continue;
    draft.patch[field] = String(value || "");
  }
  draft.version += 1;
  draft.state = "dirty";
  draft.conflicts = [];
  data.journal = { ...(data.journal || {}) };
  const serverEntry = lastPersistedData?.journal?.[date] || data.journal[date] || {};
  data.journal[date] = applyJournalPatch(serverEntry, draft.patch);
  setJournalStatus(date, "dirty");
  scheduleJournalAutosave();
}

function fallbackMergeJournalPatch(baseEntry, patch, remoteEntry) {
  const entry = { ...remoteEntry };
  const conflicts = [];
  for (const field of ["done", "feeling", "tomorrow", "mood"]) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const baseValue = String(baseEntry?.[field] || "");
    const localValue = String(patch[field] || "");
    const remoteValue = String(remoteEntry?.[field] || "");
    if (remoteValue === baseValue || remoteValue === localValue) entry[field] = localValue;
    else conflicts.push(field);
  }
  if (!conflicts.length) entry.updatedAt = new Date().toISOString();
  return { entry, conflicts };
}

async function flushJournalAutosave() {
  clearTimeout(journalAutosaveTimer);
  journalAutosaveTimer = null;
  if (journalSaveInFlight) return journalSaveInFlight;

  const snapshots = new Map(
    [...journalDrafts.entries()]
      .filter(([, draft]) => ["dirty", "error"].includes(draft.state))
      .map(([date, draft]) => [
        date,
        {
          baseEntry: cloneData(draft.baseEntry),
          patch: cloneData(draft.patch),
          version: draft.version
        }
      ])
  );
  if (!snapshots.size) return true;

  journalSaveInFlight = (async () => {
    const merge = dateUtils.mergeJournalPatch || fallbackMergeJournalPatch;
    const saveable = new Map();
    for (const [date, snapshot] of snapshots) {
      const currentDraft = journalDrafts.get(date);
      if (!currentDraft) continue;
      currentDraft.state = "saving";
      setJournalStatus(date, "saving");
      const remoteEntry = lastPersistedData?.journal?.[date] || {};
      const result = merge(snapshot.baseEntry, snapshot.patch, remoteEntry);
      if (result.conflicts.length) {
        currentDraft.state = "conflict";
        currentDraft.conflicts = result.conflicts;
        setJournalStatus(date, "conflict");
        continue;
      }
      saveable.set(date, result.entry);
    }

    if (!saveable.size) return false;
    data.journal = { ...(data.journal || {}) };
    for (const [date] of journalDrafts) {
      data.journal[date] = cloneData(lastPersistedData?.journal?.[date] || {});
    }
    for (const [date, entry] of saveable) data.journal[date] = cloneData(entry);

    try {
      await persist();
      for (const [date, snapshot] of snapshots) {
        const draft = journalDrafts.get(date);
        if (!draft || draft.state === "conflict") continue;
        if (draft.version === snapshot.version) {
          journalDrafts.delete(date);
          const time = new Intl.DateTimeFormat("zh-TW", {
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date());
          setJournalStatus(date, "saved", `已保存 ${time}`);
        } else {
          draft.baseEntry = cloneData(lastPersistedData?.journal?.[date] || {});
          draft.state = "dirty";
          setJournalStatus(date, "dirty");
        }
      }
      data = overlayJournalDrafts(lastPersistedData || data);
      scheduleRender();
      return true;
    } catch (error) {
      for (const [date] of saveable) {
        const draft = journalDrafts.get(date);
        if (!draft) continue;
        draft.state = "error";
        setJournalStatus(date, "error");
      }
      data = overlayJournalDrafts(lastPersistedData || data);
      scheduleJournalAutosave(3000);
      console.error("日誌自動保存失敗：", error);
      return false;
    }
  })().finally(() => {
    journalSaveInFlight = null;
    if ([...journalDrafts.values()].some((draft) => draft.state === "dirty")) {
      scheduleJournalAutosave();
    }
  });

  return journalSaveInFlight;
}

function flushJournalBeforeUnload(event) {
  if (!journalDrafts.size || !api?.saveDataSync) return;
  const merge = dateUtils.mergeJournalPatch || fallbackMergeJournalPatch;
  const candidate = cloneData(lastPersistedData || data);
  candidate.journal = { ...(candidate.journal || {}) };
  for (const [date, draft] of journalDrafts) {
    const remoteEntry = lastPersistedData?.journal?.[date] || {};
    const result = merge(draft.baseEntry, draft.patch, remoteEntry);
    if (result.conflicts.length) {
      draft.state = "conflict";
      setJournalStatus(date, "conflict");
      event.preventDefault();
      event.returnValue = "";
      return;
    }
    candidate.journal[date] = result.entry;
  }
  const saved = api.saveDataSync(candidate);
  if (saved?._saveError || saved?._saveConflict) {
    if (saved?._saveConflict) {
      rememberServerData(saved);
      data = overlayJournalDrafts(lastPersistedData || data);
    }
    for (const [date, draft] of journalDrafts) {
      draft.state = saved?._saveConflict ? "conflict" : "error";
      setJournalStatus(date, draft.state);
    }
    event.preventDefault();
    event.returnValue = "";
    return;
  }
  rememberServerData(saved);
  journalDrafts.clear();
}

async function persist() {
  if (!api || typeof api.saveData !== "function") throw new Error("資料儲存功能不可用。");

  const base = cloneData(lastPersistedData || data);
  const intended = withoutSaveConflict(data);
  pendingPersistCount += 1;

  const saveOperation = async () => {
    const latestKnown = cloneData(lastPersistedData || base);
    const candidate = Number(latestKnown.revision) === Number(base.revision)
      ? { ...intended, revision: latestKnown.revision }
      : replayRendererDelta(base, intended, latestKnown);
    let saved = await api.saveData(candidate);

    if (saved?._saveConflict) {
      const latest = withoutSaveConflict(saved);
      const retry = replayRendererDelta(base, intended, latest);
      saved = await api.saveData(retry);
      if (saved?._saveConflict) {
        throw new Error("資料同時被其他操作更新，請再試一次。");
      }
    }

    return rememberServerData(saved);
  };

  const queuedSave = persistQueue.then(saveOperation, saveOperation);
  persistQueue = queuedSave.catch(() => undefined);
  let succeeded = false;
  try {
    const saved = await queuedSave;
    succeeded = true;
    return saved;
  } finally {
    pendingPersistCount = Math.max(0, pendingPersistCount - 1);
    if (succeeded && pendingPersistCount === 0 && lastPersistedData) {
      data = overlayJournalDrafts(lastPersistedData);
      scheduleRender();
    }
  }
}

function deleteTask(task) {
  if (!task?.id) return false;
  data.tasks = data.tasks.filter((item) => item.id !== task.id);
  data.trash = [
    ...(data.trash || []),
    {
      id: uid(),
      task: structuredClone(task),
      deletedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + UNDO_WINDOW_MS).toISOString()
    }
  ];
  return true;
}

function eventResponseStatus(task) {
  return task?.responseStatus || task?.external?.responseStatus || "";
}

function responseStatusPill(task) {
  const status = eventResponseStatus(task);
  if (!["accepted", "needsAction", "tentative", "declined"].includes(status)) return "";
  const labels = {
    accepted: "已接受",
    needsAction: "待回覆",
    tentative: "暫定",
    declined: "已婉拒"
  };
  return `<span class="response-pill ${escapeHtml(status)}">${labels[status]}</span>`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "早安";
  if (hour < 17) return "午安";
  return "晚安";
}

function navigate(route, { focusHeading = false } = {}) {
  if (!ROUTES.includes(route)) route = "today";
  const previousRoute = activeRoute;
  const routeChanged = activeRoute !== route;
  if (routeChanged && ["today", "journal"].includes(previousRoute)) {
    void flushJournalAutosave();
  }
  activeRoute = route;
  api?.setActiveRoute?.(route);
  $$(".nav-item").forEach((button) => {
    const isActive = button.dataset.route === route;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".page").forEach((page) => page.classList.toggle("active", page.dataset.page === route));

  const titles = {
    today: `${greeting()}${data.settings.userName ? `，${data.settings.userName}` : ""}，今天也一起加油`,
    tasks: "待辦事項",
    week: "明天與本週",
    month: "本月行事曆",
    journal: "每日記錄",
    settings: "設定"
  };
  $("#page-title").textContent = titles[route] || titles.today;
  $("#quick-add-button").style.display = route === "settings" ? "none" : "";
  if (routeChanged) {
    const content = $(".content");
    if (content) content.scrollTop = 0;
  }

  if (route === "journal") loadJournalEditor($("#journal-date").value || localDateKey());
  if (route === "settings") {
    refreshClaudeStatus();
    refreshCalendarStatus();
  }
  render();
  if (focusHeading) {
    requestAnimationFrame(() => $("#page-title")?.focus({ preventScroll: true }));
  }
}

function taskRow(task) {
  const dateLabel =
    task.date === localDateKey()
      ? "今天"
      : task.date === localDateKey(addDays(new Date(), 1))
        ? "明天"
        : formatDate(task.date, { month: "numeric", day: "numeric", weekday: "short" });
  return `
    <div class="task-row ${task.completed ? "completed" : ""} ${!task.completed && task.date < localDateKey() ? "overdue" : ""}" data-task-id="${task.id}">
      <button
        class="task-check"
        data-action="toggle"
        title="${task.completed ? "標示未完成" : "標示完成"}"
        aria-label="${task.completed ? "將" : "將"}「${escapeHtml(task.title)}」標示為${task.completed ? "未完成" : "完成"}"
      >
        ${task.completed ? "✓" : ""}
      </button>
      <button class="task-body-button" data-action="edit" aria-label="編輯「${escapeHtml(task.title)}」">
        <span class="task-title">${escapeHtml(task.title)}</span>
        <span class="task-meta">
          <span class="category-dot" data-category="${escapeHtml(task.category)}"></span>
          ${task.kind === "event" ? "行程" : "待辦"} · ${escapeHtml(task.category || "其他")} · ${dateLabel}${task.reminderTime ? ` · ${task.reminderTime}` : ""}
          ${task.endTime ? `–${task.endTime}` : ""}
          ${task.external?.source ? ` · ${escapeHtml(task.external.source)}` : ""}
          ${isEvent(task) ? responseStatusPill(task) : ""}
          ${task.notes ? ` · ${escapeHtml(task.notes)}` : ""}
        </span>
      </button>
      <div class="task-menu">
        <button data-action="delete" title="刪除" aria-label="刪除「${escapeHtml(task.title)}」">×</button>
      </div>
    </div>
  `;
}

function eventRow(task, displayDate = task.date) {
  const continuesFromEarlier = displayDate !== task.date;
  const dateLabel = continuesFromEarlier
    ? `從 ${formatDate(task.date, { month: "numeric", day: "numeric" })} 延續`
    : task.date === localDateKey()
      ? "今天"
      : task.date === localDateKey(addDays(new Date(), 1))
        ? "明天"
        : formatDate(task.date, { month: "numeric", day: "numeric", weekday: "short" });
  return `
    <div class="task-row event-row" data-task-id="${task.id}">
      <span class="event-time">${escapeHtml(eventTimeLabel(task, displayDate))}</span>
      <button class="task-body-button" data-action="edit" aria-label="編輯「${escapeHtml(task.title)}」">
        <span class="task-title">${escapeHtml(task.title)}</span>
        <span class="task-meta">
          行程 · ${dateLabel}
          ${task.external?.source ? ` · ${escapeHtml(task.external.source)}` : ""}
          ${responseStatusPill(task)}
        </span>
      </button>
      <div class="task-menu">
        <button data-action="delete" title="刪除" aria-label="刪除「${escapeHtml(task.title)}」">×</button>
      </div>
    </div>
  `;
}

function emptyState(message) {
  return `
    <div class="empty-state">
      <div>
        <span class="empty-symbol">✓</span>
        <div>${message}</div>
      </div>
    </div>
  `;
}

function sortedTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    return `${a.date}${a.reminderTime || "99:99"}`.localeCompare(`${b.date}${b.reminderTime || "99:99"}`);
  });
}

function captureTaskFocus(root) {
  const active = document.activeElement;
  const row = active?.closest?.("[data-task-id]");
  if (!root?.contains(active) || !row) return null;
  return {
    taskId: row.dataset.taskId,
    action: active.dataset?.action || ""
  };
}

function restoreTaskFocus(root, focusKey) {
  if (!focusKey) return;
  const row = [...root.querySelectorAll("[data-task-id]")].find(
    (item) => item.dataset.taskId === focusKey.taskId
  );
  const target =
    row?.querySelector(
      focusKey.action ? `[data-action="${focusKey.action}"]` : ".task-body-button"
    ) || $("#quick-add-button");
  requestAnimationFrame(() => target?.focus({ preventScroll: true }));
}

function normalizedSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableDateText(value) {
  const date = parseDate(value);
  if (!date) return String(value || "");
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");
  return [
    `${year}-${paddedMonth}-${paddedDay}`,
    `${year}/${month}/${day}`,
    `${year}/${paddedMonth}/${paddedDay}`,
    `${month}/${day}`,
    `${paddedMonth}/${paddedDay}`,
    `${month}月${day}日`,
    formatDate(date, { weekday: "long" })
  ].join(" ");
}

function taskSearchText(task) {
  return normalizedSearchText(
    [
      task.title,
      task.notes,
      searchableDateText(task.date),
      searchableDateText(task.endDate),
      task.reminderTime,
      task.endTime,
      task.category,
      isEvent(task) ? "行程 會議 event" : "待辦 提醒 reminder",
      task.completed ? "已完成" : "未完成",
      task.external?.source,
      eventResponseStatus(task)
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function searchScore(task, query, terms) {
  const title = normalizedSearchText(task.title);
  const notes = normalizedSearchText(task.notes);
  const haystack = taskSearchText(task);
  if (!terms.every((term) => haystack.includes(term))) return -1;
  let score = 0;
  if (title === query) score += 120;
  if (title.startsWith(query)) score += 70;
  if (title.includes(query)) score += 40;
  if (notes.includes(query)) score += 12;
  if (!task.completed) score += 4;
  if (task.date === localDateKey()) score += 3;
  return score;
}

function searchResultMarkup(task, index) {
  const dateLabel = formatDate(task.date, {
    year: task.date?.startsWith(String(new Date().getFullYear())) ? undefined : "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short"
  });
  const time = task.reminderTime
    ? `${task.reminderTime}${task.endTime ? `–${task.endTime}` : ""}`
    : "未設時間";
  return `
    <button
      type="button"
      class="search-result ${index === searchActiveIndex ? "active" : ""}"
      id="search-result-${index}"
      data-search-task-id="${task.id}"
      data-search-index="${index}"
      role="option"
      aria-selected="${index === searchActiveIndex ? "true" : "false"}"
    >
      <span class="search-result-kind ${isEvent(task) ? "event" : "reminder"}">${isEvent(task) ? "行程" : "待辦"}</span>
      <span class="search-result-copy">
        <strong>${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(dateLabel)} · ${escapeHtml(time)} · ${escapeHtml(task.category || "其他")}${task.external?.source ? ` · ${escapeHtml(task.external.source)}` : ""}</span>
      </span>
      <span class="search-result-arrow" aria-hidden="true">↵</span>
    </button>
  `;
}

function updateSearchComboboxState({ expanded = searchResultIds.length > 0 } = {}) {
  const input = $("#global-search-input");
  if (!input) return;
  input.setAttribute("aria-expanded", String(Boolean(expanded)));
  if (expanded && searchActiveIndex >= 0 && searchResultIds[searchActiveIndex]) {
    input.setAttribute("aria-activedescendant", `search-result-${searchActiveIndex}`);
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function renderGlobalSearch() {
  const query = normalizedSearchText($("#global-search-input")?.value);
  const summary = $("#global-search-summary");
  const results = $("#global-search-results");
  if (!query) {
    searchResultIds = [];
    searchActiveIndex = -1;
    summary.textContent = "可搜尋待辦、行程、備註、日期與分類";
    results.innerHTML = `
      <div class="search-empty">
        <span aria-hidden="true">⌕</span>
        <strong>很快就能找到</strong>
        <p>例如輸入「家教」、「7/30」、「健康」或備註裡的文字。</p>
      </div>
    `;
    updateSearchComboboxState({ expanded: false });
    return;
  }

  const terms = query.split(" ").filter(Boolean);
  const matches = data.tasks
    .map((task) => ({ task, score: searchScore(task, query, terms) }))
    .filter((item) => item.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.task.date}${a.task.reminderTime || "99:99"}`.localeCompare(
          `${b.task.date}${b.task.reminderTime || "99:99"}`
        )
    )
    .slice(0, 60)
    .map((item) => item.task);

  searchResultIds = matches.map((task) => task.id);
  searchActiveIndex = -1;
  summary.textContent = matches.length
    ? `找到 ${matches.length} 項${matches.length === 60 ? "（先顯示最相關的 60 項）" : ""}`
    : `找不到「${$("#global-search-input").value.trim()}」`;
  results.innerHTML = matches.length
    ? matches.map(searchResultMarkup).join("")
    : `
      <div class="search-empty">
        <span aria-hidden="true">○</span>
        <strong>沒有符合的事項</strong>
        <p>試試較短的名稱、日期或分類。</p>
      </div>
    `;
  updateSearchComboboxState({ expanded: matches.length > 0 });
}

function setSearchActiveIndex(index, { focus = false } = {}) {
  if (!searchResultIds.length) {
    searchActiveIndex = -1;
    updateSearchComboboxState({ expanded: false });
    return;
  }
  searchActiveIndex = Math.max(0, Math.min(index, searchResultIds.length - 1));
  $$(".search-result", $("#global-search-results")).forEach((button, buttonIndex) => {
    const isActive = buttonIndex === searchActiveIndex;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  const active = $(`#search-result-${searchActiveIndex}`);
  updateSearchComboboxState({ expanded: true });
  active?.scrollIntoView({ block: "nearest" });
  if (focus) active?.focus({ preventScroll: true });
}

function openTaskFromSearch(taskId) {
  const task = data.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const returnFocus = searchDialogReturnFocus || $("#global-search-button");
  $("#search-dialog").close();
  openTaskDialog(task, returnFocus);
}

function openGlobalSearch() {
  const dialog = $("#search-dialog");
  if (dialog.open) {
    $("#global-search-input")?.focus();
    return;
  }
  if ($("#task-dialog")?.open) return;
  if ($("#day-dialog")?.open) $("#day-dialog").close();
  searchDialogReturnFocus = document.activeElement;
  $("#global-search-input").value = "";
  renderGlobalSearch();
  dialog.showModal();
  requestAnimationFrame(() => $("#global-search-input")?.focus());
}

function renderToday() {
  const eventFocus = captureTaskFocus($("#today-event-list"));
  const taskFocus = captureTaskFocus($("#today-task-list"));
  const today = localDateKey();
  const todayTasks = sortedTasks(data.tasks.filter((task) => isReminder(task) && task.date === today));
  const todayEvents = sortedTasks(data.tasks.filter((task) => eventOccursOnDate(task, today)));
  const openTasks = todayTasks.filter((task) => !task.completed);
  const doneTasks = todayTasks.filter((task) => task.completed);
  const overdueTasks = sortedTasks(
    data.tasks.filter((task) => isReminder(task) && !task.completed && task.date < today)
  );

  $("#today-task-count").textContent = openTasks.length;
  $("#done-task-count").textContent = doneTasks.length;
  $("#today-event-count").textContent = todayEvents.length;
  $("#today-task-note").textContent = openTasks.length
    ? `還有 ${openTasks.length} 件${overdueTasks.length ? `，另有 ${overdueTasks.length} 件逾期` : "，照順序慢慢來"}`
    : overdueTasks.length
      ? `今天尚未安排，另有 ${overdueTasks.length} 件逾期待整理`
      : "今天很清爽";
  $("#done-task-note").textContent = doneTasks.length ? `你已經完成 ${doneTasks.length} 件了` : "從第一件開始吧";
  $("#today-task-list").innerHTML = todayTasks.length
    ? todayTasks.slice(0, 5).map(taskRow).join("")
    : emptyState("今天還沒有待辦");
  $("#today-event-list").innerHTML = todayEvents.length
    ? todayEvents
        .slice(0, 3)
        .map((task) => eventRow(task, today))
        .join("") +
      (todayEvents.length > 3
        ? `<button type="button" class="list-more-button" data-day-agenda="${today}">查看其餘 ${todayEvents.length - 3} 項行程 →</button>`
        : "")
    : emptyState(data.settings.calendarSyncEnabled ? "今天沒有行程" : "行事曆同步已關閉，請到設定開啟");

  const focusTask = openTasks[0];
  const heroAction = $("#hero-action");
  if (focusTask) {
    $("#hero-title").textContent = focusTask.title;
    $("#hero-copy").textContent = `${focusTask.reminderTime ? `${focusTask.reminderTime} 提醒你。` : "我已經替你記好了。"} 完成後記得回來打勾。`;
    heroAction.textContent = "查看今天待辦 →";
    heroAction.dataset.taskFilter = "today";
  } else if (overdueTasks.length) {
    const oldest = overdueTasks[0];
    $("#hero-title").textContent = `${overdueTasks.length} 件待辦需要重新安排`;
    $("#hero-copy").textContent = `最早是「${oldest.title}」。先決定今天做、明天做，或標示完成。`;
    heroAction.textContent = "整理逾期事項 →";
    heroAction.dataset.taskFilter = "overdue";
  } else {
    $("#hero-title").textContent = "今天最重要的一件事是什麼？";
    $("#hero-copy").textContent = "先選一件真正重要的事，我會陪你把它完成。";
    heroAction.textContent = "安排今天 →";
    heroAction.dataset.taskFilter = "open";
  }

  const quickEntry = data.journal[today] || {};
  if (document.activeElement !== $("#today-quick-journal")) {
    $("#today-quick-journal").value = quickEntry.done || "";
  }
  restoreTaskFocus($("#today-event-list"), eventFocus);
  restoreTaskFocus($("#today-task-list"), taskFocus);
}

function renderTasks() {
  const focusKey = captureTaskFocus($("#all-task-list"));
  const today = localDateKey();
  let tasks = sortedTasks(data.tasks.filter(isReminder));
  const overdueTasks = tasks.filter((task) => task.date < today && !task.completed);
  $("#overdue-count").textContent = overdueTasks.length;
  $("#overdue-organizer").hidden = overdueTasks.length === 0;
  if (taskFilter === "open") tasks = tasks.filter((task) => !task.completed);
  if (taskFilter === "overdue") tasks = overdueTasks;
  if (taskFilter === "today") tasks = tasks.filter((task) => task.date === today && !task.completed);
  if (taskFilter === "upcoming") tasks = tasks.filter((task) => task.date > today && !task.completed);
  if (taskFilter === "done") tasks = tasks.filter((task) => task.completed);
  if (taskFilter === "open" && tasks.length) {
    const groups = [
      {
        key: "overdue",
        title: "逾期待整理",
        copy: "先重新安排真正還需要做的事",
        tasks: tasks.filter((task) => task.date < today)
      },
      {
        key: "today",
        title: "今天",
        copy: "現在最值得專心的事項",
        tasks: tasks.filter((task) => task.date === today)
      },
      {
        key: "upcoming",
        title: "之後",
        copy: "已經安排好的下一步",
        tasks: tasks.filter((task) => task.date > today)
      }
    ].filter((group) => group.tasks.length);
    $("#all-task-list").innerHTML = groups
      .map(
        (group) => `
          <section class="task-group ${group.key}" aria-labelledby="task-group-${group.key}">
            <div class="task-group-heading">
              <div>
                <h3 id="task-group-${group.key}">${group.title}</h3>
                <span>${group.copy}</span>
              </div>
              <strong>${group.tasks.length}</strong>
            </div>
            <div class="task-group-list">${group.tasks.map(taskRow).join("")}</div>
          </section>
        `
      )
      .join("");
  } else {
    $("#all-task-list").innerHTML = tasks.length ? tasks.map(taskRow).join("") : emptyState("這裡目前沒有事項");
  }
  restoreTaskFocus($("#all-task-list"), focusKey);
}

function activateTaskFilter(filter, { renderPage = false } = {}) {
  const allowed = ["open", "overdue", "today", "upcoming", "done"];
  taskFilter = allowed.includes(filter) ? filter : "open";
  $$("#task-filter button").forEach((item) => {
    const isActive = item.dataset.filter === taskFilter;
    item.classList.toggle("active", isActive);
    item.setAttribute("aria-pressed", String(isActive));
  });
  if (renderPage && activeRoute === "tasks") renderTasks();
}

function renderWeek() {
  const start = new Date();
  const tomorrow = localDateKey(addDays(start, 1));
  const cards = [];

  for (let index = 0; index < 7; index += 1) {
    const date = addDays(start, index);
    const key = localDateKey(date);
    const tasks = sortedTasks(
      data.tasks.filter(
        (task) =>
          (isEvent(task) && eventOccursOnDate(task, key)) ||
          (isReminder(task) && task.date === key && !task.completed)
      )
    );
    cards.push(`
      <article class="day-card ${index === 0 ? "today" : ""}" aria-label="${escapeHtml(formatDate(date, { month: "long", day: "numeric", weekday: "long" }))}">
        <button type="button" class="day-heading" data-day-agenda="${key}" aria-label="查看${escapeHtml(formatDate(date, { month: "long", day: "numeric", weekday: "long" }))}全部安排">
          <span class="day-name">${index === 0 ? "今天" : index === 1 ? "明天" : formatDate(date, { weekday: "long" })}</span>
          <span class="day-date">${formatDate(date, { month: "numeric", day: "numeric" })}</span>
        </button>
        ${
          tasks.length
            ? tasks
                .slice(0, 4)
                .map(
                  (task) => `
                    <div class="day-task" data-task-id="${task.id}" title="${escapeHtml(task.title)}">
                      <div class="day-task-body">
                        ${isEvent(task) ? `<time>${escapeHtml(eventTimeLabel(task, key))}</time>` : task.reminderTime ? `<time>${task.reminderTime}</time>` : ""}
                        <span class="day-task-type">${isEvent(task) ? "行程" : "待辦"}</span>
                        ${isEvent(task) ? responseStatusPill(task) : ""}
                        <span class="day-task-title">${escapeHtml(task.title)}</span>
                      </div>
                      <div class="day-task-actions">
                        <button data-action="edit" title="編輯" aria-label="編輯「${escapeHtml(task.title)}」">✎</button>
                        <button data-action="delete" title="刪除" aria-label="刪除「${escapeHtml(task.title)}」">×</button>
                      </div>
                    </div>
                  `
                )
                .join("") +
              (tasks.length > 4
                ? `<button type="button" class="week-more" data-day-agenda="${key}">還有 ${tasks.length - 4} 項 →</button>`
                : "")
            : `<p class="day-empty">${data.settings.calendarSyncEnabled ? "沒有安排<br />留一點空白也很好" : "行事曆同步已關閉<br />請到設定開啟"}</p>`
        }
      </article>
    `);
  }
  $("#week-board").innerHTML = cards.join("");
}

function sortedMonthItems(items, displayDate) {
  return [...items].sort((left, right) => {
    if (left.completed !== right.completed) return Number(left.completed) - Number(right.completed);
    const leftTime = isEvent(left) && left.date !== displayDate
      ? left.endTime || "00:00"
      : left.reminderTime || "99:99";
    const rightTime = isEvent(right) && right.date !== displayDate
      ? right.endTime || "00:00"
      : right.reminderTime || "99:99";
    return `${leftTime}${left.title || ""}`.localeCompare(`${rightTime}${right.title || ""}`, "zh-TW");
  });
}

function monthDateButtons(grid = $("#month-grid")) {
  return grid ? $$("[data-month-date]", grid) : [];
}

function setMonthActiveDate(date, { focus = false } = {}) {
  const buttons = monthDateButtons();
  const target = buttons.find((button) => button.dataset.monthDate === date);
  if (!target) return null;
  monthActiveDate = date;
  buttons.forEach((button) => {
    button.tabIndex = button === target ? 0 : -1;
  });
  if (focus) target.focus({ preventScroll: true });
  return target;
}

function renderMonth() {
  const grid = $("#month-grid");
  if (!grid) return;
  const hadMonthDateFocus = Boolean(document.activeElement?.closest?.("[data-month-date]"));
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const titleEl = $("#month-title");
  if (titleEl) titleEl.textContent = `${year}年${month + 1}月`;

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = localDateKey();
  const startKey = localDateKey(new Date(year, month, 1));
  const endKey = localDateKey(new Date(year, month, daysInMonth));
  const activeDate = monthActiveDate >= startKey && monthActiveDate <= endKey
    ? monthActiveDate
    : todayKey >= startKey && todayKey <= endKey
      ? todayKey
      : startKey;
  monthActiveDate = activeDate;
  const dateIndex = dateUtils.buildDateItemIndex
    ? dateUtils.buildDateItemIndex(data.tasks, startKey, endKey)
    : {};
  const foldableKeys = new Set(
    dateUtils.foldableRoutineCandidates
      ? dateUtils.foldableRoutineCandidates(data.tasks, startKey, endKey)
      : []
  );
  let foldedOccurrenceCount = 0;

  const weekdays = ["日", "一", "二", "三", "四", "五", "六"]
    .map((w) => `<div class="month-weekday" role="columnheader">${w}</div>`)
    .join("");

  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) {
    cells.push('<div class="month-cell empty" aria-hidden="true"></div>');
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const key = localDateKey(date);
    const indexedItems = dateIndex[key] || data.tasks.filter(
      (task) =>
        (isEvent(task) && eventOccursOnDate(task, key)) ||
        (isReminder(task) && task.date === key)
    );
    const dayItems = sortedMonthItems(indexedItems, key);
    const routineItems = monthViewMode === "focus"
      ? dayItems.filter((task) =>
          Boolean(dateUtils.isFoldableRoutine?.(task, foldableKeys))
        )
      : [];
    const priorityItems = routineItems.length
      ? dayItems.filter((task) => !dateUtils.isFoldableRoutine(task, foldableKeys))
      : dayItems;
    foldedOccurrenceCount += routineItems.length;
    const chips = priorityItems
      .slice(0, 4)
      .map(
        (task) => `
          <button
            type="button"
            class="month-chip ${isEvent(task) ? "event" : "reminder"} ${task.completed ? "done" : ""}"
            data-task-id="${task.id}"
            tabindex="-1"
            title="${escapeHtml(task.title)}"
            aria-label="編輯「${escapeHtml(task.title)}」，${escapeHtml(formatDate(key, { month: "long", day: "numeric" }))}"
          >
            ${
              isEvent(task)
                ? `<time>${escapeHtml(eventTimeLabel(task, key))}</time> `
                : task.reminderTime
                  ? `<time>${escapeHtml(task.reminderTime)}</time> `
                  : ""
            }${escapeHtml(task.title)}
          </button>`
      )
      .join("");
    const more =
      priorityItems.length > 4
        ? `<button type="button" class="month-more" data-day-agenda="${key}" tabindex="-1" aria-label="查看${escapeHtml(formatDate(key, { month: "long", day: "numeric" }))}全部 ${dayItems.length} 項安排">其餘 ${priorityItems.length - 4} 項</button>`
        : "";
    const routineTitles = [...new Set(routineItems.map((task) => task.title).filter(Boolean))];
    const routineLabel = routineTitles.length === 1
      ? `固定 · ${routineTitles[0]}${routineItems.length > 1 ? ` ×${routineItems.length}` : ""}`
      : `固定安排 ${routineItems.length} 項`;
    const routineTrack = routineItems.length
      ? `<button type="button" class="month-routine-track" data-day-agenda="${key}" tabindex="-1" aria-label="查看${escapeHtml(formatDate(key, { month: "long", day: "numeric" }))}${routineItems.length}筆固定安排">${escapeHtml(routineLabel)}</button>`
      : "";
    const dateLabel = escapeHtml(formatDate(key, {
      month: "long",
      day: "numeric",
      weekday: "long"
    }));
    cells.push(`
      <div
        class="month-cell ${key === todayKey ? "today" : ""}"
        role="gridcell"
        aria-label="${dateLabel}"
        aria-colindex="${date.getDay() + 1}"
      >
        <div class="month-day-header">
          <button
            type="button"
            class="month-daynum"
            data-day-agenda="${key}"
            data-month-date="${key}"
            data-month-column="${date.getDay()}"
            tabindex="${key === activeDate ? "0" : "-1"}"
            aria-label="查看${dateLabel}全部安排"
          >${day}</button>
          <button
            type="button"
            class="month-day-add"
            data-month-add-date="${key}"
            tabindex="-1"
            aria-label="${dateLabel}，新增事項"
          >＋</button>
        </div>
        <div class="month-chips">${chips}${more}${routineTrack}</div>
      </div>
    `);
  }

  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(`<div class="month-week" role="row">${cells.slice(index, index + 7).join("")}</div>`);
  }
  grid.innerHTML = `
    <div class="month-weekdays" role="row">${weekdays}</div>
    <div class="month-days" role="rowgroup">${weeks.join("")}</div>
  `;
  grid.setAttribute("aria-label", `${year}年${month + 1}月行事曆`);
  if (hadMonthDateFocus) {
    requestAnimationFrame(() => setMonthActiveDate(activeDate, { focus: true }));
  }
  $$("#month-view-mode [data-month-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.monthView === monthViewMode));
  });
  const summary = $("#month-view-summary");
  if (summary) {
    summary.textContent = monthViewMode === "focus"
      ? foldedOccurrenceCount
        ? `重點模式收合 ${foldedOccurrenceCount} 筆固定安排；點日期或「固定」可查看完整內容。`
        : "重點模式：這個月沒有可安全收合的高頻固定安排。"
      : "全部模式：逐筆顯示所有安排，日期可開啟完整清單。";
  }
}

function handleMonthClick(event) {
  const agendaButton = event.target.closest("[data-day-agenda]");
  if (agendaButton) {
    if (agendaButton.dataset.monthDate) setMonthActiveDate(agendaButton.dataset.monthDate);
    openDayDialog(agendaButton.dataset.dayAgenda);
    return;
  }
  const chip = event.target.closest("[data-task-id]");
  if (chip) {
    const task = data.tasks.find((item) => item.id === chip.dataset.taskId);
    if (task) openTaskDialog(task);
    return;
  }
  const addButton = event.target.closest("[data-month-add-date]");
  if (addButton) {
    openTaskDialog({ date: addButton.dataset.monthAddDate });
  }
}

function handleMonthKeydown(event) {
  const current = event.target.closest("[data-month-date]");
  if (!current) return;
  const buttons = monthDateButtons();
  const currentIndex = buttons.indexOf(current);
  if (currentIndex < 0) return;

  if (["Enter", " ", "Spacebar"].includes(event.key)) {
    event.preventDefault();
    setMonthActiveDate(current.dataset.monthDate);
    openDayDialog(current.dataset.monthDate);
    return;
  }

  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") nextIndex = Math.min(buttons.length - 1, currentIndex + 1);
  else if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
  else if (event.key === "ArrowDown") nextIndex = Math.min(buttons.length - 1, currentIndex + 7);
  else if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 7);
  else if (event.key === "Home") {
    nextIndex = Math.max(0, currentIndex - Number(current.dataset.monthColumn || 0));
  } else if (event.key === "End") {
    nextIndex = Math.min(
      buttons.length - 1,
      currentIndex + (6 - Number(current.dataset.monthColumn || 0))
    );
  } else {
    return;
  }

  event.preventDefault();
  setMonthActiveDate(buttons[nextIndex].dataset.monthDate, { focus: true });
}

function renderDayDialog() {
  if (!agendaDate) return;
  const items = sortedMonthItems(
    data.tasks.filter(
      (task) =>
        (isEvent(task) && eventOccursOnDate(task, agendaDate)) ||
        (isReminder(task) && task.date === agendaDate)
    ),
    agendaDate
  );
  $("#day-dialog-title").textContent = formatDate(agendaDate, {
    month: "long",
    day: "numeric",
    weekday: "long"
  });
  $("#day-dialog-list").innerHTML = items.length
    ? items
        .map((task) => (isEvent(task) ? eventRow(task, agendaDate) : taskRow(task)))
        .join("")
    : emptyState("這一天還沒有安排");
}

function openDayDialog(date) {
  if (!parseDate(date)) return;
  agendaDate = date;
  dayDialogReturnFocus = document.activeElement;
  renderDayDialog();
  $("#day-dialog").showModal();
  requestAnimationFrame(() => $("#day-dialog-add")?.focus({ preventScroll: true }));
}

function renderJournalHistory() {
  const entries = Object.entries(data.journal)
    .filter(([, entry]) => entry.done || entry.feeling || entry.tomorrow)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 8);
  $("#journal-history").innerHTML = entries.length
    ? entries
        .map(
          ([date, entry]) => `
            <button type="button" class="history-item" data-journal-date="${date}" aria-label="開啟 ${escapeHtml(formatDate(date, { month: "long", day: "numeric", weekday: "short" }))}的記錄">
              <strong>${formatDate(date, { month: "long", day: "numeric", weekday: "short" })}</strong>
              <p>${escapeHtml(entry.done || entry.feeling || entry.tomorrow)}</p>
            </button>
          `
        )
        .join("")
    : '<div class="empty-state"><div>還沒有日誌<br />今天就寫下第一篇吧</div></div>';
}

function resolveVoiceBrain(settings = data.settings) {
  const brain = settings.voiceBrain;
  if (brain === "claude" || brain === "ollama" || brain === "rules") return brain;
  return settings.aiVoiceEnabled ? "ollama" : "rules";
}

function settingsProjection(settings = {}) {
  const voiceBrain = resolveVoiceBrain(settings);
  return {
    userName: String(settings.userName || ""),
    assistantName: String(settings.assistantName || "小光"),
    dailyBriefTime: String(settings.dailyBriefTime || "09:00"),
    notificationsEnabled: settings.notificationsEnabled !== false,
    launchAtLogin: Boolean(settings.launchAtLogin),
    voiceAutoListen: settings.voiceAutoListen !== false,
    voiceReplyEnabled: settings.voiceReplyEnabled !== false,
    voiceAutoHide: settings.voiceAutoHide !== false,
    calendarSyncEnabled: Boolean(settings.calendarSyncEnabled),
    reminderSyncEnabled: Boolean(settings.reminderSyncEnabled),
    calendarId: String(settings.calendarId || ""),
    reminderListId: String(settings.reminderListId || ""),
    voiceBrain,
    aiVoiceEnabled: voiceBrain === "ollama",
    claudeModel: String(settings.claudeModel || "claude-haiku-4-5"),
    voicePrivacyMode: Boolean(settings.voicePrivacyMode),
    aiModel: String(settings.aiModel || "qwen2.5:3b"),
    ollamaUrl: String(settings.ollamaUrl || "http://localhost:11434")
  };
}

function readSettingsForm() {
  const saved = settingsProjection(data.settings);
  const voiceBrain = $("#voice-brain-select")?.value || "rules";
  return {
    userName: $("#user-name-input")?.value.trim() || "",
    assistantName: $("#assistant-name-input")?.value.trim() || "小光",
    dailyBriefTime: $("#brief-time-input")?.value || "09:00",
    notificationsEnabled: Boolean($("#notifications-toggle")?.checked),
    launchAtLogin: Boolean($("#launch-toggle")?.checked),
    voiceAutoListen: Boolean($("#voice-auto-listen-toggle")?.checked),
    voiceReplyEnabled: Boolean($("#voice-reply-toggle")?.checked),
    voiceAutoHide: Boolean($("#voice-auto-hide-toggle")?.checked),
    calendarSyncEnabled: Boolean($("#calendar-sync-toggle")?.checked),
    reminderSyncEnabled: Boolean($("#reminder-sync-toggle")?.checked),
    calendarId: $("#calendar-select")?.value || saved.calendarId,
    reminderListId: $("#reminder-list-select")?.value || saved.reminderListId,
    voiceBrain,
    aiVoiceEnabled: voiceBrain === "ollama",
    claudeModel: $("#claude-model-input")?.value.trim() || "claude-haiku-4-5",
    voicePrivacyMode: Boolean($("#voice-privacy-toggle")?.checked),
    aiModel: $("#ai-model-input")?.value.trim() || "qwen2.5:3b",
    ollamaUrl: $("#ollama-url-input")?.value.trim() || "http://localhost:11434"
  };
}

function hydrateSettingsForm() {
  const settings = settingsProjection(data.settings);
  $("#user-name-input").value = settings.userName;
  $("#assistant-name-input").value = settings.assistantName;
  $("#brief-time-input").value = settings.dailyBriefTime;
  $("#notifications-toggle").checked = settings.notificationsEnabled;
  $("#launch-toggle").checked = settings.launchAtLogin;
  $("#voice-shortcut-input").value = data.settings.voiceShortcut || "Alt+Space";
  $("#voice-auto-listen-toggle").checked = settings.voiceAutoListen;
  $("#voice-reply-toggle").checked = settings.voiceReplyEnabled;
  $("#voice-auto-hide-toggle").checked = settings.voiceAutoHide;
  $("#voice-brain-select").value = settings.voiceBrain;
  $("#claude-model-input").value = settings.claudeModel;
  $("#voice-privacy-toggle").checked = settings.voicePrivacyMode;
  $("#ai-model-input").value = settings.aiModel;
  $("#ollama-url-input").value = settings.ollamaUrl;
  $("#calendar-sync-toggle").checked = settings.calendarSyncEnabled;
  $("#reminder-sync-toggle").checked = settings.reminderSyncEnabled;
}

function setSettingsSaveStatus(message, tone = "") {
  const status = $("#settings-save-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("saving", tone === "saving");
  status.classList.toggle("saved", tone === "saved");
  status.classList.toggle("error", tone === "error");
}

function updateSettingsDirtyState() {
  if (!settingsHydrated) return;
  settingsDirty = !valuesEqual(readSettingsForm(), settingsProjection(data.settings));
  const saveButton = $("#save-settings-button");
  if (saveButton) saveButton.disabled = !settingsDirty;
  setSettingsSaveStatus(
    settingsDirty ? "有尚未儲存的變更" : "所有變更都已儲存",
    settingsDirty ? "saving" : "saved"
  );
  const brain = $("#voice-brain-select")?.value || resolveVoiceBrain();
  $("#voice-brain-badge").textContent =
    brain === "claude" ? "Claude 雲端" : brain === "ollama" ? "Ollama 本地" : "規則式";
}

function activateSettingsSection(name, { focus = false } = {}) {
  if (!SETTINGS_SECTIONS.includes(name)) name = "general";
  activeSettingsSection = name;
  $$("#settings-tabs [data-settings-tab]").forEach((tab) => {
    const active = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus({ preventScroll: true });
  });
  $$("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== name;
  });
  const tablist = $("#settings-tabs");
  if (tablist) {
    tablist.setAttribute("aria-orientation", window.innerWidth <= 1000 ? "horizontal" : "vertical");
  }
}

function renderSettings() {
  if (!settingsDirty) {
    hydrateSettingsForm();
    settingsHydrated = true;
  }
  renderCalendarOptions({ preserveSelection: settingsDirty });
  renderCalendarSyncStatus();
  renderSyncHealth();
  const brain = settingsDirty
    ? $("#voice-brain-select").value
    : resolveVoiceBrain();
  $("#voice-brain-badge").textContent =
    brain === "claude" ? "Claude 雲端" : brain === "ollama" ? "Ollama 本地" : "規則式";
  activateSettingsSection(activeSettingsSection);
  const saveButton = $("#save-settings-button");
  if (saveButton) saveButton.disabled = !settingsDirty;
  if (!settingsDirty) setSettingsSaveStatus("所有變更都已儲存", "saved");
  $("#brand-name").textContent = data.settings.assistantName || "小光";
}

async function refreshCalendarStatus(retries = 5) {
  // 同步元件冷啟動時第一次可能回空，重試直到拿到已授權狀態，徽章才不會誤顯示「尚未連接」
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const status = await api.getCalendarStatus();
      calendarStatus = status;
      const authed =
        ["authorized", "fullAccess", "writeOnly"].includes(status?.authorization?.events) ||
        ["authorized", "fullAccess"].includes(status?.authorization?.reminders);
      if (authed || status?.calendars?.length) {
        if (activeRoute === "settings") renderSettings();
        return status;
      }
    } catch {
      calendarStatus = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (activeRoute === "settings") renderSettings();
  return calendarStatus;
}

async function refreshClaudeStatus() {
  const statusEl = $("#claude-key-status");
  if (!statusEl || !api.getClaudeStatus) return;
  try {
    const status = await api.getClaudeStatus();
    if (status.hasKey) {
      setInlineStatus("#claude-key-status", "✅ 已設定（存在本機保護檔，不會再問鑰匙圈密碼）。可按「測試 Claude」確認。", "success");
    } else {
      setInlineStatus("#claude-key-status", "尚未設定。貼上 sk-ant- 開頭的金鑰後按儲存（存在本機保護檔）。");
    }
  } catch {
    setInlineStatus("#claude-key-status", "無法讀取金鑰狀態。", "error");
  }
}

function setInlineStatus(selector, message, tone = "") {
  const status = $(selector);
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("success", tone === "success");
  status.classList.toggle("error", tone === "error");
}

function renderSelectOptions(select, items, selectedValue, emptyLabel) {
  const options = items.length
    ? items
        .map(
          (item) =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.source)} · ${escapeHtml(item.title)}</option>`
        )
        .join("")
    : `<option value="">${emptyLabel}</option>`;
  select.innerHTML = options;
  if (items.some((item) => item.id === selectedValue)) select.value = selectedValue;
}

function renderCalendarOptions({ preserveSelection = false } = {}) {
  const calendarSelection = preserveSelection
    ? $("#calendar-select")?.value || data.settings.calendarId || ""
    : data.settings.calendarId || "";
  const reminderSelection = preserveSelection
    ? $("#reminder-list-select")?.value || data.settings.reminderListId || ""
    : data.settings.reminderListId || "";
  renderSelectOptions(
    $("#calendar-select"),
    calendarStatus?.calendars || [],
    calendarSelection,
    "尚未取得行事曆"
  );
  renderSelectOptions(
    $("#reminder-list-select"),
    calendarStatus?.reminderLists || [],
    reminderSelection,
    "尚未取得提醒事項"
  );
}

function readableSyncTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時間格式錯誤";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function renderCalendarSyncStatus() {
  const eventAccess = calendarStatus?.authorization?.events;
  const reminderAccess = calendarStatus?.authorization?.reminders;
  const connected = ["authorized", "fullAccess", "writeOnly"].includes(eventAccess) ||
    ["authorized", "fullAccess"].includes(reminderAccess);
  const badge = $("#calendar-connection-badge");
  badge.textContent = connected ? "已連接" : "尚未連接";
  badge.classList.toggle("connected", connected);

  const status = $("#calendar-sync-status");
  if (data.sync?.lastSyncError) {
    status.textContent = `同步失敗：${data.sync.lastSyncError}`;
    status.classList.add("error");
  } else if (!data.settings.calendarSyncEnabled && !data.settings.reminderSyncEnabled) {
    status.textContent = "行事曆與提醒事項同步目前都已關閉。";
    status.classList.add("error");
  } else if (!data.settings.calendarSyncEnabled) {
    status.textContent = "提醒事項會同步，但行事曆同步目前已關閉。";
    status.classList.add("error");
  } else if (data.sync?.lastSyncAt) {
    const warning = data.sync.warnings?.length ? `，${data.sync.warnings.length} 筆需留意` : "";
    status.textContent = `上次同步：${readableSyncTime(data.sync.lastSyncAt)}${warning}`;
    status.classList.remove("error");
  } else {
    status.textContent = connected ? "選擇清單並開啟同步。" : "連接後即可在手機查看。";
    status.classList.remove("error");
  }
}

function syncHealthCard(title, state, detail, tone = "") {
  return `
    <article class="sync-health-card ${tone}">
      <strong>${escapeHtml(title)}</strong>
      <span class="sync-health-state">${escapeHtml(state)}</span>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function renderSyncHealth() {
  const calendars = calendarStatus?.calendars || [];
  const reminderLists = calendarStatus?.reminderLists || [];
  const selectedCalendar = calendars.find((item) => item.id === data.settings.calendarId);
  const selectedReminderList = reminderLists.find((item) => item.id === data.settings.reminderListId);
  const googleCalendars = calendars.filter((item) => item.source === "Google");
  const appleCalendars = calendars.filter((item) => item.source !== "Google");
  const eventAuthorized = ["authorized", "fullAccess", "writeOnly"].includes(
    calendarStatus?.authorization?.events
  );
  const reminderAuthorized = ["authorized", "fullAccess"].includes(
    calendarStatus?.authorization?.reminders
  );
  const syncAge = Date.now() - Date.parse(data.sync?.lastSyncAt || 0);
  const eventSyncAge = Date.now() - Date.parse(data.sync?.lastEventSyncAt || 0);
  const syncHealthy =
    !data.sync?.lastSyncError &&
    data.sync?.lastSyncAt &&
    syncAge < 15 * 60 * 1_000;
  const pendingDeletes = data.sync?.pendingDeletes?.length || 0;
  const pendingEventActions = data.sync?.pendingEventActions?.length || 0;
  const pendingSyncText = [
    pendingDeletes ? `${pendingDeletes} 筆待刪除` : "",
    pendingEventActions ? `${pendingEventActions} 筆會議更新` : ""
  ].filter(Boolean).join("，");

  $("#sync-health-grid").innerHTML = [
    syncHealthCard(
      "Google 行事曆",
      !data.settings.calendarSyncEnabled
        ? "同步已關閉"
        : eventAuthorized && googleCalendars.length
          ? "正常"
          : "未連接",
      !data.settings.calendarSyncEnabled
        ? "請開啟行事曆同步，手機上的新行程才會更新"
        : googleCalendars.length
          ? `${googleCalendars.length} 個行事曆${selectedCalendar?.source === "Google" ? "，目前使用中" : ""}`
          : "尚未從 macOS 取得 Google 行事曆",
      data.settings.calendarSyncEnabled && eventAuthorized && googleCalendars.length
        ? eventSyncAge < 15 * 60 * 1_000
          ? "healthy"
          : "muted"
        : data.settings.calendarSyncEnabled
          ? "muted"
          : "error"
    ),
    syncHealthCard(
      "Apple／iCloud 行事曆",
      !data.settings.calendarSyncEnabled
        ? "同步已關閉"
        : eventAuthorized && appleCalendars.length
          ? "正常"
          : "未連接",
      !data.settings.calendarSyncEnabled
        ? "請開啟行事曆同步"
        : appleCalendars.length
          ? `${appleCalendars.length} 個行事曆${selectedCalendar && selectedCalendar.source !== "Google" ? "，目前使用中" : ""}`
          : "尚未取得 Apple 或 iCloud 行事曆",
      data.settings.calendarSyncEnabled && eventAuthorized && appleCalendars.length
        ? "healthy"
        : data.settings.calendarSyncEnabled
          ? "muted"
          : "error"
    ),
    syncHealthCard(
      "Apple 提醒事項",
      reminderAuthorized && selectedReminderList ? "正常" : "未設定",
      selectedReminderList
        ? `${selectedReminderList.source} · ${selectedReminderList.title}`
        : "尚未選擇同步清單",
      reminderAuthorized && selectedReminderList ? "healthy" : "muted"
    ),
    syncHealthCard(
      "最近同步",
      data.sync?.lastSyncError ? "需要處理" : syncHealthy ? "正常" : "等待同步",
      data.sync?.lastSyncError ||
        (data.sync?.lastSyncAt
          ? `${readableSyncTime(data.sync.lastSyncAt)}${pendingSyncText ? `，${pendingSyncText}` : ""}`
          : "尚未完成第一次同步"),
      data.sync?.lastSyncError ? "error" : syncHealthy ? "healthy" : "muted"
    )
  ].join("");
}

function renderUndoToast() {
  clearInterval(undoCountdownTimer);
  const now = Date.now();
  const active = (data.trash || [])
    .filter((entry) => Date.parse(entry.expiresAt || 0) > now)
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))[0];
  const toast = $("#undo-toast");
  if (!active) {
    toast.hidden = true;
    return;
  }

  const updateCountdown = () => {
    const seconds = Math.max(0, Math.ceil((Date.parse(active.expiresAt) - Date.now()) / 1_000));
    $("#undo-countdown").textContent = seconds;
    if (!seconds) {
      clearInterval(undoCountdownTimer);
      toast.hidden = true;
    }
  };
  $("#undo-message").textContent = `已刪除「${active.task.title}」`;
  toast.dataset.trashId = active.id;
  toast.hidden = false;
  updateCountdown();
  undoCountdownTimer = setInterval(updateCountdown, 250);
}

function render() {
  const now = new Date();
  try {
    const brandName = $("#brand-name");
    if (brandName) brandName.textContent = data.settings.assistantName || "小光";
    const todayDate = $("#today-date");
    if (todayDate) {
      todayDate.textContent = formatDate(now, {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long"
      });
    }
  } catch (error) {
    console.error("頂部日期渲染失敗：", error);
  }
  const routeRenderers = {
    today: renderToday,
    tasks: renderTasks,
    week: renderWeek,
    month: renderMonth,
    journal: renderJournalHistory,
    settings: renderSettings
  };
  const renderSection = routeRenderers[activeRoute] || renderToday;
  try {
    renderSection();
  } catch (error) {
    console.error(`畫面區塊渲染失敗：${renderSection.name}`, error);
  }
  try {
    renderUndoToast();
    if ($("#day-dialog")?.open) renderDayDialog();
    if ($("#search-dialog")?.open) renderGlobalSearch();
  } catch (error) {
    console.error("浮動介面渲染失敗：", error);
  }
}

function openTaskDialog(task = null, returnFocus = document.activeElement) {
  taskDialogReturnFocus = returnFocus;
  const searchDialog = $("#search-dialog");
  const dayDialog = $("#day-dialog");
  if (searchDialog?.open) searchDialog.close();
  if (dayDialog?.open) dayDialog.close();
  $("#dialog-title").textContent = task?.id ? "編輯事項" : "新增事項";
  $("#task-dialog-status").hidden = true;
  $("#task-dialog-status").textContent = "";
  $("#task-id").value = task?.id || "";
  $("#task-title").value = task?.title || "";
  $("#task-date").value = task?.date || localDateKey();
  $("#task-time").value = task?.reminderTime || "";
  $("#task-end-time").value = task?.endTime || "";
  $("#task-kind").value = task?.kind || "reminder";
  const isEventKind = task?.kind === "event";
  const inferredAllDay = Boolean(
    isEventKind && (task?.isAllDay || (!task?.reminderTime && !task?.endTime))
  );
  $("#task-all-day").checked = inferredAllDay;
  $("#task-end-date").value = isEventKind
    ? task?.endDate ||
      (
        task?.reminderTime &&
        task?.endTime &&
        task.endTime <= task.reminderTime
          ? addDateDays(task.date, 1)
          : task?.date
      ) ||
      localDateKey()
    : task?.date || localDateKey();
  $("#task-category").value = task?.category || "工作";
  $("#task-notes").value = task?.notes || "";
  $("#delete-task-button").hidden = !task?.id;
  $("#task-dialog").showModal();
  syncTaskKindFields({ autoAdvance: false });
  setTimeout(() => $("#task-title").focus(), 50);
}

function calendarDaySpan(startValue, endValue) {
  const start = parseDate(startValue);
  const end = parseDate(endValue);
  if (!start || !end) return 0;
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / 86_400_000);
}

// 依「類型」切換排程欄位，明確保留跨日與全天語意。
function syncTaskKindFields({ autoAdvance = true } = {}) {
  const isEventKind = $("#task-kind").value === "event";
  const allDay = isEventKind && $("#task-all-day").checked;
  const startDate = $("#task-date").value;
  const endDateInput = $("#task-end-date");
  const startTimeInput = $("#task-time");
  const endTimeInput = $("#task-end-time");
  const eventSchedule = $("#task-event-schedule");
  const startTimeRow = $("#task-start-time-row");
  const endTimeRow = $("#task-end-time-row");

  $("#task-date-label").textContent = isEventKind ? "開始日期" : "日期";
  $("#task-time-label").textContent = isEventKind ? "開始時間" : "提醒時間";
  eventSchedule.hidden = !isEventKind;
  startTimeRow.hidden = allDay;
  endTimeRow.hidden = !isEventKind || allDay;
  endDateInput.required = isEventKind;
  startTimeInput.required = isEventKind && !allDay;
  endTimeInput.required = isEventKind && !allDay;
  endDateInput.min = startDate || "";

  if (isEventKind && startDate) {
    if (!endDateInput.value || endDateInput.value < startDate) {
      endDateInput.value = startDate;
    }
    if (
      autoAdvance &&
      !allDay &&
      startTimeInput.value &&
      endTimeInput.value &&
      endDateInput.value === startDate &&
      endTimeInput.value <= startTimeInput.value
    ) {
      endDateInput.value = addDateDays(startDate, 1);
    }
  }
  updateTaskScheduleHint();
}

function updateTaskScheduleHint() {
  const hint = $("#task-schedule-hint");
  const detail = $("#task-end-date-hint");
  if (!hint || !detail) return;
  const isEventKind = $("#task-kind").value === "event";
  const allDay = isEventKind && $("#task-all-day").checked;
  const startDate = $("#task-date").value;
  const endDate = $("#task-end-date").value;
  const start = $("#task-time").value;
  const end = $("#task-end-time").value;
  detail.hidden = true;
  detail.textContent = "";

  if (!isEventKind) {
    hint.textContent = "待辦會在指定日期與時間提醒你。";
    return;
  }
  if (!startDate || !endDate) {
    hint.textContent = "請選擇開始與結束日期。";
    return;
  }

  const daySpan = Math.max(0, calendarDaySpan(startDate, endDate));
  if (allDay) {
    hint.textContent = daySpan
      ? `這是 ${daySpan + 1} 天的全天行程；結束日期包含 ${formatDate(endDate, { month: "numeric", day: "numeric" })}。`
      : "這是全天行程；結束日期包含當天。";
    return;
  }
  if (!start || !end) {
    hint.textContent = "請填寫開始與結束時間，或切換為全天。";
    return;
  }
  if (daySpan > 0) {
    hint.textContent = `跨日行程，將在 ${formatDate(endDate, { month: "numeric", day: "numeric" })} ${end} 結束。`;
    return;
  }
  hint.textContent = `${start}–${end}，同一天完成。`;
}

function loadJournalEditor(date) {
  if (!parseDate(date)) date = localDateKey();
  activeJournalDate = date;
  const entry = data.journal[date] || {};
  $("#journal-date").value = date;
  $("#journal-done").value = entry.done || "";
  $("#journal-feeling").value = entry.feeling || "";
  $("#journal-tomorrow").value = entry.tomorrow || "";
  selectedMood = entry.mood || "";
  $$("#mood-picker button").forEach((button) => {
    const isActive = button.dataset.mood === selectedMood;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  const draft = journalDrafts.get(date);
  setJournalStatus(date, draft?.state || "saved");
}

function refreshJournalEditorFromData(date = activeJournalDate) {
  if (!date || activeJournalDate !== date) return;
  const entry = data.journal?.[date] || {};
  const draft = journalDrafts.get(date);
  const fieldMap = {
    done: "#journal-done",
    feeling: "#journal-feeling",
    tomorrow: "#journal-tomorrow"
  };
  for (const [field, selector] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(draft?.patch || {}, field)) continue;
    const input = $(selector);
    if (input && document.activeElement !== input) input.value = entry[field] || "";
  }
  if (!Object.prototype.hasOwnProperty.call(draft?.patch || {}, "mood")) {
    selectedMood = entry.mood || "";
    $$("#mood-picker button").forEach((button) => {
      const active = button.dataset.mood === selectedMood;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  setJournalStatus(date, draft?.state || "saved");
}

async function handleTaskAction(event) {
  const agendaButton = event.target.closest("[data-day-agenda]");
  if (agendaButton) {
    openDayDialog(agendaButton.dataset.dayAgenda);
    return;
  }
  const button = event.target.closest("[data-action]");
  const row = event.target.closest("[data-task-id]");
  if (!button || !row) return;

  const task = data.tasks.find((item) => item.id === row.dataset.taskId);
  if (!task) return;
  const snapshot = cloneData(data);

  if (button.dataset.action === "toggle") {
    if (!isReminder(task)) return;
    task.completed = !task.completed;
    task.completedAt = task.completed ? new Date().toISOString() : null;
    task.updatedAt = new Date().toISOString();
  }
  if (button.dataset.action === "edit") {
    const returnFocus = $("#day-dialog")?.open
      ? dayDialogReturnFocus || $("#quick-add-button")
      : document.activeElement;
    openTaskDialog(task, returnFocus);
    return;
  }
  if (button.dataset.action === "delete") {
    deleteTask(task);
  }

  try {
    await persist();
    if ($("#day-dialog")?.open) renderDayDialog();
  } catch (error) {
    data = snapshot;
    render();
    showActionError("事項尚未保存，原本內容已保留，請再試一次。", error);
  }
}

function restoreDialogFocus(candidate) {
  setTimeout(() => {
    if ($("dialog[open]")) return;
    const target =
      candidate?.isConnected && !candidate.closest?.("dialog:not([open])")
        ? candidate
        : $("#quick-add-button");
    target?.focus({ preventScroll: true });
  }, 0);
}

function wireEvents() {
  on("#settings-tabs", "click", (event) => {
    const tab = event.target.closest("[data-settings-tab]");
    if (tab) activateSettingsSection(tab.dataset.settingsTab);
  });
  on("#settings-tabs", "keydown", (event) => {
    const tab = event.target.closest("[data-settings-tab]");
    if (!tab) return;
    const currentIndex = SETTINGS_SECTIONS.indexOf(tab.dataset.settingsTab);
    let nextIndex = currentIndex;
    if (["ArrowRight", "ArrowDown"].includes(event.key)) nextIndex = (currentIndex + 1) % SETTINGS_SECTIONS.length;
    else if (["ArrowLeft", "ArrowUp"].includes(event.key)) nextIndex = (currentIndex - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SETTINGS_SECTIONS.length - 1;
    else return;
    event.preventDefault();
    activateSettingsSection(SETTINGS_SECTIONS[nextIndex], { focus: true });
  });
  const handleSettingsDraftChange = (event) => {
    if (["claude-key-input", "voice-shortcut-input"].includes(event.target?.id)) return;
    updateSettingsDirtyState();
  };
  on("#settings-workspace", "input", handleSettingsDraftChange);
  on("#settings-workspace", "change", handleSettingsDraftChange);
  on(window, "resize", () => {
    if (activeRoute === "settings") activateSettingsSection(activeSettingsSection);
  });
  on("#nav", "click", (event) => {
    const button = event.target.closest("[data-route]");
    if (button) navigate(button.dataset.route, { focusHeading: event.detail === 0 });
  });
  $$("[data-go]").forEach((button) => on(button, "click", (event) => {
    if (button.dataset.taskFilter) activateTaskFilter(button.dataset.taskFilter);
    navigate(button.dataset.go, { focusHeading: event.detail === 0 });
  }));
  on("#quick-add-button", "click", () => openTaskDialog());
  on("#global-search-button", "click", openGlobalSearch);
  on("#close-search-dialog", "click", () => $("#search-dialog")?.close());
  on("#close-day-dialog", "click", () => $("#day-dialog")?.close());
  on("#close-dialog", "click", () => $("#task-dialog")?.close());
  on("#cancel-dialog", "click", () => $("#task-dialog")?.close());
  on("#search-dialog", "close", () => {
    updateSearchComboboxState({ expanded: false });
    restoreDialogFocus(searchDialogReturnFocus);
  });
  on("#day-dialog", "close", () => restoreDialogFocus(dayDialogReturnFocus));
  on("#task-dialog", "close", () => restoreDialogFocus(taskDialogReturnFocus));
  on("#global-search-input", "input", renderGlobalSearch);
  on("#global-search-input", "keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSearchActiveIndex(searchActiveIndex < 0 ? 0 : searchActiveIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSearchActiveIndex(searchActiveIndex <= 0 ? searchResultIds.length - 1 : searchActiveIndex - 1);
    } else if (event.key === "Enter" && searchActiveIndex >= 0) {
      event.preventDefault();
      openTaskFromSearch(searchResultIds[searchActiveIndex]);
    }
  });
  on("#global-search-results", "click", (event) => {
    const result = event.target.closest("[data-search-task-id]");
    if (result) openTaskFromSearch(result.dataset.searchTaskId);
  });
  on("#global-search-results", "keydown", (event) => {
    const result = event.target.closest("[data-search-index]");
    if (!result) return;
    const index = Number(result.dataset.searchIndex);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSearchActiveIndex(index + 1, { focus: true });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) $("#global-search-input")?.focus();
      else setSearchActiveIndex(index - 1, { focus: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      openTaskFromSearch(result.dataset.searchTaskId);
    }
  });
  on("#day-dialog-list", "click", handleTaskAction);
  on("#day-dialog-add", "click", () => {
    const returnFocus = dayDialogReturnFocus || $("#quick-add-button");
    $("#day-dialog").close();
    openTaskDialog({ date: agendaDate }, returnFocus);
  });
  on(document, "keydown", (event) => {
    const command = event.metaKey || event.ctrlKey;
    if (!command || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      openGlobalSearch();
      return;
    }
    if (key === "n") {
      event.preventDefault();
      if (!$("#task-dialog")?.open) openTaskDialog();
      return;
    }
    const routeIndex = Number(event.key) - 1;
    if (
      !event.shiftKey &&
      routeIndex >= 0 &&
      routeIndex < ROUTES.length &&
      !$("dialog[open]")
    ) {
      event.preventDefault();
      navigate(ROUTES[routeIndex], { focusHeading: true });
    }
  });
  on("#delete-task-button", "click", async () => {
    const id = $("#task-id").value;
    const task = data.tasks.find((item) => item.id === id);
    if (!task) return;
    const snapshot = cloneData(data);
    if (!deleteTask(task)) return;
    const form = $("#task-form");
    form.setAttribute("aria-busy", "true");
    try {
      await persist();
      $("#task-dialog").close();
    } catch (error) {
      data = snapshot;
      $("#task-dialog-status").textContent = `刪除失敗：${error.message || "請再試一次"}`;
      $("#task-dialog-status").hidden = false;
    } finally {
      form.removeAttribute("aria-busy");
    }
  });

  on("#task-form", "submit", async (event) => {
    event.preventDefault();
    const id = $("#task-id").value;
    const existing = data.tasks.find((task) => task.id === id);
    syncTaskKindFields();
    const kind = $("#task-kind").value;
    const isEventKind = kind === "event";
    const isAllDay = isEventKind && $("#task-all-day").checked;
    const startDate = $("#task-date").value;
    const endDate = isEventKind ? ($("#task-end-date").value || startDate) : startDate;
    const startTime = isAllDay ? "" : $("#task-time").value;
    const endTime = isEventKind && !isAllDay ? $("#task-end-time").value : "";
    const status = $("#task-dialog-status");
    const rejectSchedule = (message, target) => {
      status.textContent = message;
      status.hidden = false;
      target?.focus();
    };
    if (!startDate || (isEventKind && (!endDate || endDate < startDate))) {
      rejectSchedule("結束日期不能早於開始日期。", $("#task-end-date"));
      return;
    }
    if (isEventKind && !isAllDay && (!startTime || !endTime)) {
      rejectSchedule("請填寫開始與結束時間，或切換為全天。", !startTime ? $("#task-time") : $("#task-end-time"));
      return;
    }
    if (isEventKind && !isAllDay && endDate === startDate && endTime <= startTime) {
      rejectSchedule("結束時間必須晚於開始時間；跨午夜請將結束日期設為隔天。", $("#task-end-date"));
      return;
    }
    const snapshot = cloneData(data);
    const task = {
      id: id || uid(),
      title: $("#task-title").value.trim(),
      date: startDate,
      reminderTime: startTime,
      endDate,
      endTime,
      isAllDay,
      kind,
      category: $("#task-category").value,
      notes: $("#task-notes").value.trim(),
      completed: existing?.completed || false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      completedAt: existing?.completedAt || null,
      updatedAt: new Date().toISOString(),
      origin: existing ? existing.origin : "manual",
      external: existing?.external
    };
    if (!task.title || !task.date) return;
    const form = $("#task-form");
    const submitButton = form.querySelector('[type="submit"]');
    form.setAttribute("aria-busy", "true");
    submitButton.disabled = true;
    $("#task-dialog-status").hidden = true;
    if (existing) Object.assign(existing, task);
    else {
      data.tasks.push(task);
      $("#task-id").value = task.id;
    }
    try {
      await persist();
      $("#task-dialog").close();
    } catch (error) {
      data = snapshot;
      $("#task-id").value = id;
      $("#task-dialog-status").textContent = `保存失敗：${error.message || "請再試一次"}`;
      $("#task-dialog-status").hidden = false;
    } finally {
      form.removeAttribute("aria-busy");
      submitButton.disabled = false;
    }
  });

  on("#today-task-list", "click", handleTaskAction);
  on("#today-event-list", "click", handleTaskAction);
  on("#all-task-list", "click", handleTaskAction);
  on("#week-board", "click", handleTaskAction);
  on("#month-grid", "click", handleMonthClick);
  on("#month-grid", "keydown", handleMonthKeydown);
  on("#month-view-mode", "click", (event) => {
    const button = event.target.closest("[data-month-view]");
    if (!button || !["focus", "all"].includes(button.dataset.monthView)) return;
    monthViewMode = button.dataset.monthView;
    renderMonth();
  });
  on("#month-prev", "click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1);
    renderMonth();
  });
  on("#month-next", "click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
    renderMonth();
  });
  on("#month-today", "click", () => {
    monthCursor = new Date();
    renderMonth();
  });
  on("#task-kind", "change", () => syncTaskKindFields());
  on("#task-all-day", "change", () => syncTaskKindFields({ autoAdvance: false }));
  ["#task-date", "#task-time", "#task-end-date", "#task-end-time"].forEach((selector) => {
    on(selector, "input", () => syncTaskKindFields());
  });

  on("#task-filter", "click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    activateTaskFilter(button.dataset.filter, { renderPage: true });
  });
  on("#overdue-organizer", "click", async (event) => {
    const button = event.target.closest("[data-overdue-action]");
    if (!button) return;
    const snapshot = cloneData(data);
    const today = localDateKey();
    const tomorrow = localDateKey(addDays(new Date(), 1));
    const now = new Date().toISOString();
    button.disabled = true;
    $("#overdue-organizer")?.setAttribute("aria-busy", "true");
    for (const task of data.tasks) {
      if (!isReminder(task) || task.completed || task.date >= today) continue;
      if (button.dataset.overdueAction === "complete") {
        task.completed = true;
        task.completedAt = now;
      } else {
        task.date = button.dataset.overdueAction === "tomorrow" ? tomorrow : today;
      }
      task.updatedAt = now;
    }
    try {
      await persist();
    } catch (error) {
      data = snapshot;
      render();
      showActionError("批次整理尚未保存，所有事項已還原，請再試一次。", error);
    } finally {
      button.disabled = false;
      $("#overdue-organizer")?.removeAttribute("aria-busy");
    }
  });
  on("#undo-delete-button", "click", async () => {
    const trashId = $("#undo-toast").dataset.trashId;
    const entry = (data.trash || []).find((item) => item.id === trashId);
    if (!entry) return;
    const snapshot = cloneData(data);
    data.tasks.push(entry.task);
    data.trash = data.trash.filter((item) => item.id !== trashId);
    try {
      await persist();
    } catch (error) {
      data = snapshot;
      render();
      showActionError("復原尚未保存，刪除狀態已保留，請再試一次。", error);
    }
  });

  on("#today-quick-journal", "input", (event) => {
    stageJournalPatch(localDateKey(), { done: event.target.value });
  });

  on("#journal-date", "change", (event) => {
    void flushJournalAutosave();
    loadJournalEditor(event.target.value);
  });
  on("#mood-picker", "click", (event) => {
    const button = event.target.closest("[data-mood]");
    if (!button) return;
    selectedMood = button.dataset.mood;
    $$("#mood-picker button").forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });
    stageJournalPatch(activeJournalDate || $("#journal-date").value, { mood: selectedMood });
  });
  const journalFields = {
    "journal-done": "done",
    "journal-feeling": "feeling",
    "journal-tomorrow": "tomorrow"
  };
  $$(".journal-editor textarea").forEach((input) => {
    on(input, "input", (event) => {
      const field = journalFields[event.target.id];
      if (field) {
        stageJournalPatch(activeJournalDate || $("#journal-date").value, {
          [field]: event.target.value
        });
      }
    });
  });
  on("#save-journal-button", "click", async () => {
    const date = $("#journal-date").value;
    const current = data.journal[date] || {};
    const editorValues = {
      done: $("#journal-done").value,
      feeling: $("#journal-feeling").value,
      tomorrow: $("#journal-tomorrow").value,
      mood: selectedMood
    };
    const patch = Object.fromEntries(
      Object.entries(editorValues).filter(([field, value]) => String(current[field] || "") !== value)
    );
    if (Object.keys(patch).length) stageJournalPatch(date, patch);
    const draft = journalDrafts.get(date);
    if (draft?.state === "conflict") {
      draft.baseEntry = cloneData(lastPersistedData?.journal?.[date] || {});
      draft.state = "dirty";
      setJournalStatus(date, "dirty");
    }
    await flushJournalAutosave();
    if (date === localDateKey() && document.activeElement !== $("#today-quick-journal")) {
      $("#today-quick-journal").value = data.journal[date]?.done || "";
    }
  });
  on("#journal-history", "click", (event) => {
    const item = event.target.closest("[data-journal-date]");
    if (item) {
      void flushJournalAutosave();
      loadJournalEditor(item.dataset.journalDate);
    }
  });

  on("#save-settings-button", "click", async () => {
    const snapshot = cloneData(data);
    const previousSettings = settingsProjection(data.settings);
    const formSettings = readSettingsForm();
    const button = $("#save-settings-button");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setSettingsSaveStatus("正在儲存所有變更…", "saving");
    data.settings = { ...data.settings, ...formSettings };
    try {
      const launchEnabled = await api.setLaunchAtLogin(formSettings.launchAtLogin);
      data.settings.launchAtLogin = Boolean(launchEnabled);
      await persist();
      settingsDirty = false;
      settingsHydrated = true;
      const time = new Intl.DateTimeFormat("zh-TW", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date());
      setSettingsSaveStatus(`已儲存 ${time}`, "saved");
      $("#brand-name").textContent = data.settings.assistantName || "小光";
    } catch (error) {
      data = overlayJournalDrafts(snapshot);
      settingsDirty = true;
      setSettingsSaveStatus("儲存失敗，畫面上的變更仍保留", "error");
      try { await api.setLaunchAtLogin(previousSettings.launchAtLogin); } catch {}
      console.error("設定保存失敗：", error);
    } finally {
      button.removeAttribute("aria-busy");
      button.disabled = !settingsDirty;
    }
  });
  on("#save-voice-shortcut-button", "click", async () => {
    const input = $("#voice-shortcut-input");
    const button = $("#save-voice-shortcut-button");
    const requested = input.value.trim();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "套用中…";
    setInlineStatus("#voice-shortcut-status", "正在重新註冊快捷鍵…");
    try {
      if (!api.setVoiceShortcut) throw new Error("目前版本不支援自訂快捷鍵。");
      const result = await api.setVoiceShortcut(requested);
      if (!result?.registered) throw new Error(result?.error || "快捷鍵註冊失敗。");
      data.settings.voiceShortcut = requested;
      input.value = requested;
      const registrationMessage = result.accelerator && result.accelerator !== requested
        ? `${requested} 無法使用，已改用 ${result.label || result.accelerator}`
        : `已註冊 ${result.label || result.accelerator || requested}`;
      setInlineStatus("#voice-shortcut-status", `${registrationMessage}。請再按「測試快捷鍵」確認沒有被其他 App 攔截。`, "success");
      button.textContent = "已套用 ✓";
    } catch (error) {
      setInlineStatus("#voice-shortcut-status", error.message || "快捷鍵註冊失敗。", "error");
      button.textContent = original;
    } finally {
      button.disabled = false;
      setTimeout(() => (button.textContent = original), 1500);
    }
  });
  on("#test-voice-shortcut-button", "click", async () => {
    const button = $("#test-voice-shortcut-button");
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "10 秒內按快捷鍵…";
    setInlineStatus("#voice-shortcut-status", "請現在按一次你設定的快捷鍵。");
    try {
      if (!api.beginVoiceShortcutTest) throw new Error("目前版本不支援快捷鍵測試。");
      const result = await api.beginVoiceShortcutTest();
      setInlineStatus(
        "#voice-shortcut-status",
        result?.message || (result?.triggered ? "快捷鍵測試成功。" : "沒有收到快捷鍵；可能被其他 App 攔截。"),
        result?.triggered ? "success" : "error"
      );
    } catch (error) {
      setInlineStatus("#voice-shortcut-status", error.message || "快捷鍵測試失敗。", "error");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
  on("#test-voice-button", "click", () => api.testVoice());
  on("#test-notification-button", "click", () => api.testNotification());
  on("#test-ai-button", "click", async () => {
    const btn = $("#test-ai-button");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "測試中…";
    setInlineStatus("#ollama-test-status", "正在連線 Ollama…");
    try {
      const res = await api.testAIConnection();
      setInlineStatus(
        "#ollama-test-status",
        res?.success ? `連線成功，模型：${res.model || "未知"}` : `連線失敗：${res?.error || "無法連線 Ollama"}`,
        res?.success ? "success" : "error"
      );
    } catch (e) {
      setInlineStatus("#ollama-test-status", `測試失敗：${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  on("#save-claude-key-button", "click", async () => {
    const input = $("#claude-key-input");
    const key = input.value.trim();
    const btn = $("#save-claude-key-button");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "儲存中…";
    try {
      const res = await api.setClaudeKey(key);
      input.value = "";
      await refreshClaudeStatus();
      if (res?.hasKey) {
        // 設好金鑰後，若還在規則式就自動切到 Claude
        if (resolveVoiceBrain() === "rules") {
          $("#voice-brain-select").value = "claude";
          data.settings = { ...data.settings, voiceBrain: "claude" };
          await persist();
        }
        btn.textContent = "已儲存 ✓";
      } else {
        btn.textContent = "已清除";
      }
    } catch (e) {
      setInlineStatus("#claude-key-status", `儲存金鑰失敗：${e.message}`, "error");
      btn.textContent = original;
    } finally {
      btn.disabled = false;
      setTimeout(() => (btn.textContent = original), 1500);
    }
  });
  on("#test-claude-button", "click", async () => {
    const btn = $("#test-claude-button");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "測試中…";
    setInlineStatus("#claude-test-status", "正在連線 Claude…");
    try {
      const res = await api.testClaude();
      setInlineStatus(
        "#claude-test-status",
        res?.success ? `Claude 連線成功，模型：${res.model || "未知"}` : `Claude 連線失敗：${res?.error || "無法連線"}`,
        res?.success ? "success" : "error"
      );
    } catch (e) {
      setInlineStatus("#claude-test-status", `Claude 測試失敗：${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  on("#show-data-button", "click", () => api.showDataFile());
  on("#open-accounts-button", "click", () => api.openInternetAccounts());
  on("#connect-calendar-button", "click", async () => {
    const button = $("#connect-calendar-button");
    const snapshot = cloneData(data);
    button.disabled = true;
    button.textContent = "等待系統授權…";
    try {
      calendarStatus = await api.requestCalendarAccess();
      if (calendarStatus?.calendars?.length) {
        data.settings.calendarSyncEnabled = true;
        if (!calendarStatus.calendars.some((item) => item.id === data.settings.calendarId)) {
          data.settings.calendarId = calendarStatus.calendars[0].id;
        }
      }
      if (calendarStatus?.reminderLists?.length) {
        data.settings.reminderSyncEnabled = true;
        if (!calendarStatus.reminderLists.some((item) => item.id === data.settings.reminderListId)) {
          data.settings.reminderListId = calendarStatus.reminderLists[0].id;
        }
      }
      await persist();
    } catch (error) {
      data = overlayJournalDrafts(snapshot);
      data.sync = { ...(data.sync || {}), lastSyncError: error.message };
      renderCalendarSyncStatus();
    } finally {
      button.disabled = false;
      button.textContent = "連接行事曆";
    }
  });
  on("#sync-calendar-button", "click", async () => {
    const button = $("#sync-calendar-button");
    const snapshot = cloneData(data);
    data.settings = {
      ...data.settings,
      calendarSyncEnabled: $("#calendar-sync-toggle").checked,
      reminderSyncEnabled: $("#reminder-sync-toggle").checked,
      calendarId: $("#calendar-select").value || data.settings.calendarId || "",
      reminderListId: $("#reminder-list-select").value || data.settings.reminderListId || ""
    };
    button.disabled = true;
    button.textContent = "同步中…";
    try {
      await persist();
      updateSettingsDirtyState();
      data = rememberServerData(await api.syncCalendars());
      calendarStatus = await api.getCalendarStatus();
    } catch (error) {
      data = overlayJournalDrafts(snapshot);
      data.sync = { ...(data.sync || {}), lastSyncError: error.message };
      setInlineStatus("#calendar-sync-status", `同步失敗：${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = "立即同步";
      try {
        renderCalendarOptions({ preserveSelection: settingsDirty });
        renderCalendarSyncStatus();
        renderSyncHealth();
      } catch (error) {
        console.error("行事曆同步狀態渲染失敗：", error);
      }
    }
  });
  on(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushJournalAutosave();
  });
  on(window, "blur", () => {
    void flushJournalAutosave();
  });
  on(window, "beforeunload", flushJournalBeforeUnload);
}

async function init() {
  if (!api) {
    showRendererError("主程式連線未載入，請重新啟動貼身小秘書。");
    return;
  }

  try {
    data = rememberServerData(await api.getData());
  } catch (error) {
    showRendererError("資料載入失敗，請重新啟動後再試。", error);
    return;
  }

  try {
    wireEvents();
  } catch (error) {
    showRendererError("部分操作無法啟用，其他功能仍可繼續使用。", error);
  }

  const today = localDateKey();
  try {
    const journalDate = $("#journal-date");
    if (journalDate) journalDate.value = today;
    loadJournalEditor(today);
  } catch (error) {
    console.error("日誌編輯器初始化失敗：", error);
  }

  listenApi("onDataChanged", (nextData) => {
    rememberServerData(nextData);
    if (pendingPersistCount === 0 && lastPersistedData) {
      data = overlayJournalDrafts(lastPersistedData);
      if (activeRoute === "journal") refreshJournalEditorFromData();
      scheduleRender();
    }
  });
  listenApi("onNavigate", (route) => {
    try { navigate(route); } catch (error) { console.error("切換頁面失敗：", error); }
  });
  listenApi("onCalendarStatusChanged", (status) => {
    calendarStatus = status;
    if (activeRoute === "settings") {
      try { renderSettings(); } catch (error) { console.error("行事曆狀態渲染失敗：", error); }
    }
  });

  try {
    const initialRoute = typeof api.getInitialRoute === "function"
      ? await api.getInitialRoute()
      : "today";
    navigate(initialRoute);
  } catch (error) {
    showRendererError("主畫面渲染失敗，部分功能仍可繼續使用。", error);
  }
  void refreshCalendarStatus(); // 背景重試取得行事曆狀態，徽章就緒後自動更新
  void refreshClaudeStatus();
}

init().catch((error) => {
  showRendererError("初始化失敗，請重新啟動貼身小秘書。", error);
});
