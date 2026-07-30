const assert = require("node:assert/strict");
const { mergeArrayDelta } = require("../src/utils");

const baseTask = {
  id: "task-1",
  title: "原始標題",
  completed: false,
  notes: "原始備註",
  category: "工作",
  createdAt: "2026-07-30T01:00:00.000Z",
  updatedAt: "2026-07-30T01:00:00.000Z",
  external: {
    provider: "eventkit",
    type: "event",
    id: "event-1",
    calendarId: "calendar-1",
    calendarTitle: "原始日曆名稱",
    modifiedAt: "2026-07-30T01:00:00.000Z"
  }
};
const deletedTask = {
  id: "task-delete",
  title: "準備刪除",
  completed: false,
  createdAt: "2026-07-30T01:00:00.000Z",
  updatedAt: "2026-07-30T01:00:00.000Z"
};
const newTask = {
  id: "task-new",
  title: "本機新增",
  completed: false,
  createdAt: "2026-07-30T04:00:00.000Z",
  updatedAt: "2026-07-30T04:00:00.000Z"
};
const remoteOnlyTask = {
  id: "task-remote",
  title: "語音新增",
  completed: false,
  createdAt: "2026-07-30T03:00:00.000Z",
  updatedAt: "2026-07-30T03:00:00.000Z"
};

const baseItems = [baseTask, deletedTask];
const intendedItems = [
  {
    ...structuredClone(baseTask),
    title: "畫面改名",
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2026-07-30T04:00:00.000Z"
  },
  newTask
];
const latestItems = [
  {
    ...structuredClone(baseTask),
    completed: true,
    createdAt: "2088-01-01T00:00:00.000Z",
    updatedAt: "2026-07-30T03:00:00.000Z",
    external: {
      ...structuredClone(baseTask.external),
      calendarTitle: "雲端最新日曆名稱",
      modifiedAt: "2026-07-30T03:00:00.000Z"
    }
  },
  {
    ...deletedTask,
    title: "遠端同時改名",
    updatedAt: "2026-07-30T03:00:00.000Z"
  },
  remoteOnlyTask
];
const inputsBeforeMerge = JSON.stringify({ baseItems, intendedItems, latestItems });
const merged = mergeArrayDelta(baseItems, intendedItems, latestItems);
const mergedTask = merged.items.find((item) => item.id === "task-1");

assert.deepEqual(merged.conflicts, []);
assert.equal(mergedTask.title, "畫面改名");
assert.equal(mergedTask.completed, true);
assert.equal(mergedTask.createdAt, baseTask.createdAt);
assert.equal(mergedTask.updatedAt, "2026-07-30T04:00:00.000Z");
assert.equal(mergedTask.external.calendarTitle, "雲端最新日曆名稱");
assert.equal(mergedTask.external.modifiedAt, "2026-07-30T03:00:00.000Z");
assert.equal(merged.items.some((item) => item.id === "task-delete"), false);
assert.equal(merged.items.find((item) => item.id === "task-new").title, "本機新增");
assert.equal(merged.items.find((item) => item.id === "task-remote").title, "語音新增");
assert.equal(JSON.stringify({ baseItems, intendedItems, latestItems }), inputsBeforeMerge);

const notesConflict = mergeArrayDelta(
  [baseTask],
  [{
    ...structuredClone(baseTask),
    notes: "畫面版本",
    updatedAt: "2026-07-30T04:00:00.000Z"
  }],
  [{
    ...structuredClone(baseTask),
    notes: "語音版本",
    updatedAt: "2026-07-30T03:00:00.000Z"
  }]
);
assert.deepEqual(notesConflict.conflicts, [{ id: "task-1", fields: ["notes"] }]);
assert.equal(
  notesConflict.items.find((item) => item.id === "task-1").notes,
  "語音版本",
  "有衝突時不得靜默以本機值覆蓋 latest"
);

const nestedExternalMerge = mergeArrayDelta(
  [baseTask],
  [{
    ...structuredClone(baseTask),
    external: {
      ...structuredClone(baseTask.external),
      calendarTitle: "畫面選擇的新名稱"
    },
    updatedAt: "2026-07-30T04:00:00.000Z"
  }],
  [{
    ...structuredClone(baseTask),
    external: {
      ...structuredClone(baseTask.external),
      modifiedAt: "2026-07-30T03:00:00.000Z"
    },
    updatedAt: "2026-07-30T03:00:00.000Z"
  }]
);
const nestedTask = nestedExternalMerge.items.find((item) => item.id === "task-1");
assert.deepEqual(nestedExternalMerge.conflicts, []);
assert.equal(nestedTask.external.calendarTitle, "畫面選擇的新名稱");
assert.equal(nestedTask.external.modifiedAt, "2026-07-30T03:00:00.000Z");
assert.equal(nestedTask.external.id, "event-1");

console.log("✓ 事項逐欄位三方合併、衝突回報、新增刪除與 external metadata 保留");
