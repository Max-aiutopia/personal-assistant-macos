const assert = require("node:assert/strict");
const { handleVoiceCommand, rescheduleEvent } = require("../src/voiceCommands");
const { applyIntent, resolveBrain } = require("../src/voiceIntent");
const {
  conversationExcerpt,
  contextFallbackResponse,
  normalizeVoiceHistory
} = require("../src/voiceContext");

const now = new Date(2026, 5, 12, 11, 30);
const baseData = {
  tasks: [],
  trash: [],
  journal: {},
  settings: { assistantName: "小光", userName: "Max" },
  notifiedKeys: []
};

const timedReminder = handleVoiceCommand(baseData, "提醒我明天下午三點打電話給客戶", now);
assert.equal(timedReminder.data.tasks.length, 1);
assert.equal(timedReminder.data.tasks[0].title, "打電話給客戶");
assert.equal(timedReminder.data.tasks[0].date, "2026-06-13");
assert.equal(timedReminder.data.tasks[0].reminderTime, "15:00");
assert.equal(timedReminder.data.tasks[0].category, "工作");
assert.equal(timedReminder.data.tasks[0].kind, "event");

const reminder = handleVoiceCommand(baseData, "提醒我明天打電話給客戶", now);
assert.equal(reminder.data.tasks.length, 1);
assert.equal(reminder.data.tasks[0].title, "打電話給客戶");
assert.equal(reminder.data.tasks[0].date, "2026-06-13");
assert.equal(reminder.data.tasks[0].reminderTime, "");
assert.equal(reminder.data.tasks[0].kind, "reminder");

const calendarEvent = handleVoiceCommand(baseData, "幫我安排明天下午兩點拍攝", now);
assert.equal(calendarEvent.data.tasks[0].title, "拍攝");
assert.equal(calendarEvent.data.tasks[0].kind, "event");
assert.equal(calendarEvent.data.tasks[0].reminderTime, "14:00");

const addToCalendar = handleVoiceCommand(baseData, "幫我加到行事曆明天下午四點公司成長會議", now);
assert.equal(addToCalendar.data.tasks[0].title, "公司成長會議");
assert.equal(addToCalendar.data.tasks[0].kind, "event");
assert.equal(addToCalendar.data.tasks[0].reminderTime, "16:00");

const tutoringEvent = handleVoiceCommand(baseData, "幫我記錄七月八號晚上七點到九點有高雄家教", now);
assert.equal(tutoringEvent.data.tasks[0].title, "高雄家教");
assert.equal(tutoringEvent.data.tasks[0].kind, "event");
assert.equal(tutoringEvent.data.tasks[0].date, "2026-07-08");
assert.equal(tutoringEvent.data.tasks[0].reminderTime, "19:00");
assert.equal(tutoringEvent.data.tasks[0].endTime, "21:00");

const multiTutoringEvents = handleVoiceCommand(
  baseData,
  "幫我記錄一下7月8號15號22號29號晚上七點到九點要上高雄的家教",
  now
);
assert.equal(multiTutoringEvents.data.tasks.length, 4);
assert.deepEqual(
  multiTutoringEvents.data.tasks.map((task) => task.date),
  ["2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]
);
assert.equal(new Set(multiTutoringEvents.data.tasks.map((task) => task.title)).size, 1);
assert.equal(multiTutoringEvents.data.tasks[0].title, "高雄家教");
assert.equal(multiTutoringEvents.data.tasks[0].reminderTime, "19:00");
assert.equal(multiTutoringEvents.data.tasks[0].endTime, "21:00");
assert.match(multiTutoringEvents.response, /已新增 4 個行程/);
assert.match(multiTutoringEvents.response, /07\/08、07\/15、07\/22、07\/29/);

const existingFirstTutoringDate = {
  ...baseData,
  tasks: [multiTutoringEvents.data.tasks[0]]
};
const patchedTutoringEvents = handleVoiceCommand(
  existingFirstTutoringDate,
  "幫我記錄一下7月8號15號22號29號晚上七點到九點要上高雄的家教",
  now
);
assert.equal(patchedTutoringEvents.data.tasks.length, 4);
assert.deepEqual(
  patchedTutoringEvents.data.tasks.map((task) => task.date).sort(),
  ["2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]
);
assert.match(patchedTutoringEvents.response, /已新增 3 個行程/);
assert.match(patchedTutoringEvents.response, /07\/08 原本就有了/);

const journal = handleVoiceCommand(baseData, "記錄一下今天完成了企劃書", now);
assert.equal(journal.data.journal["2026-06-12"].done, "今天完成了企劃書");

const schedule = {
  ...reminder.data,
  tasks: [reminder.data.tasks[0], timedReminder.data.tasks[0], calendarEvent.data.tasks[0]]
};
const queriedTasks = handleVoiceCommand(schedule, "明天有什麼待辦", now);
assert.match(queriedTasks.response, /打電話給客戶/);
assert.doesNotMatch(queriedTasks.response, /拍攝/);

const queriedEvents = handleVoiceCommand(schedule, "明天有什麼行程", now);
assert.match(queriedEvents.response, /打電話給客戶/);
assert.match(queriedEvents.response, /拍攝/);

const completed = handleVoiceCommand(reminder.data, "完成打電話給客戶", now);
assert.equal(completed.data.tasks[0].completed, true);

const weekly = handleVoiceCommand(reminder.data, "這週有什麼安排", now);
assert.match(weekly.response, /週六1件待辦、0個行程/);

const deleted = handleVoiceCommand(reminder.data, "刪除待辦打電話給客戶", now);
assert.equal(deleted.data.tasks.length, 0);
assert.equal(deleted.data.trash.length, 1);

const meetingData = {
  ...baseData,
  sync: { pendingEventActions: [] },
  tasks: [
    {
      id: "meeting-1",
      title: "公司成長會議",
      date: "2026-06-13",
      reminderTime: "10:00",
      endDate: "2026-06-13",
      endTime: "11:00",
      kind: "event",
      category: "工作",
      completed: false,
      createdAt: "2026-06-12T01:00:00.000Z",
      updatedAt: "2026-06-12T01:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "event",
        id: "event-1",
        calendarId: "google-calendar",
        source: "Google"
      }
    },
    {
      id: "shoot-1",
      title: "Moutain 拍攝",
      date: "2026-06-15",
      reminderTime: "14:00",
      endDate: "2026-06-15",
      endTime: "16:00",
      kind: "event",
      category: "工作",
      completed: false,
      createdAt: "2026-06-12T01:00:00.000Z",
      updatedAt: "2026-06-12T01:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "event",
        id: "event-2",
        calendarId: "google-calendar",
        source: "Google"
      }
    }
  ]
};

const acceptedMeeting = handleVoiceCommand(meetingData, "接受明天的公司成長會議", now);
assert.equal(acceptedMeeting.data.tasks[0].responseStatus, "accepted");
assert.equal(acceptedMeeting.data.sync.pendingEventActions[0].action, "respond");
assert.equal(acceptedMeeting.data.sync.pendingEventActions[0].responseStatus, "accepted");

const rescheduledMeeting = handleVoiceCommand(meetingData, "把公司成長會議延後半小時", now);
assert.equal(rescheduledMeeting.data.tasks[0].reminderTime, "10:30");
assert.equal(rescheduledMeeting.data.tasks[0].endTime, "11:30");
assert.equal(rescheduledMeeting.data.sync.pendingEventActions[0].action, "reschedule");
assert.equal(rescheduledMeeting.data.sync.pendingEventActions[0].date, "2026-06-13");
assert.equal(rescheduledMeeting.data.sync.pendingEventActions[0].nextReminderTime, "10:30");

const allDayTripData = {
  ...baseData,
  sync: { pendingEventActions: [] },
  tasks: [{
    id: "trip-1",
    title: "三天旅行",
    date: "2026-06-13",
    reminderTime: "",
    endDate: "2026-06-15",
    endTime: "",
    isAllDay: true,
    kind: "event",
    category: "生活",
    completed: false,
    createdAt: "2026-06-12T01:00:00.000Z",
    updatedAt: "2026-06-12T01:00:00.000Z",
    external: {
      provider: "eventkit",
      type: "event",
      id: "trip-event",
      calendarId: "google-calendar",
      source: "Google"
    }
  }]
};
const allDayReschedule = structuredClone(allDayTripData);
const allDayResult = rescheduleEvent(
  allDayReschedule,
  allDayReschedule.tasks[0],
  { date: "2026-06-20" },
  now
);
assert.equal(allDayResult.ok, true);
assert.equal(allDayReschedule.tasks[0].date, "2026-06-20");
assert.equal(allDayReschedule.tasks[0].endDate, "2026-06-22");
assert.equal(allDayReschedule.tasks[0].reminderTime, "");
assert.equal(allDayReschedule.tasks[0].endTime, "");
assert.equal(allDayReschedule.tasks[0].isAllDay, true);
assert.equal(
  allDayReschedule.sync.pendingEventActions[0].nextEndDate,
  "2026-06-22"
);

const declinedShoot = handleVoiceCommand(meetingData, "拒絕 Moutain 拍攝", now);
assert.equal(declinedShoot.data.tasks[1].responseStatus, "declined");

const deletedMeeting = handleVoiceCommand(meetingData, "刪掉行事曆的公司成長會議", now);
assert.equal(deletedMeeting.data.tasks.some((task) => task.title === "公司成長會議"), false);
assert.equal(deletedMeeting.data.trash?.length || 0, 0);
assert.equal(deletedMeeting.data.sync.pendingDeletes.length, 1);
assert.equal(deletedMeeting.data.sync.pendingDeletes[0].id, "event-1");
assert.equal(deletedMeeting.data.sync.pendingDeletes[0].calendarId, "google-calendar");
assert.equal(deletedMeeting.data.sync.deletedExternalItems.length, 1);

const aiDeletedMeeting = applyIntent(meetingData, {
  action: "delete",
  title: "公司成長會議",
  response: "已經刪除完成。"
}, now);
assert.equal(aiDeletedMeeting.data.tasks.some((task) => task.title === "公司成長會議"), false);
assert.equal(aiDeletedMeeting.data.trash?.length || 0, 0);
assert.equal(aiDeletedMeeting.data.sync.pendingDeletes.length, 1);
assert.equal(aiDeletedMeeting.data.sync.pendingDeletes[0].id, "event-1");
assert.equal(aiDeletedMeeting.data.sync.deletedExternalItems.length, 1);

const aiAccepted = applyIntent(meetingData, {
  action: "respond_event",
  title: "公司成長會議",
  date: "2026-06-13",
  responseStatus: "accepted",
  response: "已接受公司成長會議。"
}, now);
assert.equal(aiAccepted.data.tasks[0].responseStatus, "accepted");
assert.equal(aiAccepted.data.sync.pendingEventActions[0].action, "respond");

const aiRescheduled = applyIntent(meetingData, {
  action: "reschedule_event",
  title: "公司成長會議",
  offsetMinutes: 30,
  response: "已延後半小時。"
}, now);
assert.equal(aiRescheduled.data.tasks[0].reminderTime, "10:30");
assert.equal(aiRescheduled.data.tasks[0].endTime, "11:30");

const aiMultiAdd = applyIntent(baseData, {
  action: "add",
  title: "高雄家教",
  date: "2026-07-08",
  time: "19:00",
  endTime: "21:00",
  kind: "event",
  response: "好，我幫你記下來。",
  _transcript: "幫我記錄一下7月8號15號22號29號晚上七點到九點要上高雄的家教"
}, now);
assert.equal(aiMultiAdd.data.tasks.length, 4);
assert.deepEqual(
  aiMultiAdd.data.tasks.map((task) => task.date),
  ["2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]
);
assert.match(aiMultiAdd.response, /已新增 4 個行程/);
assert.doesNotMatch(aiMultiAdd.response, /幫你記下來/);

const aiTimedReminder = applyIntent(baseData, {
  action: "add",
  title: "打電話給客戶",
  date: "2026-06-13",
  time: "15:00",
  kind: "reminder",
  response: "好，我提醒你。",
  _transcript: "提醒我明天下午三點打電話給客戶"
}, now);
assert.equal(aiTimedReminder.data.tasks[0].kind, "event");
assert.equal(aiTimedReminder.data.tasks[0].reminderTime, "15:00");

const missingAddTitle = applyIntent(baseData, {
  action: "add",
  title: "",
  response: "已經幫你新增完成。"
}, now);
assert.equal(missingAddTitle.data.tasks.length, 0);
assert.match(missingAddTitle.response, /內容是什麼/);
assert.doesNotMatch(missingAddTitle.response, /新增完成/);

const unknownAction = applyIntent(baseData, {
  action: "drop_database",
  response: "已經幫你刪除完成。"
}, now);
assert.deepEqual(unknownAction.data, baseData);
assert.match(unknownAction.response, /不確定/);
assert.doesNotMatch(unknownAction.response, /刪除完成/);

const missingCompleteTarget = applyIntent(baseData, {
  action: "complete",
  response: "已標示完成。"
}, now);
assert.equal(missingCompleteTarget.data.tasks.length, 0);
assert.match(missingCompleteTarget.response, /哪一件待辦/);
assert.doesNotMatch(missingCompleteTarget.response, /已標示完成/);

const safeCompleted = applyIntent(reminder.data, {
  action: "complete",
  title: "打電話給客戶",
  response: "已新增另一件事情。"
}, now);
assert.equal(safeCompleted.data.tasks[0].completed, true);
assert.match(safeCompleted.response, /標示完成/);
assert.doesNotMatch(safeCompleted.response, /新增另一件/);

const casualMeetingChat = handleVoiceCommand(baseData, "我覺得明天的客戶會議可能會很久", now);
assert.equal(casualMeetingChat.data.tasks.length, 0);
assert.match(casualMeetingChat.response, /不確定/);

const fallbackAddConfirmation = handleVoiceCommand(
  baseData,
  "幫我安排明天下午兩點拍攝",
  now,
  { requireAddConfirmation: true }
);
assert.equal(fallbackAddConfirmation.data.tasks.length, 0);
assert.equal(fallbackAddConfirmation.confirmationRequired, true);
assert.match(fallbackAddConfirmation.response, /先確認一下/);
assert.match(fallbackAddConfirmation.response, /確認新增/);

const confirmedFallbackAdd = handleVoiceCommand(
  baseData,
  "確認新增明天下午兩點拍攝",
  now,
  { requireAddConfirmation: true }
);
assert.equal(confirmedFallbackAdd.data.tasks.length, 1);
assert.equal(confirmedFallbackAdd.data.tasks[0].title, "拍攝");
assert.equal(confirmedFallbackAdd.data.tasks[0].date, "2026-06-13");
assert.equal(confirmedFallbackAdd.data.tasks[0].reminderTime, "14:00");

assert.equal(resolveBrain({ voiceBrain: "rules", aiVoiceEnabled: true }), "ollama");
assert.equal(resolveBrain({ voiceBrain: "claude", aiVoiceEnabled: true }), "claude");
assert.equal(resolveBrain({ voiceBrain: "rules", aiVoiceEnabled: false }), "rules");

const screenshotNow = new Date(2026, 5, 28, 10, 0);
const stuckAsrText = "幫我新增七月15七月227月293天晚上七點到九點有高雄家教";
const stuckAsrRules = handleVoiceCommand(baseData, stuckAsrText, screenshotNow);
assert.equal(stuckAsrRules.data.tasks.length, 3);
assert.deepEqual(
  stuckAsrRules.data.tasks.map((task) => task.date),
  ["2026-07-15", "2026-07-22", "2026-07-29"]
);
assert.equal(stuckAsrRules.data.tasks[0].title, "高雄家教");
assert.match(stuckAsrRules.response, /07\/15、07\/22、07\/29/);
assert.doesNotMatch(stuckAsrRules.response, /06\/28/);

const stuckAsrAi = applyIntent(baseData, {
  action: "add",
  title: "高雄家教",
  dates: ["2026-07-15", "2026-07-22", "2026-07-29"],
  date: "2026-06-28",
  time: "19:00",
  endTime: "21:00",
  kind: "event",
  response: "好，我幫你新增。",
  _transcript: stuckAsrText
}, screenshotNow);
assert.equal(stuckAsrAi.data.tasks.length, 3);
assert.deepEqual(
  stuckAsrAi.data.tasks.map((task) => task.date),
  ["2026-07-15", "2026-07-22", "2026-07-29"]
);
assert.doesNotMatch(stuckAsrAi.response, /06\/28/);

const sessionHistory = normalizeVoiceHistory({
  history: [
    { role: "user", content: "請幫我確認 7 月 1 日有沒有吃飯行程" },
    { role: "assistant", content: "好，我幫你確認一下 7 月 1 日有沒有吃飯行程。" }
  ]
});
assert.match(conversationExcerpt(sessionHistory), /7 月 1 日/);
const followUp = contextFallbackResponse(sessionHistory, "確認好了嗎");
assert.match(followUp, /7 月 1 日/);
assert.doesNotMatch(followUp, /要確認什麼/);

console.log("✓ 語音新增待辦");
console.log("✓ 語音新增行事曆事件");
console.log("✓ 語音記錄日誌");
console.log("✓ 語音查詢與完成待辦");
console.log("✓ 語音分流待辦與行程");
console.log("✓ 語音刪除可復原");
console.log("✓ 語音會議回覆與改期");
console.log("✓ 語音短期對話記憶");
console.log("語音指令測試全部通過");
