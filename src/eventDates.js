(function exposeEventDates(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.eventDates = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  // Prefer shared utils when available (node / bundled), fall back to inline for pure browser global
  let utils;
  try {
    utils = require("./utils");
  } catch {}

  const parseDateKey = utils?.parseDateKey || function parseDateKey(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
  };

  const dateKey = utils?.dateKey || function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const addDateDays = utils?.addDateDays || function addDateDays(value, amount) {
    const date = parseDateKey(value);
    if (!date) return value || "";
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  };

  const eventEndDate = utils?.eventEndDate || function eventEndDate(task) {
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
  };

  const eventOccursOnDate = utils?.eventOccursOnDate || function eventOccursOnDate(task, targetDate) {
    if (task?.kind !== "event" || !task.date || !targetDate) return false;
    if (task.date === targetDate) return true;
    if (!task.reminderTime || targetDate < task.date) return false;
    const endDate = eventEndDate(task);
    if (!endDate || targetDate > endDate) return false;
    return !(targetDate === endDate && task.endTime === "00:00");
  };

  const eventTimeLabel = utils?.eventTimeLabel || function eventTimeLabel(task, targetDate) {
    if (targetDate !== task.date) {
      return task.endTime ? `延續至 ${task.endTime}` : "延續行程";
    }
    if (!task.reminderTime) return "全天";
    return task.endTime ? `${task.reminderTime}–${task.endTime}` : task.reminderTime;
  };

  return { addDateDays, eventEndDate, eventOccursOnDate, eventTimeLabel };
});
