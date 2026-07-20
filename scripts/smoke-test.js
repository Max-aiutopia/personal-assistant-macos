const DEBUG_ENDPOINT = process.env.DEBUG_ENDPOINT || "http://127.0.0.1:9222";
const TEST_TASK_TITLE = "__貼身小秘書互動測試__";
const TEST_EVENT_TITLE = "__行事曆類型測試__";
const TEST_CROSS_EVENT_TITLE = "__跨午夜行程測試__";
const TEST_OVERDUE_TITLE = "__逾期待辦整理測試__";
const TEST_JOURNAL_MARKER = "__日誌保存測試__";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket 連線失敗")), {
      once: true
    });
  });

  return {
    async evaluate(expression, awaitPromise = true) {
      await ready;
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise,
            returnByValue: true
          }
        })
      );
      const result = await response;
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "頁面程式執行失敗");
      }
      return result.result.value;
    },
    close() {
      socket.close();
    }
  };
}

async function main() {
  const pages = await getPages();
  const mainPage = pages.find((page) => page.title === "貼身小秘書");
  const voicePage = pages.find((page) => page.title === "小光語音");
  if (!mainPage || !voicePage) throw new Error("找不到主視窗或語音視窗");

  const mainClient = createCdpClient(mainPage.webSocketDebuggerUrl);
  const voiceClient = createCdpClient(voicePage.webSocketDebuggerUrl);
  let originalSyncSettings;

  try {
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
      existing.tasks = existing.tasks.filter((task) => ![${JSON.stringify(TEST_TASK_TITLE)}, ${JSON.stringify(TEST_EVENT_TITLE)}, ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, ${JSON.stringify(TEST_OVERDUE_TITLE)}].includes(task.title));
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
      await window.assistantAPI.saveData(withOverdue);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const latest = await window.assistantAPI.getData();
      const event = latest.tasks.find((task) => task.title === ${JSON.stringify(TEST_EVENT_TITLE)});
      document.querySelector('[data-route="month"]').click();
      const monthGrid = document.querySelector('#month-grid');
      const monthDays = monthGrid.querySelector('.month-days');
      const monthHeaders = [...monthGrid.querySelectorAll('.month-weekday')];
      const monthCells = [...monthDays.querySelectorAll(':scope > .month-cell')];
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
        settingsReady,
        endTimeVisible,
        eventKind: event?.kind,
        eventEndTime: event?.endTime,
        monthLayout,
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
      !calendarUi.settingsReady ||
      !calendarUi.endTimeVisible ||
      calendarUi.eventKind !== "event" ||
      calendarUi.eventEndTime !== "15:00" ||
      !calendarUi.monthLayout.sevenColumns ||
      !calendarUi.monthLayout.equalColumns ||
      !calendarUi.monthLayout.headerBodyAligned ||
      !calendarUi.monthLayout.saturdayVisible ||
      !calendarUi.monthLayout.noHorizontalOverflow ||
      !calendarUi.monthLayout.insideViewport ||
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
      document.querySelector('[data-route="journal"]').click();
      document.querySelector('#journal-date').value = date;
      document.querySelector('#journal-done').value = ${JSON.stringify(TEST_JOURNAL_MARKER)};
      document.querySelector('#save-journal-button').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const latest = await window.assistantAPI.getData();
      const ok = latest.journal[date]?.done === ${JSON.stringify(TEST_JOURNAL_MARKER)};
      if (originalJournal) latest.journal[date] = originalJournal;
      else delete latest.journal[date];
      latest.tasks = latest.tasks.filter((task) => ![${JSON.stringify(TEST_TASK_TITLE)}, ${JSON.stringify(TEST_EVENT_TITLE)}, ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, ${JSON.stringify(TEST_OVERDUE_TITLE)}].includes(task.title));
      await window.assistantAPI.saveData(latest);
      await window.assistantAPI.openMain('today');
      return ok;
    })()`);
    if (!journalSaved) throw new Error("日誌內容未保存");

    console.log("✓ 主畫面初始化");
    console.log("✓ 新增與完成待辦");
    console.log("✓ 日誌保存");
    console.log("✓ 語音辨識、朗讀與待辦查詢");
    console.log("✓ 行程與待辦分流");
    console.log("✓ 跨午夜行程延續顯示");
    console.log("✓ 刪除後復原");
    console.log("✓ 逾期待辦整理");
    console.log("✓ 同步健康狀態");
    console.log("互動測試全部通過");
  } finally {
    if (originalSyncSettings) {
      await mainClient.evaluate(`(async () => {
        const latest = await window.assistantAPI.getData();
        latest.tasks = latest.tasks.filter((task) => ![${JSON.stringify(TEST_TASK_TITLE)}, ${JSON.stringify(TEST_EVENT_TITLE)}, ${JSON.stringify(TEST_CROSS_EVENT_TITLE)}, ${JSON.stringify(TEST_OVERDUE_TITLE)}].includes(task.title));
        latest.settings.calendarSyncEnabled = ${JSON.stringify(originalSyncSettings.calendarSyncEnabled)};
        latest.settings.reminderSyncEnabled = ${JSON.stringify(originalSyncSettings.reminderSyncEnabled)};
        latest.settings.voiceBrain = ${JSON.stringify(originalSyncSettings.voiceBrain)};
        latest.settings.aiVoiceEnabled = ${JSON.stringify(originalSyncSettings.aiVoiceEnabled)};
        await window.assistantAPI.saveData(latest);
      })()`).catch(() => {});
    }
    mainClient.close();
    voiceClient.close();
  }
}

main().catch((error) => {
  console.error(`互動測試失敗：${error.message}`);
  process.exitCode = 1;
});
