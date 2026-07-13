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
  diagnostics: document.getElementById("diagnostics"),
  cameraField: document.getElementById("camera-field"),
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
let activeVideoTrack = null;
let cameraDiag = "ok"; // "ok" | "muted" | "ended" | "dark"
let darkFrameStreakStartedAt = null;
let cameraStartedAt = null;

// --- Camera-health diagnostics ---------------------------------------------
// Answers "is there simply no video feed, or is the lens/shutter physically
// covered": getUserMedia succeeding only means the OS granted a stream, not
// that frames contain a picture. A hardware privacy shutter (common on
// laptops, including yours) typically surfaces as the MediaStreamTrack
// going "muted" - the browser's own signal that no data is arriving at the
// hardware level. A near-black picture despite an unmuted, live track is
// the other case: the shutter/lens cap is physically blocking the sensor.

const DIAGNOSTIC_TEXT = {
  ok: "",
  muted: "Видео с камеры не поступает на аппаратном уровне — похоже, шторка камеры закрыта или она отключена системным переключателем.",
  ended: "Видеодорожка остановлена — камера отвалилась или её забрала другая программа.",
  dark: "Кадры почти полностью чёрные — камера передаёт видео, но объектив, похоже, чем-то закрыт.",
};

function setDiagnostic(next) {
  if (cameraDiag === next) return;
  cameraDiag = next;
  els.diagnostics.textContent = DIAGNOSTIC_TEXT[next];
  if (next !== "ok") speak(DIAGNOSTIC_TEXT[next]);
}

function averageBrightness(data) {
  // Luma (matches the grayscale weights used in the wasm module), not a
  // single channel. Sampling red alone caused false "dark" reports under
  // cool-toned lighting where the red channel legitimately reads low even
  // though the picture is perfectly visible.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 16) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count++;
  }
  return count ? sum / count : 0;
}

const DARK_THRESHOLD = 12; // 0..255, "basically black"
const DARK_HOLD_MS = 2000; // how long it must stay black before we say so
const EXPOSURE_GRACE_MS = 2000; // ignore brightness right after camera start - auto-exposure needs a moment

let lastBrightnessLogAt = 0;

function updateBrightnessDiagnostic(data, now) {
  if (cameraDiag === "muted" || cameraDiag === "ended") return; // those take priority
  if (cameraStartedAt !== null && now - cameraStartedAt < EXPOSURE_GRACE_MS) return; // let auto-exposure settle

  const brightness = averageBrightness(data);
  if (now - lastBrightnessLogAt > 1000) {
    console.debug(`[motion-detector] средняя яркость кадра: ${brightness.toFixed(1)}/255`);
    lastBrightnessLogAt = now;
  }

  if (brightness < DARK_THRESHOLD) {
    if (darkFrameStreakStartedAt === null) darkFrameStreakStartedAt = now;
    if (now - darkFrameStreakStartedAt >= DARK_HOLD_MS) setDiagnostic("dark");
  } else {
    darkFrameStreakStartedAt = null;
    if (cameraDiag === "dark") setDiagnostic("ok");
  }
}

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
  updateBrightnessDiagnostic(data, now);
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

function attachTrackDiagnostics(track) {
  activeVideoTrack = track;
  const evaluate = () => {
    if (track.readyState === "ended") setDiagnostic("ended");
    else if (track.muted) setDiagnostic("muted");
    else if (cameraDiag === "muted" || cameraDiag === "ended") setDiagnostic("ok");
  };
  track.addEventListener("mute", evaluate);
  track.addEventListener("unmute", evaluate);
  track.addEventListener("ended", evaluate);
  evaluate();
}

async function openStream(deviceId) {
  const constraints = deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: true };
  return navigator.mediaDevices.getUserMedia(constraints);
}

/** Populate the camera <select> with real device labels; hide it entirely
 *  if there's nothing to choose between (the common desktop case: one
 *  webcam, no "front/back" concept). Labels are only available *after*
 *  permission was granted, hence this runs after the first getUserMedia. */
async function populateCameraList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");

  els.cameraSelect.innerHTML = "";
  cameras.forEach((cam, i) => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Камера ${i + 1}`;
    els.cameraSelect.appendChild(opt);
  });

  els.cameraField.hidden = cameras.length <= 1;
}

async function attachStream(stream) {
  if (els.video.srcObject) {
    els.video.srcObject.getTracks().forEach((track) => track.stop());
  }
  els.video.srcObject = stream;
  attachTrackDiagnostics(stream.getVideoTracks()[0]);
  await new Promise((resolve) => els.video.addEventListener("loadedmetadata", resolve, { once: true }));
  cameraStartedAt = performance.now();
  darkFrameStreakStartedAt = null;
}

async function initCamera() {
  const stream = await openStream(); // no deviceId yet - just get permission + a default camera
  await attachStream(stream);
  await populateCameraList();
  motionDetector = new wasm.MotionDetector(els.video.videoWidth, els.video.videoHeight);
  refreshSensitivityLabel(); // apply current sensitivity to the fresh detector
}

/** Switch to a specific camera once the list is known (select "change"). */
async function switchCamera(deviceId) {
  try {
    const stream = await openStream(deviceId);
    await attachStream(stream);
    // motionDetector stays alive; set_size() in the frame loop clears its
    // buffer automatically if the new camera's resolution differs.
  } catch (error) {
    console.error("Error switching camera:", error);
    alert("Не удалось переключиться на выбранную камеру.");
  }
}

els.cameraSelect.addEventListener("change", () => switchCamera(els.cameraSelect.value));

function stopCamera() {
  if (els.video.srcObject) {
    els.video.srcObject.getTracks().forEach((track) => track.stop());
    els.video.srcObject = null;
  }
  activeVideoTrack = null;
  motionDetector = null;
  darkFrameStreakStartedAt = null;
  cameraStartedAt = null;
  cameraDiag = "ok";
  els.diagnostics.textContent = "";
}

// --- Start / stop / delayed start ------------------------------------------

const CAMERA_ERROR_MESSAGES = {
  NotFoundError: "Камера не найдена системой — физически не подключена или отключена в диспетчере устройств.",
  DevicesNotFoundError: "Камера не найдена системой — физически не подключена или отключена в диспетчере устройств.",
  NotAllowedError: "Доступ к камере запрещён — проверь разрешения браузера и системные настройки приватности.",
  PermissionDeniedError: "Доступ к камере запрещён — проверь разрешения браузера и системные настройки приватности.",
  NotReadableError: "Камера не отвечает на уровне железа — либо занята другой программой, либо аппаратно заблокирована (шторка/переключатель на корпусе).",
  TrackStartError: "Камера не отвечает на уровне железа — либо занята другой программой, либо аппаратно заблокирована (шторка/переключатель на корпусе).",
  OverconstrainedError: "Не удалось подобрать камеру под заданные параметры.",
};

function cameraErrorMessage(error) {
  return CAMERA_ERROR_MESSAGES[error.name] || `Не удалось получить доступ к камере (${error.name || error.message}).`;
}

async function start() {
  await wasmReady;
  els.startStop.textContent = "Стоп";
  els.startStop.classList.add("is-active");

  try {
    await initCamera();
  } catch (error) {
    console.error("Error accessing camera:", error);
    alert(cameraErrorMessage(error));
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
    // Must happen synchronously inside the click, not after the camera's
    // awaits - otherwise the browser no longer considers this a user
    // gesture and keeps the AudioContext suspended (silent) forever.
    ensureSirenNodes();
    audioCtx.resume();
    start();
  } else {
    stop();
  }
});

setStatus("idle");
