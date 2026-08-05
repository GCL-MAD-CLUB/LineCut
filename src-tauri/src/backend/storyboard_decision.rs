use serde::{Deserialize, Serialize};

use crate::{app_error, AppResult, ErrorCode};

const FEATURE_NAMES: [&str; 10] = [
    "peak_logit",
    "robust_prominence",
    "log_event_area",
    "log_event_width",
    "concentration",
    "left_slope",
    "right_slope",
    "asymmetry",
    "background_difference",
    "neighbor_mass",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StoryboardDecisionConfig {
    pub model_version: u32,
    pub model_origin: String,
    pub epsilon: f64,
    pub robust_window_radius: usize,
    pub candidate_probability_threshold: f64,
    pub peak_radius: usize,
    pub candidate_robust_threshold: f64,
    pub event_probability_floor: f64,
    pub event_relative_floor: f64,
    pub event_robust_floor: f64,
    pub event_boundary_patience: usize,
    pub neighbor_radius: usize,
    pub classifier: EventClassifier,
    pub calibration: Option<BetaCalibration>,
    pub false_positive_cost: f64,
    pub false_negative_cost: f64,
    pub minimum_event_distance: usize,
    pub short_shot_midpoint: f64,
    pub short_shot_softness: f64,
}

impl Default for StoryboardDecisionConfig {
    fn default() -> Self {
        Self {
            model_version: 1,
            model_origin: "bootstrap_uncalibrated".to_string(),
            epsilon: 1.0e-6,
            robust_window_radius: 50,
            candidate_probability_threshold: 0.1,
            peak_radius: 2,
            candidate_robust_threshold: 2.5,
            event_probability_floor: 0.03,
            event_relative_floor: 0.15,
            event_robust_floor: 1.5,
            event_boundary_patience: 2,
            neighbor_radius: 2,
            classifier: EventClassifier {
                feature_order: FEATURE_NAMES
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect(),
                intercept: -2.5,
                coefficients: vec![0.55, 0.0, -0.3, -0.6, 2.2, 0.75, 0.75, -0.4, 1.1, -0.12],
            },
            calibration: None,
            false_positive_cost: 1.0,
            false_negative_cost: 2.0,
            minimum_event_distance: 3,
            short_shot_midpoint: 2.0,
            short_shot_softness: 2.0,
        }
    }
}

impl StoryboardDecisionConfig {
    pub(super) fn validate(&self) -> AppResult<()> {
        if self.model_version != 1 {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Unsupported storyboard event model version {}",
                    self.model_version
                ),
            ));
        }
        if self.model_origin.trim().is_empty() {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard event model origin must not be empty",
            ));
        }
        if !self.epsilon.is_finite() || !(0.0..0.5).contains(&self.epsilon) {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard event model epsilon must be finite and in (0, 0.5)",
            ));
        }
        validate_probability(
            "candidate_probability_threshold",
            self.candidate_probability_threshold,
        )?;
        validate_probability("event_probability_floor", self.event_probability_floor)?;
        validate_probability("event_relative_floor", self.event_relative_floor)?;
        validate_finite(
            "candidate_robust_threshold",
            self.candidate_robust_threshold,
        )?;
        validate_finite("event_robust_floor", self.event_robust_floor)?;
        if self.event_boundary_patience == 0 {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard event boundary patience must be at least 1",
            ));
        }
        self.classifier.validate()?;
        if let Some(calibration) = &self.calibration {
            calibration.validate()?;
        }
        if !self.false_positive_cost.is_finite() || self.false_positive_cost <= 0.0 {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard false-positive cost must be finite and positive",
            ));
        }
        if !self.false_negative_cost.is_finite() || self.false_negative_cost <= 0.0 {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard false-negative cost must be finite and positive",
            ));
        }
        if !self.short_shot_midpoint.is_finite() || self.short_shot_midpoint < 0.0 {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard short-shot midpoint must be finite and non-negative",
            ));
        }
        if !self.short_shot_softness.is_finite() || self.short_shot_softness <= 0.0 {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard short-shot softness must be finite and positive",
            ));
        }
        Ok(())
    }

    fn decision_threshold(&self) -> f64 {
        self.false_positive_cost / (self.false_positive_cost + self.false_negative_cost)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EventClassifier {
    feature_order: Vec<String>,
    intercept: f64,
    coefficients: Vec<f64>,
}

impl EventClassifier {
    fn validate(&self) -> AppResult<()> {
        if self.feature_order.as_slice() != FEATURE_NAMES {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Storyboard feature order must exactly match [{}]",
                    FEATURE_NAMES.join(", ")
                ),
            ));
        }
        if self.coefficients.len() != FEATURE_NAMES.len() {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                format!(
                    "Storyboard classifier must contain {} coefficients",
                    FEATURE_NAMES.len()
                ),
            ));
        }
        validate_finite("classifier intercept", self.intercept)?;
        if self.coefficients.iter().any(|value| !value.is_finite()) {
            return Err(app_error(
                ErrorCode::StoryboardInferenceFailed,
                "Storyboard classifier coefficients must be finite",
            ));
        }
        Ok(())
    }

    fn predict(&self, features: &[f64; 10]) -> f64 {
        let linear_score = self
            .coefficients
            .iter()
            .zip(features)
            .fold(self.intercept, |score, (coefficient, feature)| {
                score + coefficient * feature
            });
        sigmoid(linear_score)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BetaCalibration {
    a: f64,
    b: f64,
    c: f64,
}

impl BetaCalibration {
    fn validate(&self) -> AppResult<()> {
        validate_finite("calibration a", self.a)?;
        validate_finite("calibration b", self.b)?;
        validate_finite("calibration c", self.c)
    }

    fn calibrate(&self, probability: f64, epsilon: f64) -> f64 {
        let probability = probability.clamp(epsilon, 1.0 - epsilon);
        sigmoid(
            self.a * (probability + epsilon).ln()
                - self.b * (1.0 - probability + epsilon).ln()
                - self.c,
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryboardCut {
    pub(super) cut_frame: usize,
    pub(super) confidence: f64,
    pub(super) event_start: usize,
    pub(super) event_end: usize,
    pub(super) peak_probability: f64,
    pub(super) robust_prominence: f64,
    pub(super) event_area: f64,
    pub(super) event_width: usize,
}

#[derive(Debug, Clone)]
struct RobustSeries {
    probabilities: Vec<f64>,
    logits: Vec<f64>,
    probability_medians: Vec<f64>,
    robust_scores: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
struct EventInterval {
    start: usize,
    end: usize,
}

#[derive(Debug, Clone)]
struct CandidateEvent {
    interval: EventInterval,
    peak_frame: usize,
    peak_probability: f64,
    robust_prominence: f64,
    area: f64,
    width: usize,
    features: [f64; 10],
}

#[derive(Debug, Clone)]
struct ScoredEvent {
    event: CandidateEvent,
    calibrated_probability: f64,
}

pub(super) fn detect_storyboard_cuts(
    predictions: &[f32],
    config: &StoryboardDecisionConfig,
) -> Vec<StoryboardCut> {
    if predictions.is_empty() {
        return Vec::new();
    }

    let series = robust_series(predictions, config);
    let peaks = candidate_peaks(&series, config);
    let intervals = candidate_event_intervals(&series, &peaks, config);
    let mut scored_events = intervals
        .into_iter()
        .map(|interval| event_features(&series, interval, config))
        .map(|event| {
            let probability = config.classifier.predict(&event.features);
            let calibrated_probability = config
                .calibration
                .as_ref()
                .map_or(probability, |calibration| {
                    calibration.calibrate(probability, config.epsilon)
                });
            ScoredEvent {
                event,
                calibrated_probability,
            }
        })
        .filter(|event| event.calibrated_probability > config.decision_threshold())
        .collect::<Vec<_>>();

    scored_events = non_maximum_suppression(scored_events, config.minimum_event_distance);
    apply_short_shot_constraint(scored_events, config)
}

fn robust_series(predictions: &[f32], config: &StoryboardDecisionConfig) -> RobustSeries {
    let probabilities = predictions
        .iter()
        .map(|prediction| {
            if prediction.is_finite() {
                (*prediction as f64).clamp(0.0, 1.0)
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let logits = probabilities
        .iter()
        .map(|probability| logit(*probability, config.epsilon))
        .collect::<Vec<_>>();
    let mut probability_medians = Vec::with_capacity(predictions.len());
    let mut robust_scores = Vec::with_capacity(predictions.len());

    for index in 0..predictions.len() {
        let start = index.saturating_sub(config.robust_window_radius);
        let end = index
            .saturating_add(config.robust_window_radius)
            .min(predictions.len() - 1);
        let probability_median = median(probabilities[start..=end].to_vec());
        let logit_median = median(logits[start..=end].to_vec());
        let deviations = logits[start..=end]
            .iter()
            .map(|value| (value - logit_median).abs())
            .collect::<Vec<_>>();
        let scale = 1.4826 * median(deviations) + config.epsilon;

        probability_medians.push(probability_median);
        robust_scores.push((logits[index] - logit_median) / scale);
    }

    RobustSeries {
        probabilities,
        logits,
        probability_medians,
        robust_scores,
    }
}

fn candidate_peaks(series: &RobustSeries, config: &StoryboardDecisionConfig) -> Vec<usize> {
    series
        .probabilities
        .iter()
        .enumerate()
        .filter_map(|(index, probability)| {
            if *probability < config.candidate_probability_threshold
                || series.robust_scores[index] < config.candidate_robust_threshold
            {
                return None;
            }

            let start = index.saturating_sub(config.peak_radius);
            let end = index
                .saturating_add(config.peak_radius)
                .min(series.probabilities.len() - 1);
            let maximum = series.probabilities[start..=end]
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            let earliest_maximum = series.probabilities[start..=end]
                .iter()
                .position(|value| *value == maximum)
                .map(|offset| start + offset);
            (probability.total_cmp(&maximum).is_eq() && earliest_maximum == Some(index))
                .then_some(index)
        })
        .collect()
}

fn candidate_event_intervals(
    series: &RobustSeries,
    peaks: &[usize],
    config: &StoryboardDecisionConfig,
) -> Vec<EventInterval> {
    let mut intervals = peaks
        .iter()
        .map(|peak| expand_event_interval(series, *peak, config))
        .collect::<Vec<_>>();
    intervals.sort_by_key(|interval| (interval.start, interval.end));

    let mut merged = Vec::<EventInterval>::new();
    for interval in intervals {
        if let Some(previous) = merged.last_mut() {
            if interval.start <= previous.end {
                previous.end = previous.end.max(interval.end);
                continue;
            }
        }
        merged.push(interval);
    }
    merged
}

fn expand_event_interval(
    series: &RobustSeries,
    peak: usize,
    config: &StoryboardDecisionConfig,
) -> EventInterval {
    let peak_probability = series.probabilities[peak];
    let probability_floor = config
        .event_probability_floor
        .max(config.event_relative_floor * peak_probability);
    let qualifies = |index: usize| {
        series.probabilities[index] >= probability_floor
            || series.robust_scores[index] >= config.event_robust_floor
    };

    let mut start = peak;
    let mut misses = 0usize;
    for index in (0..peak).rev() {
        if qualifies(index) {
            start = index;
            misses = 0;
        } else {
            misses += 1;
            if misses >= config.event_boundary_patience {
                break;
            }
        }
    }

    let mut end = peak;
    misses = 0;
    for index in peak + 1..series.probabilities.len() {
        if qualifies(index) {
            end = index;
            misses = 0;
        } else {
            misses += 1;
            if misses >= config.event_boundary_patience {
                break;
            }
        }
    }
    EventInterval { start, end }
}

fn event_features(
    series: &RobustSeries,
    interval: EventInterval,
    config: &StoryboardDecisionConfig,
) -> CandidateEvent {
    let event_probabilities = &series.probabilities[interval.start..=interval.end];
    let peak_probability = event_probabilities
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let peak_frame = interval.start
        + event_probabilities
            .iter()
            .position(|probability| *probability == peak_probability)
            .unwrap_or(0);
    let robust_prominence = series.robust_scores[interval.start..=interval.end]
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let area = event_probabilities.iter().sum::<f64>();
    let width = interval.end - interval.start + 1;
    let concentration = peak_probability / (area + config.epsilon);
    let left_slope = (peak_probability - series.probabilities[interval.start])
        / peak_frame.saturating_sub(interval.start).max(1) as f64;
    let right_slope = (peak_probability - series.probabilities[interval.end])
        / interval.end.saturating_sub(peak_frame).max(1) as f64;
    let asymmetry = (left_slope - right_slope).abs();
    let background_difference = peak_probability - series.probability_medians[peak_frame];
    let neighbor_start = peak_frame.saturating_sub(config.neighbor_radius);
    let neighbor_end = peak_frame
        .saturating_add(config.neighbor_radius)
        .min(series.probabilities.len() - 1);
    let neighbor_mass = series.probabilities[neighbor_start..=neighbor_end]
        .iter()
        .sum::<f64>();
    let features = [
        series.logits[peak_frame],
        robust_prominence,
        (area + config.epsilon).ln(),
        (width as f64).ln(),
        concentration,
        left_slope,
        right_slope,
        asymmetry,
        background_difference,
        neighbor_mass,
    ];

    CandidateEvent {
        interval,
        peak_frame,
        peak_probability,
        robust_prominence,
        area,
        width,
        features,
    }
}

fn non_maximum_suppression(
    mut events: Vec<ScoredEvent>,
    minimum_distance: usize,
) -> Vec<ScoredEvent> {
    events.sort_by(compare_event_priority);
    let mut retained = Vec::<ScoredEvent>::new();
    for event in events {
        let conflicts = retained.iter().any(|known| {
            known.event.peak_frame.abs_diff(event.event.peak_frame) < minimum_distance
        });
        if !conflicts {
            retained.push(event);
        }
    }
    retained.sort_by_key(|event| event.event.peak_frame);
    retained
}

fn compare_event_priority(left: &ScoredEvent, right: &ScoredEvent) -> std::cmp::Ordering {
    right
        .calibrated_probability
        .total_cmp(&left.calibrated_probability)
        .then_with(|| {
            right
                .event
                .peak_probability
                .total_cmp(&left.event.peak_probability)
        })
        .then_with(|| {
            right
                .event
                .robust_prominence
                .total_cmp(&left.event.robust_prominence)
        })
        .then_with(|| left.event.peak_frame.cmp(&right.event.peak_frame))
}

fn apply_short_shot_constraint(
    events: Vec<ScoredEvent>,
    config: &StoryboardDecisionConfig,
) -> Vec<StoryboardCut> {
    let decision_threshold = config.decision_threshold();
    let mut previous_frame = None;
    let mut cuts = Vec::new();

    for scored in events {
        let length_factor = previous_frame.map_or(1.0, |previous: usize| {
            let distance = scored.event.peak_frame.saturating_sub(previous) as f64;
            sigmoid((distance - config.short_shot_midpoint) / config.short_shot_softness)
        });
        let confidence = scored.calibrated_probability * length_factor;
        if confidence <= decision_threshold {
            continue;
        }

        previous_frame = Some(scored.event.peak_frame);
        cuts.push(StoryboardCut {
            cut_frame: scored.event.peak_frame,
            confidence,
            event_start: scored.event.interval.start,
            event_end: scored.event.interval.end,
            peak_probability: scored.event.peak_probability,
            robust_prominence: scored.event.robust_prominence,
            event_area: scored.event.area,
            event_width: scored.event.width,
        });
    }
    cuts
}

fn validate_probability(name: &str, value: f64) -> AppResult<()> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("Storyboard event model {name} must be finite and in [0, 1]"),
        ))
    }
}

fn validate_finite(name: &str, value: f64) -> AppResult<()> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(app_error(
            ErrorCode::StoryboardInferenceFailed,
            format!("Storyboard event model {name} must be finite"),
        ))
    }
}

fn logit(probability: f64, epsilon: f64) -> f64 {
    let probability = probability.clamp(epsilon, 1.0 - epsilon);
    (probability / (1.0 - probability)).ln()
}

fn sigmoid(value: f64) -> f64 {
    if value >= 0.0 {
        1.0 / (1.0 + (-value).exp())
    } else {
        let exponential = value.exp();
        exponential / (1.0 + exponential)
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let middle = values.len() / 2;
    values.select_nth_unstable_by(middle, f64::total_cmp);
    let upper = values[middle];
    if values.len() % 2 == 1 {
        upper
    } else {
        let lower = values[..middle]
            .iter()
            .copied()
            .max_by(f64::total_cmp)
            .unwrap_or(upper);
        (lower + upper) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> StoryboardDecisionConfig {
        let config = StoryboardDecisionConfig::default();
        config.validate().expect("default config must be valid");
        config
    }

    #[test]
    fn isolated_peak_becomes_one_event_cut() {
        let mut predictions = vec![0.01; 120];
        predictions[60] = 0.9;

        let cuts = detect_storyboard_cuts(&predictions, &default_config());

        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].cut_frame, 60);
        assert_eq!(cuts[0].event_start, 60);
        assert_eq!(cuts[0].event_end, 60);
        assert!(cuts[0].confidence > 0.5);
    }

    #[test]
    fn flat_high_sequence_has_no_robust_candidate() {
        let predictions = vec![0.9; 80];

        let cuts = detect_storyboard_cuts(&predictions, &default_config());

        assert!(cuts.is_empty());
    }

    #[test]
    fn marginal_candidate_can_be_rejected_by_event_model() {
        let mut predictions = vec![0.01; 120];
        predictions[60] = 0.1;
        let config = default_config();
        let series = robust_series(&predictions, &config);

        let peaks = candidate_peaks(&series, &config);
        let cuts = detect_storyboard_cuts(&predictions, &config);

        assert_eq!(peaks, vec![60]);
        assert!(cuts.is_empty());
    }

    #[test]
    fn concentrated_lower_probability_peak_is_retained() {
        let mut predictions = vec![0.01; 120];
        predictions[60] = 0.13;

        let cuts = detect_storyboard_cuts(&predictions, &default_config());

        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].cut_frame, 60);
    }

    #[test]
    fn broad_motion_like_probability_hump_is_rejected() {
        let mut predictions = vec![0.01; 120];
        predictions[57..=63].copy_from_slice(&[0.2, 0.35, 0.6, 0.9, 0.6, 0.35, 0.2]);

        let cuts = detect_storyboard_cuts(&predictions, &default_config());

        assert!(cuts.is_empty());
    }

    #[test]
    fn equal_peak_plateau_uses_earliest_peak_frame() {
        let mut predictions = vec![0.01; 80];
        predictions[39..=41].fill(0.9);

        let series = robust_series(&predictions, &default_config());
        let peaks = candidate_peaks(&series, &default_config());
        let intervals = candidate_event_intervals(&series, &peaks, &default_config());
        let event = event_features(&series, intervals[0], &default_config());

        assert_eq!(peaks, vec![39]);
        assert_eq!(event.peak_frame, 39);
        assert_eq!(event.width, 3);
    }

    #[test]
    fn adjacent_peak_candidates_merge_into_one_event() {
        let mut predictions = vec![0.01; 100];
        predictions[40] = 0.9;
        predictions[41] = 0.95;
        predictions[42] = 0.92;

        let cuts = detect_storyboard_cuts(&predictions, &default_config());

        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].cut_frame, 41);
        assert_eq!(cuts[0].event_start, 40);
        assert_eq!(cuts[0].event_end, 42);
    }

    #[test]
    fn identity_beta_calibration_preserves_probability() {
        let calibration = BetaCalibration {
            a: 1.0,
            b: 1.0,
            c: 0.0,
        };

        let calibrated = calibration.calibrate(0.73, 1.0e-9);

        assert!((calibrated - 0.73).abs() < 1.0e-8);
    }

    #[test]
    fn false_positive_cost_controls_decision_threshold() {
        let mut config = default_config();
        config.false_positive_cost = 3.0;
        config.false_negative_cost = 1.0;

        assert_eq!(config.decision_threshold(), 0.75);
    }

    #[test]
    fn short_shot_constraint_is_soft_and_uses_last_accepted_cut() {
        let config = default_config();
        let event = |peak_frame, probability| ScoredEvent {
            event: CandidateEvent {
                interval: EventInterval {
                    start: peak_frame,
                    end: peak_frame,
                },
                peak_frame,
                peak_probability: probability,
                robust_prominence: 10.0,
                area: probability,
                width: 1,
                features: [0.0; 10],
            },
            calibrated_probability: probability,
        };

        let cuts = apply_short_shot_constraint(
            vec![event(20, 0.9), event(21, 0.8), event(40, 0.9)],
            &config,
        );

        assert_eq!(
            cuts.iter().map(|cut| cut.cut_frame).collect::<Vec<_>>(),
            vec![20, 40]
        );
        assert_eq!(cuts[0].confidence, 0.9);
        assert!(cuts[1].confidence < 0.9);
        assert!(cuts[1].confidence > 0.5);
    }

    #[test]
    fn nms_uses_probability_then_peak_then_prominence_then_time() {
        let event =
            |peak_frame, calibrated_probability, peak_probability, prominence| ScoredEvent {
                event: CandidateEvent {
                    interval: EventInterval {
                        start: peak_frame,
                        end: peak_frame,
                    },
                    peak_frame,
                    peak_probability,
                    robust_prominence: prominence,
                    area: peak_probability,
                    width: 1,
                    features: [0.0; 10],
                },
                calibrated_probability,
            };

        let retained = non_maximum_suppression(
            vec![
                event(10, 0.8, 0.9, 10.0),
                event(11, 0.9, 0.8, 9.0),
                event(20, 0.7, 0.7, 7.0),
            ],
            3,
        );

        assert_eq!(
            retained
                .iter()
                .map(|candidate| candidate.event.peak_frame)
                .collect::<Vec<_>>(),
            vec![11, 20]
        );
    }
}
