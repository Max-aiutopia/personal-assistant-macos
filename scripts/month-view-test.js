const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const {
  addDateDays,
  buildDateItemIndex,
  eventOccursOnDate,
  foldableRoutineCandidates,
  isFoldableRoutine,
  routineScheduleSignature
} = require("../src/utils");

const START = "2026-07-01";
const END = "2026-07-31";

function routineTask(day, overrides = {}) {
  const compactDate = day.replaceAll("-", "");
  return {
    id: `routine-${compactDate}`,
    title: "sleep",
    date: day,
    reminderTime: "23:45",
    endTime: "08:45",
    endDate: addDateDays(day, 1),
    kind: "event",
    isAllDay: false,
    notes: "",
    responseStatus: "accepted",
    external: {
      provider: "eventkit",
      type: "event",
      calendarId: "google-primary",
      id: `daily-sleep/RID=${compactDate}`,
      responseStatus: "accepted"
    },
    ...overrides
  };
}

const routine = Array.from({ length: 31 }, (_, index) => {
  const day = `2026-07-${String(index + 1).padStart(2, "0")}`;
  if (day === "2026-07-16") {
    return routineTask(day, {
      reminderTime: "22:30",
      endTime: "07:30"
    });
  }
  return routineTask(day);
});

const mainRoutine = routine[0];
const scheduleException = routine.find((task) => task.date === "2026-07-16");
const safetyProbes = [
  routineTask("2026-07-01", {
    id: "routine-with-notes",
    notes: "特殊安排"
  }),
  routineTask("2026-07-02", {
    id: "routine-needs-action",
    responseStatus: "needsAction",
    external: {
      ...routineTask("2026-07-02").external,
      responseStatus: "needsAction"
    }
  }),
  routineTask("2026-07-03", {
    id: "routine-reminder",
    kind: "reminder"
  }),
  routineTask("2026-07-04", {
    id: "routine-all-day",
    reminderTime: "",
    endTime: "",
    endDate: "2026-07-04",
    isAllDay: true
  }),
  routineTask("2026-07-05", {
    id: "routine-too-long",
    reminderTime: "07:00",
    endTime: "22:00",
    endDate: "2026-07-05"
  }),
  routineTask("2026-07-06", {
    id: "routine-without-series",
    external: {
      provider: "eventkit",
      type: "event",
      calendarId: "",
      id: ""
    }
  })
];

const shortSeries = [2, 9, 16, 23, 30].map((date) => ({
  ...routineTask(`2026-07-${String(date).padStart(2, "0")}`),
  id: `weekly-${date}`,
  title: "每週會議",
  reminderTime: "10:00",
  endTime: "11:00",
  endDate: `2026-07-${String(date).padStart(2, "0")}`,
  external: {
    provider: "eventkit",
    type: "event",
    calendarId: "google-primary",
    id: `weekly-meeting/RID=202607${String(date).padStart(2, "0")}`
  }
}));

const otherItems = [
  {
    id: "reminder-1",
    title: "繳費",
    date: "2026-07-07",
    reminderTime: "09:00",
    kind: "reminder"
  },
  {
    id: "ordinary-event",
    title: "看牙醫",
    date: "2026-07-08",
    reminderTime: "18:45",
    endTime: "19:45",
    kind: "event",
    external: {
      provider: "eventkit",
      type: "event",
      calendarId: "google-primary",
      id: "ordinary-event"
    }
  },
  {
    id: "previous-night",
    title: "跨月行程",
    date: "2026-06-30",
    reminderTime: "23:00",
    endTime: "01:00",
    endDate: "2026-07-01",
    kind: "event"
  },
  {
    id: "outside-range",
    title: "下個月行程",
    date: "2026-08-01",
    reminderTime: "10:00",
    endTime: "11:00",
    kind: "event"
  }
];

const tasks = [...routine, ...safetyProbes, ...shortSeries, ...otherItems];
const inputSnapshot = JSON.stringify(tasks);
const foldableKeys = foldableRoutineCandidates(tasks, START, END);

assert.equal(foldableKeys.length, 1, "只有高頻且穩定的外部週期行程可收合");
assert.ok(
  foldableKeys[0].endsWith(`|${routineScheduleSignature(mainRoutine)}`),
  "收合鍵應指向佔比超過 90% 的主要時間規律"
);
assert.equal(isFoldableRoutine(mainRoutine, foldableKeys), true);
assert.equal(isFoldableRoutine(scheduleException, foldableKeys), false);
for (const task of safetyProbes) {
  assert.equal(
    isFoldableRoutine(task, foldableKeys),
    false,
    `${task.id} 不得因共用系列識別碼而被誤收合`
  );
}
assert.equal(isFoldableRoutine(shortSeries[0], foldableKeys), false);

const index = buildDateItemIndex(tasks, START, END);
const dateKeys = Object.keys(index);
assert.equal(dateKeys.length, 31);
assert.equal(dateKeys[0], START);
assert.equal(dateKeys.at(-1), END);
for (const day of dateKeys) {
  const expectedIds = tasks
    .filter((task) => (
      task.kind === "event"
        ? eventOccursOnDate(task, day)
        : task.date === day
    ))
    .map((task) => task.id)
    .sort();
  const actualIds = index[day].map((task) => task.id).sort();
  assert.deepEqual(actualIds, expectedIds, `${day} 的完整項目索引不可漏失或重複`);
}
assert.ok(index[START].some((task) => task.id === "previous-night"));
assert.ok(!dateKeys.some((day) => index[day].some((task) => task.id === "outside-range")));
assert.equal(JSON.stringify(tasks), inputSnapshot, "月份分析不可修改原始任務資料");

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

const largeTasks = Array.from({ length: 5_000 }, (_, indexValue) => {
  const day = String((indexValue % 31) + 1).padStart(2, "0");
  if (indexValue % 2 === 0) {
    return {
      id: `large-reminder-${indexValue}`,
      title: `提醒 ${indexValue}`,
      date: `2026-07-${day}`,
      reminderTime: "09:00",
      kind: "reminder"
    };
  }
  return {
    id: `large-event-${indexValue}`,
    title: `行程 ${indexValue}`,
    date: `2026-07-${day}`,
    reminderTime: "10:00",
    endTime: "11:00",
    endDate: `2026-07-${day}`,
    kind: "event",
    external: {
      provider: "eventkit",
      type: "event",
      calendarId: "performance",
      id: `single-${indexValue}`
    }
  };
});

for (let warmup = 0; warmup < 2; warmup += 1) {
  buildDateItemIndex(largeTasks, START, END);
  foldableRoutineCandidates(largeTasks, START, END);
}
const timings = [];
for (let run = 0; run < 10; run += 1) {
  const startedAt = performance.now();
  buildDateItemIndex(largeTasks, START, END);
  foldableRoutineCandidates(largeTasks, START, END);
  timings.push(performance.now() - startedAt);
}
const p95 = percentile95(timings);
assert.ok(
  p95 < 250,
  `5,000 筆資料的月份索引與規律判斷 p95 應低於 250ms，實測 ${p95.toFixed(1)}ms`
);

console.log(
  `✓ 月份收合安全規則、完整索引、無資料突變與效能（5,000 筆 p95 ${p95.toFixed(1)}ms）`
);
