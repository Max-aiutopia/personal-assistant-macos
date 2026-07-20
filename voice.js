const api = window.assistantAPI;

const card = document.querySelector(".voice-card");
const transcriptElement = document.querySelector("#transcript");
const responseElement = document.querySelector("#response");
const promptElement = document.querySelector("#prompt");
const statusLabel = document.querySelector("#status-label");
const orbButton = document.querySelector("#voice-orb");

let isListening = false;
let isProcessing = false;
let autoHideTimer;
let conversationId = "";
let conversationTurns = [];
const VOICE_HISTORY_LIMIT = 12;
let settings = {
  voiceReplyEnabled: true,
  voiceAutoListen: true,
  voiceAutoHide: true
};

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
  card.dataset.state = state;
  const labels = {
    idle: "準備好了",
    listening: "正在聆聽",
    thinking: "正在整理",
    speaking: "正在回覆",
    error: "需要注意"
  };
  statusLabel.textContent = labels[state] || labels.idle;
  promptElement.textContent = prompt || "請說，我在聽";
}

function clearAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = undefined;
}

function scheduleAutoHide(delay = 8000) {
  clearAutoHide();
  if (!settings.voiceAutoHide) return;
  autoHideTimer = setTimeout(() => api.hideVoice(), delay);
}

function stopListening() {
  if (!isListening) return;
  api.stopVoiceListening();
  isListening = false;
}

function stopSpeaking() {
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
  utterance.lang = "zh-TW";
  utterance.rate = 0.92;
  utterance.pitch = 1.08;
  utterance.volume = 0.98;
  utterance.voice = chooseWarmChineseVoice();
  utterance.onstart = () => setState("speaking", "小光正在回答");
  utterance.onend = () => {
    setState("idle", "按一下可以繼續說");
    onDone?.();
  };
  utterance.onerror = () => {
    setState("idle", "回覆已顯示在畫面上");
    onDone?.();
  };
  window.speechSynthesis.speak(utterance);
}

async function processTranscript(transcript) {
  if (!transcript || isProcessing) return;
  isProcessing = true;
  isListening = false;
  transcriptElement.textContent = transcript;
  const thinkingLabel = (settings.aiVoiceEnabled) ? "小光正在用 AI 思考…" : "我正在處理這句話";
  setState("thinking", thinkingLabel);

  try {
    const result = await api.processVoice(transcript, {
      conversationId,
      history: conversationTurns
    });
    settings = { ...settings, ...(result.settings || {}) };
    responseElement.textContent = result.response;
    rememberConversationTurn(transcript, result.response);
    speak(result.response, () => {
      isProcessing = false;
      if (result.hide) {
        scheduleAutoHide(1800);
      } else {
        scheduleAutoHide();
      }
    });
  } catch (error) {
    isProcessing = false;
    responseElement.textContent = "剛才沒有處理成功，請再說一次。";
    setState("error", "處理失敗");
    scheduleAutoHide();
  }
}

async function startListening() {
  clearAutoHide();
  stopSpeaking();
  if (isProcessing || isListening) return;
  transcriptElement.textContent = "正在啟動麥克風…";
  responseElement.textContent = "第一次使用時，macOS 會詢問語音與麥克風權限。";
  setState("thinking", "正在啟動語音辨識");
  const started = await api.startVoiceListening();
  if (!started) {
    responseElement.textContent = "語音辨識元件無法啟動，請重新安裝貼身小秘書。";
    setState("error", "無法啟動語音");
  }
}

async function prepareVoice() {
  clearAutoHide();
  resetConversation();
  const data = await api.getData();
  settings = { ...settings, ...(data.settings || {}) };
  document.querySelector("#assistant-name").textContent = data.settings.assistantName || "小光";
  transcriptElement.textContent = "我出現了，請直接告訴我你要做什麼。";
  responseElement.textContent = "你可以新增待辦、記錄日誌，或詢問今天與明天的行程。";
  setState("idle", settings.voiceAutoListen ? "準備開始聆聽" : "按一下小光開始");
  if (settings.voiceAutoListen) setTimeout(startListening, 180);
}

orbButton.addEventListener("click", () => {
  if (isListening) stopListening();
  else startListening();
});
document.querySelector("#close-button").addEventListener("click", hideVoice);
document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => processTranscript(button.dataset.example));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideVoice();
});
card.addEventListener("mouseenter", clearAutoHide);

api.getVoiceShortcut().then((shortcut) => {
  document.querySelector("#shortcut-label").textContent = `${shortcut} 呼叫`;
});
api.onVoiceStart(prepareVoice);
api.onVoiceStop(() => {
  clearAutoHide();
  stopListening();
  stopSpeaking();
  resetConversation();
});
api.onVoicePreview(async () => {
  const data = await api.getData();
  settings = { ...settings, ...(data.settings || {}) };
  const message = "語音回覆功能正常。需要我時，按 Option 加空白鍵呼叫我。";
  transcriptElement.textContent = "測試語音";
  responseElement.textContent = message;
  stopListening();
  speak(message, () => scheduleAutoHide());
});
api.onNativeVoiceEvent((event) => {
  if (event.type === "ready") {
    isListening = true;
    transcriptElement.textContent = "正在聽你說話…";
    responseElement.textContent = "說完停頓 3 秒，我就會自動送出。";
    setState("listening", "請說，停頓 3 秒後結束");
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
    responseElement.textContent = event.message || "語音辨識暫時無法使用，請再試一次。";
    setState("error", "語音辨識需要注意");
    scheduleAutoHide(3000);
  }
});
api.onDataChanged((data) => {
  settings = { ...settings, ...(data.settings || {}) };
  document.querySelector("#assistant-name").textContent = data.settings.assistantName || "小光";
});

setState("idle", "需要我時再呼叫");
