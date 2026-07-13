// Motion detector
//
// State machine: idle -> countdown -> armed -> alarm -> armed -> ... -> idle
//
// The wasm module only judges a single frame ("did enough pixels change
// just now"). Whether that becomes a full alarm is decided here in JS,
// which tracks how long motion has been continuous before reacting -
// that's what keeps a single flickering shadow from screaming immediately.

import * as wasm from "./pkg/motion_detector.js";
import { speak } from "./screenreader.js";

const PROCESS_WIDTH = 160; // downscale target for the buffer we feed to wasm
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const SPEAK_DEBOUNCE_MS = 1000; // don't re-announce more often than this

const els = {
  video: document.getElementById("video"),
  displayCanvas: document.getElementById("canvas"),
  cameraSelect: document.getElementById("camera-select"),
  status: document.getElementById("status"),
  startStop: document.getElementById("start-stop"),
  delay: document.getElementById("delay"),
  delayValue: document.getElementById("delay-value"),
  sensitivity: document.getElementById("sensitivity"),
  sensitivityValue: document.getElementById("sensitivity-value"),
  duration: document.getElementById("duration"),
  durationValue: document.getElementById("duration-value"),
  message: document.getElementById("message"),
  soundUrl: document.getElementById("sound-url"),
  soundFile: document.getElementById("sound-file"),
  sirenToggle: document.getElementById("siren-toggle"),
  alarmAudio: document.getElementById("alarm-audio"),
};

const displayCtx = els.displayCanvas.getContext("2d");
const wasmReady = wasm.default();

// Small offscreen canvas used only to feed the detector.
const processCanvas = document.createElement("canvas");
const processCtx = processCanvas.getContext("2d", { willReadFrequently: true });

/** @typedef {"idle"|"countdown"|"armed"|"alarm"} AppState */
/** @type {AppState} */
let state = "idle";

let motionDetector = null;
let lastSpokeAt = 0;
let motionStreakStartedAt = null; // timestamp when the current unbroken motion streak began
let countdownTimer = null;
let objectSoundUrl = null; // set when a local file is chosen, revoked on replace

// --- Settings, read live from the controls -------------------------------

function customMessage() {
  return els.message.value.trim() || "Обнаружено движение";
}

function durationMs() {
  return Number(els.duration.value) * 1000;
}

function delaySeconds() {
  return Number(els.delay.value);
}

function alarmSoundSrc() {
  return objectSoundUrl || els.soundUrl.value.trim() || null;
}

// --- Slider readouts (kept in sync so sighted users see the same numbers
// a screen reader gets from the native range input's accessible value) ---

function refreshSensitivityLabel() {
  els.sensitivityValue.textContent = `${els.sensitivity.value}%`;
  if (motionDetector) {
    // Sensitivity slider: 1 (least sensitive) .. 100 (most sensitive) maps
    // down to a required-change-ratio between 30% (barely reacts) and 1%
    // (reacts to small movements) of the downscaled frame.
    const pct = Number(els.sensitivity.value);
    const maxRatio = 0.3;
    const minRatio = 0.01;
    const ratio = maxRatio - (pct - 1) * ((maxRatio - minRatio) / 99);
    motionDetector.motion_ratio = ratio;
  }
}

function refreshDurationLabel() {
  els.durationValue.textContent = `${Number(els.duration.value).toFixed(1)} с`;
}

function refreshDelayLabel() {
  els.delayValue.textContent = `${els.delay.value} с`;
}

els.sensitivity.addEventListener("input", refreshSensitivityLabel);
els.duration.addEventListener("input", refreshDurationLabel);
els.delay.addEventListener("input", refreshDelayLabel);
refreshSensitivityLabel();
refreshDurationLabel();
refreshDelayLabel();

els.soundFile.addEventListener("change", () => {
  if (objectSoundUrl) URL.revokeObjectURL(objectSoundUrl);
  objectSoundUrl = els.soundFile.files[0] ? URL.createObjectURL(els.soundFile.files[0]) : null;
});

// --- Status display -------------------------------------------------------

const STATUS_TEXT = {
  idle: "Не запущено",
  armed: "Наблюдение идёт, движения нет",
};

function setStatus(next, text) {
  state = next;
  els.status.className = `status status--${next}`;
  els.status.textContent = text ?? STATUS_TEXT[next] ?? "";
}

// --- Experimental siren: continuous tone, pitch tracks motion intensity --

let audioCtx = null;
let oscillator = null;
let gainNode = null;

function ensureSirenNodes() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!oscillator) {
    oscillator = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 200;
    gainNode.gain.value = 0;
    oscillator.connect(gainNode).connect(audioCtx.destination);
    oscillator.start();
  }
}

function updateSiren(changeRatio) {
  if (!els.sirenToggle.checked) {
    if (gainNode) gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    return;
  }
  ensureSirenNodes();
  // 200Hz at rest, up to ~2200Hz at full-frame change. Volume tracks
  // intensity too so silence is silence, not a quiet idle tone.
  const freq = 200 + changeRatio * 2000;
  oscillator.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.05);
  gainNode.gain.setTargetAtTime(Math.min(changeRatio * 2, 0.2), audioCtx.currentTime, 0.05);
}

function stopSiren() {
  if (oscillator) {
    oscillator.stop();
    oscillator.disconnect();
    oscillator = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

// --- Alarm ----------------------------------------------------------------

function playAlarmSound() {
  const src = alarmSoundSrc();
  if (!src) return;
  if (els.alarmAudio.src !== src) els.alarmAudio.src = src;
  els.alarmAudio.currentTime = 0;
  els.alarmAudio.play().catch(() => {
    // Autoplay can be blocked before any user gesture; Start is a click,
    // so this normally succeeds. Silently ignore otherwise.
  });
}

function announceAlarm(now) {
  if (now - lastSpokeAt < SPEAK_DEBOUNCE_MS) return;
  speak(customMessage());
  playAlarmSound();
  lastSpokeAt = now;
}

// --- Frame processing -------------------------------------------------------

function processFrame(now) {
  if (!motionDetector) return;

  const scale = PROCESS_WIDTH / els.video.videoWidth;
  const w = PROCESS_WIDTH;
  const h = Math.round(els.video.videoHeight * scale);
  processCanvas.width = w;
  processCanvas.height = h;
  processCtx.drawImage(els.video, 0, 0, w, h);

  els.displayCanvas.width = els.video.videoWidth;
  els.displayCanvas.height = els.video.videoHeight;
  displayCtx.drawImage(els.video, 0, 0);

  const { data } = processCtx.getImageData(0, 0, w, h);
  motionDetector.set_size(w, h);
  const result = motionDetector.process_frame(data);

  if (state !== "countdown") {
    updateSiren(motionDetector.last_change_ratio);
  }

  if (state === "countdown") return; // ignore results while arming

  const isMotion = result === wasm.DetectionResult.Detected;

  if (!isMotion) {
    motionStreakStartedAt = null;
    if (state === "alarm") setStatus("armed");
    return;
  }

  if (motionStreakStartedAt === null) motionStreakStartedAt = now;
  const streakMs = now - motionStreakStartedAt;

  if (streakMs >= durationMs()) {
    setStatus("alarm", customMessage());
    announceAlarm(now);
  }
}

let lastFrameAt = 0;
let rafHandle = null;
function tick(now) {
  if (els.video.readyState === els.video.HAVE_ENOUGH_DATA && now - lastFrameAt >= FRAME_INTERVAL_MS) {
    lastFrameAt = now;
    processFrame(now);
  }
  rafHandle = requestAnimationFrame(tick);
}

// --- Camera ----------------------------------------------------------------

async function initCamera() {
  if (els.video.srcObject) {
    els.video.srcObject.getTracks().forEach((track) => track.stop());
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: els.cameraSelect.value },
  });
  els.video.srcObject = stream;
  await new Promise((resolve) => els.video.addEventListener("loadedmetadata", resolve, { once: true }));
  motionDetector = new wasm.MotionDetector(els.video.videoWidth, els.video.videoHeight);
  refreshSensitivityLabel(); // apply current sensitivity to the fresh detector
}

function stopCamera() {
  if (els.video.srcObject) {
    els.video.srcObject.getTracks().forEach((track) => track.stop());
    els.video.srcObject = null;
  }
  motionDetector = null;
}

// --- Start / stop / delayed start ------------------------------------------

async function start() {
  await wasmReady;
  els.startStop.textContent = "Стоп";
  els.startStop.classList.add("is-active");

  try {
    await initCamera();
  } catch (error) {
    console.error("Error accessing camera:", error);
    alert("Не удалось получить доступ к камере. Проверь разрешения.");
    els.startStop.textContent = "Старт";
    els.startStop.classList.remove("is-active");
    return;
  }

  motionStreakStartedAt = null;
  rafHandle = requestAnimationFrame(tick);

  const delay = delaySeconds();
  if (delay > 0) {
    setStatus("countdown", `Запуск через ${delay} с`);
    speak(`Мониторинг запустится через ${delay} секунд`);
    let remaining = delay;
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        setStatus("armed");
        speak("Мониторинг запущен");
      } else {
        setStatus("countdown", `Запуск через ${remaining} с`);
      }
    }, 1000);
  } else {
    setStatus("armed");
    speak("Мониторинг запущен");
  }
}

function stop() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  stopSiren();
  stopCamera();
  motionStreakStartedAt = null;
  setStatus("idle");
  els.startStop.textContent = "Старт";
  els.startStop.classList.remove("is-active");
}

els.startStop.addEventListener("click", () => {
  if (state === "idle") {
    start();
  } else {
    stop();
  }
});

setStatus("idle");
