const {
  dateKey,
  addDays,
  parseDateKey,
  addDateDays,
  eventEndDate,
  eventOccursOnDate,
  eventTimeLabel
} = require("./utils");

const WEEKDAYS = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6
};

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return [...value].reduce((total, character) => total * 10 + (digits[character] ?? 0), 0);
}

function monthDayDate(month, day, now) {
  const date = new Date(now.getFullYear(), month - 1, day);
    if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      date.setFullYear(date.getFullYear() + 1);
    }
  return dateKey(date);
}

function parseDateToken(value) {
  if (/^\d+$/.test(value)) return Number(value);
  return chineseNumber(value);
}

function readFuzzyDay(text, cursor) {
  const rest = text.slice(cursor).replace(/^\s*(?:和|及|、|,|，)?\s*/, "");
  const skipped = text.slice(cursor).length - rest.length;
  const chineseMatch = rest.match(/^[零〇一二兩三四五六七八九十]{1,3}/);
  if (chineseMatch) {
    const day = parseDateToken(chineseMatch[0]);
    if (day >= 1 && day <= 31) {
      const suffix = rest.slice(chineseMatch[0].length).match(/^[日號]/)?.[0] || "";
      return {
        day,
        length: skipped + chineseMatch[0].length + suffix.length
      };
    }
  }

  const digitMatch = rest.match(/^\d{1,4}/);
  if (!digitMatch) return null;
  const digits = digitMatch[0];
  const twoDigits = Number(digits.slice(0, 2));
  const oneDigit = Number(digits.slice(0, 1));
  let length = 0;
  let day = 0;

  if (digits.length >= 2 && twoDigits >= 1 && twoDigits <= 31) {
    day = twoDigits;
    length = 2;
  } else if (oneDigit >= 1 && oneDigit <= 9) {
    day = oneDigit;
    length = 1;
  }
  if (!day) return null;

  const suffix = rest.slice(length).match(/^[日號]/)?.[0] || "";
  return { day, length: skipped + length + suffix.length };
}

function parseMonthDayPairs(text, now) {
  const tokenPattern = "(\\d{1,2}|[零〇一二兩三四五六七八九十]{1,3})";
  const monthRegex = new RegExp(`${tokenPattern}月`, "g");
  const dates = [];
  let matchedStart = -1;
  let matchedEnd = -1;
  let monthMatch;

  while ((monthMatch = monthRegex.exec(text))) {
    const month = parseDateToken(monthMatch[1]);
    if (month < 1 || month > 12) continue;
    const parsedDay = readFuzzyDay(text, monthRegex.lastIndex);
    if (!parsedDay) continue;
    if (parsedDay.day < 1 || parsedDay.day > 31) continue;
    const end = monthRegex.lastIndex + parsedDay.length;
    if (matchedStart < 0) matchedStart = monthMatch.index;
    matchedEnd = end;
    dates.push({
      value: monthDayDate(month, parsedDay.day, now),
      matched: text.slice(monthMatch.index, end)
    });
    monthRegex.lastIndex = end;
  }

  return dates.length
    ? { dates, matched: text.slice(matchedStart, matchedEnd) }
    : { dates: [], matched: "" };
}

function parseExplicitDates(text, now) {
  const tokenPattern = "(\\d{1,2}|[零〇一二兩三四五六七八九十]{1,3})";
  const monthRegex = new RegExp(`${tokenPattern}月`, "g");
  let best = null;
  let monthMatch;

  while ((monthMatch = monthRegex.exec(text))) {
    const month = parseDateToken(monthMatch[1]);
    if (month < 1 || month > 12) continue;

    let cursor = monthRegex.lastIndex;
    const dates = [];
    let matchedEnd = cursor;
    const dayRegex = new RegExp(`^\\s*(?:和|及|、|,|，)?\\s*${tokenPattern}[日號]`);

    while (cursor < text.length) {
      const dayMatch = text.slice(cursor).match(dayRegex);
      if (!dayMatch) break;
      const day = parseDateToken(dayMatch[1]);
      if (day < 1 || day > 31) break;
      dates.push({
        value: monthDayDate(month, day, now),
        matched: dayMatch[0].trim()
      });
      cursor += dayMatch[0].length;
      matchedEnd = cursor;
    }

    if (dates.length) {
      const matched = text.slice(monthMatch.index, matchedEnd);
      const value = { dates, matched };
      if (!best || dates.length > best.dates.length) {
        best = value;
      }
    }
  }

  const monthDayPairs = parseMonthDayPairs(text, now);
  if (monthDayPairs.dates.length > (best?.dates.length || 0)) return monthDayPairs;
  return best || monthDayPairs;
}

function parseDate(text, now) {
  if (text.includes("後天")) return { value: dateKey(addDays(now, 2)), matched: "後天" };
  if (text.includes("明天")) return { value: dateKey(addDays(now, 1)), matched: "明天" };
  if (text.includes("今天")) return { value: dateKey(now), matched: "今天" };

  const explicitDates = parseExplicitDates(text, now);
  if (explicitDates.dates.length) {
    return { value: explicitDates.dates[0].value, matched: explicitDates.matched };
  }

  const weekdayMatch = text.match(/(下週|下星期|這週|本週|這星期|星期|週)([一二三四五六日天])/);
  if (weekdayMatch) {
    const targetDay = WEEKDAYS[weekdayMatch[2]];
    const currentDay = now.getDay();
    let offset;
    if (weekdayMatch[1] === "下週" || weekdayMatch[1] === "下星期") {
      const daysUntilMonday = ((8 - currentDay) % 7) || 7;
      offset = daysUntilMonday + ((targetDay + 6) % 7);
    } else {
      offset = (targetDay - currentDay + 7) % 7;
    }
    return { value: dateKey(addDays(now, offset)), matched: weekdayMatch[0] };
  }

  return { value: dateKey(now), matched: "" };
}

function parseTime(text) {
  const colonMatch = text.match(/(?:上午|下午|晚上|早上)?\s*(\d{1,2}):(\d{2})/);
  if (colonMatch) {
    let hour = Number(colonMatch[1]);
    const minute = Number(colonMatch[2]);
    const prefix = colonMatch[0];
    if (/(下午|晚上)/.test(prefix) && hour < 12) hour += 12;
    if (hour <= 23 && minute <= 59) {
      return {
        value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        matched: colonMatch[0]
      };
    }
  }

  const timeMatch = text.match(
    /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([零〇一二兩三四五六七八九十\d]{1,3})\s*[點時](半|([零〇一二兩三四五六七八九十\d]{1,2})\s*分?)?/
  );
  if (!timeMatch) return { value: "", matched: "" };

  const period = timeMatch[1] || "";
  let hour = chineseNumber(timeMatch[2]);
  const minute = timeMatch[3] === "半" ? 30 : timeMatch[4] ? chineseNumber(timeMatch[4]) : 0;
  if (/(下午|傍晚|晚上)/.test(period) && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (period === "凌晨" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { value: "", matched: "" };

  return {
    value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    matched: timeMatch[0]
  };
}

function periodFromTimeText(text) {
  const match = String(text || "").match(/凌晨|早上|上午|中午|下午|傍晚|晚上/);
  return match ? match[0] : "";
}

function parseTimeRange(text) {
  const rangeMatch = String(text || "").match(
    /((?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*[零〇一二兩三四五六七八九十\d]{1,3}\s*[點時](?:半|[零〇一二兩三四五六七八九十\d]{1,2}\s*分?)?|\d{1,2}:\d{2})\s*(?:到|至|－|-|~|～)\s*((?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*[零〇一二兩三四五六七八九十\d]{1,3}\s*[點時](?:半|[零〇一二兩三四五六七八九十\d]{1,2}\s*分?)?|\d{1,2}:\d{2})/
  );
  if (!rangeMatch) return { start: "", end: "", matched: "" };
  const startParsed = parseTime(rangeMatch[1]);
  let endText = rangeMatch[2];
  if (!periodFromTimeText(endText)) {
    const period = periodFromTimeText(rangeMatch[1]);
    if (period) endText = `${period}${endText}`;
  }
  let endParsed = parseTime(endText);
  if (startParsed.value && endParsed.value && endParsed.value <= startParsed.value) {
    const [hour, minute] = endParsed.value.split(":").map(Number);
    if (hour < 12 && /下午|傍晚|晚上/.test(periodFromTimeText(rangeMatch[1]))) {
      endParsed = {
        value: `${String(hour + 12).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        matched: rangeMatch[2]
      };
    }
  }
  return {
    start: startParsed.value,
    end: endParsed.value,
    matched: rangeMatch[0]
  };
}

function inferCategory(title) {
  if (/(運動|看醫生|吃藥|喝水|睡覺|健身|健康)/.test(title)) return "健康";
  if (/(家人|爸爸|媽媽|小孩|孩子|太太|先生|老婆|老公)/.test(title)) return "家人";
  if (/(客戶|報告|會議|工作|企劃|同事|公司|回覆|電話|家教)/.test(title)) return "工作";
  if (/(買|繳費|打掃|整理|取貨|生活)/.test(title)) return "生活";
  return "其他";
}

const RESPONSE_STATUS_LABELS = {
  accepted: "accepted",
  needsAction: "needsAction",
  tentative: "tentative",
  declined: "declined"
};

function normalizeResponseStatus(value) {
  const text = String(value || "").trim();
  if (Object.prototype.hasOwnProperty.call(RESPONSE_STATUS_LABELS, text)) return text;
  if (/^(接受|答應|同意|參加|會去|出席)$/i.test(text)) return "accepted";
  if (/^(拒絕|婉拒|不參加|不去|不能參加|decline|declined)$/i.test(text)) return "declined";
  if (/^(暫定|可能|tentative)$/i.test(text)) return "tentative";
  if (/^(待回覆|needsAction|pending)$/i.test(text)) return "needsAction";
  return "";
}

function responseStatusFromText(text) {
  if (/(拒絕|婉拒|不參加|不去|不能參加|decline|declined)/i.test(text)) return "declined";
  if (/(暫定|可能會去|可能參加|tentative)/i.test(text)) return "tentative";
  if (/(接受|答應|同意|參加|會去|出席|accept|accepted)/i.test(text)) return "accepted";
  if (/(待回覆|稍後回覆|needsAction|pending)/i.test(text)) return "needsAction";
  return "";
}

function responseStatusSpeak(status) {
  return {
    accepted: "接受",
    needsAction: "待回覆",
    tentative: "暫定",
    declined: "拒絕"
  }[status] || "待回覆";
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[，,。.!！?？、\s]/g, "");
}

function hasSameScheduledItem(data, title, date, time, endTime, kind) {
  const normalized = normalizeTitle(title);
  return (data.tasks || []).some((task) => {
    if (task.kind !== kind || task.date !== date) return false;
    if (normalizeTitle(task.title) !== normalized) return false;
    return (task.reminderTime || "") === (time || "") && (task.endTime || "") === (endTime || "");
  });
}

function shortDateLabel(value) {
  return String(value || "").slice(5).replace("-", "/");
}

function addResponse({ title, kind, addedDates, skippedDates, requestedDates, time, endTime, today, tomorrow }) {
  const noun = kind === "event" ? "行程" : "待辦";
  const timeLabel = time ? `，${time}${endTime ? ` 到 ${endTime}` : ""}` : "";
  const added = addedDates || [];
  const skipped = skippedDates || [];
  const requested = requestedDates || added;

  if (!added.length && skipped.length) {
    const skippedLabel = skipped.map(shortDateLabel).join("、");
    return `這幾天原本就有「${title}」了：${skippedLabel}${timeLabel}。`;
  }

  if (requested.length > 1) {
    const addedLabel = added.map(shortDateLabel).join("、");
    const skippedLabel = skipped.length ? `；${skipped.map(shortDateLabel).join("、")} 原本就有了` : "";
    return `好，已新增 ${added.length} 個${noun}「${title}」，日期是 ${addedLabel}${timeLabel}${skippedLabel}。`;
  }

  const onlyDate = added[0] || requested[0];
  const dateLabel = onlyDate === today ? "今天" : onlyDate === tomorrow ? "明天" : onlyDate;
  return `好，已新增${noun}「${title}」，安排在${dateLabel}${timeLabel}。`;
}

function taskSummary(data, targetDate, label) {
  const tasks = data.tasks
    .filter((task) => task.kind !== "event" && task.date === targetDate && !task.completed)
    .sort((a, b) => (a.reminderTime || "99:99").localeCompare(b.reminderTime || "99:99"));
  if (!tasks.length) return `${label}目前沒有待辦。`;

  const details = tasks
    .slice(0, 4)
    .map((task) => `${task.reminderTime ? `${task.reminderTime}，` : ""}${task.title}`)
    .join("；");
  const remaining = tasks.length > 4 ? `，另外還有${tasks.length - 4}件` : "";
  return `${label}有${tasks.length}件待辦：${details}${remaining}。`;
}

function eventSummary(data, targetDate, label) {
  const events = data.tasks
    .filter((task) => eventOccursOnDate(task, targetDate))
    .sort((a, b) => (a.reminderTime || "00:00").localeCompare(b.reminderTime || "00:00"));
  if (!events.length) return `${label}目前沒有行程。`;

  const details = events
    .slice(0, 4)
    .map((event) => `${eventTimeLabel(event, targetDate)}，${event.title}`)
    .join("；");
  const remaining = events.length > 4 ? `，另外還有${events.length - 4}個` : "";
  return `${label}有${events.length}個行程：${details}${remaining}。`;
}

function daySummary(data, targetDate, label) {
  return `${taskSummary(data, targetDate, label)} ${eventSummary(data, targetDate, label)}`;
}

function cleanTaskTitle(text, dateMatch, timeMatch) {
  return text
    .replace(/^(小光|小幫手|助理)[，,\s]*/i, "")
    .replace(/^(請|麻煩)?\s*(幫我)?\s*/i, "")
    .replace(/^(新增|加入|建立|加上|加到|加進|放到|排進|記錄一下|記錄|記下|記得|提醒我|安排)\s*/i, "")
    .replace(/^(一個|一項)?\s*(待辦事項|待辦|提醒|事項|行程|會議|約會|行事曆)?\s*/i, "")
    .replace(/^(到|進)?\s*(行事曆|日曆)\s*(裡|中)?\s*/i, "")
    .replace(dateMatch, "")
    .replace(timeMatch, "")
    .replace(/^[零〇一二兩三四五六七八九十\d]{1,3}\s*天\s*/i, "")
    .replace(/^(一下|在|要上|要|有|上|記得|提醒我)\s*/i, "")
    .replace(/的(?=家教|會議|拍攝|課|課程)/g, "")
    .replace(/[，,。.!！?？]+$/g, "")
    .trim();
}

function findTask(data, spokenTitle) {
  const normalized = spokenTitle.replace(/[，,。.!！?？\s]/g, "");
  return data.tasks.find((task) => {
    if (task.kind === "event" || task.completed) return false;
    const title = task.title.replace(/\s/g, "");
    return title.includes(normalized) || normalized.includes(title);
  });
}

function eventSortKey(task) {
  return `${task.date || "9999-99-99"}${task.reminderTime || "99:99"}`;
}

function findEvent(data, spokenTitle, options = {}) {
  const normalized = normalizeTitle(spokenTitle);
  const targetDate = options.date || "";
  const nowKey = options.now ? dateKey(options.now) : dateKey();
  const candidates = (data.tasks || []).filter((task) => {
    if (task.kind !== "event") return false;
    if (targetDate && !eventOccursOnDate(task, targetDate)) return false;
    if (!normalized) return true;
    const title = normalizeTitle(task.title);
    return title.includes(normalized) || normalized.includes(title);
  });
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const aFuture = eventEndDate(a) >= nowKey;
    const bFuture = eventEndDate(b) >= nowKey;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return eventSortKey(a).localeCompare(eventSortKey(b));
  })[0];
}

function ensureSync(data) {
  data.sync = data.sync || {};
  data.sync.pendingEventActions = Array.isArray(data.sync.pendingEventActions)
    ? data.sync.pendingEventActions
    : [];
}

function pendingEventActionKey(action) {
  const externalId = action.externalId || action.external?.id || "";
  return `${action.action || ""}:${externalId || action.localId || ""}`;
}

function queueEventAction(data, task, actionFields, now = new Date()) {
  const external = task.external || {};
  if (external.provider !== "eventkit" || external.type !== "event" || !external.id) return;
  ensureSync(data);
  const action = {
    id: `event-action-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    action: actionFields.action,
    localId: task.id,
    title: actionFields.title || task.title || "",
    type: "event",
    externalId: external.id,
    calendarId: external.calendarId || "",
    date: actionFields.date || task.date || "",
    reminderTime: actionFields.reminderTime ?? task.reminderTime ?? "",
    endDate: actionFields.endDate || task.endDate || task.date || "",
    endTime: actionFields.endTime ?? task.endTime ?? "",
    isAllDay: Boolean(task.isAllDay || !task.reminderTime),
    responseStatus: actionFields.responseStatus || "",
    nextDate: actionFields.nextDate || "",
    nextReminderTime: actionFields.nextReminderTime ?? "",
    nextEndDate: actionFields.nextEndDate || "",
    nextEndTime: actionFields.nextEndTime ?? "",
    createdAt: now.toISOString(),
    external: {
      provider: external.provider,
      type: external.type,
      id: external.id,
      calendarId: external.calendarId || "",
      calendarTitle: external.calendarTitle || "",
      source: external.source || "",
      modifiedAt: external.modifiedAt || ""
    }
  };
  const key = pendingEventActionKey(action);
  data.sync.pendingEventActions = data.sync.pendingEventActions.filter(
    (item) => pendingEventActionKey(item) !== key
  );
  data.sync.pendingEventActions.push(action);
}

function setEventResponse(data, task, rawStatus, now = new Date()) {
  const status = normalizeResponseStatus(rawStatus);
  if (!task || task.kind !== "event" || !status) return false;
  task.responseStatus = status;
  task.updatedAt = now.toISOString();
  queueEventAction(
    data,
    task,
    {
      action: "respond",
      responseStatus: status,
      date: task.date,
      reminderTime: task.reminderTime || "",
      endDate: task.endDate || task.date || "",
      endTime: task.endTime || ""
    },
    now
  );
  return true;
}

function parseClockOnDate(dateValue, timeValue) {
  const date = parseDateKey(dateValue);
  if (!date) return null;
  const match = String(timeValue || "").match(/^(\d{2}):(\d{2})$/);
  if (match) date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  else date.setHours(0, 0, 0, 0);
  return date;
}

function dateTimeParts(value) {
  return {
    date: dateKey(value),
    time: `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`
  };
}

function eventDurationMs(task) {
  if (!task.reminderTime) return 24 * 60 * 60 * 1_000;
  const start = parseClockOnDate(task.date, task.reminderTime);
  const end = task.endTime
    ? parseClockOnDate(task.endDate || eventEndDate(task), task.endTime)
    : null;
  if (!start || !end || end <= start) return 60 * 60 * 1_000;
  return end.getTime() - start.getTime();
}

function rescheduleEvent(data, task, change, now = new Date()) {
  if (!task || task.kind !== "event") return { ok: false, reason: "notFound" };
  const original = {
    date: task.date,
    reminderTime: task.reminderTime || "",
    endDate: task.endDate || eventEndDate(task),
    endTime: task.endTime || ""
  };
  const duration = eventDurationMs(task);
  let nextStart;
  let nextEnd = null;

  if (Number.isFinite(change?.offsetMinutes)) {
    if (!task.reminderTime) return { ok: false, reason: "allDayOffset" };
    nextStart = parseClockOnDate(task.date, task.reminderTime);
    if (!nextStart) return { ok: false, reason: "invalidTime" };
    nextStart = new Date(nextStart.getTime() + change.offsetMinutes * 60_000);
    if (task.endTime) nextEnd = new Date(nextStart.getTime() + duration);
  } else {
    const nextDate = change?.date || task.date;
    const nextTime = change?.time || task.reminderTime || "";
    nextStart = parseClockOnDate(nextDate, nextTime);
    if (!nextStart) return { ok: false, reason: "invalidTime" };
    if (nextTime) {
      if (change?.endTime) nextEnd = parseClockOnDate(change.endDate || nextDate, change.endTime);
      else nextEnd = new Date(nextStart.getTime() + duration);
    }
  }

  const startParts = dateTimeParts(nextStart);
  task.date = startParts.date;
  task.reminderTime = task.reminderTime || change?.time ? startParts.time : "";
  if (nextEnd) {
    const endParts = dateTimeParts(nextEnd);
    task.endDate = endParts.date;
    task.endTime = endParts.time;
  } else {
    task.endDate = task.date;
    task.endTime = "";
  }
  task.updatedAt = now.toISOString();

  queueEventAction(
    data,
    task,
    {
      action: "reschedule",
      date: original.date,
      reminderTime: original.reminderTime,
      endDate: original.endDate,
      endTime: original.endTime,
      nextDate: task.date,
      nextReminderTime: task.reminderTime || "",
      nextEndDate: task.endDate || task.date || "",
      nextEndTime: task.endTime || ""
    },
    now
  );
  return { ok: true, original };
}

function cleanMeetingResponseTitle(text, dateMatch) {
  return String(text || "")
    .replace(/^(小光|小幫手|助理)[，,\s]*/i, "")
    .replace(/^(請|麻煩)?\s*(幫我)?\s*/i, "")
    .replace(/^(接受|答應|同意|參加|會去|出席|拒絕|婉拒|不參加|不去|不能參加|暫定|待回覆)\s*/i, "")
    .replace(dateMatch || "", "")
    .replace(/^(的|這個|那個)\s*/i, "")
    .replace(/(邀請|通知)$/i, "")
    .replace(/[，,。.!！?？]+$/g, "")
    .trim();
}

function parseDurationMinutes(text) {
  if (/半\s*(個)?小時/.test(text)) return 30;
  const hourMatch = text.match(/([零〇一二兩三四五六七八九十\d]{1,3})\s*(個)?小時/);
  if (hourMatch) return chineseNumber(hourMatch[1]) * 60;
  const minuteMatch = text.match(/([零〇一二兩三四五六七八九十\d]{1,3})\s*分鐘?/);
  if (minuteMatch) return chineseNumber(minuteMatch[1]);
  return null;
}

function offsetMinutesFromText(text) {
  const match = text.match(/(延後|延遲|推遲|往後|提前|提早|往前)\s*([零〇一二兩三四五六七八九十\d]{1,3}\s*(?:個)?小時|半\s*(?:個)?小時|[零〇一二兩三四五六七八九十\d]{1,3}\s*分鐘?)/);
  if (!match) return null;
  const minutes = parseDurationMinutes(match[2]);
  if (!minutes) return null;
  return /(提前|提早|往前)/.test(match[1]) ? -minutes : minutes;
}

function cleanRescheduleTitle(text, dateMatch, timeMatch) {
  return String(text || "")
    .replace(/^(小光|小幫手|助理)[，,\s]*/i, "")
    .replace(/^(請|麻煩)?\s*(幫我)?\s*/i, "")
    .replace(/^(把|將)\s*/i, "")
    .replace(/(延後|延遲|推遲|往後|提前|提早|往前)\s*[零〇一二兩三四五六七八九十\d半\s]*(個)?(小時|分鐘?).*$/i, "")
    .replace(/(改到|改成|移到|調到|改期到|改時間到).*$/i, "")
    .replace(dateMatch || "", "")
    .replace(timeMatch || "", "")
    .replace(/^(的|這個|那個)\s*/i, "")
    .replace(/[，,。.!！?？]+$/g, "")
    .trim();
}

function handleVoiceCommand(inputData, rawText, now = new Date()) {
  const data = structuredClone(inputData);
  const text = String(rawText || "").trim();
  const today = dateKey(now);
  const tomorrow = dateKey(addDays(now, 1));

  if (!text) {
    return { data, response: "我沒有聽清楚，可以再說一次嗎？" };
  }

  if (/(不用了|先這樣|掰掰|再見|隱藏|關閉)/.test(text)) {
    return { data, response: "好的，需要我時再按 Option 加空白鍵。", hide: true };
  }

  if (/(打開|顯示).*(設定)/.test(text)) {
    return { data, response: "已經替你打開設定。", route: "settings", hide: true };
  }
  if (/(打開|顯示).*(日誌|日記|記錄)/.test(text)) {
    return { data, response: "已經替你打開每日記錄。", route: "journal", hide: true };
  }
  if (/(打開|顯示).*(行程|行事曆)/.test(text)) {
    return { data, response: "已經替你打開本週行程。", route: "week", hide: true };
  }
  if (/(打開|顯示).*(待辦|清單)/.test(text)) {
    return { data, response: "已經替你打開待辦清單。", route: "tasks", hide: true };
  }

  if (/(現在)?幾點|目前時間/.test(text)) {
    return {
      data,
      response: `現在是${now.getHours()}點${now.getMinutes() ? `${now.getMinutes()}分` : "整"}。`
    };
  }

  if (/(這週|本週|一週|這星期).*(什麼|哪些|待辦|行程|安排)|本週行程/.test(text)) {
    const summaries = [];
    for (let index = 0; index < 7; index += 1) {
      const date = addDays(now, index);
      const reminders = data.tasks.filter(
        (task) => task.kind !== "event" && task.date === dateKey(date) && !task.completed
      );
      const events = data.tasks.filter(
        (task) => eventOccursOnDate(task, dateKey(date))
      );
      const wantsEvents = /行程/.test(text);
      const wantsTasks = /待辦/.test(text);
      const count = wantsEvents && !wantsTasks ? events.length : wantsTasks && !wantsEvents ? reminders.length : reminders.length + events.length;
      if (count) {
        const weekday = new Intl.DateTimeFormat("zh-TW", { weekday: "short" }).format(date);
        if (wantsEvents && !wantsTasks) summaries.push(`${weekday}${events.length}個行程`);
        else if (wantsTasks && !wantsEvents) summaries.push(`${weekday}${reminders.length}件待辦`);
        else summaries.push(`${weekday}${reminders.length}件待辦、${events.length}個行程`);
      }
    }
    return {
      data,
      response: summaries.length ? `未來七天的安排是：${summaries.join("，")}。` : "未來七天目前沒有待辦或行程。"
    };
  }

  if (/明天.*行程|明天的?行程/.test(text)) {
    return { data, response: eventSummary(data, tomorrow, "明天") };
  }
  if (/明天.*待辦|明天的?待辦/.test(text)) {
    return { data, response: taskSummary(data, tomorrow, "明天") };
  }
  if (/明天.*(什麼|哪些|安排)|明天有什麼/.test(text)) {
    return { data, response: daySummary(data, tomorrow, "明天") };
  }

  if (/今天.*行程|今天的?行程/.test(text)) {
    return { data, response: eventSummary(data, today, "今天") };
  }
  if (/今天.*待辦|今天的?待辦/.test(text)) {
    return { data, response: taskSummary(data, today, "今天") };
  }
  if (/今天.*(什麼|哪些|安排)|今天有什麼/.test(text)) {
    return { data, response: daySummary(data, today, "今天") };
  }

  const completeMatch = text.match(
    /^(?:(?:小光|小幫手|助理)[，,\s]*)?(?:請|幫我)?\s*(?:完成|做完|處理完|勾掉)\s*(.+)/
  );
  if (completeMatch) {
    const task = findTask(data, completeMatch[1]);
    if (!task) return { data, response: `我找不到「${completeMatch[1]}」這件未完成的待辦。` };
    task.completed = true;
    task.completedAt = now.toISOString();
    return { data, response: `做得好，「${task.title}」已經標示完成。` };
  }

  const deleteMatch = text.match(
    /^(?:(?:小光|小幫手|助理)[，,\s]*)?(?:請|幫我)?\s*(?:刪除|刪掉|刪|取消|移除)\s*(?:待辦|行程|會議|行事曆)?\s*(.+)/
  );
  if (deleteMatch) {
    const wantsEvent = /(行程|會議|約會|拍攝|活動|行事曆|日曆)/.test(text);
    const task = wantsEvent ? findEvent(data, deleteMatch[1]) : findTask(data, deleteMatch[1]);
    if (!task) {
      return {
        data,
        response: `我找不到「${deleteMatch[1]}」這個${wantsEvent ? "行程" : "待辦"}。`
      };
    }
    data.tasks = data.tasks.filter((item) => item.id !== task.id);
    const deleteImmediately = task.kind === "event" && task.external?.provider === "eventkit";
    if (!deleteImmediately) {
      data.trash = [
        ...(data.trash || []),
        {
          id: `voice-trash-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
          task,
          deletedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 10_000).toISOString()
        }
      ];
    }
    return {
      data,
      response: deleteImmediately
        ? `好，我幫你刪掉行程「${task.title}」。`
        : `已刪除${wantsEvent ? "行程" : "待辦"}「${task.title}」，10 秒內可以在主畫面復原。`
    };
  }

  if (
    /(接受|答應|同意|參加|會去|出席|拒絕|婉拒|不參加|不去|不能參加|暫定|待回覆)/.test(text) &&
    /(會議|行程|約會|拍攝|活動|邀請)/.test(text)
  ) {
    const status = responseStatusFromText(text);
    const parsedDate = parseDate(text, now);
    const targetDate = parsedDate.matched ? parsedDate.value : "";
    const title = cleanMeetingResponseTitle(text, parsedDate.matched);
    const event = findEvent(data, title, { date: targetDate, now });
    if (!status) {
      return { data, response: "你想接受、暫定，還是拒絕這個邀請呢？" };
    }
    if (!event) {
      return { data, response: `我找不到「${title || "這個"}」會議或行程。` };
    }
    setEventResponse(data, event, status, now);
    return {
      data,
      response: `已把「${event.title}」標記為 ${responseStatusSpeak(status)}。`,
      hide: true,
      route: "week"
    };
  }

  if (
    /(延後|延遲|推遲|往後|提前|提早|往前|改到|改成|移到|調到|改期到|改時間到)/.test(text) &&
    /(會議|行程|約會|拍攝|活動)/.test(text)
  ) {
    const parsedDate = parseDate(text, now);
    const parsedTime = parseTime(text);
    const targetDate = parsedDate.matched && !/(改到|改成|移到|調到|改期到)/.test(text)
      ? parsedDate.value
      : "";
    const title = cleanRescheduleTitle(text, targetDate ? parsedDate.matched : "", parsedTime.matched);
    const event = findEvent(data, title, { date: targetDate, now });
    if (!event) {
      return { data, response: `我找不到「${title || "這個"}」會議或行程。` };
    }
    const offsetMinutes = offsetMinutesFromText(text);
    const change =
      offsetMinutes !== null
        ? { offsetMinutes }
        : {
            date: parsedDate.matched ? parsedDate.value : "",
            time: parsedTime.matched ? parsedTime.value : ""
          };
    if (!Number.isFinite(change.offsetMinutes) && !change.date && !change.time) {
      return { data, response: "你想把這個行程改到哪一天或幾點呢？" };
    }
    const result = rescheduleEvent(data, event, change, now);
    if (!result.ok && result.reason === "allDayOffset") {
      return { data, response: `「${event.title}」是全天行程，請告訴我要改到哪一天。` };
    }
    if (!result.ok) {
      return { data, response: `我暫時無法改「${event.title}」的時間。` };
    }
    const dateLabel =
      event.date === today ? "今天" : event.date === tomorrow ? "明天" : event.date;
    const timeLabel = event.reminderTime ? ` ${event.reminderTime}` : "";
    return {
      data,
      response: `已把「${event.title}」改到${dateLabel}${timeLabel}。`,
      hide: true,
      route: "week"
    };
  }

  const journalMatch = text.match(
    /(?:記錄一下|寫進日誌|寫入日誌|日誌|日記|今天做了|今天發生了|今天的感想是)\s*[：:]?\s*(.+)/
  );
  const looksLikeScheduledItem =
    /(行事曆|日曆|行程|會議|約會|拍攝|家教)/.test(text) ||
    Boolean(parseExplicitDates(text, now).dates.length) ||
    Boolean(parseTimeRange(text).matched);
  if (journalMatch && !looksLikeScheduledItem) {
    const content = journalMatch[1].trim();
    const entry = data.journal[today] || {};
    data.journal[today] = {
      ...entry,
      done: [entry.done, content].filter(Boolean).join("\n"),
      updatedAt: now.toISOString()
    };
    return { data, response: `已經把「${content}」記在今天的日誌。` };
  }

  if (/(提醒我|新增|加入|建立|加到|加進|放到|排進|待辦|記得|記錄|幫我記下|安排|行程|會議|約會|拍攝|家教|行事曆|日曆)/.test(text)) {
    const parsedDates = parseExplicitDates(text, now);
    const parsedDate = parsedDates.dates.length
      ? { value: parsedDates.dates[0].value, matched: parsedDates.matched }
      : parseDate(text, now);
    const dateValues = parsedDates.dates.length
      ? [...new Set(parsedDates.dates.map((item) => item.value))]
      : [parsedDate.value];
    const parsedTimeRange = parseTimeRange(text);
    const parsedTime = parsedTimeRange.matched
      ? { value: parsedTimeRange.start, matched: parsedTimeRange.matched }
      : parseTime(text);
    const title = cleanTaskTitle(text, parsedDate.matched, parsedTime.matched);
    if (!title) return { data, response: "這件待辦的內容是什麼呢？請再說一次。" };
    const kind =
      /(安排|行程|會議|約會|拍攝|家教|行事曆|日曆)/.test(text) ||
      Boolean(parsedTimeRange.matched) ||
      Boolean(parsedTime.value)
        ? "event"
        : "reminder";
    const endTime = kind === "event" ? parsedTimeRange.end : "";
    const addedDates = [];
    const skippedDates = [];

    dateValues.forEach((dateValue, index) => {
      if (hasSameScheduledItem(data, title, dateValue, parsedTime.value, endTime, kind)) {
        skippedDates.push(dateValue);
        return;
      }
      const itemEndDate = kind === "event" && parsedTime.value && endTime && endTime <= parsedTime.value
        ? addDateDays(dateValue, 1)
        : dateValue;
      addedDates.push(dateValue);
      data.tasks.push({
        id: `voice-${now.getTime()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        date: dateValue,
        reminderTime: parsedTime.value,
        endTime,
        endDate: itemEndDate,
        kind,
        category: inferCategory(title),
        notes: "由語音新增",
        completed: false,
        createdAt: now.toISOString(),
        completedAt: null,
        updatedAt: now.toISOString()
      });
    });

    return {
      data,
      response: addResponse({
        title,
        kind,
        addedDates,
        skippedDates,
        requestedDates: dateValues,
        time: parsedTime.value,
        endTime,
        today,
        tomorrow
      })
    };
  }

  if (/(你好|嗨|哈囉|在嗎|小光)/.test(text)) {
    const name = data.settings.userName ? `，${data.settings.userName}` : "";
    return { data, response: `我在${name}。你可以叫我新增待辦、記日誌，或問今天有什麼事。` };
  }

  if (/(怎麼用|可以做什麼|幫助|指令)/.test(text)) {
    return {
      data,
      response: "你可以說：提醒我明天下午三點打電話、記錄一下今天完成報告，或問我今天有什麼事。"
    };
  }

  return {
    data,
    response: "我聽到了，但還不確定你要我怎麼處理。你可以說新增待辦、安排會議、記錄日誌，或詢問今天行程。"
  };
}

module.exports = {
  handleVoiceCommand,
  dateKey,
  parseDate,
  parseExplicitDates,
  parseTime,
  parseTimeRange,
  inferCategory,
  findTask,
  findEvent,
  normalizeResponseStatus,
  responseStatusSpeak,
  setEventResponse,
  rescheduleEvent,
  hasSameScheduledItem,
  addResponse
};
