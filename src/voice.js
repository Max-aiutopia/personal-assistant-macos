const api = window.assistantAPI;

const card = document.querySelector(".voice-card");
const transcriptElement = document.querySelector("#transcript");
const responseElement = document.querySelector("#response");
const responseLiveRegion = responseElement.parentElement;
const conversationElement = document.querySelector(".conversation");
const promptElement = document.querySelector("#prompt");
const statusLabel = document.querySelector("#status-label");
const orbButton = document.querySelector("#voice-orb");
const retryButton = document.createElement("button");
retryButton.id = "retry-button";
retryButton.className = "retry-button";
retryButton.type = "button";
retryButton.textContent = "再試一次";
retryButton.hidden = true;
responseElement.parentElement.appendChild(retryButton);

let isListening = false;
let isProcessing = false;
let autoHideTimer;
let activeUtterance;
let speechWatchdog;
let sessionGeneration = 0;
let conversationId = "";
let conversationTurns = [];
const VOICE_HISTORY_LIMIT = 12;
let settings = {
  voiceReplyEnabled: true,
  voiceAutoListen: true,
  voiceAutoHide: true,
  voiceBrain: "rules",
  aiVoiceEnabled: false
};

function resolveConfiguredVoiceBrain(currentSettings = {}) {
  if (currentSettings.voiceBrain === "claude" || currentSettings.voiceBrain === "ollama") {
    return currentSettings.voiceBrain;
  }
  // 與主程序的 resolveBrain 相同：舊資料即使被補成 rules，舊 AI 旗標仍要先遷移。
  if (currentSettings.aiVoiceEnabled) return "ollama";
  return "rules";
}

function updateSettings(nextSettings = {}) {
  settings = { ...settings, ...nextSettings };
}

function resetConversation() {
  conversationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  conversationTurns = [];
}

function rememberConversationTurn(userText, assistantText) {
  const now = new Date().toISOString();
  conversationTurns.push(
    { role: "user", content: String(userText || "").trim(), at: now },
    { role: "assistant", content: String(assistantText || "").trim(), at: now }
  );
  conversationTurns = conversationTurns
    .filter((item) => item.content)
    .slice(-VOICE_HISTORY_LIMIT);
}

function setState(state, prompt) {
  if (state === "error") clearAutoHide();
  card.dataset.state = state;
  retryButton.hidden = state !== "error";
  const labels = {
    idle: "準備好了",
    listening: "正在聆聽",
    thinking: "正在整理",
    speaking: "正在回覆",
    error: "需要注意"
  };
  statusLabel.textContent = labels[state] || labels.idle;
  promptElement.textContent = prompt || "請說，我在聽";
  const listening = state === "listening";
  const busy = state === "thinking" || state === "speaking";
  const orbLabels = {
    idle: "開始聆聽",
    listening: "停止聆聽",
    thinking: "正在處理語音，請稍候",
    speaking: "正在回覆，請稍候",
    error: "重新開始聆聽"
  };
  orbButton.setAttribute("aria-label", orbLabels[state] || orbLabels.idle);
  orbButton.setAttribute("aria-pressed", String(listening));
  orbButton.setAttribute("aria-busy", String(busy));
  orbButton.setAttribute("aria-disabled", String(busy));
}

function setResponse(message, { assertive = false } = {}) {
  responseLiveRegion.setAttribute("role", assertive ? "alert" : "status");
  responseLiveRegion.setAttribute("aria-live", assertive ? "assertive" : "polite");
  responseElement.textContent = message;
  requestAnimationFrame(() => {
    conversationElement.scrollTop = conversationElement.scrollHeight;
  });
}

function clearAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = undefined;
}

function scheduleAutoHide(delay = 8000) {
  clearAutoHide();
  if (!settings.voiceAutoHide) return;
  autoHideTimer = setTimeout(() => {
    if (!isListening) api.hideVoice();
  }, delay);
}

function stopListening() {
  if (!isListening) return;
  api.stopVoiceListening();
  isListening = false;
  setState("idle", "已停止，按一下小光繼續說");
}

function stopSpeaking() {
  clearTimeout(speechWatchdog);
  activeUtterance = undefined;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function chooseWarmChineseVoice() {
  const voices = window.speechSynthesis.getVoices();
  const preferredNames = [
    "Mei-Jia",
    "美佳",
    "Yu-shu",
    "玉書",
    "Li-mu",
    "李沐",
    "Ting-Ting",
    "婷婷",
    "Sin-ji",
    "馨之"
  ];
  return (
    preferredNames
      .map((name) =>
        voices.find(
          (voice) =>
            voice.lang.startsWith("zh") &&
            voice.name.toLowerCase().includes(name.toLowerCase())
        )
      )
      .find(Boolean) ||
    voices.find((voice) => voice.lang === "zh-TW" && voice.localService) ||
    voices.find((voice) => voice.lang === "zh-TW") ||
    voices.find((voice) => voice.lang.startsWith("zh") && voice.localService) ||
    voices.find((voice) => voice.lang.startsWith("zh")) ||
    null
  );
}

function prepareSpokenReply(text) {
  return String(text || "")
    .replace(/\bGoogle\s*\/\s*Apple\b/g, "Google 和 Apple")
    .replace(/\baccepted\b/g, "已接受")
    .replace(/\bneedsAction\b/g, "待回覆")
    .replace(/\btentative\b/g, "暫定")
    .replace(/\bdeclined\b/g, "已拒絕")
    .replace(/；/g, "。")
    .replace(/\s+/g, " ")
    .trim();
}

function hideVoice() {
  clearAutoHide();
  stopListening();
  stopSpeaking();
  api.hideVoice();
}

function speak(text, onDone) {
  stopSpeaking();
  if (!settings.voiceReplyEnabled || !("speechSynthesis" in window)) {
    setState("idle", "按一下可以繼續說");
    onDone?.();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(prepareSpokenReply(text));
  activeUtterance = utterance;
  utterance.lang = "zh-TW";
  utterance.rate = 0.92;
  utterance.pitch = 1.08;
  utterance.volume = 0.98;
  utterance.voice = chooseWarmChineseVoice();
  utterance.onstart = () => setState("speaking", "小光正在回答");
  let finished = false;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    clearTimeout(speechWatchdog);
    activeUtterance = undefined;
    setState("idle", message);
    onDone?.();
  };
  utterance.onend = () => finish("按一下可以繼續說");
  utterance.onerror = () => finish("回覆已顯示在畫面上");
  speechWatchdog = setTimeout(
    () => finish("回覆已顯示在畫面上"),
    Math.min(4000 + String(text || "").length * 250, 20000)
  );
  window.speechSynthesis.speak(utterance);
}

async function processTranscript(transcript) {
  if (!transcript || isProcessing) return;
  isProcessing = true;
  const generation = sessionGeneration;
  isListening = false;
  transcriptElement.textContent = transcript;
  const thinkingLabel =
    resolveConfiguredVoiceBrain(settings) === "rules"
      ? "我正在處理這句話"
      : "小光正在用 AI 思考…";
  setState("thinking", thinkingLabel);

  let processTimeoutId;
  try {
    const processTimeout = new Promise((_, reject) => {
      processTimeoutId = setTimeout(() => reject(new Error("voice-process-timeout")), 45000);
    });
    const result = await Promise.race([
      api.processVoice(transcript, { conversationId, history: conversationTurns }),
      processTimeout
    ]);
    clearTimeout(processTimeoutId);
    if (generation !== sessionGeneration) return;
    updateSettings(result.settings);
    setResponse(result.response);
    rememberConversationTurn(transcript, result.response);
    speak(result.response, () => {
      isProcessing = false;
      if (settings.voiceAutoListen && !result.hide) {
        startListening();
      } else if (result.hide) {
        scheduleAutoHide(5000);
      } else {
        scheduleAutoHide();
      }
    });
  } catch (error) {
    clearTimeout(processTimeoutId);
    isProcessing = false;
    const timedOut = error?.message === "voice-process-timeout";
    setResponse(
      timedOut ? "處理逾時，請再說一次。" : "剛才沒有處理成功，請再說一次。",
      { assertive: true }
    );
    setState("error", timedOut ? "處理逾時" : "處理失敗");
  }
}

async function startListening() {
  clearAutoHide();
  stopSpeaking();
  if (isProcessing || isListening) return;
  transcriptElement.textContent = "正在啟動麥克風…";
  setResponse("第一次使用時，macOS 會詢問語音與麥克風權限。");
  setState("thinking", "正在啟動語音辨識");
  let started = false;
  try {
    started = await api.startVoiceListening();
  } catch {
    started = false;
  }
  if (!started) {
    setResponse("語音辨識元件無法啟動，請重新安裝貼身小秘書。", { assertive: true });
    setState("error", "無法啟動語音");
  }
}

async function prepareVoice() {
  clearAutoHide();
  sessionGeneration += 1;
  isProcessing = false;
  isListening = false;
  stopSpeaking();
  try { await api.stopVoiceListening(); } catch {}
  resetConversation();
  const data = await api.getData();
  updateSettings(data.settings);
  document.querySelector("#assistant-name").textContent = data.settings.assistantName || "小光";
  transcriptElement.textContent = "我出現了，請直接告訴我你要做什麼。";
  setResponse("你可以新增待辦、記錄日誌，或詢問今天與明天的行程。");
  setState("idle", settings.voiceAutoListen ? "準備開始聆聽" : "按一下小光開始");
  requestAnimationFrame(() => orbButton.focus({ preventScroll: true }));
  if (settings.voiceAutoListen) setTimeout(startListening, 180);
}

orbButton.addEventListener("click", () => {
  if (orbButton.getAttribute("aria-disabled") === "true") return;
  if (isListening) stopListening();
  else startListening();
});
retryButton.addEventListener("click", async () => {
  clearAutoHide();
  sessionGeneration += 1;
  isProcessing = false;
  isListening = false;
  stopSpeaking();
  setResponse("正在重新啟動語音辨識…");
  try {
    await api.stopVoiceListening();
  } catch {}
  await startListening();
});
document.querySelector("#close-button").addEventListener("click", hideVoice);
document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => processTranscript(button.dataset.example));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideVoice();
});
card.addEventListener("mouseenter", clearAutoHide);
card.addEventListener("focusin", clearAutoHide);
card.addEventListener("pointerdown", clearAutoHide);
card.addEventListener("keydown", clearAutoHide);

api.getVoiceShortcut().then((shortcut) => {
  document.querySelector("#shortcut-label").textContent = `${shortcut} 呼叫`;
});
api.onVoiceShortcutChanged((shortcut) => {
  document.querySelector("#shortcut-label").textContent = `${shortcut} 呼叫`;
});
api.onVoiceStart(prepareVoice);
api.onVoiceStop(() => {
  clearAutoHide();
  stopListening();
  stopSpeaking();
  isProcessing = false;
  isListening = false;
  sessionGeneration += 1;
  resetConversation();
});
api.onVoicePreview(async () => {
  const data = await api.getData();
  updateSettings(data.settings);
  const message = "語音回覆功能正常。需要我時，按 Option 加空白鍵呼叫我。";
  transcriptElement.textContent = "測試語音";
  setResponse(message);
  stopListening();
  speak(message, () => scheduleAutoHide());
});
api.onNativeVoiceEvent((event) => {
  if (event.type === "ready") {
    isListening = true;
    transcriptElement.textContent = "正在聽你說話…";
    setResponse("開始說話後，安靜約 5 秒我會自動送出。");
    setState("listening", "請說，安靜約 5 秒後結束");
    return;
  }
  if (event.type === "partial") {
    transcriptElement.textContent = event.text || "正在聽你說話…";
    return;
  }
  if (event.type === "final") {
    isListening = false;
    processTranscript((event.text || "").trim());
    return;
  }
  if (event.type === "error") {
    isListening = false;
    setResponse(event.message || "語音辨識暫時無法使用，請再試一次。", { assertive: true });
    setState("error", "語音辨識需要注意");
  }
});
if (typeof api.onSettingsChanged === "function") {
  api.onSettingsChanged((nextSettings) => {
    updateSettings(nextSettings);
    document.querySelector("#assistant-name").textContent = nextSettings.assistantName || "小光";
  });
}
// 舊版 preload 的相容路徑；新主程序只送輕量 settings-changed。
if (typeof api.onDataChanged === "function") {
  api.onDataChanged((data) => {
    updateSettings(data.settings);
    document.querySelector("#assistant-name").textContent = data.settings.assistantName || "小光";
  });
}

setState("idle", "需要我時再呼叫");
