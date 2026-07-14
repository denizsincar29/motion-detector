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
  torchField: document.getElementById("torch-field"),
  torchHint: document.getElementById("torch-hint"),
  torchToggle: document.getElementById("torch-toggle"),
  calibrateStart: document.getElementById("calibrate-start"),
  calibrationPanel: document.getElementById("calibration-panel"),
  calibrationStatus: document.getElementById("calibration-status"),
  calibrationAction: document.getElementById("calibration-action"),
  calibrationYesNo: document.getElementById("calibration-yesno"),
  calibrationApply: document.getElementById("calibration-apply"),
  calibrationDiscard: document.getElementById("calibration-discard"),
};

const displayCtx = els.displayCanvas.getContext("2d");
const wasmReady = wasm.default();

// Small offscreen canvas used only to feed the detector.
const processCanvas = document.createElement("canvas");
const processCtx = processCanvas.getContext("2d", { willReadFrequently: true });

/** @typedef {"idle"|"countdown"|"armed"|"alarm"|"calibrating"} AppState */
/** @type {AppState} */
let state = "idle";

let motionDetector = null;
let lastSpokeAt = 0;
let motionStreakStartedAt = null; // timestamp when the current unbroken motion streak began
let countdownTimer = null;
let objectSoundUrl = null; // set when a local file is chosen, revoked on replace
let currentMotionRatio = 0;
let lastMotionLogAt = 0;
let activeVideoTrack = null;
let cameraDiag = "ok"; // "ok" | "muted" | "ended" | "dark"
let darkFrameStreakStartedAt = null;
let cameraStartedAt = null;
let frameReader = null;
let usingTrackProcessor = false;

// --- Calibration wizard state -----------------------------------------------
let calNoiseFloor = 0; // max last_change_ratio observed while standing still
let calStillTimer = null; // set while the "still" phase's timer is pending
let calMoveActive = false; // true once the "move" phase has started
let calMoveStartedAt = 0;
let calAboveFloorMs = 0; // total time during the move phase spent above calNoiseFloor
let calLastFrameAt = null; // for computing per-frame dt during calibration
let calProposedPct = 50;
let calProposedDurationS = 1;

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
    console.debug(
      `[motion-detector] яркость: ${brightness.toFixed(1)}/255, ` +
        `video.currentTime=${els.video.currentTime.toFixed(2)}, paused=${els.video.paused}`
    );
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

/** Best-effort: nudge exposure/brightness up and surface a torch toggle if
 *  the camera exposes these (most webcams don't; phone rear cameras with
 *  torch are the realistic win here). None of this can help if there's
 *  genuinely no light at all - it's a sensor, not magic. */
async function tryBrightenCamera(track) {
  els.torchField.hidden = true;
  els.torchHint.hidden = true;
  if (typeof track.getCapabilities !== "function") return;

  let caps;
  try {
    caps = track.getCapabilities();
  } catch {
    return;
  }
  console.info("[motion-detector] возможности камеры:", caps);

  const advanced = {};
  if (caps.exposureCompensation) advanced.exposureCompensation = caps.exposureCompensation.max;
  if (caps.brightness) advanced.brightness = caps.brightness.max;
  if (Object.keys(advanced).length > 0) {
    try {
      await track.applyConstraints({ advanced: [advanced] });
      console.info("[motion-detector] подняли экспозицию/яркость камеры:", advanced);
    } catch (error) {
      console.warn("[motion-detector] не удалось применить настройки яркости:", error);
    }
  }

  if (caps.torch) {
    els.torchField.hidden = false;
    els.torchHint.hidden = false;
    els.torchToggle.checked = false;
  }
}

els.torchToggle.addEventListener("change", async () => {
  if (!activeVideoTrack) return;
  try {
    await activeVideoTrack.applyConstraints({ advanced: [{ torch: els.torchToggle.checked }] });
  } catch (error) {
    console.error("[motion-detector] не удалось переключить фонарик:", error);
    alert("Не удалось включить фонарик — камера или браузер это не поддерживает.");
    els.torchToggle.checked = false;
  }
});

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

// --- Sensitivity slider <-> wasm parameter mapping ------------------------
// Shared by the slider itself and the calibration wizard, which needs to
// go the other way (measured ratio -> slider position to propose).

const SENSITIVITY_MIN_RATIO = 0.01; // most sensitive
const SENSITIVITY_MAX_RATIO = 0.3; // least sensitive
const THRESHOLD_MIN = 10; // most sensitive
const THRESHOLD_MAX = 40; // least sensitive

function sensitivityPctToRatio(pct) {
  return SENSITIVITY_MAX_RATIO - (pct - 1) * ((SENSITIVITY_MAX_RATIO - SENSITIVITY_MIN_RATIO) / 99);
}

function sensitivityPctToThreshold(pct) {
  return Math.round(THRESHOLD_MAX - (pct - 1) * ((THRESHOLD_MAX - THRESHOLD_MIN) / 99));
}

function ratioToSensitivityPct(ratio) {
  const clamped = Math.min(SENSITIVITY_MAX_RATIO, Math.max(SENSITIVITY_MIN_RATIO, ratio));
  const pct = 1 + (SENSITIVITY_MAX_RATIO - clamped) * (99 / (SENSITIVITY_MAX_RATIO - SENSITIVITY_MIN_RATIO));
  return Math.round(pct);
}

function clampDurationSeconds(seconds) {
  return Math.min(5, Math.max(0.2, seconds));
}

function refreshSensitivityLabel() {
  els.sensitivityValue.textContent = `${els.sensitivity.value}%`;
  if (motionDetector) {
    const pct = Number(els.sensitivity.value);
    // Two knobs on the wasm side move together: how much of the frame must
    // change (motion_ratio) and how much a single pixel must change to
    // count at all (threshold). Only tuning the former left threshold
    // stuck at a fixed value that no slider setting could get under.
    const ratio = sensitivityPctToRatio(pct);
    motionDetector.motion_ratio = ratio;
    currentMotionRatio = ratio;
    motionDetector.threshold = sensitivityPctToThreshold(pct);
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

function sourceDimensions(source) {
  return source instanceof HTMLVideoElement
    ? [source.videoWidth, source.videoHeight]
    : [source.displayWidth, source.displayHeight]; // VideoFrame
}

function processFrame(source, now) {
  if (!motionDetector) return;
  const [srcWidth, srcHeight] = sourceDimensions(source);
  if (!srcWidth || !srcHeight) return;

  const scale = PROCESS_WIDTH / srcWidth;
  const w = PROCESS_WIDTH;
  const h = Math.round(srcHeight * scale);
  processCanvas.width = w;
  processCanvas.height = h;
  processCtx.drawImage(source, 0, 0, w, h);

  els.displayCanvas.width = srcWidth;
  els.displayCanvas.height = srcHeight;
  displayCtx.drawImage(source, 0, 0);

  const { data } = processCtx.getImageData(0, 0, w, h);
  updateBrightnessDiagnostic(data, now);
  motionDetector.set_size(w, h);
  const result = motionDetector.process_frame(data);

  if (now - lastMotionLogAt > 1000) {
    const resultText =
      result === wasm.DetectionResult.Detected
        ? "движение"
        : result === wasm.DetectionResult.NotReady
          ? "буфер наполняется"
          : "нет движения";
    console.debug(
      `[motion-detector] изменилось: ${(motionDetector.last_change_ratio * 100).toFixed(1)}%, ` +
        `порог срабатывания: ${(currentMotionRatio * 100).toFixed(1)}%, результат: ${resultText}`
    );
    lastMotionLogAt = now;
  }

  if (state === "calibrating") {
    onCalibrationFrame(motionDetector.last_change_ratio, now);
    return;
  }

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

// Fallback path for browsers without MediaStreamTrackProcessor: pull
// frames from the <video> element via rAF, as before.
function tick(now) {
  if (
    !usingTrackProcessor &&
    els.video.readyState === els.video.HAVE_ENOUGH_DATA &&
    now - lastFrameAt >= FRAME_INTERVAL_MS
  ) {
    lastFrameAt = now;
    processFrame(els.video, now);
  }
  rafHandle = requestAnimationFrame(tick);
}

// Preferred path: read decoded VideoFrames straight off the camera track.
// This bypasses the <video> element's compositor entirely, which matters
// on setups where drawImage() from a *playing, unpaused* <video> still
// reads a black buffer - typically a GPU hardware-overlay/zero-copy
// video path that never becomes software-readable through the element.
async function readFrameLoop() {
  const reader = frameReader;
  while (reader === frameReader) {
    let result;
    try {
      result = await reader.read();
    } catch (error) {
      console.error("[motion-detector] track processor read failed:", error);
      break;
    }
    if (reader !== frameReader) {
      if (result?.value) result.value.close();
      break;
    }
    if (result.done) break;

    const frame = result.value;
    const now = performance.now();
    if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
      lastFrameAt = now;
      processFrame(frame, now);
    }
    frame.close();
  }
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

  console.info(
    `[motion-detector] найдено камер: ${cameras.length} — ` +
      cameras.map((c, i) => `[${i}] "${c.label || "(без названия)"}"`).join(", ")
  );

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
  stopFrameSource();
  if (els.video.srcObject) {
    els.video.srcObject.getTracks().forEach((track) => track.stop());
  }
  els.video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  attachTrackDiagnostics(track);
  await new Promise((resolve) => els.video.addEventListener("loadedmetadata", resolve, { once: true }));

  try {
    await els.video.play();
  } catch (error) {
    // If autoplay is blocked here, the fallback <video>+canvas path would
    // keep reading the element's initial (black) frame forever even
    // though the track itself is "live" - this is a concrete failure
    // mode, not a guess. Doesn't matter if MediaStreamTrackProcessor ends
    // up being used instead, but worth knowing either way.
    console.error("[motion-detector] video.play() failed:", error);
  }

  cameraStartedAt = performance.now();
  darkFrameStreakStartedAt = null;
  await tryBrightenCamera(track);

  if (typeof MediaStreamTrackProcessor !== "undefined") {
    // Reads decoded VideoFrames straight off the track, bypassing the
    // <video> element's compositor path entirely. On some GPU/driver
    // combinations a playing, unpaused <video> is composited via a
    // hardware overlay and drawImage() from it reads a black buffer -
    // this sidesteps that class of bug rather than working around it.
    usingTrackProcessor = true;
    const processor = new MediaStreamTrackProcessor({ track });
    frameReader = processor.readable.getReader();
    readFrameLoop();
    console.info("[motion-detector] источник кадров: MediaStreamTrackProcessor (в обход <video>/canvas)");
  } else {
    usingTrackProcessor = false;
    console.info("[motion-detector] источник кадров: <video> + canvas (MediaStreamTrackProcessor не поддерживается)");
  }

  console.info(
    `[motion-detector] выбрана камера: "${track.label || "(без названия)"}", ` +
      `${els.video.videoWidth}x${els.video.videoHeight}, ` +
      `readyState=${track.readyState}, muted=${track.muted}, paused=${els.video.paused}`
  );
}

function stopFrameSource() {
  if (frameReader) {
    const reader = frameReader;
    frameReader = null;
    reader.cancel().catch(() => {});
  }
  usingTrackProcessor = false;
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
  stopFrameSource();
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
  els.torchField.hidden = true;
  els.torchHint.hidden = true;
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
  els.calibrateStart.disabled = true;

  try {
    await initCamera();
  } catch (error) {
    console.error("Error accessing camera:", error);
    alert(cameraErrorMessage(error));
    els.startStop.textContent = "Старт";
    els.startStop.classList.remove("is-active");
    els.calibrateStart.disabled = false;
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
  els.calibrateStart.disabled = false;
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

// --- Calibration wizard -----------------------------------------------------
// Measures the actual noise floor in front of the camera right now (nobody
// holds perfectly still, lights flicker, compression adds jitter) and
// proposes a sensitivity/duration pair from real numbers instead of
// guessing at abstract percentages.

const STILL_SAMPLE_MS = 4000;

function calSetStatus(text) {
  els.calibrationStatus.textContent = text;
}

function showCalAction(label, handler) {
  els.calibrationAction.textContent = label;
  els.calibrationAction.hidden = false;
  els.calibrationAction.onclick = handler;
}

function hideCalAction() {
  els.calibrationAction.hidden = true;
  els.calibrationAction.onclick = null;
}

async function startCalibration() {
  if (state !== "idle") return;
  els.calibrateStart.hidden = true;
  els.startStop.disabled = true;
  els.calibrationPanel.hidden = false;
  els.calibrationYesNo.hidden = true;
  calSetStatus("Включаю камеру...");

  try {
    await wasmReady;
    await initCamera();
  } catch (error) {
    console.error("[motion-detector] camera error during calibration:", error);
    alert(cameraErrorMessage(error));
    endCalibration();
    return;
  }

  setStatus("calibrating", "Калибровка идёт — подробности в панели ниже.");
  rafHandle = requestAnimationFrame(tick);

  calNoiseFloor = 0;
  calLastFrameAt = null;
  calSetStatus("Встань перед камерой в обычном положении и не двигайся. Когда будешь готов — нажми кнопку.");
  speak("Встань перед камерой и не двигайся. Когда будешь готов, нажми кнопку записи фона.");
  showCalAction("Я стою неподвижно — начать запись", beginStillPhase);
}

function beginStillPhase() {
  hideCalAction();
  calNoiseFloor = 0;
  calLastFrameAt = null;
  calStillTimer = setTimeout(beginMovePhase, STILL_SAMPLE_MS);
  calSetStatus("Записываю фон, не двигайся ещё несколько секунд...");
  speak("Записываю фон, не двигайся четыре секунды.");
}

function beginMovePhase() {
  calStillTimer = null;
  calMoveActive = true;
  calMoveStartedAt = performance.now();
  calAboveFloorMs = 0;
  calLastFrameAt = null;
  calSetStatus("Теперь подвигайся перед камерой — помаши руками, пройдись. Нажми «Стоп», когда закончишь.");
  speak("Теперь подвигайся перед камерой. Нажми стоп, когда закончишь.");
  showCalAction("Стоп, закончил двигаться", finishMovePhase);
}

function finishMovePhase() {
  hideCalAction();
  calMoveActive = false;
  const totalMoveS = (performance.now() - calMoveStartedAt) / 1000;
  const movedS = calAboveFloorMs / 1000;

  // Threshold: comfortably above the observed noise floor, never below the
  // slider's own minimum. Duration: noisier background -> longer debounce,
  // since a jittery floor is more likely to throw brief false spikes.
  const proposedRatio = Math.min(SENSITIVITY_MAX_RATIO, Math.max(SENSITIVITY_MIN_RATIO, calNoiseFloor * 1.6 + 0.01));
  calProposedPct = ratioToSensitivityPct(proposedRatio);
  calProposedDurationS = clampDurationSeconds(calNoiseFloor > 0.05 ? 0.8 : calNoiseFloor > 0.02 ? 0.5 : 0.3);

  const summary =
    `Фон: ${(calNoiseFloor * 100).toFixed(1)} процента. ` +
    `Во время движения оно засекалось ${movedS.toFixed(1)} секунды из ${totalMoveS.toFixed(1)}. ` +
    `Предлагаю чувствительность ${calProposedPct} процентов и задержку ${calProposedDurationS.toFixed(1)} секунды. Применить?`;

  calSetStatus(summary);
  speak(summary);
  els.calibrationYesNo.hidden = false;
}

function onCalibrationFrame(ratio, now) {
  const dt = calLastFrameAt !== null ? now - calLastFrameAt : 0;
  calLastFrameAt = now;

  if (calStillTimer !== null) {
    if (ratio > calNoiseFloor) calNoiseFloor = ratio;
    return;
  }

  if (calMoveActive && ratio > calNoiseFloor) {
    calAboveFloorMs += dt;
  }
}

function applyCalibration() {
  els.sensitivity.value = String(calProposedPct);
  refreshSensitivityLabel();
  els.duration.value = calProposedDurationS.toFixed(1);
  refreshDurationLabel();
  speak("Настройки применены.");
  endCalibration();
}

function discardCalibration() {
  speak("Изменения не применены, старые настройки сохранены.");
  endCalibration();
}

function endCalibration() {
  if (calStillTimer) {
    clearTimeout(calStillTimer);
    calStillTimer = null;
  }
  calMoveActive = false;
  hideCalAction();
  els.calibrationYesNo.hidden = true;
  els.calibrationPanel.hidden = true;
  els.calibrateStart.hidden = false;
  els.startStop.disabled = false;
  calSetStatus("");

  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  stopCamera();
  setStatus("idle");
}

els.calibrateStart.addEventListener("click", startCalibration);
els.calibrationApply.addEventListener("click", applyCalibration);
els.calibrationDiscard.addEventListener("click", discardCalibration);

setStatus("idle");
