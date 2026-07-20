/**
 * 語音「理解大腦」＋獨立執行層。
 *
 * 設計重點（修正舊版 aiVoice 的 critical bug）：
 *  - 解析（parse）與執行（apply）完全分離。
 *  - LLM 只負責輸出「結構化意圖」(action + 參數)，由 applyIntent 確定地改資料，
 *    絕不再回頭用 regex 重新解析原句、也絕不丟棄 LLM 的解析結果。
 *  - 三層 fallback：Claude（最聰明）→ Ollama（本地）→ 規則式（離線保底，由呼叫端負責）。
 */

const { dateKey, addDays } = require("./utils");
const { conversationExcerpt, normalizeVoiceHistory } = require("./voiceContext");
const {
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
} = require("./voiceCommands");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const ALLOWED_ROUTES = ["today", "tasks", "week", "journal", "settings"];

const INTENT_TOOL = {
  name: "record_intent",
  description: "回報使用者語音指令的結構化意圖。一律呼叫此工具，不要用純文字回覆。",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "add",
          "complete",
          "delete",
          "journal",
          "query",
          "navigate",
          "respond_event",
          "reschedule_event",
          "close",
          "none"
        ],
        description:
          "add=新增待辦/行程；complete=標記完成；delete=刪除；journal=記日誌；query=查詢回答（不改資料）；navigate=切換頁面；respond_event=接受/拒絕/暫定會議邀請；reschedule_event=改期或延後/提前行程；close=收起語音視窗；none=不確定"
      },
      title: { type: "string", description: "事項標題；complete/delete 時為要比對的目標名稱" },
      date: { type: "string", description: "YYYY-MM-DD（依今天推算「明天/下週三」等）" },
      dates: {
        type: "array",
        items: { type: "string" },
        description: "多個日期 YYYY-MM-DD。使用者一次講多天，例如 7/8、7/15、7/22、7/29 時全部放這裡"
      },
      time: { type: "string", description: "開始時間 HH:mm 24 小時制" },
      endTime: { type: "string", description: "結束時間 HH:mm 24 小時制。若使用者講了時間區間（例如「11點到2點」「下午三點到五點」）一定要填這個" },
      offsetMinutes: {
        type: "number",
        description: "action=reschedule_event 且使用者說延後/提前時填分鐘數；延後為正，提前為負，例如延後半小時=30"
      },
      responseStatus: {
        type: "string",
        enum: ["accepted", "needsAction", "tentative", "declined"],
        description: "action=respond_event 的邀請回覆狀態"
      },
      kind: { type: "string", enum: ["reminder", "event"], description: "reminder=一般待辦；event=行程/會議/約會" },
      content: { type: "string", description: "action=journal 時要記下的內容" },
      route: { type: "string", enum: ALLOWED_ROUTES, description: "action=navigate 時要前往的頁面" },
      response: { type: "string", description: "要用溫暖自然的繁體中文說給使用者聽的回覆" },
      hide: { type: "boolean", description: "處理完是否自動收起語音視窗" }
    },
    required: ["action", "response"]
  }
};

function buildSystemPrompt(data, now, conversationHistory = []) {
  const today = dateKey(now); // 使用本地日期，修正舊版 UTC 偏移一天的 bug
  const settings = data.settings || {};
  const name = settings.assistantName || "小光";
  const userName = settings.userName || "";
  const history = conversationExcerpt(conversationHistory);
  const upcoming = (data.tasks || [])
    .filter((t) => !t.completed && t.date >= today)
    .slice(0, 12)
    .map(
      (t) =>
        `- ${t.date}${t.reminderTime ? ` ${t.reminderTime}` : ""} [${t.kind === "event" ? "行程" : "待辦"}${t.responseStatus || t.external?.responseStatus ? `/${t.responseStatus || t.external.responseStatus}` : ""}] ${t.title}`
    )
    .join("\n");

  return `你是繁體中文（台灣）個人秘書「${name}」。今天是 ${today}。${userName ? `使用者叫「${userName}」。` : ""}
使用者透過語音和你說話，文字可能有少量辨識錯字，請依上下文合理推斷他真正的意思。

使用者目前未完成的事項（最多 12 筆，供你比對「完成/刪除」目標、回答查詢）：
${upcoming || "(目前沒有待辦)"}

本次語音視窗的短期對話紀錄（只在這次開窗期間有效，供理解「剛剛」「那個」「確認好了嗎」等追問）：
${history || "(目前沒有前文)"}

規則：
- 一律呼叫 record_intent 工具回報意圖，不要用純文字回覆。
- 使用者追問「確認好了嗎」「剛剛那個呢」「結果呢」時，必須參考短期對話紀錄，不要反問「要確認什麼」。
- 日期一律輸出 YYYY-MM-DD，依今天 ${today} 推算相對日期（明天、後天、下週三…）。
- 如果使用者一次講多個日期（例如「7月8號15號22號29號晚上七點到九點高雄家教」），action=add，title 只放共同標題，dates 放全部日期，time/endTime 放共同時間；不要只取第一天。
- 時間一律 24 小時制 HH:mm（例如「下午三點」→ 15:00）。若使用者講了時間區間（如「11點到2點」「三點到五點」「上午十點到中午」），time 填開始時間、endTime 填結束時間。
- 只要使用者有提到明確時間（例如「下午三點」「19:00」「晚上七點到九點」），一律用 kind=event，放到行事曆，不要當待辦。
- 沒有明確時間、只是要記一件事時才用 kind=reminder。
- complete / delete 的 title 請盡量對齊上面列出的既有事項名稱。
- 接受/答應/參加/拒絕/婉拒/暫定既有會議時，用 action=respond_event，不要新增或刪除；responseStatus 只可用 accepted / needsAction / tentative / declined。
- 改期、延後、提前既有會議時，用 action=reschedule_event，不要新增；「延後半小時」填 offsetMinutes=30，「提前一小時」填 offsetMinutes=-60；「改到明天下午三點」則填 date/time。
- query（例如「今天有什麼事」）請在 response 裡直接總結，不要改資料。
- 真的不確定時 action 用 none，並在 response 溫柔引導。
- response 是要直接唸出來的口語，不要像系統通知；用一點真人秘書的溫度，例如「好，我幫你處理」、「可以，這個我來」。
- response 要簡短、自然、有情緒溫度，但不要亂取暱稱或過度自來熟（不知道名字就直接講事情，不要用「帥哥」「親愛的」這類稱呼）。
- 不要聲稱已經同步到 Google/Apple，執行層會在同步成功後改成正確說法。`;
}

async function callClaude(data, transcript, apiKey, model, now, conversationHistory = [], timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model || DEFAULT_CLAUDE_MODEL,
        max_tokens: 512,
        system: buildSystemPrompt(data, now, conversationHistory),
        tools: [INTENT_TOOL],
        tool_choice: { type: "tool", name: "record_intent" },
        messages: [{ role: "user", content: String(transcript || "") }]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Claude HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const toolUse = (json.content || []).find(
      (block) => block.type === "tool_use" && block.name === "record_intent"
    );
    if (!toolUse || !toolUse.input) throw new Error("Claude 未回傳結構化意圖");
    return { ...toolUse.input, _via: "claude" };
  } finally {
    clearTimeout(timer);
  }
}

function buildOllamaPrompt(data, transcript, now, conversationHistory = []) {
  const today = dateKey(now);
  const upcoming = (data.tasks || [])
    .filter((t) => !t.completed && t.date >= today)
    .slice(0, 8)
    .map((t) => `${t.date} ${t.reminderTime || ""} ${t.kind} ${t.title}`)
    .join("\n");

  return `${buildSystemPrompt(data, now, conversationHistory)}

使用者剛剛說：「${transcript}」

請只用以下 JSON 格式回覆（不要任何多餘文字）：
{"action":"add|complete|delete|journal|query|navigate|respond_event|reschedule_event|close|none","title":"","date":"YYYY-MM-DD","dates":["YYYY-MM-DD"],"time":"HH:mm","endTime":"HH:mm","offsetMinutes":0,"responseStatus":"accepted|needsAction|tentative|declined","kind":"reminder|event","content":"","route":"today|tasks|week|journal|settings|null","response":"","hide":true}`;
}

async function callOllama(data, transcript, settings, now, conversationHistory = [], timeoutMs = 25000) {
  const model = settings.aiModel || "qwen2.5:3b";
  const baseUrl = (settings.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildOllamaPrompt(data, transcript, now, conversationHistory),
        stream: false,
        format: "json", // Ollama 原生 JSON 模式，強制合法 JSON
        options: { temperature: 0.2, num_predict: 300 }
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const raw = json.response || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Ollama 未回傳有效 JSON");
      parsed = JSON.parse(match[0]);
    }
    if (!parsed || !parsed.action) throw new Error("Ollama 回傳缺少 action");
    return { ...parsed, _via: "ollama" };
  } finally {
    clearTimeout(timer);
  }
}

function resolveBrain(settings = {}) {
  if (settings.voiceBrain === "claude" || settings.voiceBrain === "ollama" || settings.voiceBrain === "rules") {
    return settings.voiceBrain;
  }
  if (settings.aiVoiceEnabled) return "ollama"; // 舊設定遷移
  return "rules";
}

/**
 * 解析語音為結構化意圖。回傳 intent 物件，或 null（代表交給規則式 fallback）。
 * 任何 AI 失敗都會往上拋，由呼叫端 catch 後退回規則式。
 */
async function parseVoiceIntent(data, transcript, settings = {}, apiKey = "", now = new Date(), conversationHistory = []) {
  const brain = resolveBrain(settings);
  const history = normalizeVoiceHistory(conversationHistory);
  if (brain === "claude" && apiKey) {
    return await callClaude(data, transcript, apiKey, settings.claudeModel, now, history);
  }
  if (brain === "ollama") {
    return await callOllama(data, transcript, settings, now, history);
  }
  return null; // rules tier
}

// ---- 執行層：把結構化意圖確定地套用到資料 ----

function pad2(value) {
  return String(value).padStart(2, "0");
}

function addDaysToKey(key, amount) {
  const [y, m, d] = String(key).split("-").map(Number);
  return dateKey(addDays(new Date(y, m - 1, d), amount));
}

function normalizeDate(rawDate, fallbackText, now) {
  if (typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  if (rawDate) {
    const fromRaw = parseDate(String(rawDate), now);
    if (fromRaw.matched) return fromRaw.value;
  }
  return parseDate(String(fallbackText || ""), now).value; // 預設今天
}

function normalizeOptionalDate(rawDate, now) {
  if (typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  if (!rawDate) return "";
  const parsed = parseDate(String(rawDate), now);
  return parsed.matched ? parsed.value : "";
}

function normalizeAddDates(intent, fallbackTitle, now) {
  const explicit = parseExplicitDates(String(intent?._transcript || ""), now).dates.map((item) => item.value);
  const fromIntent = Array.isArray(intent?.dates)
    ? intent.dates.map((value) => normalizeOptionalDate(value, now)).filter(Boolean)
    : [];
  const dates = [...explicit, ...fromIntent];
  const primary = normalizeOptionalDate(intent?.date, now);
  const transcript = String(intent?._transcript || "");
  const today = dateKey(now);

  if (dates.length) {
    if (primary && (primary !== today || /今天/.test(transcript))) dates.push(primary);
    return [...new Set(dates)];
  }

  if (primary) return [primary];
  return [normalizeDate(intent?.date, transcript || fallbackTitle, now)];
}

function transcriptLooksScheduled(text, now) {
  const value = String(text || "");
  if (/(行事曆|日曆|行程|會議|約會|拍攝|家教|活動)/.test(value)) return true;
  return Boolean(parseExplicitDates(value, now).dates.length && parseTime(value).value);
}

function normalizeKind(intent, transcript) {
  const text = String(transcript || "");
  const eventWords = /(行事曆|日曆|行程|會議|約會|拍攝|家教|活動)/.test(text);
  const reminderWords = /(待辦|提醒事項|提醒我)/.test(text);
  const hasExplicitTime =
    Boolean(parseTimeRange(text).matched || parseTime(text).value) ||
    typeof intent.time === "string" && /^\d{1,2}:\d{2}$/.test(intent.time);
  if (hasExplicitTime) return "event";
  if (eventWords) return "event";
  if (reminderWords) return "reminder";
  return intent.kind === "event" ? "event" : "reminder";
}

function normalizeTime(rawTime, fallbackText) {
  if (typeof rawTime === "string") {
    const m = rawTime.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour <= 23 && minute <= 59) return `${pad2(hour)}:${pad2(minute)}`;
    }
  }
  return parseTime(String(fallbackText || "")).value;
}

function safeRoute(route) {
  return ALLOWED_ROUTES.includes(route) ? route : null;
}

/**
 * 依結構化意圖改資料。回傳 { data, response, hide?, route? }。
 * data 為傳入資料的深拷貝，呼叫端負責 store.write。
 */
function applyIntent(inputData, intent, now = new Date()) {
  const data = structuredClone(inputData);
  intent = intent || {};
  let action = intent.action || "none";
  const transcript = String(intent._transcript || "");
  if (action === "journal" && transcriptLooksScheduled(transcript, now)) {
    action = "add";
    intent = {
      ...intent,
      title: intent.title || intent.content || "",
      kind: normalizeKind(intent, transcript)
    };
  }
  const response = (intent?.response && String(intent.response).trim()) || "好的。";
  const route = safeRoute(intent?.route);
  const today = dateKey(now);
  const tomorrow = dateKey(addDays(now, 1));
  const iso = now.toISOString();

  if (action === "add") {
    const title = String(intent.title || "").trim();
    if (!title) {
      return { data, response: response || "這件事的內容是什麼呢？再說一次給我聽。" };
    }
    const kind = normalizeKind(intent, transcript);
    const dates = normalizeAddDates(intent, intent.title, now);
    const range = parseTimeRange(transcript);
    const fallbackText = [range.start || "", transcript, intent.title || ""].filter(Boolean).join(" ");
    const time = normalizeTime(intent.time, fallbackText);
    // 結束時間只有「行程」才有意義；若結束 <= 開始視為跨午夜，結束日 +1 天
    const endTime = kind === "event" ? normalizeTime(intent.endTime, range.end || "") : "";
    const addedDates = [];
    const skippedDates = [];
    dates.forEach((date, index) => {
      if (hasSameScheduledItem(data, title, date, time, endTime, kind)) {
        skippedDates.push(date);
        return;
      }
      const endDate =
        kind === "event" && time && endTime && endTime <= time ? addDaysToKey(date, 1) : date;
      addedDates.push(date);
      data.tasks.push({
        id: `voice-${now.getTime()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        date,
        reminderTime: time,
        endTime,
        endDate,
        kind,
        category: inferCategory(title),
        notes: "由語音新增",
        origin: "voice",
        completed: false,
        createdAt: iso,
        completedAt: null,
        updatedAt: iso
      });
    });
    return {
      data,
      response: addResponse({
        title,
        kind,
        addedDates,
        skippedDates,
        requestedDates: dates,
        time,
        endTime,
        today,
        tomorrow
      }),
      hide: Boolean(intent.hide),
      route
    };
  }

  if (action === "complete") {
    const task = findTask(data, String(intent.title || ""));
    if (!task) {
      return { data, response: `我找不到「${intent.title || ""}」這件未完成的待辦。` };
    }
    task.completed = true;
    task.completedAt = iso;
    task.updatedAt = iso;
    return { data, response, hide: Boolean(intent.hide), route };
  }

  if (action === "delete") {
    const task = findTask(data, String(intent.title || "")) || findEvent(data, String(intent.title || ""));
    if (!task) {
      return { data, response: `我找不到「${intent.title || ""}」這個項目。` };
    }
    data.tasks = data.tasks.filter((item) => item.id !== task.id);
    const deleteImmediately = task.kind === "event" && task.external?.provider === "eventkit";
    if (!deleteImmediately) {
      data.trash = [
        ...(data.trash || []),
        {
          id: `voice-trash-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
          task,
          deletedAt: iso,
          expiresAt: new Date(now.getTime() + 10_000).toISOString()
        }
      ];
    }
    return { data, response, hide: Boolean(intent.hide), route };
  }

  if (action === "respond_event") {
    const title = String(intent.title || "").trim();
    const targetDate = normalizeOptionalDate(intent.date, now);
    const status = normalizeResponseStatus(intent.responseStatus);
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
      response: response || `已把「${event.title}」標記為 ${responseStatusSpeak(status)}。`,
      hide: intent.hide !== false,
      route: route || "week"
    };
  }

  if (action === "reschedule_event") {
    const title = String(intent.title || "").trim();
    const offsetMinutes = Number(intent.offsetMinutes);
    const usesOffset = Number.isFinite(offsetMinutes) && offsetMinutes !== 0;
    const targetDate = usesOffset ? normalizeOptionalDate(intent.date, now) : "";
    const event = findEvent(data, title, { date: targetDate, now });
    if (!event) {
      return { data, response: `我找不到「${title || "這個"}」會議或行程。` };
    }
    const change = usesOffset
      ? { offsetMinutes }
      : {
          date: normalizeOptionalDate(intent.date, now),
          time: normalizeTime(intent.time, ""),
          endTime: normalizeTime(intent.endTime, "")
        };
    if (!usesOffset && !change.date && !change.time) {
      return { data, response: "你想把這個行程改到哪一天或幾點呢？" };
    }
    const result = rescheduleEvent(data, event, change, now);
    if (!result.ok && result.reason === "allDayOffset") {
      return { data, response: `「${event.title}」是全天行程，請告訴我要改到哪一天。` };
    }
    if (!result.ok) {
      return { data, response: `我暫時無法改「${event.title}」的時間。` };
    }
    return {
      data,
      response: response || `已把「${event.title}」改到 ${event.date}${event.reminderTime ? ` ${event.reminderTime}` : ""}。`,
      hide: intent.hide !== false,
      route: route || "week"
    };
  }

  if (action === "journal") {
    const content = String(intent.content || intent.title || "").trim();
    if (!content) return { data, response: response || "你想記下什麼呢？" };
    const entry = data.journal[today] || {};
    data.journal[today] = {
      ...entry,
      done: [entry.done, content].filter(Boolean).join("\n"),
      updatedAt: iso
    };
    return { data, response, hide: Boolean(intent.hide), route };
  }

  if (action === "navigate") {
    return { data, response, hide: true, route: route || "today" };
  }

  if (action === "close") {
    return { data, response, hide: true };
  }

  // query / none：不改資料，只回覆（route 仍允許帶頁面）
  return { data, response, hide: Boolean(intent.hide), route };
}

/**
 * 測試 Claude 連線與金鑰是否有效（極小一次呼叫）。
 */
async function testClaude(apiKey, model) {
  if (!apiKey) return { success: false, error: "尚未設定 API 金鑰" };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model || DEFAULT_CLAUDE_MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "回覆 ok" }]
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    const json = await res.json();
    return { success: true, model: json.model || model || DEFAULT_CLAUDE_MODEL };
  } catch (error) {
    return { success: false, error: error.name === "TimeoutError" ? "連線逾時" : error.message };
  }
}

module.exports = {
  parseVoiceIntent,
  applyIntent,
  testClaude,
  resolveBrain,
  ALLOWED_ROUTES,
  DEFAULT_CLAUDE_MODEL,
  // 匯出供測試
  callClaude,
  callOllama,
  normalizeDate,
  normalizeTime
};
