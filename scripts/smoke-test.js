const DEBUG_ENDPOINT = process.env.DEBUG_ENDPOINT || "http://127.0.0.1:9222";
const TEST_TASK_TITLE = "__貼身小秘書互動測試__";
const TEST_EVENT_TITLE = "__行事曆類型測試__";
const TEST_CROSS_EVENT_TITLE = "__跨午夜行程測試__";
const TEST_ALL_DAY_EVENT_TITLE = "__三天全天行程測試__";
const TEST_OVERDUE_TITLE = "__逾期待辦整理測試__";
const TEST_ROUTINE_TITLE = "__固定安排收合測試__";
const TEST_JOURNAL_MARKER = "__日誌保存測試__";
const CRASH_ONLY = process.env.SMOKE_CRASH_ONLY === "1";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function getPages() {
  const response = await fetch(`${DEBUG_ENDPOINT}/json/list`);
  if (!response.ok) throw new Error(`無法連線到 Electron 偵錯端點：${response.status}`);
  return response.json();
}

function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const { reject } of pending.values()) {
      reject(new Error("CDP WebSocket 已關閉"));
    }
    pending.clear();
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket 連線失敗")), {
      once: true
    });
  });

  async function send(method, params = {}) {
    await ready;
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket 尚未連線或已關閉");
    }
    const id = nextId++;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  return {
    send,
    async evaluate(expression, awaitPromise = true) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "頁面程式執行失敗");
      }
      return result.result.value;
    },
    async crashPage() {
      try {
        await withTimeout(
          send("Page.crash"),
          3000,
          "Page.crash 已觸發但 CDP 連線未及時結束"
        );
      } catch (error) {
        if (/method.*not found|wasn.t found|-32601/i.test(error.message)) throw error;
        if (!/closed|關閉|crash|target|timed out|未及時結束/i.test(error.message)) {
          throw error;
        }
      }
    },
    close() {
      socket.close();
    }
  };
}

async function waitForRecoveredMainClient(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("尚未找到恢復後的主畫面");

  while (Date.now() < deadline) {
    let pages = [];
    try {
      pages = await getPages();
    } catch (error) {
      lastError = error;
    }
    const candidates = pages.filter((page) => page.title === "貼身小秘書");
    for (const page of candidates) {
      const client = createCdpClient(page.webSocketDebuggerUrl);
      try {
        const state = await withTimeout(
          client.evaluate(`(async () => ({
            ready: document.readyState,
            assistantApiReady: Boolean(window.assistantAPI),
            dataReadable: Boolean((await window.assistantAPI?.getData?.())?.tasks),
            mainDomReady: Boolean(
              document.querySelector('#nav') &&
              document.querySelector('#page-title') &&
              document.querySelector('[data-page="month"]') &&
              document.querySelector('#month-grid')
            ),
            monthRouteActive: Boolean(
              document.querySelector('[data-page="month"]')?.classList.contains('active') &&
              document.querySelector('[data-route="month"]')?.getAttribute('aria-current') === 'page'
            )
          }))()`),
          1500,
          "恢復後主畫面尚未完成初始化"
        );
        if (
          state.ready === "complete" &&
          state.assistantApiReady &&
          state.dataReadable &&
          state.mainDomReady &&
          state.monthRouteActive
        ) {
          return { client, state };
        }
        lastError = new Error(`恢復狀態尚未就緒：${JSON.stringify(state)}`);
      } catch (error) {
        lastError = error;
      }
      client.close();
    }
    await wait(200);
  }

  throw new Error(`主 renderer crash 後未在 ${timeoutMs}ms 內恢復：${lastError.message}`);
}

async function verifyMainRendererCrashRecovery(mainClient) {
  const crashRouteReady = await mainClient.evaluate(`(async () => {
    const monthNav = document.querySelector('[data-route="month"]');
    monthNav.click();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const routeReporterReady = typeof window.assistantAPI.setActiveRoute === 'function';
    if (routeReporterReady) window.assistantAPI.setActiveRoute('month');
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      routeReporterReady,
      monthRouteActive:
        document.querySelector('[data-page="month"]').classList.contains('active') &&
        monthNav.getAttribute('aria-current') === 'page'
    };
  })()`);
  if (!crashRouteReady.routeReporterReady || !crashRouteReady.monthRouteActive) {
    throw new Error(`主 renderer crash 前無法鎖定月份 route：${JSON.stringify(crashRouteReady)}`);
  }

  try {
    await mainClient.crashPage();
    return (await waitForRecoveredMainClient()).client;
  } finally {
    mainClient.close();
  }
}

async function main() {
  const pages = await getPages();
  const mainPage = pages.find((page) => page.title === "貼身小秘書");
  const voicePage = pages.find((page) => page.title === "小光語音");
  if (!mainPage || (!CRASH_ONLY && !voicePage)) throw new Error("找不到主視窗或語音視窗");

  let mainClient = createCdpClient(mainPage.webSocketDebuggerUrl);
  const voiceClient = voicePage ? createCdpClient(voicePage.webSocketDebuggerUrl) : null;
  let originalSyncSettings;

  try {
    if (CRASH_ONLY) {
      mainClient = await verifyMainRendererCrashRecovery(mainClient);
      console.log("✓ 主 renderer crash 後自動恢復 API、DOM 與月份 route");
      return;
    }

    const initialState = await mainClient.evaluate(`(() => {
      document.querySelector('[data-route="today"]').click();
      return {
        ready: document.readyState,
        todayPageVisible: document.querySelector('[data-page="today"]').classList.contains('active'),
        assistantApiReady: Boolean(window.assistantAPI)
      };
    })()`);
    if (!initialState.ready || !initialState.todayPageVisible || !initialState.assistantApiReady) {
      throw new Error(`主畫面未正確初始化：${JSON.stringify(initialState)}`);
    }

    originalSyncSettings = await mainClient.evaluate(`(async () => {
      const existing = await window.assistantAPI.getData();
      const original = {
        calendarSyncEnabled: existing.settings.calendarSyncEnabled,
        reminderSyncEnabled: existing.settings.reminderSyncEnabled,
        voiceBrain: existing.settings.voiceBrain,
        aiVoiceEnabled: existing.settings.aiVoiceEnabled
      };
      existing.settings.calendarSyncEnabled = false;
      existing.settings.reminderSyncEnabled = false;
      existing.settings.voiceBrain = 'rules';
      existing.settings.aiVoiceEnabled = false;
      existing.tasks = existing.tasks.filter((task) => ![${JSON.stringify(TEST_TASK_TITLE)}, ${JSON.stringify(TEST_EVENT_TITLE)}, ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, ${JSON.stringify(TEST_ALL_DAY_EVENT_TITLE)}, ${JSON.stringify(TEST_OVERDUE_TITLE)}, ${JSON.stringify(TEST_ROUTINE_TITLE)}].includes(task.title));
      await window.assistantAPI.saveData(existing);
      document.querySelector('#quick-add-button').click();
      document.querySelector('#task-title').value = ${JSON.stringify(TEST_TASK_TITLE)};
      document.querySelector('#task-date').value = new Date().toLocaleDateString('en-CA');
      document.querySelector('#task-time').value = '23:59';
      document.querySelector('#task-category').value = '工作';
      document.querySelector('#task-notes').value = '自動測試建立';
      document.querySelector('#task-form').requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return original;
    })()`);

    const created = await mainClient.evaluate(
      `window.assistantAPI.getData().then((value) => value.tasks.some((task) => task.title === ${JSON.stringify(TEST_TASK_TITLE)}))`
    );
    if (!created) throw new Error("新增待辦未保存");

    const calendarUi = await mainClient.evaluate(`(async () => {
      const status = await window.assistantAPI.getCalendarStatus();
      document.querySelector('[data-route="settings"]').click();
      const settingsReady = Boolean(
        document.querySelector('#calendar-select') &&
        document.querySelector('#reminder-list-select') &&
        document.querySelector('#sync-calendar-button')
      );
      const generalTab = document.querySelector('[data-settings-tab="general"]');
      generalTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const settingsTabsAccessible =
        document.querySelector('[data-settings-tab="sync"]').getAttribute('aria-selected') === 'true' &&
        !document.querySelector('[data-settings-panel="sync"]').hidden &&
        document.querySelectorAll('[data-settings-panel]:not([hidden])').length === 1;
      generalTab.click();
      const nameInput = document.querySelector('#user-name-input');
      const savedNameDraft = nameInput.value;
      nameInput.value = '__背景更新保護__';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      renderSettings();
      const settingsDraftPreserved = nameInput.value === '__背景更新保護__';
      nameInput.value = savedNameDraft;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#quick-add-button').style.display = '';
      document.querySelector('#quick-add-button').click();
      const kind = document.querySelector('#task-kind');
      kind.value = 'event';
      kind.dispatchEvent(new Event('change'));
      const endTimeVisible = !document.querySelector('#task-end-time-row').hidden;
      document.querySelector('#task-title').value = ${JSON.stringify(TEST_EVENT_TITLE)};
      document.querySelector('#task-date').value = new Date().toLocaleDateString('en-CA');
      document.querySelector('#task-time').value = '14:00';
      document.querySelector('#task-end-time').value = '15:00';
      document.querySelector('#task-form').requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const withOverdue = await window.assistantAPI.getData();
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      withOverdue.tasks.push({
        id: 'overdue-smoke-test',
        title: ${JSON.stringify(TEST_OVERDUE_TITLE)},
        date: yesterday.toLocaleDateString('en-CA'),
        reminderTime: '',
        endTime: '',
        kind: 'reminder',
        category: '工作',
        notes: '',
        completed: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
        updatedAt: new Date().toISOString()
      });
      withOverdue.tasks.push({
        id: 'cross-midnight-smoke-test',
        title: ${JSON.stringify(TEST_CROSS_EVENT_TITLE)},
        date: yesterday.toLocaleDateString('en-CA'),
        reminderTime: '23:45',
        endDate: new Date().toLocaleDateString('en-CA'),
        endTime: '08:45',
        kind: 'event',
        category: '健康',
        notes: '',
        completed: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
        updatedAt: new Date().toISOString()
      });
      const routineYear = new Date().getFullYear();
      const routineMonth = new Date().getMonth();
      for (let day = 1; day <= 12; day += 1) {
        const startDate = new Date(routineYear, routineMonth, day);
        const endDate = new Date(routineYear, routineMonth, day + 1);
        withOverdue.tasks.push({
          id: 'routine-smoke-' + day,
          title: ${JSON.stringify(TEST_ROUTINE_TITLE)},
          date: startDate.toLocaleDateString('en-CA'),
          reminderTime: '23:45',
          endDate: endDate.toLocaleDateString('en-CA'),
          endTime: '08:45',
          kind: 'event',
          category: '健康',
          notes: '',
          completed: false,
          createdAt: new Date().toISOString(),
          completedAt: null,
          updatedAt: new Date().toISOString(),
          external: {
            provider: 'eventkit',
            type: 'event',
            calendarId: 'routine-smoke-calendar',
            id: 'routine-smoke-series/RID=' + String(day).padStart(9, '0')
          }
        });
      }
      await window.assistantAPI.saveData(withOverdue);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const latest = await window.assistantAPI.getData();
      const event = latest.tasks.find((task) => task.title === ${JSON.stringify(TEST_EVENT_TITLE)});
      document.querySelector('[data-route="month"]').click();
      const monthGrid = document.querySelector('#month-grid');
      let monthDays = monthGrid.querySelector('.month-days');
      let monthHeaders = [...monthGrid.querySelectorAll('.month-weekday')];
      let monthCells = [...monthDays.querySelectorAll('.month-cell')];
      const focusRoutineTrack = [...monthGrid.querySelectorAll('.month-routine-track')]
        .some((item) => item.textContent.includes(${JSON.stringify(TEST_ROUTINE_TITLE)}));
      const focusHidesRoutineChips = ![...monthGrid.querySelectorAll('.month-chip')]
        .some((item) => item.textContent.includes(${JSON.stringify(TEST_ROUTINE_TITLE)}));
      document.querySelector('[data-month-view="all"]').click();
      const allShowsRoutineChips = [...monthGrid.querySelectorAll('.month-chip')]
        .some((item) => item.textContent.includes(${JSON.stringify(TEST_ROUTINE_TITLE)}));
      document.querySelector('[data-month-view="focus"]').click();
      monthDays = monthGrid.querySelector('.month-days');
      monthHeaders = [...monthGrid.querySelectorAll('.month-weekday')];
      monthCells = [...monthDays.querySelectorAll('.month-cell')];
      const firstRealMonthCell = [...monthGrid.querySelectorAll('.month-cell:not(.empty)')][0];
      const separateDateActions = Boolean(
        firstRealMonthCell.querySelector('[data-day-agenda]') &&
        firstRealMonthCell.querySelector('[data-month-add-date]') &&
        firstRealMonthCell.querySelector('[data-day-agenda]') !== firstRealMonthCell.querySelector('[data-month-add-date]')
      );
      const firstWeekCells = monthCells.slice(0, 7);
      const layoutProbe = document.createElement('div');
      layoutProbe.className = 'month-chip event';
      layoutProbe.textContent = '23:45 這是一段用來確認七欄不會被長行程名稱撐開的版面測試文字';
      firstWeekCells.find((cell) => !cell.classList.contains('empty')).append(layoutProbe);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const monthGridRect = monthGrid.getBoundingClientRect();
      const monthHeaderRects = monthHeaders.map((header) => header.getBoundingClientRect());
      const firstWeekRects = firstWeekCells.map((cell) => cell.getBoundingClientRect());
      const firstWeekWidths = firstWeekRects.map((rect) => rect.width);
      const tolerance = 1;
      const monthLayout = {
        sevenColumns: monthHeaders.length === 7 && firstWeekCells.length === 7,
        equalColumns: Math.max(...firstWeekWidths) - Math.min(...firstWeekWidths) <= tolerance,
        headerBodyAligned: monthHeaderRects.every(
          (rect, index) =>
            Math.abs(rect.left - firstWeekRects[index].left) <= tolerance &&
            Math.abs(rect.right - firstWeekRects[index].right) <= tolerance
        ),
        saturdayVisible: monthCells
          .filter((_, index) => index % 7 === 6)
          .every((cell) => cell.getBoundingClientRect().right <= monthGridRect.right + tolerance),
        noHorizontalOverflow:
          monthDays.scrollWidth <= monthDays.clientWidth + tolerance &&
          monthGrid.scrollWidth <= monthGrid.clientWidth + tolerance,
        insideViewport:
          monthGridRect.left >= -tolerance &&
          monthGridRect.right <= document.documentElement.clientWidth + tolerance,
        widthDelta: Math.max(...firstWeekWidths) - Math.min(...firstWeekWidths)
      };
      layoutProbe.remove();
      const monthDateButtons = [...monthGrid.querySelectorAll('[data-month-date]')];
      const initialMonthTabStops = [...monthGrid.querySelectorAll('button')]
        .filter((button) => button.tabIndex === 0);
      let activeMonthDate = monthDateButtons.find((button) => button.tabIndex === 0);
      activeMonthDate.focus();
      const pressMonthKey = (key) => {
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        );
      };
      const initialMonthIndex = monthDateButtons.indexOf(activeMonthDate);
      const horizontalKey = initialMonthIndex < monthDateButtons.length - 1 ? 'ArrowRight' : 'ArrowLeft';
      const horizontalIndex = horizontalKey === 'ArrowRight' ? initialMonthIndex + 1 : initialMonthIndex - 1;
      pressMonthKey(horizontalKey);
      const horizontalMoved = document.activeElement === monthDateButtons[horizontalIndex];
      activeMonthDate = document.activeElement;
      const horizontalActiveIndex = monthDateButtons.indexOf(activeMonthDate);
      const verticalKey = horizontalActiveIndex + 7 < monthDateButtons.length ? 'ArrowDown' : 'ArrowUp';
      const verticalIndex = verticalKey === 'ArrowDown' ? horizontalActiveIndex + 7 : horizontalActiveIndex - 7;
      pressMonthKey(verticalKey);
      const verticalMoved = document.activeElement === monthDateButtons[verticalIndex];
      activeMonthDate = document.activeElement;
      const beforeHomeIndex = monthDateButtons.indexOf(activeMonthDate);
      const homeIndex = Math.max(0, beforeHomeIndex - Number(activeMonthDate.dataset.monthColumn || 0));
      pressMonthKey('Home');
      const homeMovedToWeekStart = document.activeElement === monthDateButtons[homeIndex];
      activeMonthDate = document.activeElement;
      const beforeEndIndex = monthDateButtons.indexOf(activeMonthDate);
      const endIndex = Math.min(
        monthDateButtons.length - 1,
        beforeEndIndex + (6 - Number(activeMonthDate.dataset.monthColumn || 0))
      );
      pressMonthKey('End');
      const endMovedToWeekEnd = document.activeElement === monthDateButtons[endIndex];
      const singleMonthTabStop =
        initialMonthTabStops.length === 1 &&
        initialMonthTabStops[0].matches('[data-month-date]') &&
        [...monthGrid.querySelectorAll('button')].filter((button) => button.tabIndex === 0).length === 1;
      const monthDetailControlsOutsideTabOrder = [
        ...monthGrid.querySelectorAll('.month-chip, .month-day-add, .month-more, .month-routine-track')
      ].every((button) => button.tabIndex === -1);
      pressMonthKey('Enter');
      const enterOpenedDayAgenda = document.querySelector('#day-dialog').open;
      const dayAgendaKeyboardControls = [...document.querySelectorAll(
        '#day-dialog button:not([disabled]), #day-dialog input:not([disabled]), #day-dialog textarea:not([disabled])'
      )].some((control) => control.tabIndex >= 0);
      document.querySelector('#close-day-dialog').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      monthGrid.querySelector('[data-month-date][tabindex="0"]').focus();
      pressMonthKey(' ');
      const spaceOpenedDayAgenda = document.querySelector('#day-dialog').open;
      document.querySelector('#close-day-dialog').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const monthKeyboard = {
        gridSemantics:
          monthGrid.getAttribute('role') === 'grid' &&
          monthGrid.querySelectorAll('[role="row"]').length >= 2 &&
          monthGrid.querySelectorAll('[role="gridcell"]').length === monthDateButtons.length,
        singleMonthTabStop,
        monthDetailControlsOutsideTabOrder,
        horizontalMoved,
        verticalMoved,
        homeMovedToWeekStart,
        endMovedToWeekEnd,
        enterOpenedDayAgenda,
        spaceOpenedDayAgenda,
        dayAgendaKeyboardControls
      };
      const monthChip = [...document.querySelectorAll('.month-chip')].find((item) =>
        item.textContent.includes(${JSON.stringify(TEST_EVENT_TITLE)})
      );
      if (!monthChip) throw new Error('月曆找不到測試行程');
      monthChip.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const monthDialogDeleteVisible = !document.querySelector('#delete-task-button').hidden;
      document.querySelector('#cancel-dialog').click();
      document.querySelector('[data-route="tasks"]').click();
      const eventInTaskList = document.querySelector('#all-task-list').textContent.includes(${JSON.stringify(TEST_EVENT_TITLE)});
      const overdueVisible = !document.querySelector('#overdue-organizer').hidden;
      document.querySelector('[data-overdue-action="today"]').click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const movedOverdue = (await window.assistantAPI.getData()).tasks.find((task) => task.title === ${JSON.stringify(TEST_OVERDUE_TITLE)});
      document.querySelector('[data-route="week"]').click();
      const eventInWeek = document.querySelector('#week-board').textContent.includes(${JSON.stringify(TEST_EVENT_TITLE)});
      document.querySelector('[data-route="today"]').click();
      const crossEventInToday = document.querySelector('#today-event-list').textContent.includes(${JSON.stringify(TEST_CROSS_EVENT_TITLE)}) &&
        document.querySelector('#today-event-list').textContent.includes('延續至 08:45');
      document.querySelector('[data-route="settings"]').click();
      const healthCards = document.querySelectorAll('#sync-health-grid .sync-health-card').length;
      return {
        statusReady: Boolean(status.authorization),
        calendarHelperNotTopLevel: !String(status.bundle?.path || '').startsWith('/Applications/貼身小秘書同步.app'),
        settingsReady,
        settingsTabsAccessible,
        settingsDraftPreserved,
        endTimeVisible,
        eventKind: event?.kind,
        eventEndTime: event?.endTime,
        monthLayout,
        monthKeyboard,
        focusRoutineTrack,
        focusHidesRoutineChips,
        allShowsRoutineChips,
        separateDateActions,
        monthDialogDeleteVisible,
        eventInTaskList,
        overdueVisible,
        overdueMovedToToday: movedOverdue?.date === new Date().toLocaleDateString('en-CA'),
        eventInWeek,
        crossEventInToday,
        healthCards
      };
    })()`);
    if (
      !calendarUi.statusReady ||
      !calendarUi.calendarHelperNotTopLevel ||
      !calendarUi.settingsReady ||
      !calendarUi.settingsTabsAccessible ||
      !calendarUi.settingsDraftPreserved ||
      !calendarUi.endTimeVisible ||
      calendarUi.eventKind !== "event" ||
      calendarUi.eventEndTime !== "15:00" ||
      !calendarUi.monthLayout.sevenColumns ||
      !calendarUi.monthLayout.equalColumns ||
      !calendarUi.monthLayout.headerBodyAligned ||
      !calendarUi.monthLayout.saturdayVisible ||
      !calendarUi.monthLayout.noHorizontalOverflow ||
      !calendarUi.monthLayout.insideViewport ||
      !calendarUi.monthKeyboard.gridSemantics ||
      !calendarUi.monthKeyboard.singleMonthTabStop ||
      !calendarUi.monthKeyboard.monthDetailControlsOutsideTabOrder ||
      !calendarUi.monthKeyboard.horizontalMoved ||
      !calendarUi.monthKeyboard.verticalMoved ||
      !calendarUi.monthKeyboard.homeMovedToWeekStart ||
      !calendarUi.monthKeyboard.endMovedToWeekEnd ||
      !calendarUi.monthKeyboard.enterOpenedDayAgenda ||
      !calendarUi.monthKeyboard.spaceOpenedDayAgenda ||
      !calendarUi.monthKeyboard.dayAgendaKeyboardControls ||
      !calendarUi.focusRoutineTrack ||
      !calendarUi.focusHidesRoutineChips ||
      !calendarUi.allShowsRoutineChips ||
      !calendarUi.separateDateActions ||
      !calendarUi.monthDialogDeleteVisible ||
      calendarUi.eventInTaskList ||
      !calendarUi.overdueVisible ||
      !calendarUi.overdueMovedToToday ||
      !calendarUi.eventInWeek ||
      !calendarUi.crossEventInToday ||
      calendarUi.healthCards !== 4
    ) {
      throw new Error(`行事曆介面未正確初始化：${JSON.stringify(calendarUi)}`);
    }

    const eventScheduleRoundTrip = await mainClient.evaluate(`(async () => {
      const nextFrame = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const waitForTask = async (predicate, message) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const latest = await window.assistantAPI.getData();
          const task = latest.tasks.find(predicate);
          if (task) return task;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(message);
      };
      const waitForTaskDialogToClose = async () => {
        const deadline = Date.now() + 3000;
        while (document.querySelector('#task-dialog').open && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (document.querySelector('#task-dialog').open) {
          throw new Error('保存後事項對話框未關閉');
        }
      };
      const openTaskBySearch = async (title, expectedId) => {
        document.querySelector('#global-search-button').click();
        await nextFrame();
        if (!document.querySelector('#search-dialog').open) {
          throw new Error('無法開啟全域搜尋來重新編輯測試行程');
        }
        const searchInput = document.querySelector('#global-search-input');
        searchInput.value = title;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        const result = [...document.querySelectorAll(
          '#global-search-results [data-search-task-id]'
        )].find((button) =>
          button.dataset.searchTaskId === expectedId &&
          button.querySelector('strong')?.textContent === title
        );
        if (!result) throw new Error('搜尋找不到要重新編輯的測試行程');
        result.click();
        await nextFrame();
        if (
          !document.querySelector('#task-dialog').open ||
          document.querySelector('#task-id').value !== expectedId
        ) {
          throw new Error('搜尋結果未開啟正確的測試行程');
        }
      };

      const start = new Date();
      const end = new Date(start);
      end.setDate(end.getDate() + 2);
      const startDate = start.toLocaleDateString('en-CA');
      const endDate = end.toLocaleDateString('en-CA');
      const editedNotes = '三天全天行程 round-trip 備註';

      document.querySelector('[data-route="tasks"]').click();
      document.querySelector('#quick-add-button').click();
      document.querySelector('#task-title').value = ${JSON.stringify(TEST_ALL_DAY_EVENT_TITLE)};
      const kindInput = document.querySelector('#task-kind');
      kindInput.value = 'event';
      kindInput.dispatchEvent(new Event('change', { bubbles: true }));
      const startDateInput = document.querySelector('#task-date');
      startDateInput.value = startDate;
      startDateInput.dispatchEvent(new Event('input', { bubbles: true }));
      const allDayInput = document.querySelector('#task-all-day');
      allDayInput.checked = true;
      allDayInput.dispatchEvent(new Event('change', { bubbles: true }));
      const endDateInput = document.querySelector('#task-end-date');
      endDateInput.value = endDate;
      endDateInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#task-form').requestSubmit();

      const created = await waitForTask(
        (task) => task.title === ${JSON.stringify(TEST_ALL_DAY_EVENT_TITLE)},
        '三天全天測試行程未保存'
      );
      await waitForTaskDialogToClose();
      await openTaskBySearch(${JSON.stringify(TEST_ALL_DAY_EVENT_TITLE)}, created.id);

      const openedAllDay = {
        dialogOpen: document.querySelector('#task-dialog').open,
        eventScheduleVisible: !document.querySelector('#task-event-schedule').hidden,
        kind: document.querySelector('#task-kind').value,
        startDate: document.querySelector('#task-date').value,
        endDate: document.querySelector('#task-end-date').value,
        allDayChecked: document.querySelector('#task-all-day').checked,
        startTime: document.querySelector('#task-time').value,
        endTime: document.querySelector('#task-end-time').value,
        startTimeHidden: document.querySelector('#task-start-time-row').hidden,
        endTimeHidden: document.querySelector('#task-end-time-row').hidden,
        threeDayHint: document.querySelector('#task-schedule-hint').textContent.includes('3 天')
      };

      document.querySelector('#task-notes').value = editedNotes;
      document.querySelector('#task-form').requestSubmit();
      const edited = await waitForTask(
        (task) => task.id === created.id && task.notes === editedNotes,
        '三天全天測試行程重新編輯後未保存'
      );
      await waitForTaskDialogToClose();

      const latest = await window.assistantAPI.getData();
      const crossMidnight = latest.tasks.find(
        (task) => task.title === ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}
      );
      if (!crossMidnight) throw new Error('找不到跨午夜測試行程');
      await openTaskBySearch(${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, crossMidnight.id);
      const openedCrossMidnight = {
        eventScheduleVisible: !document.querySelector('#task-event-schedule').hidden,
        kind: document.querySelector('#task-kind').value,
        startDate: document.querySelector('#task-date').value,
        endDate: document.querySelector('#task-end-date').value,
        allDayChecked: document.querySelector('#task-all-day').checked,
        startTime: document.querySelector('#task-time').value,
        endTime: document.querySelector('#task-end-time').value
      };
      document.querySelector('#cancel-dialog').click();

      return {
        expected: { startDate, endDate, editedNotes },
        created: {
          date: created.date,
          isAllDay: created.isAllDay,
          reminderTime: created.reminderTime,
          endTime: created.endTime,
          endDate: created.endDate
        },
        openedAllDay,
        edited: {
          title: edited.title,
          notes: edited.notes,
          date: edited.date,
          isAllDay: edited.isAllDay,
          reminderTime: edited.reminderTime,
          endTime: edited.endTime,
          endDate: edited.endDate
        },
        crossExpected: {
          startDate: crossMidnight.date,
          endDate: crossMidnight.endDate,
          startTime: crossMidnight.reminderTime,
          endTime: crossMidnight.endTime
        },
        openedCrossMidnight
      };
    })()`);
    if (
      eventScheduleRoundTrip.created.date !== eventScheduleRoundTrip.expected.startDate ||
      eventScheduleRoundTrip.created.isAllDay !== true ||
      eventScheduleRoundTrip.created.reminderTime !== "" ||
      eventScheduleRoundTrip.created.endTime !== "" ||
      eventScheduleRoundTrip.created.endDate !== eventScheduleRoundTrip.expected.endDate ||
      !eventScheduleRoundTrip.openedAllDay.dialogOpen ||
      !eventScheduleRoundTrip.openedAllDay.eventScheduleVisible ||
      eventScheduleRoundTrip.openedAllDay.kind !== "event" ||
      eventScheduleRoundTrip.openedAllDay.startDate !== eventScheduleRoundTrip.expected.startDate ||
      eventScheduleRoundTrip.openedAllDay.endDate !== eventScheduleRoundTrip.expected.endDate ||
      !eventScheduleRoundTrip.openedAllDay.allDayChecked ||
      eventScheduleRoundTrip.openedAllDay.startTime !== "" ||
      eventScheduleRoundTrip.openedAllDay.endTime !== "" ||
      !eventScheduleRoundTrip.openedAllDay.startTimeHidden ||
      !eventScheduleRoundTrip.openedAllDay.endTimeHidden ||
      !eventScheduleRoundTrip.openedAllDay.threeDayHint ||
      eventScheduleRoundTrip.edited.title !== TEST_ALL_DAY_EVENT_TITLE ||
      eventScheduleRoundTrip.edited.notes !== eventScheduleRoundTrip.expected.editedNotes ||
      eventScheduleRoundTrip.edited.date !== eventScheduleRoundTrip.expected.startDate ||
      eventScheduleRoundTrip.edited.isAllDay !== true ||
      eventScheduleRoundTrip.edited.reminderTime !== "" ||
      eventScheduleRoundTrip.edited.endTime !== "" ||
      eventScheduleRoundTrip.edited.endDate !== eventScheduleRoundTrip.expected.endDate ||
      !eventScheduleRoundTrip.openedCrossMidnight.eventScheduleVisible ||
      eventScheduleRoundTrip.openedCrossMidnight.kind !== "event" ||
      eventScheduleRoundTrip.openedCrossMidnight.startDate !==
        eventScheduleRoundTrip.crossExpected.startDate ||
      eventScheduleRoundTrip.crossExpected.endDate ===
        eventScheduleRoundTrip.crossExpected.startDate ||
      eventScheduleRoundTrip.openedCrossMidnight.endDate !==
        eventScheduleRoundTrip.crossExpected.endDate ||
      eventScheduleRoundTrip.openedCrossMidnight.allDayChecked ||
      eventScheduleRoundTrip.openedCrossMidnight.startTime !==
        eventScheduleRoundTrip.crossExpected.startTime ||
      eventScheduleRoundTrip.openedCrossMidnight.endTime !==
        eventScheduleRoundTrip.crossExpected.endTime
    ) {
      throw new Error(
        `跨日／全天行程 round-trip 未正確保存：${JSON.stringify(eventScheduleRoundTrip)}`
      );
    }

    const accessibilityUi = await mainClient.evaluate(`(async () => {
      const nextFrame = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const todayNav = document.querySelector('[data-route="today"]');
      todayNav.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await nextFrame();
      const dataGo = document.querySelector('[data-page="today"] [data-go="tasks"]');
      dataGo.focus();
      dataGo.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      await nextFrame();
      const keyboardDataGoFocusedHeading =
        document.querySelector('[data-page="tasks"]').classList.contains('active') &&
        document.activeElement === document.querySelector('#page-title');

      todayNav.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await nextFrame();
      dataGo.focus();
      dataGo.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await nextFrame();
      const mouseDataGoKeptFocus =
        document.querySelector('[data-page="tasks"]').classList.contains('active') &&
        document.activeElement !== document.querySelector('#page-title');

      document.querySelector('#global-search-button').click();
      await nextFrame();
      const searchInput = document.querySelector('#global-search-input');
      searchInput.value = '測試';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      const firstResult = document.querySelector('#global-search-results [role="option"]');
      const resultCount = document.querySelectorAll('#global-search-results [role="option"]').length;
      const comboboxLinked =
        searchInput.getAttribute('role') === 'combobox' &&
        searchInput.getAttribute('aria-controls') === 'global-search-results' &&
        searchInput.getAttribute('aria-expanded') === 'true' &&
        !searchInput.hasAttribute('aria-activedescendant') &&
        resultCount >= 2;
      searchInput.focus();
      searchInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      );
      const firstArrowSelectedFirst =
        document.activeElement === searchInput &&
        searchInput.getAttribute('aria-activedescendant') === firstResult?.id &&
        firstResult?.getAttribute('aria-selected') === 'true';
      const expectedTaskId = firstResult?.dataset.searchTaskId;
      searchInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      await nextFrame();
      const enterOpenedAnnouncedResult =
        document.querySelector('#task-dialog').open &&
        document.querySelector('#task-id').value === expectedTaskId;
      const collapsedAfterSearchClosed =
        searchInput.getAttribute('aria-expanded') === 'false' &&
        !searchInput.hasAttribute('aria-activedescendant');
      document.querySelector('#cancel-dialog').click();
      await nextFrame();

      return {
        keyboardDataGoFocusedHeading,
        mouseDataGoKeptFocus,
        comboboxLinked,
        firstArrowSelectedFirst,
        enterOpenedAnnouncedResult,
        collapsedAfterSearchClosed
      };
    })()`);
    if (
      !accessibilityUi.keyboardDataGoFocusedHeading ||
      !accessibilityUi.mouseDataGoKeptFocus ||
      !accessibilityUi.comboboxLinked ||
      !accessibilityUi.firstArrowSelectedFirst ||
      !accessibilityUi.enterOpenedAnnouncedResult ||
      !accessibilityUi.collapsedAfterSearchClosed
    ) {
      throw new Error(`鍵盤與搜尋可及性未正確初始化：${JSON.stringify(accessibilityUi)}`);
    }

    const voiceState = await voiceClient.evaluate(`(async () => {
      const result = await window.assistantAPI.processVoice('今天有什麼待辦');
      const followUp = await window.assistantAPI.processVoice('確認好了嗎', {
        conversationId: 'smoke-session',
        history: [
          { role: 'user', content: '請幫我確認 7 月 1 日有沒有吃飯行程' },
          { role: 'assistant', content: '好，我幫你確認一下 7 月 1 日有沒有吃飯行程。' }
        ]
      });
      return {
        response: result.response,
        followUpResponse: followUp.response,
        recognitionReady: typeof window.assistantAPI.startVoiceListening === 'function',
        speechReady: typeof speechSynthesis === 'object'
      };
    })()`);
    if (!voiceState.response.includes(TEST_TASK_TITLE)) throw new Error("語音查詢未讀取新的待辦");
    if (!voiceState.followUpResponse.includes('7 月 1 日') || /要確認什麼/.test(voiceState.followUpResponse)) {
      throw new Error(`語音短期記憶未正確帶入：${voiceState.followUpResponse}`);
    }
    if (!voiceState.recognitionReady || !voiceState.speechReady) throw new Error("語音引擎未正確載入");

    const undoWorked = await mainClient.evaluate(`(async () => {
      document.querySelector('[data-route="tasks"]').click();
      const rows = [...document.querySelectorAll('[data-task-id]')];
      const row = rows.find((item) => item.querySelector('.task-title')?.textContent === ${JSON.stringify(TEST_TASK_TITLE)});
      if (!row) throw new Error('找不到測試待辦列');
      row.querySelector('[data-action="delete"]').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const deleted = !(await window.assistantAPI.getData()).tasks.some((task) => task.title === ${JSON.stringify(TEST_TASK_TITLE)});
      document.querySelector('#undo-delete-button').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const restored = (await window.assistantAPI.getData()).tasks.some((task) => task.title === ${JSON.stringify(TEST_TASK_TITLE)});
      return deleted && restored;
    })()`);
    if (!undoWorked) throw new Error("刪除復原未正確保存");

    await mainClient.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-task-id]')];
      const row = rows.find((item) => item.querySelector('.task-title')?.textContent === ${JSON.stringify(TEST_TASK_TITLE)});
      if (!row) throw new Error('復原後找不到測試待辦列');
      row.querySelector('[data-action="toggle"]').click();
      return true;
    })()`);
    await wait(250);

    const completed = await mainClient.evaluate(
      `window.assistantAPI.getData().then((value) => value.tasks.find((task) => task.title === ${JSON.stringify(TEST_TASK_TITLE)})?.completed)`
    );
    if (!completed) throw new Error("待辦完成狀態未保存");

    const journalSaved = await mainClient.evaluate(`(async () => {
      const date = new Date().toLocaleDateString('en-CA');
      const before = await window.assistantAPI.getData();
      const originalJournal = before.journal[date];
      document.querySelector('[data-route="today"]').click();
      const quickJournal = document.querySelector('#today-quick-journal');
      quickJournal.value = ${JSON.stringify(TEST_JOURNAL_MARKER)};
      quickJournal.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-route="journal"]').click();
      const immediateLoaded = document.querySelector('#journal-done').value === ${JSON.stringify(TEST_JOURNAL_MARKER)};
      await new Promise((resolve) => setTimeout(resolve, 900));
      const latest = await window.assistantAPI.getData();
      const ok = latest.journal[date]?.done === ${JSON.stringify(TEST_JOURNAL_MARKER)};
      if (originalJournal) latest.journal[date] = originalJournal;
      else delete latest.journal[date];
      latest.tasks = latest.tasks.filter((task) => ![${JSON.stringify(TEST_TASK_TITLE)}, ${JSON.stringify(TEST_EVENT_TITLE)}, ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, ${JSON.stringify(TEST_ALL_DAY_EVENT_TITLE)}, ${JSON.stringify(TEST_OVERDUE_TITLE)}].includes(task.title));
      await window.assistantAPI.saveData(latest);
      await window.assistantAPI.openMain('today');
      return immediateLoaded && ok;
    })()`);
    if (!journalSaved) throw new Error("日誌內容未保存");

    mainClient = await verifyMainRendererCrashRecovery(mainClient);

    console.log("✓ 主畫面初始化");
    console.log("✓ 新增與完成待辦");
    console.log("✓ 日誌保存");
    console.log("✓ 日誌快速輸入立即帶入完整編輯器");
    console.log("✓ 語音辨識、朗讀與待辦查詢");
    console.log("✓ 行程與待辦分流");
    console.log("✓ 跨午夜行程延續顯示");
    console.log("✓ 三天全天行程與跨午夜編輯 round-trip");
    console.log("✓ 刪除後復原");
    console.log("✓ 逾期待辦整理");
    console.log("✓ 同步健康狀態");
    console.log("✓ 設定分類鍵盤操作與草稿保護");
    console.log("✓ 月曆重點／全部模式與固定安排收合");
    console.log("✓ data-go 鍵盤切頁焦點與滑鼠焦點保留");
    console.log("✓ 搜尋 combobox 選取與 ARIA 狀態");
    console.log("✓ 月曆單一 Tab 入口與方向鍵日程操作");
    console.log("✓ 主 renderer crash 後自動恢復 API、DOM 與月份 route");
    console.log("互動測試全部通過");
  } finally {
    if (originalSyncSettings) {
      await mainClient.evaluate(`(async () => {
        const latest = await window.assistantAPI.getData();
        latest.tasks = latest.tasks.filter((task) => ![${JSON.stringify(TEST_TASK_TITLE)}, ${JSON.stringify(TEST_EVENT_TITLE)}, ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, ${JSON.stringify(TEST_ALL_DAY_EVENT_TITLE)}, ${JSON.stringify(TEST_OVERDUE_TITLE)}, ${JSON.stringify(TEST_ROUTINE_TITLE)}].includes(task.title));
        latest.settings.calendarSyncEnabled = ${JSON.stringify(originalSyncSettings.calendarSyncEnabled)};
        latest.settings.reminderSyncEnabled = ${JSON.stringify(originalSyncSettings.reminderSyncEnabled)};
        latest.settings.voiceBrain = ${JSON.stringify(originalSyncSettings.voiceBrain)};
        latest.settings.aiVoiceEnabled = ${JSON.stringify(originalSyncSettings.aiVoiceEnabled)};
        await window.assistantAPI.saveData(latest);
      })()`).catch(() => {});
    }
    mainClient.close();
    voiceClient?.close();
  }
}

main().catch((error) => {
  console.error(`互動測試失敗：${error.message}`);
  process.exitCode = 1;
});
