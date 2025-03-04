// Motion detector
// sends video data to wasm module, it returns if current 3 frames are 100 px different

// import wasm module
import * as wasm from "./pkg/motion_detector.js";
import { speak } from "./screenreader.js";

let motionDetector = null;
let canvas = null;
let ctx = null;
let video = null; // Define video here
let motion_div = document.getElementById("motion");

// Debounce time for screen reader announcements (milliseconds)
const DEBOUNCE_TIME = 1000;
let lastSpokeTime = 0;
let motionDetectedSinceLastSpoke = false;

// if ?say=custom+detection+message is in the URL, speak the custom message
const urlParams = new URLSearchParams(window.location.search);
let customMessage = urlParams.get("say");
// is it url decoded? And + is space as like in google search
customMessage = customMessage ? decodeURIComponent(customMessage) : null;
if (!customMessage) {
  customMessage = "Motion detected";
}

// Function to process frame and send to WASM
function processFrame() {
  if (motionDetector === null) {
    console.log("motionDetector is not ready yet");
    return wasm.DetectionResult.NotReady; // Return NotReady to avoid errors later
  }
  // Set canvas size to match video dimensions
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // Draw current video frame to canvas
  ctx.drawImage(video, 0, 0);

  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  // set width and height of the motion detector
  motionDetector.set_size(canvas.width, canvas.height);
  // Send the raw pixel data to WASM
  return motionDetector.process_frame(pixels);
}

function handleMotion(detectionResult) {
  if (detectionResult === wasm.DetectionResult.Detected) {
    motionDetectedSinceLastSpoke = true;
    motion_div.style.backgroundColor = "red";
    motion_div.style.color = "white"; // Ensure text is visible on red
    motion_div.textContent = customMessage;
  } else {
    motion_div.style.backgroundColor = "lightgray"; // Neutral background
    motion_div.style.color = "black"; // Default text color
    motion_div.textContent = "No Motion";
  }
}

// Process frames at regular intervals
setInterval(() => {
  // if canvas or ctx or video is not defined yet, return
  if (!canvas || !ctx || !video) {
    return;
  }

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const result = processFrame();
    handleMotion(result);
  }
}, 1000 / 30); // 30 fps

// Screen reader announcement interval
setInterval(() => {
  if (motionDetectedSinceLastSpoke) {
    const now = Date.now();
    if (now - lastSpokeTime > DEBOUNCE_TIME) {
      speak(customMessage);
      lastSpokeTime = now;
      motionDetectedSinceLastSpoke = false; // Reset the flag
    }
  }
}, 100); // Check every 100ms

async function initEverything() {
  await wasm.default();
  // get video element
  video = document.getElementById("video"); // Assign video here
  // get canvas element
  canvas = document.getElementById("canvas");
  ctx = canvas.getContext("2d");
  // init camera
  let stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  motionDetector = new wasm.MotionDetector(video.videoWidth, video.videoHeight);
}

initEverything();