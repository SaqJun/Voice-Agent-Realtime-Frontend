// API base
const API_BASE = 'http://127.0.0.1:8000';

// Core hooks (existing)
const startAndstopBtn = document.getElementById('startAndstopBtn');
const chatLog = document.getElementById('chat-log');
const loadingIndicator = document.getElementById('loading');

// Optional Aizen UI hooks (present if you used the themed HTML)
const appRoot = document.getElementById('appRoot');
const statusText = document.getElementById('statusText');
const sessionValue = document.getElementById('sessionValue');
const copySessionBtn = document.getElementById('copySessionBtn');
const resetBtn = document.getElementById('resetBtn');
const muteBtn = document.getElementById('muteBtn');
const scrollBtn = document.getElementById('scrollBtn');
const vu = document.getElementById('vu');
const toastRoot = document.getElementById('toast-root');

// Settings modal hooks
const openSettingsBtn = document.getElementById('openSettingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsForm = document.getElementById('settingsForm');
const clearKeysBtn = document.getElementById('clearKeysBtn');
const showKeysToggle = document.getElementById('showKeysToggle');
const geminiKeyInput = document.getElementById('geminiKeyInput');
const sttKeyInput = document.getElementById('sttKeyInput');
const ttsKeyInput = document.getElementById('ttsKeyInput');
const weatherKeyInput = document.getElementById('weatherKeyInput');
const websearchKeyInput = document.getElementById('websearchKeyInput');

let isRecording = false;
let ws = null;

// Separate audio contexts for mic (input) and playback (output)
let inputCtx = null;
let outputCtx = null;
let micSource = null;
let processor = null;
let micStream = null;

// Streaming UI state
let streamingEl = null;
let streamingText = '';
let streamingFinalizeTimer = null;

// TTS playback
let audioQueue = [];
let isPlaying = false;
let currentSource = null;
let ttsMuted = false;

// -------------------- Session --------------------
function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  let id = params.get("session");
  if (!id) {
    id = crypto.randomUUID();
    params.set("session", id);
    window.history.replaceState({}, "", `${location.pathname}?${params}`);
  }
  return id;
}
const sessionId = getSessionId();
if (sessionValue) sessionValue.textContent = sessionId;

// Copy session id
if (copySessionBtn) {
  copySessionBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      toast('Session ID copied');
    } catch {
      toast('Failed to copy', 'error');
    }
  });
}

// Optional: reset memory
if (resetBtn) {
  resetBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`${API_BASE}/history/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(res.statusText);
      clearChat();
      toast('Memory reset');
    } catch {
      toast('Reset route not available. Add DELETE /history/{session}.', 'warn');
    }
  });
}

// -------------------- Toasts --------------------
function toast(msg, type = 'info') {
  if (!toastRoot) return console.log(`[${type}]`, msg);
  const div = document.createElement('div');
  const palette = {
    info: 'bg-white/10 border-white/20 text-slate-200',
    warn: 'bg-yellow-500/15 border-yellow-400/30 text-yellow-200',
    error: 'bg-red-500/15 border-red-400/30 text-red-200',
  }[type] || 'bg-white/10 border-white/20 text-slate-200';
  div.className = `px-3 py-2 rounded-md border text-sm shadow ${palette}`;
  div.textContent = msg;
  toastRoot.appendChild(div);
  setTimeout(() => div.remove(), 2500);
}

// -------------------- Settings / API keys --------------------
const LS_KEYS = 'aizen.keys.v1';

function compactKeys(obj) {
  // Trim and remove empty values; never log secrets
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const t = (v || '').toString().trim();
    if (t) out[k] = t;
  }
  return out;
}
function getStoredKeys() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS) || '{}');
  } catch {
    return {};
  }
}
function setStoredKeys(keys) {
  localStorage.setItem(LS_KEYS, JSON.stringify(keys || {}));
}

function hydrateSettingsForm() {
  const stored = getStoredKeys();
  if (geminiKeyInput) geminiKeyInput.value = stored.gemini_api_key || '';
  if (sttKeyInput) sttKeyInput.value = stored.stt_api_key || '';
  if (ttsKeyInput) ttsKeyInput.value = stored.tts_api_key || '';
  if (weatherKeyInput) weatherKeyInput.value = stored.weather_api_key || '';
  if (websearchKeyInput) websearchKeyInput.value = stored.websearch_api_key || '';
}

function collectSettingsForm() {
  return compactKeys({
    gemini_api_key: geminiKeyInput?.value,
    stt_api_key: sttKeyInput?.value,
    tts_api_key: ttsKeyInput?.value,
    weather_api_key: weatherKeyInput?.value,
    websearch_api_key: websearchKeyInput?.value,
  });
}

async function pushKeysToBackend(keys) {
  try {
    const res = await fetch(`${API_BASE}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, keys })
    });
    if (!res.ok) throw new Error(await res.text());
    return true;
  } catch (e) {
    // Don't surface secrets; only generic error
    console.error('Config push failed');
    toast('Could not send keys to backend (using server .env where missing)', 'warn');
    return false;
  }
}

async function clearKeysBackend() {
  try {
    const res = await fetch(`${API_BASE}/config/${sessionId}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

function openSettings() {
  if (!settingsModal) return;
  hydrateSettingsForm();
  settingsModal.classList.remove('hidden');
  settingsModal.classList.add('flex');
  setTimeout(() => geminiKeyInput?.focus(), 0);
}
function closeSettings() {
  if (!settingsModal) return;
  settingsModal.classList.add('hidden');
  settingsModal.classList.remove('flex');
}

openSettingsBtn?.addEventListener('click', openSettings);
closeSettingsBtn?.addEventListener('click', closeSettings);
settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal?.classList.contains('hidden')) closeSettings();
});
// Ctrl+, to open settings
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    openSettings();
  }
});

if (showKeysToggle) {
  showKeysToggle.addEventListener('click', () => {
    const targets = [geminiKeyInput, sttKeyInput, ttsKeyInput, weatherKeyInput, websearchKeyInput];
    const shouldShow = showKeysToggle.textContent === 'Show';
    targets.forEach(inp => { if (inp) inp.type = shouldShow ? 'text' : 'password'; });
    showKeysToggle.textContent = shouldShow ? 'Hide' : 'Show';
  });
}

settingsForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const keys = collectSettingsForm();
  setStoredKeys(keys);
  const ok = await pushKeysToBackend(keys);
  if (ok) toast('API keys saved for this session');
  closeSettings();
});

// Clear keys locally and inform backend to fall back to .env
clearKeysBtn?.addEventListener('click', async () => {
  setStoredKeys({});
  geminiKeyInput.value = '';
  sttKeyInput.value = '';
  ttsKeyInput.value = '';
  weatherKeyInput.value = '';
  websearchKeyInput.value = '';
  const ok = await clearKeysBackend();
  if (ok) toast('Cleared — server will use .env');
  else toast('Cleared locally. Server .env will be used where applicable.', 'warn');
});

// On load: if we have stored keys, push them (silent); else just inform user
(async function initKeys() {
  const stored = getStoredKeys();
  if (Object.keys(compactKeys(stored)).length > 0) {
    await pushKeysToBackend(stored);
  } else {
    toast('Using server .env keys. Add yours in Settings.');
  }
})();

// -------------------- State --------------------
function setState(state) {
  if (appRoot) appRoot.dataset.state = state;
  if (statusText) statusText.textContent = ({
    idle: 'Idle',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
  }[state] || state);
}

function nearBottom() {
  if (!chatLog) return true;
  return chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 24;
}
function scrollToBottom() {
  if (!chatLog) return;
  // Use rAF to ensure DOM has painted before scrolling
  requestAnimationFrame(() => {
    chatLog.scrollTop = chatLog.scrollHeight;
  });
}
if (chatLog && scrollBtn) {
  chatLog.addEventListener('scroll', () => {
    scrollBtn.dataset.show = nearBottom() ? 'false' : 'true';
  });
  scrollBtn.addEventListener('click', scrollToBottom);
}

// -------------------- History --------------------
async function loadChatHistory() {
  try {
    const res = await fetch(`${API_BASE}/history/${sessionId}`);
    const data = await res.json();

    clearChat();

    if (data.history && Array.isArray(data.history)) {
      data.history.forEach(msg => {
        if (msg.role === "user") {
          addTextMessage(msg.content, "transcript");
        } else if (msg.role === "agent") {
          addTextMessage(msg.content, "llm");
        }
      });
    }
    scrollToBottom();
  } catch (err) {
    console.error("Error loading history:", err);
  }
}
function clearChat() {
  if (!chatLog) return;
  chatLog.innerHTML = "";
}
loadChatHistory();

// -------------------- Chat bubbles --------------------
function addTextMessage(text, type) {
  if (!chatLog) return null;

  const el = document.createElement('div');

  if (type === "llm") {
    // Agent bubble (left)
    el.className = appRoot
      ? 'self-start max-w-[85%] bg-gradient-to-r from-indigo-600/30 to-fuchsia-600/30 p-[1px] rounded-2xl'
      : 'self-start max-w-[80%]';
    const inner = document.createElement('div');
    inner.className = appRoot
      ? 'bg-slate-900/70 rounded-2xl px-4 py-3 shadow-md shadow-black/20 text-sm leading-relaxed'
      : 'px-4 py-2 bg-gray-800 rounded-xl text-sm text-gray-200';
    inner.textContent = text;
    el.appendChild(inner);
  } else {
    // User bubble (right)
    el.className = appRoot
      ? 'self-end max-w-[85%] rounded-2xl px-4 py-3 text-sm bg-indigo-600/90 shadow-md'
      : 'self-end max-w-[80%] px-4 py-2 bg-indigo-600 rounded-xl text-sm text-white';
    el.textContent = text;
  }

  chatLog.appendChild(el);
  scrollToBottom(); // always auto-scroll on new messages
  return el;
}

// For streaming LLM chunks: reuse one bubble
function appendLlmChunk(chunk) {
  if (!chatLog) return;
  if (!streamingEl) {
    // Create a fresh streaming bubble
    if (appRoot) {
      const wrapper = document.createElement('div');
      wrapper.className = 'self-start max-w-[85%] bg-gradient-to-r from-indigo-600/30 to-fuchsia-600/30 p-[1px] rounded-2xl';
      const inner = document.createElement('div');
      inner.className = 'bg-slate-900/70 rounded-2xl px-4 py-3 shadow-md shadow-black/20 text-sm leading-relaxed shimmer';
      inner.textContent = '';
      wrapper.appendChild(inner);
      chatLog.appendChild(wrapper);
      streamingEl = inner;
    } else {
      streamingEl = addTextMessage('', 'llm');
      if (streamingEl) streamingEl.classList.add('shimmer');
    }
    setState('thinking');
  }
  streamingText += chunk;
  streamingEl.textContent = streamingText;

  // Debounced finalize after chunks stop for a moment
  if (streamingFinalizeTimer) clearTimeout(streamingFinalizeTimer);
  streamingFinalizeTimer = setTimeout(finalizeStreaming, 600);

  scrollToBottom(); // always auto-scroll while streaming
}
function finalizeStreaming() {
  if (!streamingEl) return;
  streamingEl.classList?.remove('shimmer');
  streamingEl = null;
  streamingText = '';
  // If not speaking, fall back to idle
  if (!isPlaying && (!appRoot || appRoot.dataset.state !== 'speaking')) {
    setState('idle');
  }
}

// -------------------- Audio helpers --------------------
function ensureOutputCtx() {
  if (!outputCtx) {
    const ACtx = window.AudioContext || window.webkitAudioContext;
    outputCtx = new ACtx();
  }
  if (outputCtx.state === 'suspended') {
    outputCtx.resume().catch(() => {});
  }
  return outputCtx;
}
function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function decodeAudio(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      ctx.decodeAudioData(arrayBuffer, resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

// Play base64 audio chunks as they arrive (queued)
function playAudioChunk(b64) {
  if (ttsMuted) return;
  const ctx = ensureOutputCtx();
  const buf = base64ToArrayBuffer(b64);
  decodeAudio(ctx, buf)
    .then(abuf => {
      audioQueue.push(abuf);
      if (!isPlaying) playNextChunk();
      setState('speaking');
    })
    .catch(err => {
      console.error("Decode error:", err);
      toast("Audio decode error", "error");
    });
}
function playNextChunk() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    // If not thinking or listening, go idle shortly
    setTimeout(() => {
      if (!streamingEl && (!appRoot || appRoot.dataset.state === 'speaking')) {
        setState('idle');
      }
    }, 200);
    return;
  }
  isPlaying = true;
  const ctx = ensureOutputCtx();
  const buffer = audioQueue.shift();
  const source = ctx.createBufferSource();
  currentSource = source;
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (currentSource === source) currentSource = null;
    playNextChunk();
  };
  source.start();
}
function stopPlayback() {
  try { currentSource?.stop(0); } catch {}
  try { currentSource?.disconnect(); } catch {}
  currentSource = null;
  audioQueue = [];
  isPlaying = false;
}

// -------------------- Microphone streaming --------------------
/* Convert Float32 → PCM16 */
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

async function startRecording() {
  ws = new WebSocket(`ws://127.0.0.1:8000/ws/audio?session=${sessionId}`);

  ws.onopen = () => {
    console.log("WebSocket connected");
    setState('listening');
  };
  ws.onclose = () => {
    console.log("WebSocket closed");
  };
  ws.onerror = (err) => console.error("WebSocket error", err);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "final") {
        // Final user transcript
        addTextMessage(msg.text, "transcript");
        setState('thinking'); // Aizen is "thinking" next
      } else if (msg.type === "llm") {
        // Stream LLM chunks into one bubble
        appendLlmChunk(msg.text);
      } else if (msg.type === "audio") {
        // Stream TTS audio
        playAudioChunk(msg.b64);
      } else if (msg.type === "error") {
        console.error("Server error:", msg.message);
        toast(msg.message || "Server error", "error");
      } else if (msg.type === "info") {
        console.log(msg.message);
      }
    } catch {
      console.log("Raw message:", event.data);
    }
  };

  // Mic capture
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ACtx = window.AudioContext || window.webkitAudioContext;
  // Use 16k sample rate for your transcriber; browsers may ignore this, that's fine
  inputCtx = new ACtx({ sampleRate: 16000 });
  micSource = inputCtx.createMediaStreamSource(micStream);
  processor = inputCtx.createScriptProcessor(4096, 1, 1);

  micSource.connect(processor);
  processor.connect(inputCtx.destination);

  processor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);

    // VU meter
    if (vu) {
      let sum = 0.0;
      for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
      const rms = Math.sqrt(sum / inputData.length);
      const level = Math.min(1, rms * 3); // simple scaling
      const width = 8 + level * 92;
      vu.style.width = `${width}%`;
    }

    // Send PCM16 to server
    const pcm16 = floatTo16BitPCM(inputData);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(pcm16);
    }
  };
}

function stopRecording() {
  if (processor) {
    try {
      processor.disconnect();
      processor.onaudioprocess = null;
    } catch {}
  }
  try { micSource?.disconnect(); } catch {}
  if (inputCtx) {
    try { inputCtx.close(); } catch {}
  }
  inputCtx = null;
  micSource = null;
  processor = null;

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  // If not speaking or thinking, return to idle
  if (!isPlaying && !streamingEl) setState('idle');
}

// -------------------- Controls --------------------
startAndstopBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!isRecording) {
    try {
      await startRecording();
      isRecording = true;
      if (startAndstopBtn) {
        startAndstopBtn.textContent = "Stop Recording";
        startAndstopBtn.classList.add("recording");
        startAndstopBtn.setAttribute('data-recording', 'true');
        startAndstopBtn.setAttribute('aria-pressed', 'true');
      }
    } catch (err) {
      console.error("Mic error", err);
      alert("Microphone access denied.");
    }
  } else {
    stopRecording();
    isRecording = false;
    if (startAndstopBtn) {
      startAndstopBtn.textContent = "Start Recording";
      startAndstopBtn.classList.remove("recording");
      startAndstopBtn.removeAttribute('data-recording');
      startAndstopBtn.setAttribute('aria-pressed', 'false');
    }
  }
});

// Mute TTS toggle (optional)
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    ttsMuted = !ttsMuted;
    if (ttsMuted) {
      muteBtn.textContent = 'Unmute TTS';
      stopPlayback();
    } else {
      muteBtn.textContent = 'Mute TTS';
    }
  });
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  try { stopRecording(); } catch {}
  try { stopPlayback(); } catch {}
});
