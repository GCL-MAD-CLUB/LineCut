use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FrameTraceData {
    pub(super) motion: Vec<f64>,
    pub(super) colors: Vec<[f64; 4]>,
    pub(super) sharpness: Vec<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FrameTraceBatch {
    pub(super) start_frame: i64,
    // A batch retains the comparison crossing the preceding batch boundary.
    pub(super) previous_motion: Option<f64>,
    pub(super) data: FrameTraceData,
}

impl FrameTraceData {
    pub(super) fn is_valid(&self, frame_count: usize) -> bool {
        self.motion.len() == frame_count.saturating_sub(1)
            && self.colors.len() == frame_count
            && self.sharpness.len() == frame_count
            && self
                .motion
                .iter()
                .all(|value| value.is_finite() && (0.0..=2.0).contains(value))
            && self
                .colors
                .iter()
                .flatten()
                .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
            && self
                .sharpness
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0)
    }
}
