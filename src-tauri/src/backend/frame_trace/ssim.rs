// Streaming counterpart of core/editor/frameTrace.ts: RGB Weber SSIM, 11x11
// windows, population moments truncated to 1/1024. No frame-sized allocations
// occur after construction, and each frame's moments are computed only once.
use super::{TRACE_HEIGHT as HEIGHT, TRACE_WIDTH as WIDTH};
const STRIDE: usize = WIDTH + 1;
const WINDOW: usize = 11;
const WINDOWS: usize = (WIDTH - WINDOW + 1) * (HEIGHT - WINDOW + 1);

struct Moments {
    means: Vec<f64>,
    variances: Vec<i32>,
}

impl Moments {
    fn new() -> Self {
        Self {
            means: vec![0.0; WINDOWS * 3],
            variances: vec![0; WINDOWS * 3],
        }
    }
}

pub(super) struct StreamingSsim {
    previous: Vec<u8>,
    previous_moments: Moments,
    current_moments: Moments,
    sums: Vec<i32>,
    squares: Vec<i32>,
    products: Vec<i32>,
    ready: bool,
}

fn window_sum(integral: &[i32], index: usize) -> f64 {
    f64::from(
        integral[index + WINDOW * STRIDE + WINDOW]
            - integral[index + WINDOW]
            - integral[index + WINDOW * STRIDE]
            + integral[index],
    )
}

impl StreamingSsim {
    pub(super) fn new() -> Self {
        Self {
            previous: vec![0; WIDTH * HEIGHT * 3],
            previous_moments: Moments::new(),
            current_moments: Moments::new(),
            sums: vec![0; STRIDE * (HEIGHT + 1)],
            squares: vec![0; STRIDE * (HEIGHT + 1)],
            products: vec![0; STRIDE * (HEIGHT + 1)],
            ready: false,
        }
    }

    pub(super) fn sample(&mut self, rgb: &[u8]) -> Option<f64> {
        let mut similarity = 0.0;
        let c1 = (0.01_f64 * 255.0).powi(2);
        let c2 = (0.03_f64 * 255.0).powi(2);
        for channel in 0..3 {
            for y in 0..HEIGHT {
                let (mut sum, mut square, mut product) = (0, 0, 0);
                for x in 0..WIDTH {
                    let pixel = (y * WIDTH + x) * 3 + channel;
                    let value = i32::from(rgb[pixel]);
                    let index = (y + 1) * STRIDE + x + 1;
                    sum += value;
                    square += value * value;
                    self.sums[index] = self.sums[index - STRIDE] + sum;
                    self.squares[index] = self.squares[index - STRIDE] + square;
                    if self.ready {
                        product += value * i32::from(self.previous[pixel]);
                        self.products[index] = self.products[index - STRIDE] + product;
                    }
                }
            }
            let mut average = 0.0;
            let mut window = 0;
            for y in 0..=HEIGHT - WINDOW {
                for x in 0..=WIDTH - WINDOW {
                    let index = y * STRIDE + x;
                    let target = channel * WINDOWS + window;
                    let mean = window_sum(&self.sums, index) / 121.0;
                    let variance =
                        (1024.0 * (window_sum(&self.squares, index) / 121.0 - mean * mean)) as i32;
                    self.current_moments.means[target] = mean;
                    self.current_moments.variances[target] = variance;
                    if self.ready {
                        let old_mean = self.previous_moments.means[target];
                        let covariance = (1024.0
                            * (window_sum(&self.products, index) / 121.0 - mean * old_mean))
                            as i32;
                        let value = ((2.0 * old_mean * mean + c1)
                            * (2.0 * f64::from(covariance) / 1024.0 + c2))
                            / (old_mean * old_mean + mean * mean + c1)
                            / (f64::from(self.previous_moments.variances[target] + variance)
                                / 1024.0
                                + c2);
                        average += (value - average) / (window + 1) as f64;
                    }
                    window += 1;
                }
            }
            similarity += average / 3.0;
        }
        let motion = self.ready.then(|| (1.0 - similarity).clamp(0.0, 2.0));
        self.previous.copy_from_slice(rgb);
        std::mem::swap(&mut self.previous_moments, &mut self.current_moments);
        self.ready = true;
        motion
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgb_fixture_matches_browser_weber_ssim() {
        // Same LCG/RGB fixture as the browser analyzer, not a video decode test.
        let mut seed = 73_u32;
        let mut analyzer = StreamingSsim::new();
        for expected in [None, Some(0.9881822745590144), Some(1.0104039540308383)] {
            let rgb: Vec<u8> = (0..WIDTH * HEIGHT * 3)
                .map(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed >> 24) as u8
                })
                .collect();
            match (analyzer.sample(&rgb), expected) {
                (Some(actual), Some(expected)) => assert!((actual - expected).abs() < 1e-12),
                (None, None) => {}
                _ => panic!("unexpected adjacent-frame state"),
            }
        }
    }

    #[test]
    fn sequential_frames_have_exact_adjacent_comparisons() {
        let black = vec![0; WIDTH * HEIGHT * 3];
        let white = vec![255; WIDTH * HEIGHT * 3];
        let mut analyzer = StreamingSsim::new();
        assert_eq!(analyzer.sample(&black), None);
        assert_eq!(analyzer.sample(&black), Some(0.0));
        assert!((analyzer.sample(&white).unwrap() - (1.0 - 0.0001 / 1.0001)).abs() < 1e-12);
        assert_eq!(analyzer.sample(&white), Some(0.0));
    }
}
