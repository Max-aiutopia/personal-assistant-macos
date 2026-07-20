const MAX_HISTORY_ITEMS = 12;
const MAX_CONTENT_LENGTH = 260;

function compactText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CONTENT_LENGTH);
}

function normalizeVoiceHistory(input) {
  const raw = Array.isArray(input) ? input : input?.history;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "",
      content: compactText(item?.content)
    }))
    .filter((item) => item.role && item.content)
    .slice(-MAX_HISTORY_ITEMS);
}

function conversationExcerpt(history) {
  const normalized = normalizeVoiceHistory(history);
  if (!normalized.length) return "";
  return normalized
    .map((item) => `- ${item.role === "user" ? "使用者" : "小光"}：${item.content}`)
    .join("\n");
}

function isContextFollowUp(text) {
  const value = compactText(text);
  return /^(確認好了嗎|好了嗎|處理好了嗎|弄好了嗎|查好了嗎|有找到嗎|結果呢|那結果呢|剛剛那個呢|那個呢|所以呢|然後呢|後來呢)$/.test(value) ||
    /(剛剛|上一個|前面|剛才).*(那個|事情|行程|確認|處理|結果)/.test(value);
}

function lastUserAssistantPair(history) {
  const normalized = normalizeVoiceHistory(history);
  let assistant = "";
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const item = normalized[index];
    if (item.role === "assistant" && !assistant) {
      assistant = item.content;
      continue;
    }
    if (item.role === "user" && assistant) {
      return { user: item.content, assistant };
    }
  }
  const lastUser = [...normalized].reverse().find((item) => item.role === "user");
  return lastUser ? { user: lastUser.content, assistant: "" } : null;
}

function contextFallbackResponse(history, transcript) {
  if (!isContextFollowUp(transcript)) return "";
  const pair = lastUserAssistantPair(history);
  if (!pair) return "";
  if (!pair.assistant) {
    return `你剛剛說的是「${pair.user}」。我還留著這段脈絡，你可以直接接著補充要我怎麼處理。`;
  }
  if (/(確認|查|找)/.test(pair.assistant) && !/(已|找不到|沒有|失敗|完成|同步)/.test(pair.assistant)) {
    return `剛剛你要我處理「${pair.user}」。我這邊沒有背景作業還在跑；上一個回覆是：${pair.assistant}`;
  }
  return `你剛剛要我處理「${pair.user}」。我前一次的結果是：${pair.assistant}`;
}

module.exports = {
  normalizeVoiceHistory,
  conversationExcerpt,
  isContextFollowUp,
  contextFallbackResponse
};
