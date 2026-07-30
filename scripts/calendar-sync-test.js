const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  dedupeSyncedTasks,
  enqueueDeletedTasks,
  finalizeExpiredTrash,
  mergeSyncResult,
  mergeSyncResultIfCurrent,
  sameSyncScope
} = require("../src/calendarSync");
const { eventOccursOnDate, eventTimeLabel } = require("../src/eventDates");

const base = {
  tasks: [
    {
      id: "local-1",
      title: "回覆客戶",
      date: "2026-06-12",
      reminderTime: "15:00",
      kind: "reminder",
      completed: false,
      createdAt: "2026-06-12T01:00:00.000Z",
      updatedAt: "2026-06-12T01:00:00.000Z"
    }
  ],
  settings: {},
  sync: { pendingDeletes: [] }
};

const merged = mergeSyncResult(
  base,
  {
    links: [
      {
        localId: "local-1",
        external: {
          provider: "eventkit",
          type: "reminder",
          id: "reminder-1",
          source: "iCloud"
        }
      }
    ],
    externalItems: [
      {
        title: "回覆客戶",
        date: "2026-06-12",
        reminderTime: "15:00",
        endTime: "",
        kind: "reminder",
        notes: "",
        completed: true,
        completedAt: "2026-06-12T02:00:00.000Z",
        updatedAt: "2026-06-12T02:00:00.000Z",
        external: {
          provider: "eventkit",
          type: "reminder",
          id: "reminder-1",
          source: "iCloud"
        }
      },
      {
        title: "Google 會議",
        date: "2026-06-13",
        reminderTime: "10:00",
        endTime: "11:00",
        kind: "event",
        notes: "",
        completed: false,
        responseStatus: "needsAction",
        updatedAt: "2026-06-12T02:00:00.000Z",
        external: {
          provider: "eventkit",
          type: "event",
          id: "event-1",
          source: "Google",
          responseStatus: "needsAction"
        }
      }
    ],
    removedDeletes: [],
    warnings: []
  },
  new Date("2026-06-12T02:01:00.000Z")
);

assert.equal(merged.tasks.length, 2);
assert.equal(merged.tasks.find((task) => task.id === "local-1").completed, true);
assert.equal(merged.tasks.find((task) => task.title === "Google 會議").kind, "event");
assert.equal(merged.tasks.find((task) => task.title === "Google 會議").responseStatus, "needsAction");

const afterDelete = enqueueDeletedTasks(merged, {
  ...merged,
  tasks: merged.tasks.filter((task) => task.id !== "local-1")
});
assert.equal(afterDelete.sync.pendingDeletes.length, 1);
assert.equal(afterDelete.sync.pendingDeletes[0].id, "reminder-1");
assert.equal(afterDelete.sync.pendingDeletes[0].title, "回覆客戶");
assert.equal(afterDelete.sync.pendingDeletes[0].date, "2026-06-12");
assert.equal(afterDelete.sync.deletedExternalItems.length, 1);

const afterDeleteSync = mergeSyncResult(
  afterDelete,
  {
    links: [],
    externalItems: [
      {
        title: "回覆客戶",
        date: "2026-06-12",
        reminderTime: "15:00",
        kind: "reminder",
        completed: false,
        updatedAt: "2026-06-12T02:02:00.000Z",
        external: {
          provider: "eventkit",
          type: "reminder",
          id: "reminder-1",
          source: "iCloud"
        }
      }
    ],
    removedDeletes: afterDelete.sync.pendingDeletes,
    warnings: []
  },
  new Date("2026-06-12T02:03:00.000Z")
);
assert.equal(afterDeleteSync.tasks.some((task) => task.title === "回覆客戶"), false);
assert.equal(afterDeleteSync.sync.pendingDeletes.length, 0);
assert.equal(afterDeleteSync.sync.deletedExternalItems.length, 1);

const softDeleted = enqueueDeletedTasks(merged, {
  ...merged,
  tasks: merged.tasks.filter((task) => task.id !== "local-1"),
  trash: [
    {
      id: "trash-1",
      task: merged.tasks.find((task) => task.id === "local-1"),
      deletedAt: "2026-06-12T02:01:00.000Z",
      expiresAt: "2026-06-12T02:01:10.000Z"
    }
  ]
});
assert.equal(softDeleted.sync.pendingDeletes.length, 0);
const expiredTrash = finalizeExpiredTrash(
  softDeleted,
  new Date("2026-06-12T02:01:11.000Z")
);
assert.equal(expiredTrash.trash.length, 0);
assert.equal(expiredTrash.sync.pendingDeletes.length, 1);

const recurringDuplicates = dedupeSyncedTasks([
  {
    id: "eventkit-occurrence",
    title: "高雄家教",
    date: "2026-06-28",
    reminderTime: "10:00",
    endTime: "21:00",
    updatedAt: "2026-06-12T03:00:00.000Z",
    external: {
      provider: "eventkit",
      type: "event",
      id: "calendar:event@google.com/RID=802490400",
      calendarId: "google-calendar"
    }
  },
  {
    id: "eventkit-occurrence",
    title: "高雄家教",
    date: "2026-06-28",
    reminderTime: "10:00",
    endTime: "12:00",
    updatedAt: "2026-06-12T04:00:00.000Z",
    external: {
      provider: "eventkit",
      type: "event",
      id: "calendar:event@google.com",
      calendarId: "google-calendar"
    }
  },
  {
    id: "eventkit-next-occurrence",
    title: "高雄家教",
    date: "2026-07-05",
    reminderTime: "10:00",
    endTime: "12:00",
    updatedAt: "2026-06-12T04:00:00.000Z",
    external: {
      provider: "eventkit",
      type: "event",
      id: "calendar:event@google.com/RID=803095200",
      calendarId: "google-calendar"
    }
  }
]);
assert.equal(recurringDuplicates.length, 2);
assert.equal(recurringDuplicates[0].external.id, "calendar:event@google.com/RID=802490400");

const sharedIdentifierResult = {
  links: [],
  externalItems: [
    {
      title: "sleep",
      date: "2026-06-12",
      reminderTime: "23:45",
      endDate: "2026-06-13",
      endTime: "08:45",
      kind: "event",
      updatedAt: "2026-06-12T05:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "event",
        id: "shared-sleep-event",
        calendarId: "google-calendar",
        source: "Google"
      }
    },
    {
      title: "sleep",
      date: "2026-06-13",
      reminderTime: "23:45",
      endDate: "2026-06-14",
      endTime: "08:45",
      kind: "event",
      updatedAt: "2026-06-12T05:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "event",
        id: "shared-sleep-event",
        calendarId: "google-calendar",
        source: "Google"
      }
    },
    {
      title: "公司成長會議",
      date: "2026-06-13",
      reminderTime: "10:00",
      endDate: "2026-06-13",
      endTime: "11:00",
      kind: "event",
      updatedAt: "2026-06-12T05:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "event",
        id: "shared-weekly-meeting",
        calendarId: "google-calendar",
        source: "Google"
      }
    },
    {
      title: "公司成長會議",
      date: "2026-06-20",
      reminderTime: "10:00",
      endDate: "2026-06-20",
      endTime: "11:00",
      kind: "event",
      updatedAt: "2026-06-12T05:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "event",
        id: "shared-weekly-meeting",
        calendarId: "google-calendar",
        source: "Google"
      }
    }
  ],
  removedDeletes: [],
  warnings: [],
  synced: { events: true, reminders: false }
};
const sharedIdentifierMerged = mergeSyncResult(
  { tasks: [], trash: [], sync: { pendingDeletes: [], deletedExternalItems: [] } },
  sharedIdentifierResult,
  new Date("2026-06-12T05:01:00.000Z")
);
assert.equal(sharedIdentifierMerged.tasks.length, 4);
assert.equal(new Set(sharedIdentifierMerged.tasks.map((task) => task.id)).size, 4);
assert.equal(
  sharedIdentifierMerged.tasks.filter((task) => eventOccursOnDate(task, "2026-06-13")).length,
  3
);
assert.equal(
  eventTimeLabel(
    sharedIdentifierMerged.tasks.find((task) => task.date === "2026-06-12"),
    "2026-06-13"
  ),
  "延續至 08:45"
);

const allDayTrip = {
  date: "2026-06-13",
  endDate: "2026-06-15",
  reminderTime: "",
  endTime: "",
  isAllDay: true,
  kind: "event"
};
assert.equal(eventOccursOnDate(allDayTrip, "2026-06-13"), true);
assert.equal(eventOccursOnDate(allDayTrip, "2026-06-15"), true);
assert.equal(eventOccursOnDate(allDayTrip, "2026-06-16"), false);
assert.equal(eventTimeLabel(allDayTrip, "2026-06-13"), "全天");
assert.equal(eventTimeLabel(allDayTrip, "2026-06-14"), "全天 · 延續");

const firstSleep = sharedIdentifierMerged.tasks.find(
  (task) => task.title === "sleep" && task.date === "2026-06-12"
);
const oneOccurrenceDeleted = enqueueDeletedTasks(sharedIdentifierMerged, {
  ...sharedIdentifierMerged,
  tasks: sharedIdentifierMerged.tasks.filter((task) => task.id !== firstSleep.id)
});
const afterOccurrenceDelete = mergeSyncResult(
  oneOccurrenceDeleted,
  sharedIdentifierResult,
  new Date("2026-06-12T05:02:00.000Z")
);
assert.equal(
  afterOccurrenceDelete.tasks.some((task) => task.title === "sleep" && task.date === "2026-06-12"),
  false
);
assert.equal(
  afterOccurrenceDelete.tasks.some((task) => task.title === "sleep" && task.date === "2026-06-13"),
  true
);

const pendingEventActionMerged = mergeSyncResult(
  {
    tasks: [],
    trash: [],
    sync: {
      pendingDeletes: [],
      pendingEventActions: [
        {
          action: "respond",
          localId: "eventkit-meeting",
          externalId: "event-1",
          responseStatus: "accepted"
        }
      ],
      deletedExternalItems: []
    }
  },
  {
    links: [],
    externalItems: [],
    removedDeletes: [],
    removedEventActions: [
      {
        action: "respond",
        localId: "eventkit-meeting",
        externalId: "event-1"
      }
    ],
    warnings: [],
    synced: { events: true, reminders: false }
  },
  new Date("2026-06-12T05:03:00.000Z")
);
assert.equal(pendingEventActionMerged.sync.pendingEventActions.length, 0);

const remoteDeletedMerged = mergeSyncResult(
  {
    tasks: [
      {
        id: "eventkit-remote-deleted",
        title: "Google 已刪行程",
        date: "2026-07-08",
        reminderTime: "19:00",
        endDate: "2026-07-08",
        endTime: "21:00",
        kind: "event",
        completed: false,
        createdAt: "2026-06-12T05:00:00.000Z",
        updatedAt: "2026-06-12T05:00:00.000Z",
        external: {
          provider: "eventkit",
          type: "event",
          id: "deleted-google-event",
          calendarId: "google-calendar",
          source: "Google"
        }
      },
      {
        id: "eventkit-other-calendar",
        title: "別的日曆行程",
        date: "2026-07-08",
        reminderTime: "20:00",
        endDate: "2026-07-08",
        endTime: "21:00",
        kind: "event",
        completed: false,
        createdAt: "2026-06-12T05:00:00.000Z",
        updatedAt: "2026-06-12T05:00:00.000Z",
        external: {
          provider: "eventkit",
          type: "event",
          id: "other-calendar-event",
          calendarId: "other-calendar",
          source: "iCloud"
        }
      },
      {
        id: "eventkit-far-future",
        title: "超出同步視窗行程",
        date: "2028-01-01",
        reminderTime: "10:00",
        endDate: "2028-01-01",
        endTime: "11:00",
        kind: "event",
        completed: false,
        createdAt: "2026-06-12T05:00:00.000Z",
        updatedAt: "2026-06-12T05:00:00.000Z",
        external: {
          provider: "eventkit",
          type: "event",
          id: "future-google-event",
          calendarId: "google-calendar",
          source: "Google"
        }
      }
    ],
    trash: [],
    settings: { calendarId: "google-calendar" },
    sync: { pendingDeletes: [], deletedExternalItems: [] }
  },
  {
    links: [],
    externalItems: [],
    removedDeletes: [],
    warnings: [],
    synced: { events: true, reminders: false },
    syncWindow: { eventsStart: "2026-06-01", eventsEnd: "2027-06-01" }
  },
  new Date("2026-06-12T05:04:00.000Z")
);
assert.equal(remoteDeletedMerged.tasks.some((task) => task.title === "Google 已刪行程"), false);
assert.equal(remoteDeletedMerged.tasks.some((task) => task.title === "別的日曆行程"), true);
assert.equal(remoteDeletedMerged.tasks.some((task) => task.title === "超出同步視窗行程"), true);
assert.equal(remoteDeletedMerged.sync.pendingDeletes.length, 0);

const reminderSyncBase = {
  tasks: [
    {
      id: "eventkit-reminder-deleted",
      title: "Google 已刪提醒",
      date: "2026-07-08",
      reminderTime: "09:00",
      kind: "reminder",
      completed: false,
      createdAt: "2026-06-12T05:00:00.000Z",
      updatedAt: "2026-06-12T05:00:00.000Z",
      external: {
        provider: "eventkit",
        type: "reminder",
        id: "deleted-reminder",
        calendarId: "google-reminders",
        source: "Google"
      }
    }
  ],
  trash: [],
  settings: { reminderListId: "google-reminders" },
  sync: {
    pendingDeletes: [],
    deletedExternalItems: [],
    lastReminderSyncAt: "2026-06-12T04:00:00.000Z"
  }
};
const timedOutReminderMerged = mergeSyncResult(
  reminderSyncBase,
  {
    links: [],
    externalItems: [],
    removedDeletes: [],
    warnings: ["提醒事項讀取逾時；本機提醒已保留。"],
    synced: { events: false, reminders: false }
  },
  new Date("2026-06-12T05:04:30.000Z")
);
assert.equal(timedOutReminderMerged.tasks.length, 1);
assert.equal(timedOutReminderMerged.tasks[0].id, "eventkit-reminder-deleted");
assert.equal(
  timedOutReminderMerged.sync.lastReminderSyncAt,
  "2026-06-12T04:00:00.000Z"
);
assert.match(timedOutReminderMerged.sync.warnings[0], /逾時.*保留/);

const remoteReminderDeletedMerged = mergeSyncResult(
  reminderSyncBase,
  {
    links: [],
    externalItems: [],
    removedDeletes: [],
    warnings: [],
    synced: { events: false, reminders: true }
  },
  new Date("2026-06-12T05:05:00.000Z")
);
assert.equal(remoteReminderDeletedMerged.tasks.length, 0);

const stableImported = mergeSyncResult(
  { tasks: [], trash: [], settings: { calendarId: "google-calendar" }, sync: { pendingDeletes: [], deletedExternalItems: [] } },
  {
    links: [],
    externalItems: [{
      title: "穩定識別碼會議", date: "2026-06-20", reminderTime: "10:00", endTime: "11:00",
      kind: "event", updatedAt: "2026-06-12T06:00:00.000Z",
      external: { provider: "eventkit", type: "event", id: "stable-event", calendarId: "google-calendar" }
    }],
    removedDeletes: [], warnings: [], synced: { events: true, reminders: false }
  },
  new Date("2026-06-12T06:01:00.000Z")
);
const stableId = stableImported.tasks[0].id;
const stableRescheduled = mergeSyncResult(
  stableImported,
  {
    links: [],
    externalItems: [{
      title: "穩定識別碼會議", date: "2026-06-21", reminderTime: "14:00", endTime: "15:00",
      kind: "event", updatedAt: "2026-06-12T07:00:00.000Z",
      external: { provider: "eventkit", type: "event", id: "stable-event", calendarId: "google-calendar" }
    }],
    removedDeletes: [], warnings: [], synced: { events: true, reminders: false }
  },
  new Date("2026-06-12T07:01:00.000Z")
);
assert.equal(stableRescheduled.tasks.length, 1);
assert.equal(stableRescheduled.tasks[0].id, stableId);
assert.equal(stableRescheduled.tasks[0].date, "2026-06-21");

const movedTombstone = mergeSyncResult(
  {
    tasks: [], trash: [], settings: { calendarId: "google-calendar" },
    sync: { pendingDeletes: [{ id: "stable-event", type: "event", calendarId: "google-calendar", date: "2026-06-20", reminderTime: "10:00" }], deletedExternalItems: [] }
  },
  {
    links: [], externalItems: [{
      title: "穩定識別碼會議", date: "2026-06-21", reminderTime: "14:00", kind: "event",
      updatedAt: "2026-06-12T07:00:00.000Z",
      external: { provider: "eventkit", type: "event", id: "stable-event", calendarId: "google-calendar" }
    }],
    removedDeletes: [], warnings: [], synced: { events: true, reminders: false }
  },
  new Date("2026-06-12T07:02:00.000Z")
);
assert.equal(movedTombstone.tasks.length, 0);

const startedScope = {
  tasks: [],
  settings: {
    calendarSyncEnabled: true,
    reminderSyncEnabled: false,
    calendarId: "calendar-a",
    reminderListId: ""
  },
  sync: { pendingDeletes: [], pendingEventActions: [], deletedExternalItems: [] }
};
const latestScope = {
  tasks: [{
    id: "b-local",
    title: "B 行事曆現有行程",
    date: "2026-06-22",
    reminderTime: "10:00",
    endDate: "2026-06-22",
    endTime: "11:00",
    kind: "event",
    external: {
      provider: "eventkit",
      type: "event",
      id: "event-b",
      calendarId: "calendar-b"
    }
  }],
  settings: {
    calendarSyncEnabled: true,
    reminderSyncEnabled: false,
    calendarId: "calendar-b",
    reminderListId: ""
  },
  sync: { pendingDeletes: [], pendingEventActions: [], deletedExternalItems: [] }
};
const staleScopeResult = mergeSyncResultIfCurrent(startedScope, latestScope, {
  links: [],
  externalItems: [{
    title: "A 行事曆舊結果",
    date: "2026-06-22",
    reminderTime: "09:00",
    endDate: "2026-06-22",
    endTime: "10:00",
    kind: "event",
    external: {
      provider: "eventkit",
      type: "event",
      id: "event-a",
      calendarId: "calendar-a"
    }
  }],
  removedDeletes: [],
  warnings: [],
  synced: { events: true, reminders: false }
});
assert.equal(sameSyncScope(startedScope, latestScope), false);
assert.equal(staleScopeResult.stale, true);
assert.deepEqual(staleScopeResult.data, latestScope);
assert.equal(
  sameSyncScope(
    startedScope,
    { ...startedScope, settings: { ...startedScope.settings, userName: "Max" } }
  ),
  true
);

const calendarBridgeSource = fs.readFileSync(
  path.join(__dirname, "..", "native", "CalendarBridge.swift"),
  "utf8"
);
assert.ok(
  calendarBridgeSource.includes(
    "func fetchReminders(calendar: EKCalendar) -> (reminders: [EKReminder], completed: Bool)"
  ),
  "Swift helper 必須區分成功取得空清單與 callback 逾時"
);
assert.ok(calendarBridgeSource.includes("case .timedOut:"));
assert.ok(calendarBridgeSource.includes('"reminders": didSyncReminders'));
assert.match(calendarBridgeSource, /提醒事項讀取逾時；.*本機提醒已保留/);

console.log("✓ 合併 Apple／Google 行事曆資料");
console.log("✓ 同步匯入邀請回覆狀態");
console.log("✓ 同步刪除提醒事項");
console.log("✓ 提醒事項 callback 逾時採 fail-closed，本機資料保留");
console.log("✓ 防止雲端舊快照讓已刪除待辦復活");
console.log("✓ 循環行程主事件與 occurrence ID 去重");
console.log("✓ 共用 EventKit ID 的重複行程分開保存");
console.log("✓ 跨午夜行程會在隔日延續顯示");
console.log("✓ 刪除復原期限內不刪除雲端項目");
console.log("✓ 清理已處理的會議同步動作");
console.log("✓ Google／Apple 端刪除會同步移除本機副本");
console.log("✓ 外部行程改期維持本地 ID，墓碑不受日期改動失效");
console.log("✓ 同步途中切換來源時捨棄舊範圍結果");
console.log("行事曆同步測試全部通過");
