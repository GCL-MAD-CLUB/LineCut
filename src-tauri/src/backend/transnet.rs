use std::collections::VecDeque;
use std::path::Path;

use ort::{
    execution_providers::DirectMLExecutionProvider,
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};

use super::low_level_features::{
    FEATURE_FRAME_CHANNELS, FEATURE_FRAME_HEIGHT, FEATURE_FRAME_WIDTH,
};
use crate::{app_error, AppError, AppResult, ErrorCode};

pub(super) const TRANSNET_FRAME_WIDTH: usize = 48;
pub(super) const TRANSNET_FRAME_HEIGHT: usize = 27;
pub(super) const TRANSNET_FRAME_CHANNELS: usize = 3;
pub(super) const TRANSNET_FRAME_BYTES: usize =
    TRANSNET_FRAME_WIDTH * TRANSNET_FRAME_HEIGHT * TRANSNET_FRAME_CHANNELS;
pub(super) const TRANSNET_WINDOW_FRAMES: usize = 100;
pub(super) const TRANSNET_CENTER_START: usize = 25;
pub(super) const TRANSNET_CENTER_END: usize = 75;
pub(super) const TRANSNET_STRIDE_FRAMES: usize = 50;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct TransNetPrediction {
    pub single: f32,
    pub all: f32,
}

pub(super) fn create_transnet_session(model_path: &Path) -> AppResult<Session> {
    let session = Session::builder()
        .map_err(|error| ort_error("create TransNetV2 session builder", error))?
        .with_execution_providers([DirectMLExecutionProvider::default()
            .build()
            .error_on_failure()])
        .map_err(|error| ort_error("enable DirectML execution provider", error))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| ort_error("configure TransNetV2 graph optimization", error))?
        .with_intra_threads(1)
        .map_err(|error| ort_error("configure TransNetV2 inference threads", error))?
        .commit_from_file(model_path)
        .map_err(|error| ort_error("load TransNetV2 ONNX model", error))?;
    validate_transnet_session(&session)?;
    Ok(session)
}

fn validate_transnet_session(session: &Session) -> AppResult<()> {
    let input = session.inputs.first().ok_or_else(|| {
        app_error(
            ErrorCode::StoryboardInferenceFailed,
            "TransNetV2 model has no input tensor",
        )
    })?;
    let input_shape = input.input_type.tensor_dimensions().ok_or_else(|| {
        app_error(
            ErrorCode::StoryboardInferenceFailed,
            "TransNetV2 input is not a tensor",
        )
    })?;
    let expected_input = [
        1,
        TRANSNET_WINDOW_FRAMES as i64,
        TRANSNET_FRAME_HEIGHT as i64,
        TRANSNET_FRAME_WIDTH as i64,
        TRANSNET_FRAME_CHANNELS as i64,
    ];
    if input_shape.as_slice() != expected_input {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("TransNetV2 input shape is {input_shape:?}; expected {expected_input:?}"),
        ));
    }
    if session.outputs.len() < 2 {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!(
                "TransNetV2 must expose both single-frame and all-frames outputs; found {} output(s)",
                session.outputs.len()
            ),
        ));
    }
    for (index, output) in session.outputs.iter().take(2).enumerate() {
        let shape = output.output_type.tensor_dimensions().ok_or_else(|| {
            app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!("TransNetV2 output {index} is not a tensor"),
            )
        })?;
        let expected = [1, TRANSNET_WINDOW_FRAMES as i64, 1];
        if shape.as_slice() != expected {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!("TransNetV2 output {index} shape is {shape:?}; expected {expected:?}"),
            ));
        }
    }
    Ok(())
}

pub(super) fn downsample_for_transnet(rgb: &[u8]) -> AppResult<Vec<u8>> {
    let expected = FEATURE_FRAME_WIDTH * FEATURE_FRAME_HEIGHT * FEATURE_FRAME_CHANNELS;
    if rgb.len() != expected {
        return Err(app_error(
            ErrorCode::StoryboardFrameDecodeFailed,
            format!(
                "Storyboard feature frame has {} bytes; expected {expected}",
                rgb.len()
            ),
        ));
    }

    let mut output = vec![0_u8; TRANSNET_FRAME_BYTES];
    for target_y in 0..TRANSNET_FRAME_HEIGHT {
        for target_x in 0..TRANSNET_FRAME_WIDTH {
            for channel in 0..TRANSNET_FRAME_CHANNELS {
                let mut sum = 0_u16;
                for offset_y in 0..2 {
                    for offset_x in 0..2 {
                        let source_y = target_y * 2 + offset_y;
                        let source_x = target_x * 2 + offset_x;
                        sum += u16::from(
                            rgb[(source_y * FEATURE_FRAME_WIDTH + source_x)
                                * FEATURE_FRAME_CHANNELS
                                + channel],
                        );
                    }
                }
                output[(target_y * TRANSNET_FRAME_WIDTH + target_x) * TRANSNET_FRAME_CHANNELS
                    + channel] = ((sum + 2) / 4) as u8;
            }
        }
    }
    Ok(output)
}

pub(super) fn run_transnet_window(
    session: &mut Session,
    window: &VecDeque<Vec<u8>>,
) -> AppResult<[TransNetPrediction; TRANSNET_STRIDE_FRAMES]> {
    debug_assert_eq!(
        TRANSNET_CENTER_END - TRANSNET_CENTER_START,
        TRANSNET_STRIDE_FRAMES
    );
    if window.len() < TRANSNET_WINDOW_FRAMES {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!(
                "TransNetV2 window contains {} frames; expected {TRANSNET_WINDOW_FRAMES}",
                window.len()
            ),
        ));
    }
    let mut input = Vec::with_capacity(TRANSNET_WINDOW_FRAMES * TRANSNET_FRAME_BYTES);
    for (index, frame) in window.iter().take(TRANSNET_WINDOW_FRAMES).enumerate() {
        if frame.len() != TRANSNET_FRAME_BYTES {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "TransNetV2 window frame {index} has {} bytes; expected {TRANSNET_FRAME_BYTES}",
                    frame.len()
                ),
            ));
        }
        input.extend(frame.iter().map(|value| *value as f32));
    }
    let tensor = Tensor::<f32>::from_array((
        vec![
            1_i64,
            TRANSNET_WINDOW_FRAMES as i64,
            TRANSNET_FRAME_HEIGHT as i64,
            TRANSNET_FRAME_WIDTH as i64,
            TRANSNET_FRAME_CHANNELS as i64,
        ],
        input,
    ))
    .map_err(|error| ort_error("create TransNetV2 input tensor", error))?;
    let input_name = session.inputs[0].name.clone();
    let outputs = session
        .run(
            ort::inputs! {
                input_name => tensor
            }
            .map_err(|error| ort_error("bind TransNetV2 input", error))?,
        )
        .map_err(|error| ort_error("run TransNetV2 inference", error))?;

    let single = extract_probability_head(&outputs[0], "single-frame")?;
    let all = extract_probability_head(&outputs[1], "all-frames")?;
    Ok(std::array::from_fn(|offset| TransNetPrediction {
        single: single[TRANSNET_CENTER_START + offset],
        all: all[TRANSNET_CENTER_START + offset],
    }))
}

fn extract_probability_head(value: &ort::value::DynValue, name: &str) -> AppResult<Vec<f32>> {
    let (shape, values) = value
        .try_extract_raw_tensor::<f32>()
        .map_err(|error| ort_error(&format!("extract TransNetV2 {name} output"), error))?;
    let expected_shape = [1, TRANSNET_WINDOW_FRAMES as i64, 1];
    if shape != expected_shape {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("TransNetV2 {name} output shape is {shape:?}; expected {expected_shape:?}"),
        ));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("TransNetV2 {name} output contains NaN or infinity"),
        ));
    }
    let needs_sigmoid = values.iter().any(|value| !(0.0..=1.0).contains(value));
    Ok(values
        .iter()
        .map(|value| {
            if needs_sigmoid {
                sigmoid(*value)
            } else {
                value.clamp(0.0, 1.0)
            }
        })
        .collect())
}

fn sigmoid(value: f32) -> f32 {
    if value >= 0.0 {
        1.0 / (1.0 + (-value).exp())
    } else {
        let exponential = value.exp();
        exponential / (1.0 + exponential)
    }
}

fn ort_error(context: &str, error: impl std::fmt::Display) -> AppError {
    app_error(
        ErrorCode::StoryboardInferenceFailed,
        format!("Failed to {context}: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_by_two_source_pixels_are_averaged() {
        let mut source = vec![0_u8; FEATURE_FRAME_WIDTH * FEATURE_FRAME_HEIGHT * 3];
        for y in 0..2 {
            for x in 0..2 {
                let index = (y * FEATURE_FRAME_WIDTH + x) * 3;
                source[index..index + 3].copy_from_slice(&[0, 100, 200]);
            }
        }

        let downsampled = downsample_for_transnet(&source).unwrap();

        assert_eq!(&downsampled[..3], &[0, 100, 200]);
        assert_eq!(downsampled.len(), TRANSNET_FRAME_BYTES);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn packaged_model_runs_both_probability_heads() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/transnetv2");
        ort::init_from(root.join("onnxruntime.dll").to_string_lossy().into_owned())
            .with_telemetry(false)
            .commit()
            .expect("initialize packaged ONNX Runtime");
        let mut session = Session::builder()
            .unwrap()
            .commit_from_file(root.join("transnetv2.onnx"))
            .expect("load packaged TransNetV2 model on CPU");
        validate_transnet_session(&session).expect("packaged model contract must be valid");
        let window = VecDeque::from(vec![
            vec![0_u8; TRANSNET_FRAME_BYTES];
            TRANSNET_WINDOW_FRAMES
        ]);

        let predictions = run_transnet_window(&mut session, &window).unwrap();

        assert_eq!(predictions.len(), TRANSNET_STRIDE_FRAMES);
        assert!(predictions.iter().all(|prediction| {
            prediction.single.is_finite()
                && (0.0..=1.0).contains(&prediction.single)
                && prediction.all.is_finite()
                && (0.0..=1.0).contains(&prediction.all)
        }));
    }
}
