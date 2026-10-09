use super::{TRACE_HEIGHT, TRACE_WIDTH};

pub(super) fn mean_frame_colors(frame: &[u8]) -> [f64; 4] {
    let mut sums = [0_u64; 3];
    for pixel in frame.chunks_exact(3) {
        for channel in 0..3 {
            sums[channel] += u64::from(pixel[channel]);
        }
    }
    let divisor = (frame.len() / 3) as f64 * 255.0;
    let [red, green, blue] = sums.map(|sum| sum as f64 / divisor);
    [red, green, blue, 0.30 * red + 0.59 * green + 0.11 * blue]
}

#[cfg(test)]
fn normalized_frame_sharpness(frame: &[u8]) -> f64 {
    frame_sharpness(frame, &mut Vec::new())
}

pub(super) fn frame_sharpness(frame: &[u8], gray: &mut Vec<f64>) -> f64 {
    gray.clear();
    gray.extend(frame.chunks_exact(3).map(|pixel| {
        0.30 * f64::from(pixel[0]) + 0.59 * f64::from(pixel[1]) + 0.11 * f64::from(pixel[2])
    }));
    let mean_gray = gray.iter().sum::<f64>() / gray.len() as f64;
    if mean_gray == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut square_sum = 0.0;
    // Use only interior pixels so artificial image borders do not add sharpness.
    for y in 1..TRACE_HEIGHT - 1 {
        for x in 1..TRACE_WIDTH - 1 {
            let index = y * TRACE_WIDTH + x;
            let laplacian = gray[index - TRACE_WIDTH]
                + gray[index + TRACE_WIDTH]
                + gray[index - 1]
                + gray[index + 1]
                - 4.0 * gray[index];
            sum += laplacian;
            square_sum += laplacian * laplacian;
        }
    }
    let count = ((TRACE_WIDTH - 2) * (TRACE_HEIGHT - 2)) as f64;
    let mean_laplacian = sum / count;
    let variance = (square_sum / count - mean_laplacian * mean_laplacian).max(0.0);
    variance / (mean_gray * mean_gray)
}

#[cfg(test)]
mod tests {
    use super::super::COLOR_FRAME_BYTES;
    use super::*;

    #[test]
    fn frame_colors_average_channels_and_use_305911_gray() {
        let [red, green, blue, gray] = mean_frame_colors(&[255, 0, 0, 0, 255, 0]);
        assert_eq!([red, green, blue], [0.5, 0.5, 0.0]);
        assert!((gray - 0.445).abs() < 1e-12);
        assert_eq!(mean_frame_colors(&[0, 0, 0]), [0.0; 4]);
        for value in mean_frame_colors(&[255, 255, 255]) {
            assert!((value - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn sharpness_of_uniform_frames_is_zero_including_black() {
        for brightness in [0, 1, 64, 255] {
            assert!(normalized_frame_sharpness(&vec![brightness; COLOR_FRAME_BYTES]).abs() < 1e-12);
        }
    }

    #[test]
    fn sharpness_uses_brightness_squared_without_clamping() {
        let mut frame = vec![0; COLOR_FRAME_BYTES];
        let center = (TRACE_HEIGHT / 2 * TRACE_WIDTH + TRACE_WIDTH / 2) * 3;
        frame[center..center + 3].fill(60);
        let score = normalized_frame_sharpness(&frame);
        let expected = 20.0 * (TRACE_WIDTH * TRACE_HEIGHT).pow(2) as f64
            / ((TRACE_WIDTH - 2) * (TRACE_HEIGHT - 2)) as f64;
        assert!((score - expected).abs() < 1e-8);
        frame[center..center + 3].fill(120);
        assert!((normalized_frame_sharpness(&frame) - score).abs() < 1e-8);
    }
}
