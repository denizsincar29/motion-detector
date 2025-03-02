mod utils;  // for panic hook

use wasm_bindgen::prelude::*;

// console.log
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// enum that returns by process_frame: not ready, detected, not detected
#[wasm_bindgen]
#[derive(Debug)]
pub enum DetectionResult {
    NotReady,
    Detected,
    NotDetected,
}

// make a wasm struct motion detector. It accepts 3 frames
#[wasm_bindgen]
pub struct MotionDetector {
    frames: Vec<Vec<u8>>,
    threshold: u8,          // Threshold for pixel difference to be considered motion
    motion_pixel_count: usize, // Number of pixels above the threshold to trigger detection
}
// implement the struct
#[wasm_bindgen]
// linter says to implement default, i don't want
#[allow(clippy::new_without_default)]
impl MotionDetector {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        utils::set_panic_hook();
        Self {
            frames: vec![],
            threshold: 30,
            motion_pixel_count: 100,
        }
    }

    // Setter for threshold
    #[wasm_bindgen(setter)]
    pub fn set_threshold(&mut self, threshold: u8) {
        self.threshold = threshold;
    }

     // Setter for motion_pixel_count
    #[wasm_bindgen(setter)]
    pub fn set_motion_pixel_count(&mut self, motion_pixel_count: usize) {
        self.motion_pixel_count = motion_pixel_count;
    }


    // make a private function that gets the pixel difference of 3 frames: (1 diff 2) bitand (2 diff 3)
    fn get_pixel_diff(&self) -> Vec<u8> {
        if self.frames.len() < 3 {
            return vec![]; // Or return an error, handle appropriately
        }

        let mut pixel_diff = vec![];
        for i in 0..self.frames[0].len() {
            pixel_diff.push((self.frames[0][i] ^ self.frames[1][i]) & (self.frames[1][i] ^ self.frames[2][i]));
        }
        pixel_diff
    }

    // translate to grayscale
    fn to_grayscale(&self, frame: Vec<u8>) -> Vec<u8> {
        let mut grayscale_frame = vec![];
        for i in (0..frame.len()).step_by(4) {
            if i + 2 >= frame.len() {
                // Handle edge case where frame length is not a multiple of 4
                break; // Or return an error, handle appropriately
            }
            let r = frame[i] as f32;
            let g = frame[i + 1] as f32;
            let b = frame[i + 2] as f32;
            let gray = (0.3 * r + 0.59 * g + 0.11 * b) as u8;
            grayscale_frame.push(gray);
        }
        grayscale_frame
    }

    // process frame takes a grayscale frame, width, height and returns DetectionResult
    fn process_gs_frame(&mut self, frame: Vec<u8>, _width: usize, _height: usize) -> DetectionResult {
        // if we have 3 frames, we can process them
        if self.frames.len() == 3 {
            // get the pixel difference
            let pixel_diff = self.get_pixel_diff();
            // calculate the motion detected
            let motion_detected = pixel_diff.iter().filter(|&&x| x > self.threshold).count() > self.motion_pixel_count;
            // remove the first frame and add the new frame
            self.frames.remove(0);
            self.frames.push(frame);
            // return the result
            if motion_detected {
                DetectionResult::Detected
            } else {
                DetectionResult::NotDetected
            }
        } else {
            // if we don't have 3 frames, add the frame
            self.frames.push(frame);
            DetectionResult::NotReady
        }
    }

    /// process frame takes a frame, width, height and returns DetectionResult
    #[wasm_bindgen]
    pub fn process_frame(&mut self, frame: Vec<u8>, width: usize, height: usize) -> DetectionResult {
        // convert the frame to grayscale
        let gs_frame = self.to_grayscale(frame);
        // process the grayscale frame
        self.process_gs_frame(gs_frame, width, height)
    }
}