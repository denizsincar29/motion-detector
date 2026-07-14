mod utils;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Detection result enum
#[wasm_bindgen]
#[derive(Debug, PartialEq, Eq)]
pub enum DetectionResult {
    /// Not enough frames buffered yet
    NotReady,
    /// Motion detected
    Detected,
    /// No motion detected
    NotDetected,
}

/// How many consecutive grayscale frames we keep. We diff the oldest against
/// the newest frame in this buffer, not adjacent frames - at 30fps, adjacent
/// frames (33ms apart) are too close together for normal human movement to
/// produce a meaningful per-pixel delta once downscaled, especially with a
/// per-pixel threshold in the mix. ~10 frames (~330ms at 30fps) gives real
/// motion time to actually displace pixels.
const WINDOW_SIZE: usize = 10;

/// Motion detector: keeps a small sliding window of grayscale frames and
/// flags motion when the fraction of changed pixels exceeds `motion_ratio`.
#[wasm_bindgen]
pub struct MotionDetector {
    frames: Vec<Vec<u8>>,
    /// Per-pixel brightness difference above which a pixel counts as "changed".
    threshold: u8,
    /// Fraction (0.0..=1.0) of changed pixels required to call it motion.
    /// This is a ratio rather than a raw pixel count so it doesn't need to
    /// be re-tuned every time the processing resolution changes.
    motion_ratio: f32,
    /// If the fraction of changed pixels exceeds *this*, it's treated as a
    /// global lighting change (light switch, auto-exposure jump) rather
    /// than motion, since real motion is almost always localized to part
    /// of the frame, not the whole thing at once.
    max_global_change_ratio: f32,
    /// Fraction of pixels that changed on the last processed frame, kept
    /// around so callers can read continuous motion "intensity" (e.g. to
    /// drive an audio siren) rather than just the tri-state result.
    last_change_ratio: f32,
    width: usize,
    height: usize,
}

impl Default for MotionDetector {
    fn default() -> Self {
        Self::new(0, 0)
    }
}

#[wasm_bindgen]
impl MotionDetector {
    #[wasm_bindgen(constructor)]
    pub fn new(width: usize, height: usize) -> Self {
        utils::set_panic_hook();
        Self {
            frames: Vec::with_capacity(WINDOW_SIZE),
            threshold: 20,
            motion_ratio: 0.03,
            max_global_change_ratio: 0.8,
            last_change_ratio: 0.0,
            width,
            height,
        }
    }

    /// Update the frame size. Real width/height for a `<video>` element are
    /// only known after the stream starts (0x0 before that), so JS calls
    /// this once per frame. Buffered frames are dropped if size changed.
    #[wasm_bindgen]
    pub fn set_size(&mut self, width: usize, height: usize) {
        if self.width != width || self.height != height {
            self.frames.clear();
        }
        self.width = width;
        self.height = height;
    }

    #[wasm_bindgen(setter)]
    pub fn set_threshold(&mut self, threshold: u8) {
        self.threshold = threshold;
    }

    /// Sensitivity control: fraction (0.0..=1.0) of changed pixels needed
    /// to count a frame as "motion". Lower = more sensitive.
    #[wasm_bindgen(setter)]
    pub fn set_motion_ratio(&mut self, ratio: f32) {
        self.motion_ratio = ratio.clamp(0.0, 1.0);
    }

    /// Fraction (0.0..=1.0) of changed pixels above which a frame is
    /// treated as a global lighting change, not motion. Default 0.8.
    #[wasm_bindgen(setter)]
    pub fn set_max_global_change_ratio(&mut self, ratio: f32) {
        self.max_global_change_ratio = ratio.clamp(0.0, 1.0);
    }

    /// Fraction of pixels that changed on the last processed frame
    /// (0.0..=1.0). Useful for continuous feedback (e.g. an audio siren
    /// whose pitch tracks motion intensity) independent of the discrete
    /// DetectionResult.
    #[wasm_bindgen(getter)]
    pub fn last_change_ratio(&self) -> f32 {
        self.last_change_ratio
    }

    /// Pixel-by-pixel diff between the oldest and newest buffered frame.
    fn pixel_diff(&self) -> Vec<u8> {
        let oldest = self.frames.first().expect("called with a full buffer");
        let newest = self.frames.last().expect("called with a full buffer");
        oldest
            .iter()
            .zip(newest.iter())
            .map(|(&a, &b)| (a as i16 - b as i16).unsigned_abs() as u8)
            .collect()
    }

    /// Converts an RGBA or RGB buffer (as handed over by canvas ImageData) to grayscale.
    /// Returns an empty vec if the buffer size doesn't match width*height.
    fn to_grayscale(&self, frame: &[u8]) -> Vec<u8> {
        let pixel_count = self.width * self.height;
        let channels = match frame.len() {
            len if len == pixel_count * 4 => 4,
            len if len == pixel_count * 3 => 3,
            _ => return Vec::new(),
        };

        frame
            .chunks_exact(channels)
            .map(|px| {
                let (r, g, b) = (px[0] as f32, px[1] as f32, px[2] as f32);
                (0.299 * r + 0.587 * g + 0.114 * b) as u8
            })
            .collect()
    }

    fn process_gs_frame(&mut self, frame: Vec<u8>) -> DetectionResult {
        self.frames.push(frame);
        if self.frames.len() < WINDOW_SIZE {
            return DetectionResult::NotReady;
        }
        if self.frames.len() > WINDOW_SIZE {
            self.frames.remove(0);
        }

        let diff = self.pixel_diff();
        let pixel_count = (self.width * self.height).max(1);
        let motion_pixels = diff.iter().filter(|&&d| d > self.threshold).count();
        let changed_ratio = motion_pixels as f32 / pixel_count as f32;
        self.last_change_ratio = changed_ratio;

        // A light switch, sunrise/sunset, or auto-exposure jump changes
        // nearly every pixel at once. Real motion changes a *region*, not
        // the whole frame, so a suspiciously high ratio is treated as
        // "not motion" even if it clears the sensitivity threshold.
        if changed_ratio > self.max_global_change_ratio {
            return DetectionResult::NotDetected;
        }

        if changed_ratio > self.motion_ratio {
            DetectionResult::Detected
        } else {
            DetectionResult::NotDetected
        }
    }

    /// Process one raw camera frame (RGBA/RGB bytes from canvas ImageData).
    #[wasm_bindgen]
    pub fn process_frame(&mut self, frame: Vec<u8>) -> DetectionResult {
        let gs_frame = self.to_grayscale(&frame);
        if gs_frame.is_empty() {
            return DetectionResult::NotReady;
        }
        self.process_gs_frame(gs_frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_size_frame() {
        let mut md = MotionDetector::new(4, 4);
        let bad_frame = vec![0u8; 10]; // not 4*4*3 or 4*4*4
        assert_eq!(md.process_frame(bad_frame), DetectionResult::NotReady);
    }

    #[test]
    fn detects_no_motion_on_identical_frames() {
        let mut md = MotionDetector::new(2, 2);
        md.set_motion_ratio(0.0);
        let frame = vec![100u8; 2 * 2 * 3]; // flat gray RGB
        for _ in 0..WINDOW_SIZE {
            md.process_frame(frame.clone());
        }
        let result = md.process_frame(frame);
        assert_eq!(result, DetectionResult::NotDetected);
    }

    #[test]
    fn ignores_global_brightness_change() {
        // Simulate flipping a light switch: every pixel drops at once.
        let mut md = MotionDetector::new(4, 4);
        md.set_motion_ratio(0.0); // would trigger on almost any diff
        let bright = vec![200u8; 4 * 4 * 3];
        let dark = vec![10u8; 4 * 4 * 3];
        for _ in 0..WINDOW_SIZE {
            md.process_frame(bright.clone());
        }
        let result = md.process_frame(dark);
        assert_eq!(result, DetectionResult::NotDetected);
    }

    #[test]
    fn detects_localized_motion_after_window_fills() {
        let mut md = MotionDetector::new(4, 4);
        md.set_motion_ratio(0.05); // one changed pixel out of 16 (6.25%) should clear this
        let still = vec![50u8; 4 * 4 * 3];
        let mut moved = still.clone();
        moved[0] = 200; // one pixel changes a lot, rest of the frame stays put
        for _ in 0..WINDOW_SIZE {
            md.process_frame(still.clone());
        }
        let result = md.process_frame(moved);
        assert_eq!(result, DetectionResult::Detected);
    }

    #[test]
    fn last_change_ratio_reflects_partial_motion() {
        let mut md = MotionDetector::new(2, 2);
        md.set_motion_ratio(1.1); // impossible to exceed, we only check the ratio getter
        let a = vec![0u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 4 px RGB, all black
        let mut b = a.clone();
        b[0] = 255; // change one channel of one pixel enough to cross `threshold`
        for _ in 0..WINDOW_SIZE {
            md.process_frame(a.clone());
        }
        md.process_frame(b);
        assert!(md.last_change_ratio() > 0.0);
    }
}
