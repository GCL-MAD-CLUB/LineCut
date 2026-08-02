use std::fs;
use std::io::Read;
use std::path::Path;

use ort::{
    execution_providers::OpenVINOExecutionProvider,
    session::{builder::GraphOptimizationLevel, Session},
    value::{DynValue, Tensor},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::low_level_features::LowLevelFeatures;
use super::transnet::TransNetPrediction;
use crate::{app_error, AppError, AppResult, ErrorCode};

pub(super) const FEATURE_SCHEMA_VERSION: u32 = 1;
pub(super) const REFINER_INPUT_CHANNELS: usize = 8;
pub(super) const REFINER_INPUT_FRAMES: usize = 100;
pub(super) const REFINER_OUTPUT_FRAMES: usize = 50;
const REFINER_CENTER_START: usize = 25;
const PROBABILITY_EPSILON: f32 = 1.0e-6;
const EXPECTED_MODEL_NAME: &str = "TransNetV2 Temporal Residual Refiner";
const EXPECTED_LABEL_SEMANTICS: &str = "frame_t_is_first_frame_of_new_shot";
const EXPECTED_INPUT_NAME: &str = "raw_features";
const EXPECTED_OUTPUT_NAMES: [&str; 3] = ["final_logits", "base_logits", "delta_logits"];

#[derive(Debug, Clone, Copy, Default)]
pub(super) enum ThresholdMode {
    Conservative,
    #[default]
    Balanced,
    Sensitive,
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct RefinerConfig {
    pub threshold_mode: ThresholdMode,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct RawFrameFeatures {
    pub transnet_single: f32,
    pub transnet_all: f32,
    pub luma_mad: f32,
    pub hist_distance: f32,
    pub edge_change: f32,
    pub tile_q90: f32,
    pub flash_return: f32,
    pub valid: bool,
}

impl RawFrameFeatures {
    pub(super) fn from_predictions(
        transnet: TransNetPrediction,
        low_level: LowLevelFeatures,
    ) -> AppResult<Self> {
        let features = Self {
            transnet_single: transnet.single,
            transnet_all: transnet.all,
            luma_mad: low_level.luma_mad,
            hist_distance: low_level.hist_distance,
            edge_change: low_level.edge_change,
            tile_q90: low_level.tile_q90,
            flash_return: low_level.flash_return,
            valid: true,
        };
        features.validate()?;
        Ok(features)
    }

    fn validate(&self) -> AppResult<()> {
        if !self.transnet_single.is_finite()
            || !(0.0..=1.0).contains(&self.transnet_single)
            || !self.transnet_all.is_finite()
            || !(0.0..=1.0).contains(&self.transnet_all)
        {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Invalid TransNetV2 probabilities: single={}, all={}",
                    self.transnet_single, self.transnet_all
                ),
            ));
        }
        let low_level = [
            self.luma_mad,
            self.hist_distance,
            self.edge_change,
            self.tile_q90,
            self.flash_return,
        ];
        if low_level.iter().any(|value| !value.is_finite()) {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!("Low-level frame features contain NaN or infinity: {low_level:?}"),
            ));
        }
        Ok(())
    }

    fn channel(&self, channel: usize) -> f32 {
        match channel {
            0 => self.transnet_single,
            1 => self.transnet_all,
            2 => self.luma_mad,
            3 => self.hist_distance,
            4 => self.edge_change,
            5 => self.tile_q90,
            6 => self.flash_return,
            7 => f32::from(self.valid),
            _ => unreachable!("refiner channel count is fixed"),
        }
    }
}

impl Default for RawFrameFeatures {
    fn default() -> Self {
        Self {
            transnet_single: 0.5,
            transnet_all: 0.5,
            luma_mad: 0.0,
            hist_distance: 0.0,
            edge_change: 0.0,
            tile_q90: 0.0,
            flash_return: 0.0,
            valid: false,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct RefinerBlockOutput {
    pub final_logits: [f32; REFINER_OUTPUT_FRAMES],
    pub base_logits: [f32; REFINER_OUTPUT_FRAMES],
    pub delta_logits: [f32; REFINER_OUTPUT_FRAMES],
    pub cuts: [bool; REFINER_OUTPUT_FRAMES],
}

#[derive(Debug, Clone, Copy)]
pub(super) struct FrameCutPrediction {
    pub frame_index: usize,
    pub pts: i64,
    pub base_logit: f32,
    pub delta_logit: f32,
    pub final_logit: f32,
    pub probability: f32,
    pub is_cut: bool,
}

pub(super) trait SceneCutRefiner {
    fn infer(
        &mut self,
        input: &[RawFrameFeatures; REFINER_INPUT_FRAMES],
        mode: ThresholdMode,
    ) -> AppResult<RefinerBlockOutput>;
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RefinerManifest {
    model_name: String,
    model_version: String,
    #[serde(default)]
    model_origin: Option<String>,
    feature_schema_version: u32,
    label_semantics: String,
    input_name: String,
    input_shape: [usize; 3],
    output_names: [String; 3],
    output_shape: [usize; 2],
    transnet_model_version: String,
    transnet_model_sha256: String,
    calibrator: Calibrator,
    low_level_normalization: LowLevelNormalization,
    decision_thresholds: DecisionThresholds,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Calibrator {
    a_single: f32,
    a_all: f32,
    bias: f32,
    base_threshold: f32,
}

impl Calibrator {
    fn base_margin(&self, features: RawFrameFeatures) -> f32 {
        self.a_single * logit(features.transnet_single)
            + self.a_all * logit(features.transnet_all)
            + self.bias
            - self.base_threshold
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct LowLevelNormalization {
    median: [f32; 5],
    iqr: [f32; 5],
    clip_min: f32,
    clip_max: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionThresholds {
    conservative: f32,
    balanced: f32,
    sensitive: f32,
}

impl DecisionThresholds {
    fn selected(&self, mode: ThresholdMode) -> f32 {
        match mode {
            ThresholdMode::Conservative => self.conservative,
            ThresholdMode::Balanced => self.balanced,
            ThresholdMode::Sensitive => self.sensitive,
        }
    }
}

impl RefinerManifest {
    pub(super) fn load(path: &Path, transnet_model: &Path) -> AppResult<Self> {
        let body = fs::read_to_string(path).map_err(|error| {
            app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Failed to read refiner manifest {}: {error}",
                    path.display()
                ),
            )
        })?;
        let manifest = serde_json::from_str::<Self>(&body).map_err(|error| {
            app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Failed to parse refiner manifest {}: {error}",
                    path.display()
                ),
            )
        })?;
        manifest.validate()?;
        manifest.validate_transnet_hash(transnet_model)?;
        Ok(manifest)
    }

    fn validate(&self) -> AppResult<()> {
        if self.model_name != EXPECTED_MODEL_NAME {
            return self.invalid(format!(
                "model_name must be {EXPECTED_MODEL_NAME:?}, got {:?}",
                self.model_name
            ));
        }
        if self.model_version.trim().is_empty()
            || self
                .model_origin
                .as_deref()
                .is_some_and(|origin| origin.trim().is_empty())
            || self.transnet_model_version.trim().is_empty()
        {
            return self.invalid("model version fields must not be empty");
        }
        if self.feature_schema_version != FEATURE_SCHEMA_VERSION {
            return self.invalid(format!(
                "feature_schema_version is {}; expected {FEATURE_SCHEMA_VERSION}",
                self.feature_schema_version
            ));
        }
        if self.label_semantics != EXPECTED_LABEL_SEMANTICS {
            return self.invalid(format!(
                "label_semantics must be {EXPECTED_LABEL_SEMANTICS:?}"
            ));
        }
        if self.input_name != EXPECTED_INPUT_NAME
            || self.input_shape != [1, REFINER_INPUT_CHANNELS, REFINER_INPUT_FRAMES]
        {
            return self.invalid(format!(
                "input must be {EXPECTED_INPUT_NAME} with shape [1, {REFINER_INPUT_CHANNELS}, {REFINER_INPUT_FRAMES}]"
            ));
        }
        if self.output_names != EXPECTED_OUTPUT_NAMES.map(String::from)
            || self.output_shape != [1, REFINER_OUTPUT_FRAMES]
        {
            return self.invalid(format!(
                "outputs must be {EXPECTED_OUTPUT_NAMES:?} with shape [1, {REFINER_OUTPUT_FRAMES}]"
            ));
        }
        if self.transnet_model_sha256.len() != 64
            || !self
                .transnet_model_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return self.invalid("transnet_model_sha256 must be a 64-digit hexadecimal SHA-256");
        }
        let calibrator_values = [
            self.calibrator.a_single,
            self.calibrator.a_all,
            self.calibrator.bias,
            self.calibrator.base_threshold,
        ];
        if calibrator_values.iter().any(|value| !value.is_finite()) {
            return self.invalid("calibrator values must be finite");
        }
        if self.calibrator.a_single == 0.0 || self.calibrator.a_all == 0.0 {
            return self.invalid("calibrator must use both TransNetV2 output heads");
        }
        if self
            .low_level_normalization
            .median
            .iter()
            .chain(&self.low_level_normalization.iqr)
            .chain([
                &self.low_level_normalization.clip_min,
                &self.low_level_normalization.clip_max,
            ])
            .any(|value| !value.is_finite())
            || self
                .low_level_normalization
                .iqr
                .iter()
                .any(|value| *value <= 0.0)
            || self.low_level_normalization.clip_min >= self.low_level_normalization.clip_max
        {
            return self.invalid("low-level normalization values are invalid");
        }
        let thresholds = [
            self.decision_thresholds
                .selected(ThresholdMode::Conservative),
            self.decision_thresholds.selected(ThresholdMode::Balanced),
            self.decision_thresholds.selected(ThresholdMode::Sensitive),
        ];
        if thresholds.iter().any(|value| !value.is_finite()) {
            return self.invalid("decision thresholds must be finite");
        }
        Ok(())
    }

    fn validate_transnet_hash(&self, transnet_model: &Path) -> AppResult<()> {
        let mut file = fs::File::open(transnet_model).map_err(|error| {
            app_error(
                ErrorCode::StoryboardModelMissing,
                format!(
                    "Failed to open TransNetV2 model {}: {error}",
                    transnet_model.display()
                ),
            )
        })?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                app_error(
                    ErrorCode::StoryboardInferenceFailed,
                    format!(
                        "Failed to hash TransNetV2 model {}: {error}",
                        transnet_model.display()
                    ),
                )
            })?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(&self.transnet_model_sha256) {
            return self.invalid(format!(
                "TransNetV2 SHA-256 mismatch: manifest={}, actual={actual}",
                self.transnet_model_sha256
            ));
        }
        Ok(())
    }

    fn invalid<T>(&self, message: impl Into<String>) -> AppResult<T> {
        Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("Invalid scene-cut refiner manifest: {}", message.into()),
        ))
    }
}

pub(super) enum RefinerEngine {
    Onnx(OnnxSceneCutRefiner),
    BaseOnly(BaseOnlyRefiner),
}

impl RefinerEngine {
    pub(super) fn load(model: Option<&Path>, manifest: RefinerManifest) -> AppResult<Self> {
        match model {
            Some(model) => Ok(Self::Onnx(OnnxSceneCutRefiner::load(model, manifest)?)),
            None => Ok(Self::BaseOnly(BaseOnlyRefiner { manifest })),
        }
    }

    pub(super) fn provider_name(&self) -> &'static str {
        match self {
            Self::Onnx(_) => "DirectML TransNetV2 + OpenVINO/CPU TTRR",
            Self::BaseOnly(_) => "DirectML TransNetV2 + dual-head base-only",
        }
    }
}

impl SceneCutRefiner for RefinerEngine {
    fn infer(
        &mut self,
        input: &[RawFrameFeatures; REFINER_INPUT_FRAMES],
        mode: ThresholdMode,
    ) -> AppResult<RefinerBlockOutput> {
        match self {
            Self::Onnx(refiner) => refiner.infer(input, mode),
            Self::BaseOnly(refiner) => refiner.infer(input, mode),
        }
    }
}

pub(super) struct BaseOnlyRefiner {
    manifest: RefinerManifest,
}

impl SceneCutRefiner for BaseOnlyRefiner {
    fn infer(
        &mut self,
        input: &[RawFrameFeatures; REFINER_INPUT_FRAMES],
        mode: ThresholdMode,
    ) -> AppResult<RefinerBlockOutput> {
        for features in input {
            features.validate()?;
        }
        let base_logits = std::array::from_fn(|offset| {
            self.manifest
                .calibrator
                .base_margin(input[REFINER_CENTER_START + offset])
        });
        let delta_logits = [0.0; REFINER_OUTPUT_FRAMES];
        let final_logits = base_logits;
        let threshold = self.manifest.decision_thresholds.selected(mode);
        let cuts = std::array::from_fn(|offset| final_logits[offset] >= threshold);
        Ok(RefinerBlockOutput {
            final_logits,
            base_logits,
            delta_logits,
            cuts,
        })
    }
}

pub(super) struct OnnxSceneCutRefiner {
    session: Session,
    manifest: RefinerManifest,
    output_indices: [usize; 3],
}

impl OnnxSceneCutRefiner {
    fn load(model_path: &Path, manifest: RefinerManifest) -> AppResult<Self> {
        let session = Session::builder()
            .map_err(|error| ort_error("create TTRR session builder", error))?
            .with_execution_providers([OpenVINOExecutionProvider::default().build()])
            .map_err(|error| ort_error("configure OpenVINO/CPU TTRR providers", error))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|error| ort_error("configure TTRR graph optimization", error))?
            .with_intra_threads(1)
            .map_err(|error| ort_error("configure TTRR inference threads", error))?
            .commit_from_file(model_path)
            .map_err(|error| ort_error("load scene-cut refiner ONNX model", error))?;
        let output_indices = validate_refiner_session(&session, &manifest)?;
        Ok(Self {
            session,
            manifest,
            output_indices,
        })
    }
}

impl SceneCutRefiner for OnnxSceneCutRefiner {
    fn infer(
        &mut self,
        input: &[RawFrameFeatures; REFINER_INPUT_FRAMES],
        mode: ThresholdMode,
    ) -> AppResult<RefinerBlockOutput> {
        let mut channel_major = Vec::with_capacity(REFINER_INPUT_CHANNELS * REFINER_INPUT_FRAMES);
        for channel in 0..REFINER_INPUT_CHANNELS {
            for features in input {
                features.validate()?;
                channel_major.push(features.channel(channel));
            }
        }
        let tensor = Tensor::<f32>::from_array((
            vec![
                1_i64,
                REFINER_INPUT_CHANNELS as i64,
                REFINER_INPUT_FRAMES as i64,
            ],
            channel_major,
        ))
        .map_err(|error| ort_error("create TTRR raw_features tensor", error))?;
        let outputs = self
            .session
            .run(
                ort::inputs! {
                    self.manifest.input_name.clone() => tensor
                }
                .map_err(|error| ort_error("bind TTRR input", error))?,
            )
            .map_err(|error| ort_error("run TTRR inference", error))?;

        let final_logits =
            extract_refiner_output(&outputs[self.output_indices[0]], EXPECTED_OUTPUT_NAMES[0])?;
        let base_logits =
            extract_refiner_output(&outputs[self.output_indices[1]], EXPECTED_OUTPUT_NAMES[1])?;
        let delta_logits =
            extract_refiner_output(&outputs[self.output_indices[2]], EXPECTED_OUTPUT_NAMES[2])?;
        for index in 0..REFINER_OUTPUT_FRAMES {
            let reconstructed = base_logits[index] + delta_logits[index];
            if (final_logits[index] - reconstructed).abs() > 1.0e-4 {
                return Err(app_error(
                    ErrorCode::StoryboardInferenceFailed,
                    format!(
                        "TTRR output invariant failed at block offset {index}: final={}, base={}, delta={}",
                        final_logits[index], base_logits[index], delta_logits[index]
                    ),
                ));
            }
        }
        let threshold = self.manifest.decision_thresholds.selected(mode);
        let cuts = std::array::from_fn(|index| final_logits[index] >= threshold);
        Ok(RefinerBlockOutput {
            final_logits,
            base_logits,
            delta_logits,
            cuts,
        })
    }
}

fn validate_refiner_session(
    session: &Session,
    manifest: &RefinerManifest,
) -> AppResult<[usize; 3]> {
    if session.inputs.len() != 1 || session.inputs[0].name != manifest.input_name {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!(
                "TTRR model input must be named {:?}; found {:?}",
                manifest.input_name,
                session
                    .inputs
                    .iter()
                    .map(|input| input.name.as_str())
                    .collect::<Vec<_>>()
            ),
        ));
    }
    let input_shape = session.inputs[0]
        .input_type
        .tensor_dimensions()
        .ok_or_else(|| {
            app_error(
                ErrorCode::StoryboardInferenceFailed,
                "TTRR raw_features input is not a tensor",
            )
        })?;
    let expected_input = [
        1,
        REFINER_INPUT_CHANNELS as i64,
        REFINER_INPUT_FRAMES as i64,
    ];
    if input_shape.as_slice() != expected_input {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("TTRR input shape is {input_shape:?}; expected {expected_input:?}"),
        ));
    }

    let mut indices = [0_usize; 3];
    for (manifest_index, expected_name) in manifest.output_names.iter().enumerate() {
        let session_index = session
            .outputs
            .iter()
            .position(|output| output.name == *expected_name)
            .ok_or_else(|| {
                app_error(
                    ErrorCode::StoryboardInferenceFailed,
                    format!("TTRR model is missing output {expected_name:?}"),
                )
            })?;
        let shape = session.outputs[session_index]
            .output_type
            .tensor_dimensions()
            .ok_or_else(|| {
                app_error(
                    ErrorCode::StoryboardInferenceFailed,
                    format!("TTRR output {expected_name:?} is not a tensor"),
                )
            })?;
        let expected_shape = [1, REFINER_OUTPUT_FRAMES as i64];
        if shape.as_slice() != expected_shape {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "TTRR output {expected_name:?} shape is {shape:?}; expected {expected_shape:?}"
                ),
            ));
        }
        indices[manifest_index] = session_index;
    }
    Ok(indices)
}

fn extract_refiner_output(
    output: &DynValue,
    name: &str,
) -> AppResult<[f32; REFINER_OUTPUT_FRAMES]> {
    let (shape, values) = output
        .try_extract_raw_tensor::<f32>()
        .map_err(|error| ort_error(&format!("extract TTRR {name} output"), error))?;
    let expected_shape = [1, REFINER_OUTPUT_FRAMES as i64];
    if shape != expected_shape || values.len() != REFINER_OUTPUT_FRAMES {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!(
                "TTRR {name} output shape is {shape:?} with {} values; expected {expected_shape:?}",
                values.len()
            ),
        ));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("TTRR {name} output contains NaN or infinity"),
        ));
    }
    values.try_into().map_err(|_| {
        app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("TTRR {name} output length changed during extraction"),
        )
    })
}

pub(super) fn refine_full_video(
    features: &[RawFrameFeatures],
    pts: &[i64],
    refiner: &mut impl SceneCutRefiner,
    config: RefinerConfig,
) -> AppResult<Vec<FrameCutPrediction>> {
    if features.len() != pts.len() {
        return Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!(
                "Frame feature/PTS length mismatch: features={}, pts={}",
                features.len(),
                pts.len()
            ),
        ));
    }
    let mut predictions = Vec::with_capacity(features.len());
    for output_start in (0..features.len()).step_by(REFINER_OUTPUT_FRAMES) {
        let input = std::array::from_fn(|input_offset| {
            let source =
                output_start as isize + input_offset as isize - REFINER_CENTER_START as isize;
            usize::try_from(source)
                .ok()
                .and_then(|index| features.get(index))
                .copied()
                .unwrap_or_default()
        });
        let block = refiner.infer(&input, config.threshold_mode)?;
        let retained = REFINER_OUTPUT_FRAMES.min(features.len() - output_start);
        for offset in 0..retained {
            let frame_index = output_start + offset;
            let final_logit = block.final_logits[offset];
            predictions.push(FrameCutPrediction {
                frame_index,
                pts: pts[frame_index],
                base_logit: block.base_logits[offset],
                delta_logit: block.delta_logits[offset],
                final_logit,
                probability: sigmoid(final_logit),
                is_cut: frame_index != 0 && block.cuts[offset],
            });
        }
    }
    Ok(predictions)
}

fn logit(probability: f32) -> f32 {
    let probability = probability.clamp(PROBABILITY_EPSILON, 1.0 - PROBABILITY_EPSILON);
    (probability / (1.0 - probability)).ln()
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
    use std::path::PathBuf;

    use super::*;

    fn packaged_manifest() -> RefinerManifest {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/transnetv2");
        RefinerManifest::load(
            &root.join("scene_cut_refiner.manifest.json"),
            &root.join("transnetv2.onnx"),
        )
        .expect("packaged manifest must be valid")
    }

    #[test]
    fn base_only_mode_has_zero_delta() {
        let mut refiner = BaseOnlyRefiner {
            manifest: packaged_manifest(),
        };
        let mut input = [RawFrameFeatures::default(); REFINER_INPUT_FRAMES];
        input[REFINER_CENTER_START] = RawFrameFeatures {
            transnet_single: 0.9,
            transnet_all: 0.8,
            valid: true,
            ..RawFrameFeatures::default()
        };

        let output = refiner.infer(&input, ThresholdMode::Balanced).unwrap();

        assert_eq!(output.delta_logits, [0.0; REFINER_OUTPUT_FRAMES]);
        assert_eq!(output.final_logits, output.base_logits);
        assert!(output.base_logits[0] > 0.0);
    }

    #[test]
    fn full_video_windowing_pads_context_and_forces_first_label_false() {
        struct InspectingRefiner {
            blocks: usize,
        }
        impl SceneCutRefiner for InspectingRefiner {
            fn infer(
                &mut self,
                input: &[RawFrameFeatures; REFINER_INPUT_FRAMES],
                _mode: ThresholdMode,
            ) -> AppResult<RefinerBlockOutput> {
                if self.blocks == 0 {
                    assert!(input[..REFINER_CENTER_START]
                        .iter()
                        .all(|features| !features.valid));
                    assert!(input[REFINER_CENTER_START..REFINER_CENTER_START + 60]
                        .iter()
                        .all(|features| features.valid));
                    assert!(input[REFINER_CENTER_START + 60..]
                        .iter()
                        .all(|features| !features.valid));
                } else {
                    assert!(input[..REFINER_CENTER_START + 10]
                        .iter()
                        .all(|features| features.valid));
                    assert!(input[REFINER_CENTER_START + 10..]
                        .iter()
                        .all(|features| !features.valid));
                }
                self.blocks += 1;
                Ok(RefinerBlockOutput {
                    final_logits: [1.0; REFINER_OUTPUT_FRAMES],
                    base_logits: [1.0; REFINER_OUTPUT_FRAMES],
                    delta_logits: [0.0; REFINER_OUTPUT_FRAMES],
                    cuts: [true; REFINER_OUTPUT_FRAMES],
                })
            }
        }

        let features = vec![
            RawFrameFeatures {
                valid: true,
                ..RawFrameFeatures::default()
            };
            60
        ];
        let pts = (0..60).map(|index| index * 40_000).collect::<Vec<_>>();
        let mut refiner = InspectingRefiner { blocks: 0 };

        let predictions =
            refine_full_video(&features, &pts, &mut refiner, RefinerConfig::default()).unwrap();

        assert_eq!(refiner.blocks, 2);
        assert_eq!(predictions.len(), 60);
        assert!(!predictions[0].is_cut);
        assert!(predictions[1..].iter().all(|prediction| prediction.is_cut));
    }

    #[test]
    fn all_threshold_modes_are_selectable() {
        let thresholds = DecisionThresholds {
            conservative: 1.0,
            balanced: 0.0,
            sensitive: -1.0,
        };

        assert_eq!(thresholds.selected(ThresholdMode::Conservative), 1.0);
        assert_eq!(thresholds.selected(ThresholdMode::Balanced), 0.0);
        assert_eq!(thresholds.selected(ThresholdMode::Sensitive), -1.0);
    }
}
