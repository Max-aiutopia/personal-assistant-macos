const api = window.assistantAPI;
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
let taskFilter = "all";
let monthCursor = new Date(); // 月檢視目前顯示的月份（任一日即可）
let selectedMood = "";
let quickJournalTimer;
let undoCountdownTimer;
let calendarStatus = null;
const UNDO_WINDOW_MS = 10_000;

// Lightweight render batching for data-changed broadcasts (reduces redundant full re-renders)
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function localDateKey(date = new Date()) {
  if (dateUtils.dateKey) return dateUtils.dateKey(date);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function formatDate(value, options = {}) {
  const date = typeof value === "string" ? parseDate(value) : value;
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

async function persist() {
  data = await api.saveData(data);
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
  return `<span class="response-pill ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "早安";
  if (hour < 17) return "午安";
  return "晚安";
}

function navigate(route) {
  activeRoute = route;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.route === route));
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

  if (route === "journal") loadJournalEditor($("#journal-date").value || localDateKey());
  if (route === "settings") {
    refreshClaudeStatus();
    refreshCalendarStatus();
  }
  render();
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
      <button class="task-check" data-action="toggle" title="${task.completed ? "標示未完成" : "標示完成"}">
        ${task.completed ? "✓" : ""}
      </button>
      <div>
        <span class="task-title">${escapeHtml(task.title)}</span>
        <span class="task-meta">
          <span class="category-dot" data-category="${escapeHtml(task.category)}"></span>
          ${task.kind === "event" ? "行程" : "待辦"} · ${escapeHtml(task.category || "其他")} · ${dateLabel}${task.reminderTime ? ` · ${task.reminderTime}` : ""}
          ${task.endTime ? `–${task.endTime}` : ""}
          ${task.external?.source ? ` · ${escapeHtml(task.external.source)}` : ""}
          ${isEvent(task) ? responseStatusPill(task) : ""}
          ${task.notes ? ` · ${escapeHtml(task.notes)}` : ""}
        </span>
      </div>
      <div class="task-menu">
        <button data-action="edit" title="編輯">✎</button>
        <button data-action="delete" title="刪除">×</button>
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
      <div>
        <span class="task-title">${escapeHtml(task.title)}</span>
        <span class="task-meta">
          行程 · ${dateLabel}
          ${task.external?.source ? ` · ${escapeHtml(task.external.source)}` : ""}
          ${responseStatusPill(task)}
        </span>
      </div>
      <div class="task-menu">
        <button data-action="edit" title="編輯">✎</button>
        <button data-action="delete" title="刪除">×</button>
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

function renderToday() {
  const today = localDateKey();
  const todayTasks = sortedTasks(data.tasks.filter((task) => isReminder(task) && task.date === today));
  const todayEvents = sortedTasks(data.tasks.filter((task) => eventOccursOnDate(task, today)));
  const openTasks = todayTasks.filter((task) => !task.completed);
  const doneTasks = todayTasks.filter((task) => task.completed);

  $("#today-task-count").textContent = openTasks.length;
  $("#done-task-count").textContent = doneTasks.length;
  $("#today-event-count").textContent = todayEvents.length;
  $("#today-task-note").textContent = openTasks.length ? `還有 ${openTasks.length} 件，照順序慢慢來` : "今天很清爽";
  $("#done-task-note").textContent = doneTasks.length ? `你已經完成 ${doneTasks.length} 件了` : "從第一件開始吧";
  $("#today-task-list").innerHTML = todayTasks.length
    ? todayTasks.slice(0, 5).map(taskRow).join("")
    : emptyState("今天還沒有待辦");
  $("#today-event-list").innerHTML = todayEvents.length
    ? todayEvents.map((task) => eventRow(task, today)).join("")
    : emptyState(data.settings.calendarSyncEnabled ? "今天沒有行程" : "行事曆同步已關閉，請到設定開啟");

  const focusTask = openTasks[0];
  $("#hero-title").textContent = focusTask ? focusTask.title : "今天最重要的一件事是什麼？";
  $("#hero-copy").textContent = focusTask
    ? `${focusTask.reminderTime ? `${focusTask.reminderTime} 提醒你。` : "我已經替你記好了。"} 完成後記得回來打勾。`
    : "先選一件真正重要的事，我會陪你把它完成。";

  const quickEntry = data.journal[today] || {};
  if (document.activeElement !== $("#today-quick-journal")) {
    $("#today-quick-journal").value = quickEntry.done || "";
  }
}

function renderTasks() {
  const today = localDateKey();
  let tasks = sortedTasks(data.tasks.filter(isReminder));
  const overdueTasks = tasks.filter((task) => task.date < today && !task.completed);
  $("#overdue-count").textContent = overdueTasks.length;
  $("#overdue-organizer").hidden = overdueTasks.length === 0;
  if (taskFilter === "overdue") tasks = overdueTasks;
  if (taskFilter === "today") tasks = tasks.filter((task) => task.date === today && !task.completed);
  if (taskFilter === "upcoming") tasks = tasks.filter((task) => task.date > today && !task.completed);
  if (taskFilter === "done") tasks = tasks.filter((task) => task.completed);
  $("#all-task-list").innerHTML = tasks.length ? tasks.map(taskRow).join("") : emptyState("這裡目前沒有事項");
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
      <article class="day-card ${index === 0 ? "today" : ""}">
        <span class="day-name">${index === 0 ? "今天" : index === 1 ? "明天" : formatDate(date, { weekday: "long" })}</span>
        <span class="day-date">${formatDate(date, { month: "numeric", day: "numeric" })}</span>
        ${
          tasks.length
            ? tasks
                .map(
                  (task) => `
                    <div class="day-task" data-task-id="${task.id}">
                      <div class="day-task-body">
                        ${isEvent(task) ? `<time>${escapeHtml(eventTimeLabel(task, key))}</time>` : task.reminderTime ? `<time>${task.reminderTime}</time>` : ""}
                        <span class="day-task-type">${isEvent(task) ? "行程" : "待辦"}</span>
                        ${isEvent(task) ? responseStatusPill(task) : ""}
                        ${escapeHtml(task.title)}
                      </div>
                      <div class="day-task-actions">
                        <button data-action="edit" title="編輯" aria-label="編輯">✎</button>
                        <button data-action="delete" title="刪除" aria-label="刪除">×</button>
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<p class="day-empty">${data.settings.calendarSyncEnabled ? "沒有安排<br />留一點空白也很好" : "行事曆同步已關閉<br />請到設定開啟"}</p>`
        }
      </article>
    `);
  }
  $("#week-board").innerHTML = cards.join("");
}

function renderMonth() {
  const grid = $("#month-grid");
  if (!grid) return;
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const titleEl = $("#month-title");
  if (titleEl) titleEl.textContent = `${year}年${month + 1}月`;

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = localDateKey();

  const weekdays = ["日", "一", "二", "三", "四", "五", "六"]
    .map((w) => `<div class="month-weekday">${w}</div>`)
    .join("");

  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push('<div class="month-cell empty"></div>');

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const key = localDateKey(date);
    const dayItems = sortedTasks(
      data.tasks.filter(
        (task) =>
          (isEvent(task) && eventOccursOnDate(task, key)) ||
          (isReminder(task) && task.date === key)
      )
    );
    const chips = dayItems
      .slice(0, 4)
      .map(
        (task) => `
          <div class="month-chip ${isEvent(task) ? "event" : "reminder"} ${task.completed ? "done" : ""}" data-task-id="${task.id}" title="${escapeHtml(task.title)}">
            ${task.reminderTime ? `<time>${task.reminderTime}</time> ` : ""}${escapeHtml(task.title)}
          </div>`
      )
      .join("");
    const more = dayItems.length > 4 ? `<div class="month-more">＋${dayItems.length - 4}</div>` : "";
    cells.push(`
      <div class="month-cell ${key === todayKey ? "today" : ""}" data-date="${key}">
        <div class="month-daynum">${day}</div>
        <div class="month-chips">${chips}${more}</div>
      </div>
    `);
  }

  grid.innerHTML = `<div class="month-weekdays">${weekdays}</div><div class="month-days">${cells.join("")}</div>`;
}

function handleMonthClick(event) {
  const chip = event.target.closest("[data-task-id]");
  if (chip) {
    const task = data.tasks.find((item) => item.id === chip.dataset.taskId);
    if (task) openTaskDialog(task);
    return;
  }
  const cell = event.target.closest(".month-cell[data-date]");
  if (cell && !cell.classList.contains("empty")) {
    openTaskDialog({ date: cell.dataset.date });
  }
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
            <div class="history-item" data-journal-date="${date}">
              <strong>${formatDate(date, { month: "long", day: "numeric", weekday: "short" })}</strong>
              <p>${escapeHtml(entry.done || entry.feeling || entry.tomorrow)}</p>
            </div>
          `
        )
        .join("")
    : '<div class="empty-state"><div>還沒有日誌<br />今天就寫下第一篇吧</div></div>';
}

function resolveVoiceBrain() {
  const brain = data.settings.voiceBrain;
  if (brain === "claude" || brain === "ollama" || brain === "rules") return brain;
  return data.settings.aiVoiceEnabled ? "ollama" : "rules";
}

function renderSettings() {
  // 使用者正在設定頁編輯時，跳過回填，避免覆蓋輸入 / 游標跳動
  const focused = document.activeElement;
  if (
    focused &&
    focused.closest &&
    focused.closest(".settings-panel") &&
    ["INPUT", "SELECT", "TEXTAREA"].includes(focused.tagName)
  ) {
    $("#brand-name").textContent = data.settings.assistantName || "小光";
    return;
  }

  $("#user-name-input").value = data.settings.userName || "";
  $("#assistant-name-input").value = data.settings.assistantName || "小光";
  $("#brief-time-input").value = data.settings.dailyBriefTime || "09:00";
  $("#notifications-toggle").checked = data.settings.notificationsEnabled !== false;
  $("#launch-toggle").checked = Boolean(data.settings.launchAtLogin);
  $("#voice-auto-listen-toggle").checked = data.settings.voiceAutoListen !== false;
  $("#voice-reply-toggle").checked = data.settings.voiceReplyEnabled !== false;
  $("#voice-auto-hide-toggle").checked = data.settings.voiceAutoHide !== false;
  const brain = resolveVoiceBrain();
  $("#voice-brain-select").value = brain;
  $("#voice-brain-badge").textContent =
    brain === "claude" ? "Claude 雲端" : brain === "ollama" ? "Ollama 本地" : "規則式";
  $("#claude-model-input").value = data.settings.claudeModel || "claude-haiku-4-5";
  $("#voice-privacy-toggle").checked = Boolean(data.settings.voicePrivacyMode);
  $("#ai-model-input").value = data.settings.aiModel || "qwen2.5:3b";
  $("#ollama-url-input").value = data.settings.ollamaUrl || "http://localhost:11434";
  $("#calendar-sync-toggle").checked = Boolean(data.settings.calendarSyncEnabled);
  $("#reminder-sync-toggle").checked = Boolean(data.settings.reminderSyncEnabled);
  renderCalendarOptions();
  renderCalendarSyncStatus();
  renderSyncHealth();
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
      statusEl.textContent = "✅ 已設定（存在本機保護檔，不會再問鑰匙圈密碼）。可按「測試 Claude」確認。";
    } else {
      statusEl.textContent = "尚未設定。貼上 sk-ant- 開頭的金鑰後按儲存（存在本機保護檔）。";
    }
  } catch {
    statusEl.textContent = "無法讀取金鑰狀態。";
  }
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

function renderCalendarOptions() {
  renderSelectOptions(
    $("#calendar-select"),
    calendarStatus?.calendars || [],
    data.settings.calendarId || "",
    "尚未取得行事曆"
  );
  renderSelectOptions(
    $("#reminder-list-select"),
    calendarStatus?.reminderLists || [],
    data.settings.reminderListId || "",
    "尚未取得提醒事項"
  );
}

function readableSyncTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
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
      <span class="sync-health-state">${escapeHtml(state)}</span>
      <strong>${escapeHtml(title)}</strong>
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
  $("#today-date").textContent = formatDate(now, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  });
  renderToday();
  renderTasks();
  renderWeek();
  renderMonth();
  renderJournalHistory();
  renderSettings();
  renderUndoToast();
}

function openTaskDialog(task = null) {
  $("#dialog-title").textContent = task?.id ? "編輯事項" : "新增事項";
  $("#task-id").value = task?.id || "";
  $("#task-title").value = task?.title || "";
  $("#task-date").value = task?.date || localDateKey();
  $("#task-time").value = task?.reminderTime || "";
  $("#task-end-time").value = task?.endTime || "";
  $("#task-kind").value = task?.kind || "reminder";
  $("#task-category").value = task?.category || "工作";
  $("#task-notes").value = task?.notes || "";
  $("#delete-task-button").hidden = !task?.id;
  $("#task-dialog").showModal();
  syncTaskKindFields();
  setTimeout(() => $("#task-title").focus(), 50);
}

// 依「類型」切換時間欄位：行程＝開始時間＋結束時間；待辦＝提醒時間（無結束時間）
function syncTaskKindFields() {
  const isEventKind = $("#task-kind").value === "event";
  $("#task-time-label").textContent = isEventKind ? "開始時間" : "提醒時間";
  $("#task-end-time-row").hidden = !isEventKind;
  updateEndDateHint();
}

function updateEndDateHint() {
  const hint = $("#task-end-date-hint");
  if (!hint) return;
  const isEventKind = $("#task-kind").value === "event";
  const start = $("#task-time").value;
  const end = $("#task-end-time").value;
  const crossesMidnight = Boolean(isEventKind && start && end && end <= start);
  hint.textContent = crossesMidnight ? "結束時間會視為隔天" : "";
  hint.hidden = !crossesMidnight;
}

function loadJournalEditor(date) {
  const entry = data.journal[date] || {};
  $("#journal-date").value = date;
  $("#journal-done").value = entry.done || "";
  $("#journal-feeling").value = entry.feeling || "";
  $("#journal-tomorrow").value = entry.tomorrow || "";
  selectedMood = entry.mood || "";
  $$("#mood-picker button").forEach((button) => button.classList.toggle("active", button.dataset.mood === selectedMood));
  $("#full-journal-status").textContent = "尚未修改";
}

async function handleTaskAction(event) {
  const button = event.target.closest("[data-action]");
  const row = event.target.closest("[data-task-id]");
  if (!button || !row) return;

  const task = data.tasks.find((item) => item.id === row.dataset.taskId);
  if (!task) return;

  if (button.dataset.action === "toggle") {
    if (!isReminder(task)) return;
    task.completed = !task.completed;
    task.completedAt = task.completed ? new Date().toISOString() : null;
    task.updatedAt = new Date().toISOString();
  }
  if (button.dataset.action === "edit") {
    openTaskDialog(task);
    return;
  }
  if (button.dataset.action === "delete") {
    deleteTask(task);
  }

  await persist();
  render();
}

function wireEvents() {
  $("#nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-route]");
    if (button) navigate(button.dataset.route);
  });
  $$("[data-go]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
  $("#quick-add-button").addEventListener("click", () => openTaskDialog());
  $("#close-dialog").addEventListener("click", () => $("#task-dialog").close());
  $("#cancel-dialog").addEventListener("click", () => $("#task-dialog").close());
  $("#delete-task-button").addEventListener("click", async () => {
    const id = $("#task-id").value;
    const task = data.tasks.find((item) => item.id === id);
    if (!task || !deleteTask(task)) return;
    await persist();
    $("#task-dialog").close();
    render();
  });

  $("#task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("#task-id").value;
    const existing = data.tasks.find((task) => task.id === id);
    const task = {
      id: id || uid(),
      title: $("#task-title").value.trim(),
      date: $("#task-date").value,
      reminderTime: $("#task-time").value,
      endTime: $("#task-kind").value === "event" ? $("#task-end-time").value : "",
      kind: $("#task-kind").value,
      category: $("#task-category").value,
      notes: $("#task-notes").value.trim(),
      completed: existing?.completed || false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      completedAt: existing?.completedAt || null,
      updatedAt: new Date().toISOString(),
      origin: existing ? existing.origin : "manual",
      external: existing?.external
    };
    task.endDate =
      task.kind === "event" &&
      task.reminderTime &&
      task.endTime &&
      task.endTime <= task.reminderTime
        ? addDateDays(task.date, 1)
        : task.date;
    if (!task.title || !task.date) return;
    if (existing) Object.assign(existing, task);
    else data.tasks.push(task);
    await persist();
    $("#task-dialog").close();
    render();
  });

  $("#today-task-list").addEventListener("click", handleTaskAction);
  $("#today-event-list").addEventListener("click", handleTaskAction);
  $("#all-task-list").addEventListener("click", handleTaskAction);
  $("#week-board").addEventListener("click", handleTaskAction);
  $("#month-grid").addEventListener("click", handleMonthClick);
  $("#month-prev").addEventListener("click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1);
    renderMonth();
  });
  $("#month-next").addEventListener("click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
    renderMonth();
  });
  $("#month-today").addEventListener("click", () => {
    monthCursor = new Date();
    renderMonth();
  });
  $("#task-kind").addEventListener("change", syncTaskKindFields);
  ["#task-date", "#task-time", "#task-end-time"].forEach((selector) => {
    $(selector).addEventListener("input", updateEndDateHint);
  });

  $("#task-filter").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    taskFilter = button.dataset.filter;
    $$("#task-filter button").forEach((item) => item.classList.toggle("active", item === button));
    renderTasks();
  });
  $("#overdue-organizer").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-overdue-action]");
    if (!button) return;
    const today = localDateKey();
    const tomorrow = localDateKey(addDays(new Date(), 1));
    const now = new Date().toISOString();
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
    await persist();
    render();
  });
  $("#undo-delete-button").addEventListener("click", async () => {
    const trashId = $("#undo-toast").dataset.trashId;
    const entry = (data.trash || []).find((item) => item.id === trashId);
    if (!entry) return;
    data.tasks.push(entry.task);
    data.trash = data.trash.filter((item) => item.id !== trashId);
    await persist();
    render();
  });

  $("#today-quick-journal").addEventListener("input", () => {
    $("#journal-save-status").textContent = "正在保存…";
    clearTimeout(quickJournalTimer);
    quickJournalTimer = setTimeout(async () => {
      const today = localDateKey();
      data.journal[today] = {
        ...(data.journal[today] || {}),
        done: $("#today-quick-journal").value,
        updatedAt: new Date().toISOString()
      };
      await persist();
      $("#journal-save-status").textContent = "已自動保存";
      renderJournalHistory();
    }, 500);
  });

  $("#journal-date").addEventListener("change", (event) => loadJournalEditor(event.target.value));
  $("#mood-picker").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mood]");
    if (!button) return;
    selectedMood = button.dataset.mood;
    $$("#mood-picker button").forEach((item) => item.classList.toggle("active", item === button));
    $("#full-journal-status").textContent = "尚未保存";
  });
  $$(".journal-editor textarea").forEach((input) =>
    input.addEventListener("input", () => {
      $("#full-journal-status").textContent = "尚未保存";
    })
  );
  $("#save-journal-button").addEventListener("click", async () => {
    const date = $("#journal-date").value;
    data.journal[date] = {
      done: $("#journal-done").value.trim(),
      feeling: $("#journal-feeling").value.trim(),
      tomorrow: $("#journal-tomorrow").value.trim(),
      mood: selectedMood,
      updatedAt: new Date().toISOString()
    };
    await persist();
    $("#full-journal-status").textContent = "已保存";
    if (date === localDateKey()) $("#today-quick-journal").value = data.journal[date].done;
    renderJournalHistory();
  });
  $("#journal-history").addEventListener("click", (event) => {
    const item = event.target.closest("[data-journal-date]");
    if (item) loadJournalEditor(item.dataset.journalDate);
  });

  $("#save-settings-button").addEventListener("click", async () => {
    data.settings = {
      ...data.settings,
      userName: $("#user-name-input").value.trim(),
      assistantName: $("#assistant-name-input").value.trim() || "小光",
      dailyBriefTime: $("#brief-time-input").value || "09:00",
      notificationsEnabled: $("#notifications-toggle").checked,
      launchAtLogin: $("#launch-toggle").checked,
      voiceAutoListen: $("#voice-auto-listen-toggle").checked,
      voiceReplyEnabled: $("#voice-reply-toggle").checked,
      voiceAutoHide: $("#voice-auto-hide-toggle").checked,
      calendarSyncEnabled: $("#calendar-sync-toggle").checked,
      reminderSyncEnabled: $("#reminder-sync-toggle").checked,
      calendarId: $("#calendar-select").value || data.settings.calendarId || "",
      reminderListId: $("#reminder-list-select").value || data.settings.reminderListId || "",
      voiceBrain: $("#voice-brain-select").value || "rules",
      aiVoiceEnabled: $("#voice-brain-select").value === "ollama",
      claudeModel: $("#claude-model-input").value.trim() || "claude-haiku-4-5",
      voicePrivacyMode: $("#voice-privacy-toggle").checked,
      aiModel: $("#ai-model-input").value.trim() || "qwen2.5:3b",
      ollamaUrl: $("#ollama-url-input").value.trim() || "http://localhost:11434"
    };
    await api.setLaunchAtLogin(data.settings.launchAtLogin);
    await persist();
    render();
    navigate(activeRoute);
    $("#save-settings-button").textContent = "已儲存";
    setTimeout(() => ($("#save-settings-button").textContent = "儲存設定"), 1200);
  });
  $("#test-voice-button").addEventListener("click", () => api.testVoice());
  $("#test-notification-button").addEventListener("click", () => api.testNotification());
  $("#test-ai-button").addEventListener("click", async () => {
    const btn = $("#test-ai-button");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "測試中…";
    try {
      const res = await api.testAIConnection();
      alert(res?.success ? `✅ 連線成功！模型：${res.model || "未知"}` : `❌ 失敗：${res?.error || "無法連線 Ollama"}`);
    } catch (e) {
      alert("❌ 測試失敗：" + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  $("#save-claude-key-button").addEventListener("click", async () => {
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
          renderSettings();
        }
        btn.textContent = "已儲存 ✓";
      } else {
        btn.textContent = "已清除";
      }
    } catch (e) {
      alert("儲存金鑰失敗：" + e.message);
      btn.textContent = original;
    } finally {
      btn.disabled = false;
      setTimeout(() => (btn.textContent = original), 1500);
    }
  });
  $("#test-claude-button").addEventListener("click", async () => {
    const btn = $("#test-claude-button");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "測試中…";
    try {
      const res = await api.testClaude();
      alert(res?.success ? `✅ Claude 連線成功！模型：${res.model || "未知"}` : `❌ 失敗：${res?.error || "無法連線"}`);
    } catch (e) {
      alert("❌ 測試失敗：" + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
  $("#show-data-button").addEventListener("click", () => api.showDataFile());
  $("#open-accounts-button").addEventListener("click", () => api.openInternetAccounts());
  $("#connect-calendar-button").addEventListener("click", async () => {
    const button = $("#connect-calendar-button");
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
      renderSettings();
    } catch (error) {
      data.sync = { ...(data.sync || {}), lastSyncError: error.message };
      renderCalendarSyncStatus();
    } finally {
      button.disabled = false;
      button.textContent = "連接行事曆";
    }
  });
  $("#sync-calendar-button").addEventListener("click", async () => {
    const button = $("#sync-calendar-button");
    data.settings = {
      ...data.settings,
      calendarSyncEnabled: $("#calendar-sync-toggle").checked,
      reminderSyncEnabled: $("#reminder-sync-toggle").checked,
      calendarId: $("#calendar-select").value || data.settings.calendarId || "",
      reminderListId: $("#reminder-list-select").value || data.settings.reminderListId || ""
    };
    await persist();
    button.disabled = true;
    button.textContent = "同步中…";
    try {
      data = await api.syncCalendars();
      calendarStatus = await api.getCalendarStatus();
    } catch (error) {
      data.sync = { ...(data.sync || {}), lastSyncError: error.message };
    } finally {
      button.disabled = false;
      button.textContent = "立即同步";
      render();
    }
  });
}

async function init() {
  data = await api.getData();
  refreshCalendarStatus(); // 背景重試取得行事曆狀態，徽章就緒後自動更新
  $("#journal-date").value = localDateKey();
  loadJournalEditor(localDateKey());
  wireEvents();
  render();
  navigate("today");
  refreshClaudeStatus();
  api.onDataChanged((nextData) => {
    data = nextData;
    scheduleRender();
  });
  api.onNavigate((route) => navigate(route));
  api.onCalendarStatusChanged((status) => {
    calendarStatus = status;
    renderSettings();
  });
}

init();
