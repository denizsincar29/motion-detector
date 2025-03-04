mod utils;  // for panic hook

use wasm_bindgen::prelude::*;

// console.log wrapper
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Detection result enum
#[wasm_bindgen]
#[derive(Debug)]
pub enum DetectionResult {
    /// Not enough frames to process
    NotReady,
    /// Motion detected
    Detected,
    /// No motion detected
    NotDetected,
}

/// Motion detector struct
#[wasm_bindgen]
pub struct MotionDetector {
    frames: Vec<Vec<u8>>, // Store grayscale frames
    threshold: u8,          // Threshold for pixel difference to be considered motion
    motion_pixel_count: usize, // Number of pixels above the threshold to trigger detection
    width: usize,
    height: usize,
}

#[wasm_bindgen]
#[allow(clippy::new_without_default)]
impl MotionDetector {
    /// Create a new MotionDetector instance
    #[wasm_bindgen(constructor)]
    pub fn new(width: usize, height: usize) -> Self {
        utils::set_panic_hook();
        Self {
            frames: vec![],
            threshold: 30,
            motion_pixel_count: 100,
            width,
            height,
        }
    }

    /// set width and height
    /// This is a workaround for the fact that width and height is available only after the first frame is processed
    #[wasm_bindgen]
    pub fn set_size(&mut self, width: usize, height: usize) {
        // if width and height are different from the previous ones, clear the frames
        if self.width != width || self.height != height {
            self.frames.clear();
        }
        // set new width and height
        self.width = width;
        self.height = height;
    }

    #[wasm_bindgen(setter)]
    pub fn set_threshold(&mut self, threshold: u8) {
        self.threshold = threshold;
    }

    #[wasm_bindgen(setter)]
    pub fn set_motion_pixel_count(&mut self, motion_pixel_count: usize) {
        self.motion_pixel_count = motion_pixel_count;
    }

    fn get_pixel_diff(&self) -> Vec<u8> {
        if self.frames.len() < 3 {
            return vec![vec![0u8;self.width*self.height]].concat();
        }

        let mut pixel_diff = vec![0u8; self.width * self.height]; // Initialize with zeros

        for i in 0..self.width * self.height {
            let diff1 = (self.frames[0][i] as i32 - self.frames[1][i] as i32).abs() as u8;
            let diff2 = (self.frames[1][i] as i32 - self.frames[2][i] as i32).abs() as u8;
            pixel_diff[i] = ((diff1 as u32 + diff2 as u32) / 2) as u8; // Averaged difference
        }
        pixel_diff
    }

    fn to_grayscale(&self, frame: Vec<u8>) -> Vec<u8> {
        let expected_rgba_size = self.width * self.height * 4;
        let expected_rgb_size = self.width * self.height * 3;
        // print width and height
        // because it logged me Invalid frame size: 1228800 which is 640x480x4, seams like width and height is bad
        // upd. Width and height was 0! Js's fault
        // upd2. js's videoWidth and videoHeight is 0 until first frame is processed
        // log(&format!("width: {}", self.width));  // no need to log it anymore
        // log(&format!("height: {}", self.height));
        if frame.len() != expected_rgba_size && frame.len() != expected_rgb_size {
            // log(&format!("Invalid frame size: {}", frame.len()));
            return vec![];
        }
        let step_by = if frame.len() == expected_rgba_size { 4 } else { 3 };
        // log(&format!("step_by: {}", step_by));
        let mut grayscale_frame = Vec::with_capacity(self.width * self.height);
        for i in (0..frame.len()).step_by(step_by) {
            if i + 2 >= frame.len() {
                break;
            }
            let r = frame[i] as f32;
            let g = frame[i + 1] as f32;
            let b = frame[i + 2] as f32;
            let gray = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
            grayscale_frame.push(gray);
        }
        grayscale_frame
    }

    fn process_gs_frame(&mut self, frame: Vec<u8>) -> DetectionResult {
        if self.frames.len() == 3 {
            let pixel_diff = self.get_pixel_diff();
            let pix_count = pixel_diff.iter().filter(|&x| *x > self.threshold).count();
            let motion_detected = pix_count > self.motion_pixel_count;
            self.frames.remove(0);
            self.frames.push(frame);
            if motion_detected {
                DetectionResult::Detected
            } else {
                DetectionResult::NotDetected
            }
        } else {
            self.frames.push(frame);
            DetectionResult::NotReady
        }
    }

    /// Process a frame
    #[wasm_bindgen]
    pub fn process_frame(&mut self, frame: Vec<u8>) -> DetectionResult {
        let gs_frame = self.to_grayscale(frame);
        self.process_gs_frame(gs_frame)
    }
}