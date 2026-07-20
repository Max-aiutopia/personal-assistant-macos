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
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
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

module.exports = {
  dateKey,
  addDays,
  parseDateKey,
  addDateDays,
  eventEndDate,
  eventOccursOnDate,
  eventTimeLabel
};