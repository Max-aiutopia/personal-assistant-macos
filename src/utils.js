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
  if (!task.reminderTime || targetDate < task.date) return false;
  const endDate = eventEndDate(task);
  if (!endDate || targetDate > endDate) return false;
  return !(targetDate === endDate && task.endTime === "00:00");
}

function eventTimeLabel(task, targetDate) {
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
  mergeAppendedText,
  mergeJournalPatch
};
