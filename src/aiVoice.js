/**
 * AI 語音理解模組（使用本地 Ollama）
 * 優先使用結構化輸出，失敗時可 fallback 到規則式。
 */

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

function buildPrompt(data, transcript, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const upcoming = (data.tasks || [])
    .filter(t => !t.completed && (t.date >= today))
    .slice(0, 8)
    .map(t => `${t.date} ${t.reminderTime || ""} ${t.kind} ${t.title}`)
    .join("\n");

  return `你是一個貼心的中文個人秘書「小光」。
今天日期是 ${today}。

目前使用者有以下待辦/行程（最多顯示 8 筆）：
${upcoming || "(目前沒有待辦)"}

使用者剛剛說：「${transcript}」

請嚴格用以下 JSON 格式回覆（不要有任何額外文字）：
{
  "action": "add" | "complete" | "delete" | "journal" | "query" | "navigate" | "close" | "none",
  "payload": { ... },   // 視 action 而定，例如 {title, date, time} 或 {target: "today"}
  "response": "要用溫暖自然的中文說給使用者聽的話",
  "hide": true/false,   // 處理完是否自動隱藏語音視窗
  "route": "today" | "tasks" | "week" | "journal" | "settings" | null
}

規則：
- action 為 add 時 payload 至少要有 title，可選 date(YYYY-MM-DD), time(HH:mm), kind("reminder"|"event")
- complete / delete 要盡量匹配現有事項的 title
- journal 時 payload.content 為記錄內容
- query 時 response 盡量總結今天/明天/本週
- navigate 時 payload.target 為頁面
- 如果完全不確定，action 用 "none"，response 請溫柔引導
- 回覆必須是合法 JSON`;
}

async function callOllama(prompt, model, baseUrl = DEFAULT_OLLAMA_URL, timeoutMs = 25000) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 300 }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${text}`);
    }

    const json = await res.json();
    const raw = json.response || "";

    // 嘗試抽取 JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("模型沒有回傳有效 JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function processWithAI(inputData, rawText, settings = {}) {
  if (!settings.aiVoiceEnabled) {
    throw new Error("AI 未啟用");
  }

  const model = settings.aiModel || "qwen2.5:3b";
  const baseUrl = settings.ollamaUrl || DEFAULT_OLLAMA_URL;

  const prompt = buildPrompt(inputData, rawText);
  let aiResult;
  try {
    aiResult = await callOllama(prompt, model, baseUrl);
  } catch (e) {
    console.error("[aiVoice] Ollama 呼叫失敗:", e.message);
    throw e; // 讓上層 fallback
  }

  // 基本驗證
  if (!aiResult || typeof aiResult !== "object" || !aiResult.action) {
    throw new Error("AI 回傳格式錯誤");
  }

  // 這裡先回傳 AI 建議的結構，真正的資料修改由上層 (main.js) 決定是否執行
  // 為了相容現有 handleVoiceCommand 回傳格式，我們在主流程中處理
  return aiResult;
}

module.exports = { processWithAI, buildPrompt };