use crate::{app_error, AppResult, ErrorCode};

pub(super) const FEATURE_FRAME_WIDTH: usize = 96;
pub(super) const FEATURE_FRAME_HEIGHT: usize = 54;
pub(super) const FEATURE_FRAME_CHANNELS: usize = 3;
pub(super) const FEATURE_FRAME_BYTES: usize =
    FEATURE_FRAME_WIDTH * FEATURE_FRAME_HEIGHT * FEATURE_FRAME_CHANNELS;

const HISTOGRAM_BINS: usize = 32;
const TILE_ROWS: usize = 4;
const TILE_COLUMNS: usize = 4;
const SOBEL_EDGE_THRESHOLD: i32 = 192;
const EPSILON: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct LowLevelFeatures {
    pub luma_mad: f32,
    pub hist_distance: f32,
    pub edge_change: f32,
    pub tile_q90: f32,
    pub flash_return: f32,
}

struct FrameDescriptor {
    luma: Vec<u8>,
    histogram: [f32; HISTOGRAM_BINS],
    edges: Vec<bool>,
}

pub(super) struct LowLevelFeatureExtractor {
    previous: Option<FrameDescriptor>,
    two_frames_back_luma: Option<Vec<u8>>,
    features: Vec<LowLevelFeatures>,
}

impl LowLevelFeatureExtractor {
    pub(super) fn new() -> Self {
        Self {
            previous: None,
            two_frames_back_luma: None,
            features: Vec::new(),
        }
    }

    pub(super) fn push_rgb(&mut self, rgb: &[u8]) -> AppResult<()> {
        if rgb.len() != FEATURE_FRAME_BYTES {
            return Err(app_error(
                ErrorCode::StoryboardFrameDecodeFailed,
                format!(
                    "Low-level feature frame has {} bytes; expected {FEATURE_FRAME_BYTES}",
                    rgb.len()
                ),
            ));
        }

        let current = describe_frame(rgb);
        let Some(previous) = self.previous.as_ref() else {
            self.features.push(LowLevelFeatures::default());
            self.previous = Some(current);
            return Ok(());
        };

        let current_luma_mad = luma_mad(&previous.luma, &current.luma);
        let histogram_affinity = previous
            .histogram
            .iter()
            .zip(current.histogram)
            .map(|(left, right)| (*left * right).sqrt())
            .sum::<f32>();
        let hist_distance = (1.0 - histogram_affinity).max(0.0).sqrt();
        let edge_change = edge_change(&previous.edges, &current.edges);
        let tile_q90 = tile_q90(&previous.luma, &current.luma);
        self.features.push(LowLevelFeatures {
            luma_mad: current_luma_mad,
            hist_distance,
            edge_change,
            tile_q90,
            flash_return: 0.0,
        });

        if let Some(two_frames_back) = self.two_frames_back_luma.as_ref() {
            let d1 = self.features[self.features.len() - 2].luma_mad;
            let d2 = current_luma_mad;
            let surrounding_distance = luma_mad(two_frames_back, &current.luma);
            let minimum_neighbor_distance = d1.min(d2);
            let center_index = self.features.len() - 2;
            self.features[center_index].flash_return = ((minimum_neighbor_distance
                - surrounding_distance)
                / (minimum_neighbor_distance + EPSILON))
                .max(0.0);
        }

        let previous = self
            .previous
            .replace(current)
            .expect("previous descriptor was checked above");
        self.two_frames_back_luma = Some(previous.luma);
        Ok(())
    }

    pub(super) fn into_features(self) -> Vec<LowLevelFeatures> {
        self.features
    }
}

fn describe_frame(rgb: &[u8]) -> FrameDescriptor {
    let luma = rgb
        .chunks_exact(FEATURE_FRAME_CHANNELS)
        .map(|pixel| {
            let red = pixel[0] as u32;
            let green = pixel[1] as u32;
            let blue = pixel[2] as u32;
            ((77 * red + 150 * green + 29 * blue + 128) >> 8) as u8
        })
        .collect::<Vec<_>>();
    let mut histogram = [0.0_f32; HISTOGRAM_BINS];
    for value in &luma {
        histogram[usize::from(*value) * HISTOGRAM_BINS / 256] += 1.0;
    }
    let pixel_count = luma.len() as f32;
    for value in &mut histogram {
        *value /= pixel_count;
    }
    let edges = sobel_edges(&luma);
    FrameDescriptor {
        luma,
        histogram,
        edges,
    }
}

fn luma_mad(left: &[u8], right: &[u8]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left.abs_diff(*right) as f32)
        .sum::<f32>()
        / (left.len() as f32 * 255.0)
}

fn sobel_edges(luma: &[u8]) -> Vec<bool> {
    let mut edges = vec![false; FEATURE_FRAME_WIDTH * FEATURE_FRAME_HEIGHT];
    for y in 1..FEATURE_FRAME_HEIGHT - 1 {
        for x in 1..FEATURE_FRAME_WIDTH - 1 {
            let sample = |dx: isize, dy: isize| {
                luma[(y.wrapping_add_signed(dy)) * FEATURE_FRAME_WIDTH + x.wrapping_add_signed(dx)]
                    as i32
            };
            let gradient_x = -sample(-1, -1) + sample(1, -1) - 2 * sample(-1, 0) + 2 * sample(1, 0)
                - sample(-1, 1)
                + sample(1, 1);
            let gradient_y = -sample(-1, -1) - 2 * sample(0, -1) - sample(1, -1)
                + sample(-1, 1)
                + 2 * sample(0, 1)
                + sample(1, 1);
            edges[y * FEATURE_FRAME_WIDTH + x] =
                gradient_x.abs() + gradient_y.abs() >= SOBEL_EDGE_THRESHOLD;
        }
    }
    edges
}

fn dilate(edges: &[bool]) -> Vec<bool> {
    let mut dilated = vec![false; edges.len()];
    for y in 0..FEATURE_FRAME_HEIGHT {
        for x in 0..FEATURE_FRAME_WIDTH {
            let y_start = y.saturating_sub(1);
            let y_end = y.saturating_add(1).min(FEATURE_FRAME_HEIGHT - 1);
            let x_start = x.saturating_sub(1);
            let x_end = x.saturating_add(1).min(FEATURE_FRAME_WIDTH - 1);
            dilated[y * FEATURE_FRAME_WIDTH + x] = (y_start..=y_end).any(|neighbor_y| {
                (x_start..=x_end)
                    .any(|neighbor_x| edges[neighbor_y * FEATURE_FRAME_WIDTH + neighbor_x])
            });
        }
    }
    dilated
}

fn edge_change(previous: &[bool], current: &[bool]) -> f32 {
    let dilated_previous = dilate(previous);
    let dilated_current = dilate(current);
    let current_count = current.iter().filter(|edge| **edge).count();
    let previous_count = previous.iter().filter(|edge| **edge).count();
    let incoming = current
        .iter()
        .zip(dilated_previous)
        .filter(|(edge, covered)| **edge && !*covered)
        .count() as f32
        / (current_count as f32 + EPSILON);
    let outgoing = previous
        .iter()
        .zip(dilated_current)
        .filter(|(edge, covered)| **edge && !*covered)
        .count() as f32
        / (previous_count as f32 + EPSILON);
    incoming.max(outgoing)
}

fn tile_q90(previous: &[u8], current: &[u8]) -> f32 {
    let mut values = [0.0_f32; TILE_ROWS * TILE_COLUMNS];
    for tile_y in 0..TILE_ROWS {
        let y_start = tile_y * FEATURE_FRAME_HEIGHT / TILE_ROWS;
        let y_end = (tile_y + 1) * FEATURE_FRAME_HEIGHT / TILE_ROWS;
        for tile_x in 0..TILE_COLUMNS {
            let x_start = tile_x * FEATURE_FRAME_WIDTH / TILE_COLUMNS;
            let x_end = (tile_x + 1) * FEATURE_FRAME_WIDTH / TILE_COLUMNS;
            let mut difference = 0_u64;
            for y in y_start..y_end {
                for x in x_start..x_end {
                    let index = y * FEATURE_FRAME_WIDTH + x;
                    difference += u64::from(previous[index].abs_diff(current[index]));
                }
            }
            let pixels = (y_end - y_start) * (x_end - x_start);
            values[tile_y * TILE_COLUMNS + tile_x] = difference as f32 / (pixels as f32 * 255.0);
        }
    }

    values.sort_unstable_by(f32::total_cmp);
    let position = 0.9 * (values.len() - 1) as f32;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let fraction = position - lower as f32;
    values[lower] + fraction * (values[upper] - values[lower])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_rgb(value: u8) -> Vec<u8> {
        vec![value; FEATURE_FRAME_BYTES]
    }

    #[test]
    fn first_and_identical_frames_have_zero_features() {
        let mut extractor = LowLevelFeatureExtractor::new();
        extractor.push_rgb(&solid_rgb(64)).unwrap();
        extractor.push_rgb(&solid_rgb(64)).unwrap();

        assert_eq!(
            extractor.into_features(),
            vec![LowLevelFeatures::default(), LowLevelFeatures::default()]
        );
    }

    #[test]
    fn full_luma_change_is_normalized() {
        let mut extractor = LowLevelFeatureExtractor::new();
        extractor.push_rgb(&solid_rgb(0)).unwrap();
        extractor.push_rgb(&solid_rgb(255)).unwrap();
        let features = extractor.into_features();

        assert!((features[1].luma_mad - 1.0).abs() < 1.0e-6);
        assert!((features[1].hist_distance - 1.0).abs() < 1.0e-6);
        assert!((features[1].tile_q90 - 1.0).abs() < 1.0e-6);
    }

    #[test]
    fn one_frame_flash_is_assigned_to_center_frame() {
        let mut extractor = LowLevelFeatureExtractor::new();
        extractor.push_rgb(&solid_rgb(0)).unwrap();
        extractor.push_rgb(&solid_rgb(255)).unwrap();
        extractor.push_rgb(&solid_rgb(0)).unwrap();
        let features = extractor.into_features();

        assert!(features[1].flash_return > 0.999);
        assert_eq!(features[0].flash_return, 0.0);
        assert_eq!(features[2].flash_return, 0.0);
    }
}
