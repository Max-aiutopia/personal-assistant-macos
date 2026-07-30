const dateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function parseDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const [year, month, day] = String(value || "").split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function addDateDays(value, amount) {
  const date = parseDateKey(value);
  if (!date) return value || "";
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}

function eventEndDate(task) {
  if (task.endDate) return task.endDate;
  if (
    task.date &&
    task.reminderTime &&
    task.endTime &&
    task.endTime <= task.reminderTime
  ) {
    return addDateDays(task.date, 1);
  }
  return task.date || "";
}

function eventOccursOnDate(task, targetDate) {
  if (task?.kind !== "event" || !task.date || !targetDate) return false;
  if (task.date === targetDate) return true;
  if (targetDate < task.date) return false;
  const endDate = eventEndDate(task);
  if (!endDate || targetDate > endDate) return false;
  if (task.isAllDay || (!task.reminderTime && !task.endTime)) return true;
  if (!task.reminderTime) return false;
  return !(targetDate === endDate && task.endTime === "00:00");
}

function eventTimeLabel(task, targetDate) {
  if (task.isAllDay || (!task.reminderTime && !task.endTime)) {
    return targetDate === task.date ? "全天" : "全天 · 延續";
  }
  if (targetDate !== task.date) {
    return task.endTime ? `延續至 ${task.endTime}` : "延續行程";
  }
  if (!task.reminderTime) return "全天";
  return task.endTime ? `${task.reminderTime}–${task.endTime}` : task.reminderTime;
}

function recurringBaseId(value) {
  return String(value || "").replace(/\/RID=\d+$/i, "");
}

function routineSeriesKey(task) {
  const external = task?.external || {};
  const baseId = recurringBaseId(external.id);
  if (!baseId || !external.calendarId) return "";
  return `${external.calendarId}|${baseId}`;
}

function routineScheduleSignature(task) {
  return [
    String(task?.title || "").normalize("NFKC").trim().toLocaleLowerCase("zh-TW"),
    task?.reminderTime || "",
    task?.endTime || "",
    task?.isAllDay ? "all-day" : "timed"
  ].join("|");
}

function timeMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ""))) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isRoutineInstanceEligible(task) {
  const external = task?.external || {};
  if (
    task?.kind !== "event" ||
    !task.date ||
    task.isAllDay ||
    task.notes ||
    external.provider !== "eventkit" ||
    external.type !== "event" ||
    !routineSeriesKey(task)
  ) {
    return false;
  }
  const responseStatus = task.responseStatus || task.external?.responseStatus || "";
  if (["needsAction", "tentative", "declined"].includes(responseStatus)) return false;
  const startMinutes = timeMinutes(task.reminderTime);
  const endMinutes = timeMinutes(task.endTime);
  if (startMinutes === null || endMinutes === null) return false;
  const start = parseDateKey(task.date);
  const end = parseDateKey(eventEndDate(task));
  if (!start || !end) return false;
  const durationMinutes =
    (end.getTime() - start.getTime()) / 60_000 + endMinutes - startMinutes;
  return durationMinutes >= 0 && durationMinutes <= 12 * 60;
}

function foldableRoutineCandidates(tasks = [], startKey, endKey, minimumDates = 12) {
  const series = new Map();
  for (const task of tasks) {
    if (
      !isRoutineInstanceEligible(task) ||
      task.date < startKey ||
      task.date > endKey
    ) {
      continue;
    }
    const seriesKey = routineSeriesKey(task);
    const schedule = routineScheduleSignature(task);
    if (!series.has(seriesKey)) series.set(seriesKey, new Map());
    const scheduleDates = series.get(seriesKey);
    if (!scheduleDates.has(schedule)) scheduleDates.set(schedule, new Set());
    scheduleDates.get(schedule).add(task.date);
  }

  const foldable = new Set();
  for (const [seriesKey, schedules] of series) {
    const totalDates = new Set(
      [...schedules.values()].flatMap((dates) => [...dates])
    ).size;
    if (totalDates < minimumDates) continue;
    for (const [schedule, dates] of schedules) {
      if (dates.size >= minimumDates && dates.size / totalDates >= 0.9) {
        foldable.add(`${seriesKey}|${schedule}`);
      }
    }
  }
  return [...foldable];
}

function isFoldableRoutine(task, foldableKeys) {
  if (!isRoutineInstanceEligible(task)) return false;
  const seriesKey = routineSeriesKey(task);
  const key = `${seriesKey}|${routineScheduleSignature(task)}`;
  return foldableKeys instanceof Set
    ? foldableKeys.has(key)
    : Array.isArray(foldableKeys) && foldableKeys.includes(key);
}

function buildDateItemIndex(tasks = [], startKey, endKey) {
  const index = {};
  const rangeStart = parseDateKey(startKey);
  const rangeEnd = parseDateKey(endKey);
  if (!rangeStart || !rangeEnd || startKey > endKey) return index;

  for (let cursor = new Date(rangeStart); cursor <= rangeEnd; cursor = addDays(cursor, 1)) {
    index[dateKey(cursor)] = [];
  }

  for (const task of tasks) {
    if (!task?.date) continue;
    if (task.kind !== "event") {
      if (index[task.date]) index[task.date].push(task);
      continue;
    }
    const eventStart = task.date > startKey ? task.date : startKey;
    const endDate = eventEndDate(task);
    const eventEnd = endDate < endKey ? endDate : endKey;
    if (eventStart > eventEnd) continue;
    const cursorStart = parseDateKey(eventStart);
    const cursorEnd = parseDateKey(eventEnd);
    if (!cursorStart || !cursorEnd) continue;
    for (let cursor = cursorStart; cursor <= cursorEnd; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      if (index[key] && eventOccursOnDate(task, key)) index[key].push(task);
    }
  }
  return index;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => dataValuesEqual(value, right[index]))
    );
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          dataValuesEqual(left[key], right[key])
      )
    );
  }
  return false;
}

function cloneDataValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mergeValueState(base, intended, latest, path) {
  const statesEqual = (left, right) =>
    left.present === right.present &&
    (!left.present || dataValuesEqual(left.value, right.value));
  const localChanged = !statesEqual(base, intended);
  const remoteChanged = !statesEqual(base, latest);

  if (!localChanged) {
    return { ...latest, value: cloneDataValue(latest.value), conflicts: [] };
  }
  if (!remoteChanged || statesEqual(intended, latest)) {
    return { ...intended, value: cloneDataValue(intended.value), conflicts: [] };
  }
  if (
    base.present &&
    intended.present &&
    latest.present &&
    isPlainObject(base.value) &&
    isPlainObject(intended.value) &&
    isPlainObject(latest.value)
  ) {
    const nested = mergePlainObject(base.value, intended.value, latest.value, path);
    return { present: true, value: nested.value, conflicts: nested.conflicts };
  }

  return {
    ...latest,
    value: cloneDataValue(latest.value),
    conflicts: [path]
  };
}

function mergePlainObject(base = {}, intended = {}, latest = {}, parentPath = "") {
  const value = {};
  const conflicts = [];
  const keys = [
    ...new Set([
      ...Object.keys(latest),
      ...Object.keys(intended),
      ...Object.keys(base)
    ])
  ];

  for (const key of keys) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    const merged = mergeValueState(
      {
        present: Object.prototype.hasOwnProperty.call(base, key),
        value: base[key]
      },
      {
        present: Object.prototype.hasOwnProperty.call(intended, key),
        value: intended[key]
      },
      {
        present: Object.prototype.hasOwnProperty.call(latest, key),
        value: latest[key]
      },
      path
    );
    conflicts.push(...merged.conflicts);
    if (merged.present) value[key] = merged.value;
  }

  return { value, conflicts };
}

function newestTimestamp(...values) {
  let newest = "";
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed) && parsed >= newestTime) {
      newest = value;
      newestTime = parsed;
    }
  }
  if (newest) return newest;
  return values.at(-1) || values.find(Boolean) || "";
}

function stableCreatedAt(base, intended, latest) {
  if (base && Object.prototype.hasOwnProperty.call(base, "createdAt")) {
    return base.createdAt;
  }
  if (intended && Object.prototype.hasOwnProperty.call(intended, "createdAt")) {
    return intended.createdAt;
  }
  return latest?.createdAt;
}

function itemContentWithoutStableMetadata(item = {}) {
  const { id, createdAt, updatedAt, ...content } = item;
  return content;
}

function mergeArrayDelta(baseItems = [], intendedItems = [], latestItems = []) {
  const withId = (item) => item && item.id;
  const baseById = new Map(baseItems.filter(withId).map((item) => [item.id, item]));
  const intendedById = new Map(intendedItems.filter(withId).map((item) => [item.id, item]));
  const latestById = new Map(latestItems.filter(withId).map((item) => [item.id, item]));
  const order = [
    ...latestItems.filter(withId).map((item) => item.id),
    ...intendedItems.filter(withId).map((item) => item.id)
  ];
  const items = latestItems.filter((item) => !withId(item)).map(cloneDataValue);
  const conflicts = [];
  const visited = new Set();

  for (const id of order) {
    if (visited.has(id)) continue;
    visited.add(id);
    const base = baseById.get(id);
    const intended = intendedById.get(id);
    const latest = latestById.get(id);

    if (base && !intended) {
      // A deletion is an intentional renderer delta, including when the remote item changed meanwhile.
      continue;
    }
    if (!base && intended && !latest) {
      items.push(cloneDataValue(intended));
      continue;
    }
    if (!base && !intended && latest) {
      items.push(cloneDataValue(latest));
      continue;
    }
    if (base && intended && !latest) {
      if (!dataValuesEqual(
        itemContentWithoutStableMetadata(base),
        itemContentWithoutStableMetadata(intended)
      )) {
        conflicts.push({ id, fields: ["$deleted"] });
      }
      continue;
    }
    if (!intended || !latest) continue;

    const mergeBase = { ...(base || {}) };
    const mergeIntended = { ...intended };
    const mergeLatest = { ...latest };
    for (const field of ["id", "createdAt", "updatedAt"]) {
      delete mergeBase[field];
      delete mergeIntended[field];
      delete mergeLatest[field];
    }
    const merged = mergePlainObject(mergeBase, mergeIntended, mergeLatest);
    const item = merged.value;
    item.id = id;
    const createdAt = stableCreatedAt(base, intended, latest);
    if (createdAt !== undefined) item.createdAt = cloneDataValue(createdAt);
    const updatedAt = newestTimestamp(
      base?.updatedAt,
      intended.updatedAt,
      latest.updatedAt
    );
    if (updatedAt) item.updatedAt = updatedAt;
    items.push(item);
    if (merged.conflicts.length) {
      conflicts.push({ id, fields: [...new Set(merged.conflicts)] });
    }
  }

  return { items, conflicts };
}

const JOURNAL_FIELDS = ["done", "feeling", "tomorrow", "mood"];

function mergeAppendedText(baseValue, localValue, remoteValue) {
  const base = String(baseValue || "");
  const local = String(localValue || "");
  const remote = String(remoteValue || "");
  if (!local.startsWith(base) || !remote.startsWith(base)) return null;
  const localSuffix = local.slice(base.length);
  const remoteSuffix = remote.slice(base.length);
  if (!localSuffix) return remote;
  if (!remoteSuffix) return local;
  if (localSuffix === remoteSuffix) return remote;
  const separator = remote.endsWith("\n") || localSuffix.startsWith("\n") ? "" : "\n";
  return `${remote}${separator}${localSuffix}`;
}

function mergeJournalPatch(baseEntry = {}, patch = {}, remoteEntry = {}) {
  const entry = { ...remoteEntry };
  const conflicts = [];
  for (const field of JOURNAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const baseValue = String(baseEntry?.[field] || "");
    const localValue = String(patch[field] || "");
    const remoteValue = String(remoteEntry?.[field] || "");
    const remoteChanged = remoteValue !== baseValue;
    if (!remoteChanged || localValue === remoteValue) {
      entry[field] = localValue;
      continue;
    }
    if (field === "done") {
      const appended = mergeAppendedText(baseValue, localValue, remoteValue);
      if (appended !== null) {
        entry[field] = appended;
        continue;
      }
    }
    conflicts.push(field);
  }
  if (!conflicts.length) entry.updatedAt = new Date().toISOString();
  return { entry, conflicts };
}

module.exports = {
  dateKey,
  addDays,
  parseDateKey,
  addDateDays,
  eventEndDate,
  eventOccursOnDate,
  eventTimeLabel,
  recurringBaseId,
  routineSeriesKey,
  routineScheduleSignature,
  isRoutineInstanceEligible,
  foldableRoutineCandidates,
  isFoldableRoutine,
  buildDateItemIndex,
  mergeArrayDelta,
  mergeAppendedText,
  mergeJournalPatch
};
