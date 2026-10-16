//! CSES, arXiv:2608.00714v1, Eqs. 1–9 and Algorithms 1–2.
//! Relevance is replaced by local, sech-weighted visual novelty v_i.
use super::*;

const DELTA: f64 = 1e-6;
const TAU: f64 = 2.0;
const KAPPA: f64 = 0.005;
const EPSILON: f64 = 0.05;
const K_MIN: usize = 1;
const NOVELTY_RADIUS: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Parameters {
    pub(super) probes: usize,
    pub(super) scored: usize,
    pub(super) grid: usize,
    pub(super) selected: usize,
    pub(super) bandwidth_max: f64,
    minimum_selected: usize,
    delta: f64,
    tau: f64,
    kappa: f64,
    epsilon: f64,
    novelty_radius: usize,
}

impl Parameters {
    pub(super) fn for_shot(frames: usize, rate: f64) -> Self {
        let duration = frames as f64 / rate;
        let probes = ((duration * 2.0).ceil() as usize).clamp(4, 64).min(frames);
        Self {
            probes,
            scored: (2 * probes).min(128).min(frames),
            grid: 512.min(frames - probes),
            selected: ((duration * 2.0).ceil() as usize).clamp(1, 32).min(frames),
            bandwidth_max: (duration / 4.0).clamp(1.0, 38.0),
            minimum_selected: K_MIN,
            delta: DELTA,
            tau: TAU,
            kappa: KAPPA,
            epsilon: EPSILON,
            novelty_radius: NOVELTY_RADIUS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct EncodedFrame {
    // Relative to the shot during selection; made absolute before persistence.
    pub(super) frame: usize,
    pub(super) v_i: f64,
    // The complete encoder vector used by CSES, before pairwise affinities.
    // This is the original L2-normalized DINOv3 CLS embedding, with no quantization.
    pub(super) e_i: Vec<f32>,
    pub(super) probe: bool,
    pub(super) selected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Calibration {
    pub(super) background_median: f64,
    pub(super) background_mad: f64,
    pub(super) initial_peak: f64,
    pub(super) final_peak: f64,
    pub(super) initial_bandwidth: f64,
    pub(super) final_bandwidth: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Selection {
    pub(super) parameters: Parameters,
    pub(super) calibration: Calibration,
    // Preserve O's calculation order: probes, then acquisition points. This also
    // preserves floating-point summation order for final-selection replay.
    pub(super) frames: Vec<EncodedFrame>,
}

impl Selection {
    pub(super) fn selected_frames(&self) -> Vec<usize> {
        let mut frames: Vec<usize> = self
            .frames
            .iter()
            .filter(|frame| frame.selected)
            .map(|frame| frame.frame)
            .collect();
        frames.sort_unstable();
        frames
    }
}

// Inclusive integer linspace; distinct positions when count <= length.
fn uniform(length: usize, count: usize) -> Vec<usize> {
    match count {
        0 => Vec::new(),
        1 => vec![0],
        _ => (0..count)
            .map(|i| {
                ((i as u128 * (length - 1) as u128 + (count - 1) as u128 / 2) / (count - 1) as u128)
                    as usize
            })
            .collect(),
    }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    }
}

// The encoder supplies L2-normalized embeddings. Both novelty and visual
// coverage use nonnegative cosine similarity.
fn affinity(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&a, &b)| f64::from(a) * f64::from(b))
        .sum::<f64>()
        .clamp(0.0, 1.0)
}

fn temporal(a: usize, b: usize, rate: f64, bandwidth: f64) -> f64 {
    let distance = (a as f64 - b as f64) / rate / bandwidth;
    (-0.5 * distance * distance).exp()
}

fn concentration(peak: f64, background: f64, mad: f64, maximum: f64) -> (f64, f64) {
    let log_p = ((peak - background) / (mad + DELTA)).max(DELTA).log10();
    let u = (log_p / TAU).clamp(0.0, 1.0);
    (u, 1.0 + (1.0 - u) * (maximum - 1.0))
}

// Each dot product is evaluated once, including pairs reused after acquisition.
struct VisualAffinities {
    values: Vec<f64>,
    stride: usize,
    encoded: usize,
}

impl VisualAffinities {
    fn new(stride: usize) -> Self {
        Self {
            values: vec![0.0; stride * stride],
            stride,
            encoded: 0,
        }
    }

    fn extend(&mut self, embeddings: &[Vec<f32>]) {
        for i in self.encoded..embeddings.len() {
            for j in 0..=i {
                let value = affinity(&embeddings[i], &embeddings[j]);
                self.values[i * self.stride + j] = value;
                self.values[j * self.stride + i] = value;
            }
        }
        self.encoded = embeddings.len();
    }

    fn get(&self, i: usize, j: usize) -> f64 {
        self.values[i * self.stride + j]
    }
}

// With fixed A/K, both coverage and acquisition weights are monotonic:
// cov only increases; W = u*(predicted+kappa)+(1-u)*(1-cov)*vis only decreases.
// Hence an earlier exact marginal gain is an upper bound, even in Stage 2
// where W changes. Reevaluate descending bounds until no candidate can win.
// Strict '<' is essential: equal bounds must still honor the original tie rule.
struct GreedyGains {
    bounds: Vec<f64>,
    order: Vec<usize>,
}

impl GreedyGains {
    fn new(n: usize) -> Self {
        Self {
            bounds: vec![f64::INFINITY; n],
            order: (0..n).collect(),
        }
    }

    fn best(
        &mut self,
        kernel: &[Vec<f64>],
        weights: &[f64],
        coverage: &[f64],
        chosen: &[bool],
        positions: Option<&[usize]>,
    ) -> Option<usize> {
        self.order
            .sort_unstable_by(|&a, &b| self.bounds[b].total_cmp(&self.bounds[a]).then(a.cmp(&b)));
        let mut best = None;
        let mut best_gain = 0.0;
        for &j in &self.order {
            if chosen[j] {
                continue;
            }
            if self.bounds[j] < best_gain {
                break;
            }
            let gain = kernel[j]
                .iter()
                .zip(weights)
                .zip(coverage)
                .map(|((&k, &w), &c)| w * (k - c).max(0.0))
                .sum::<f64>();
            self.bounds[j] = gain;
            let wins_tie = best.is_some_and(|b: usize| match positions {
                Some(p) => coverage[j] < coverage[b] || (coverage[j] == coverage[b] && p[j] < p[b]),
                None => j < b,
            });
            if gain > best_gain || (gain == best_gain && gain > 0.0 && wins_tie) {
                best = Some(j);
                best_gain = gain;
            }
        }
        best
    }
}

fn novelty_scores(positions: &[usize], similarities: &VisualAffinities) -> Vec<f64> {
    let mut order: Vec<usize> = (0..positions.len()).collect();
    order.sort_unstable_by_key(|&i| positions[i]);
    let weights: Vec<f64> = (1..=NOVELTY_RADIUS)
        .map(|distance| (distance as f64 / 2.0).cosh().recip())
        .collect();
    let mut scores = vec![0.0; positions.len()];
    for (rank, &i) in order.iter().enumerate() {
        let start = rank.saturating_sub(NOVELTY_RADIUS);
        let end = (rank + NOVELTY_RADIUS + 1).min(order.len());
        let mut weighted_similarity = 0.0;
        let mut total_weight = 0.0;
        for (offset, &j) in order[start..end].iter().enumerate() {
            let distance = rank.abs_diff(start + offset);
            if distance == 0 {
                continue;
            }
            let weight = weights[distance - 1];
            weighted_similarity += weight * similarities.get(i, j);
            total_weight += weight;
        }
        // A lone point has no neighbors; retain the single-frame convention.
        if total_weight > 0.0 {
            scores[i] = 1.0 - weighted_similarity / total_weight;
        }
    }
    scores
}

pub(super) fn select(
    frames: usize,
    rate: f64,
    cancel: &AtomicBool,
    mut encode: impl FnMut(&[usize]) -> AppResult<Vec<Vec<f32>>>,
) -> AppResult<Selection> {
    ensure_not_cancelled(cancel)?;
    // Even a single-frame shot now needs its vector in the persisted source.
    let budget = Parameters::for_shot(frames, rate);
    let mut observed = uniform(frames, budget.probes);
    let probes = encode(&observed)?;
    if probes.len() != observed.len() {
        return Err(inference_error("Incomplete probe embeddings"));
    }
    let mut similarities = VisualAffinities::new(budget.scored);
    similarities.extend(&probes);
    let mut scores = novelty_scores(&observed, &similarities);
    let background = median(&scores);
    let mad = median(
        &scores
            .iter()
            .map(|v| (v - background).abs())
            .collect::<Vec<_>>(),
    );
    let initial_peak = scores.iter().copied().fold(0.0, f64::max);
    let (u, bandwidth) = concentration(initial_peak, background, mad, budget.bandwidth_max);
    let initial_bandwidth = bandwidth;

    // Sample uniformly in the ordered set of unscored frames, without allocating
    // an array proportional to video length. Probe endpoints bracket every c.
    let grid: Vec<usize> = uniform(frames - observed.len(), budget.grid)
        .into_iter()
        .map(|rank| {
            let mut frame = rank;
            for &probe in &observed {
                if probe <= frame {
                    frame += 1;
                } else {
                    break;
                }
            }
            frame
        })
        .collect();
    let mut coverage = vec![0.0_f64; grid.len()];
    let mut predicted = vec![0.0; grid.len()];
    let mut visual = vec![0.0; grid.len()];
    let mut logs = vec![0.0; observed.len()];
    for (c, &frame) in grid.iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        // Log-sum-exp stabilization of Eq. 6 preserves Gaussian regression even
        // when every unscaled affinity underflows in a very long temporal gap.
        for (log, &j) in logs.iter_mut().zip(&observed) {
            let distance = (frame as f64 - j as f64) / rate / bandwidth;
            *log = -0.5 * distance * distance;
        }
        let max_log = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        coverage[c] = max_log.exp();
        let mut numerator = 0.0;
        let mut denominator = 0.0;
        for (&log, &score) in logs.iter().zip(&scores) {
            let weight = (log - max_log).exp();
            numerator += weight * score;
            denominator += weight;
        }
        predicted[c] = numerator / denominator;
        let right = observed
            .partition_point(|&j| j < frame)
            .min(observed.len() - 1);
        let left = right.saturating_sub(1);
        visual[c] = 1.0 - similarities.get(left, right);
    }
    // Many short/static shots already meet saturation. Avoid constructing G²
    // affinities at all until the first acquisition is actually required.
    let mut temporal_grid: Vec<Vec<f64>> = Vec::new();
    let mut gains = GreedyGains::new(grid.len());
    let mut planned = vec![false; grid.len()];
    let mut acquisition = Vec::new();
    while observed.len() + acquisition.len() < budget.scored && acquisition.len() < grid.len() {
        ensure_not_cancelled(cancel)?;
        // Algorithm 1, line 8: recompute sigma AND W after every virtual update.
        let weights: Vec<f64> = (0..grid.len())
            .map(|c| u * (predicted[c] + KAPPA) + (1.0 - u) * (1.0 - coverage[c]) * visual[c])
            .collect();
        let total: f64 = weights.iter().sum();
        let covered: f64 = weights.iter().zip(&coverage).map(|(w, c)| w * c).sum();
        if covered >= (1.0 - EPSILON) * total {
            break;
        }
        if temporal_grid.is_empty() {
            temporal_grid = vec![vec![1.0; grid.len()]; grid.len()];
            for i in 0..grid.len() {
                for j in 0..i {
                    let value = temporal(grid[i], grid[j], rate, bandwidth);
                    temporal_grid[i][j] = value;
                    temporal_grid[j][i] = value;
                }
            }
        }
        let Some(x) = gains.best(&temporal_grid, &weights, &coverage, &planned, None) else {
            break;
        };
        planned[x] = true;
        acquisition.push(grid[x]);
        for (c, value) in coverage.iter_mut().enumerate() {
            *value = value.max(temporal_grid[x][c]);
        }
    }
    acquisition.sort_unstable();
    let acquired = if acquisition.is_empty() {
        Vec::new()
    } else {
        encode(&acquisition)?
    };
    if acquired.len() != acquisition.len() {
        return Err(inference_error("Incomplete acquisition embeddings"));
    }
    observed.extend(acquisition);
    let mut embeddings = probes;
    embeddings.extend(acquired);
    // New points change temporal ranks and neighborhoods, including those of
    // existing probes. Recompute every score over the expanded encoded set.
    // Eq. 9 still uses the background median/MAD saved from Stage 1.
    similarities.extend(&embeddings);
    scores = novelty_scores(&observed, &similarities);
    let peak = scores.iter().copied().fold(0.0, f64::max);
    let (_, bandwidth) = concentration(peak, background, mad, budget.bandwidth_max);
    let n = observed.len();
    let mut kernel = vec![vec![1.0; n]; n];
    for i in 0..n {
        for j in 0..i {
            let value =
                similarities.get(i, j) * temporal(observed[i], observed[j], rate, bandwidth);
            kernel[i][j] = value;
            kernel[j][i] = value;
        }
    }
    let mut gains = GreedyGains::new(n);
    let weights: Vec<f64> = scores.iter().map(|v| v + KAPPA).collect();
    let total: f64 = weights.iter().sum();
    let mut coverage = vec![0.0_f64; n];
    let mut selected = vec![false; n];
    let mut result = Vec::new();
    while result.len() < budget.selected.min(n) {
        ensure_not_cancelled(cancel)?;
        if result.len() >= K_MIN
            && weights
                .iter()
                .zip(&coverage)
                .map(|(w, c)| w * c)
                .sum::<f64>()
                >= (1.0 - EPSILON) * total
        {
            break;
        }
        let Some(j) = gains.best(&kernel, &weights, &coverage, &selected, Some(&observed)) else {
            break;
        };
        selected[j] = true;
        result.push(observed[j]);
        for i in 0..n {
            coverage[i] = coverage[i].max(kernel[i][j]);
        }
    }
    ensure_not_cancelled(cancel)?;
    Ok(Selection {
        calibration: Calibration {
            background_median: background,
            background_mad: mad,
            initial_peak,
            final_peak: peak,
            initial_bandwidth,
            final_bandwidth: bandwidth,
        },
        frames: observed
            .into_iter()
            .zip(scores)
            .zip(embeddings)
            .enumerate()
            .map(|(i, ((frame, v_i), e_i))| EncodedFrame {
                frame,
                v_i,
                e_i,
                probe: i < budget.probes,
                selected: selected[i],
            })
            .collect(),
        parameters: budget,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_source_contains_acquisition_final_scores_and_replays_selection() {
        let cancel = AtomicBool::new(false);
        let mut batches = Vec::new();
        let embedding = |frame: usize| {
            let angle = frame as f64 * 0.037;
            vec![angle.cos() as f32, angle.sin() as f32]
        };
        let selection = select(10000, 1.0, &cancel, |positions| {
            batches.push(positions.to_vec());
            Ok(positions.iter().map(|&frame| embedding(frame)).collect())
        })
        .unwrap();
        assert_eq!(batches.len(), 2, "fixture must exercise active acquisition");
        let positions: Vec<usize> = batches.iter().flatten().copied().collect();
        assert_eq!(
            selection
                .frames
                .iter()
                .map(|frame| frame.frame)
                .collect::<Vec<_>>(),
            positions
        );
        let embeddings: Vec<Vec<f32>> = positions.iter().map(|&frame| embedding(frame)).collect();
        let mut affinities = VisualAffinities::new(positions.len());
        affinities.extend(&embeddings);
        let final_scores = novelty_scores(&positions, &affinities);
        for (i, frame) in selection.frames.iter().enumerate() {
            assert_eq!(frame.e_i, embeddings[i]);
            assert_eq!(frame.v_i, final_scores[i]);
            assert_eq!(frame.probe, i < batches[0].len());
        }
        let mut coarse = VisualAffinities::new(batches[0].len());
        coarse.extend(&embeddings[..batches[0].len()]);
        let coarse_scores = novelty_scores(&batches[0], &coarse);
        assert!(coarse_scores.iter().zip(&final_scores).any(|(a, b)| a != b));
        assert_eq!(
            selection.calibration.background_median,
            median(&coarse_scores)
        );

        // Full-scan replay consumes only the captured final data, not the
        // encoder, acquisition planner, or optimized greedy implementation.
        let frames = &selection.frames;
        let weights: Vec<f64> = frames
            .iter()
            .map(|frame| frame.v_i + selection.parameters.kappa)
            .collect();
        let total: f64 = weights.iter().sum();
        let n = frames.len();
        let kernel: Vec<Vec<f64>> = frames
            .iter()
            .map(|a| {
                frames
                    .iter()
                    .map(|b| {
                        if a.frame == b.frame {
                            1.0
                        } else {
                            affinity(&a.e_i, &b.e_i)
                                * temporal(
                                    a.frame,
                                    b.frame,
                                    1.0,
                                    selection.calibration.final_bandwidth,
                                )
                        }
                    })
                    .collect()
            })
            .collect();
        let mut covered = vec![0.0_f64; n];
        let mut chosen = HashSet::new();
        while chosen.len() < selection.parameters.selected {
            if chosen.len() >= selection.parameters.minimum_selected
                && weights
                    .iter()
                    .zip(&covered)
                    .map(|(w, c)| w * c)
                    .sum::<f64>()
                    >= (1.0 - selection.parameters.epsilon) * total
            {
                break;
            }
            let mut best = None;
            let mut best_gain = 0.0;
            for j in 0..n {
                if chosen.contains(&j) {
                    continue;
                }
                let gain: f64 = (0..n)
                    .map(|i| weights[i] * (kernel[i][j] - covered[i]).max(0.0))
                    .sum();
                if gain > best_gain
                    || (gain == best_gain
                        && gain > 0.0
                        && best.is_some_and(|b: usize| {
                            covered[j] < covered[b]
                                || (covered[j] == covered[b] && frames[j].frame < frames[b].frame)
                        }))
                {
                    best = Some(j);
                    best_gain = gain;
                }
            }
            let Some(j) = best else {
                break;
            };
            chosen.insert(j);
            for i in 0..n {
                covered[i] = covered[i].max(kernel[i][j]);
            }
        }
        let mut replayed: Vec<usize> = chosen.into_iter().map(|i| frames[i].frame).collect();
        replayed.sort_unstable();
        assert_eq!(replayed, selection.selected_frames());
    }

    #[test]
    fn single_frame_also_records_its_embedding() {
        let cancel = AtomicBool::new(false);
        let selected = select(1, 25.0, &cancel, |positions| {
            assert_eq!(positions, [0]);
            Ok(vec![vec![0.6, 0.8]])
        })
        .unwrap();
        assert_eq!(selected.selected_frames(), [0]);
        assert_eq!(selected.frames[0].v_i, 0.0);
        assert_eq!(selected.frames[0].e_i, [0.6, 0.8]);
        assert!(selected.frames[0].probe);
    }

    #[test]
    fn bounded_greedy_matches_full_scan_with_changing_weights_and_ties() {
        for n in [2, 9, 41] {
            for shape in 0..3 {
                let mut kernel = vec![vec![1.0; n]; n];
                for i in 0..n {
                    for j in 0..i {
                        let value = match shape {
                            0 => temporal(i, j, 1.0, 3.0),
                            1 => ((i * 17 + j * 31) % 7) as f64 / 7.0,
                            _ => 1.0,
                        };
                        kernel[i][j] = value;
                        kernel[j][i] = value;
                    }
                }
                for u in [0.0, 0.37, 1.0] {
                    for final_stage in [false, true] {
                        let positions: Vec<usize> = (0..n).rev().collect();
                        let mut coverage = vec![0.0_f64; n];
                        let mut chosen = vec![false; n];
                        let mut lazy = GreedyGains::new(n);
                        for _ in 0..n {
                            let weights: Vec<f64> = (0..n)
                                .map(|i| {
                                    if final_stage {
                                        0.5
                                    } else {
                                        u * (i as f64 / n as f64 + KAPPA)
                                            + (1.0 - u) * (1.0 - coverage[i]) * 0.75
                                    }
                                })
                                .collect();
                            // Independent full scan in the original index order.
                            let mut expected = None;
                            let mut best_gain = 0.0;
                            for j in 0..n {
                                if chosen[j] {
                                    continue;
                                }
                                let gain = (0..n)
                                    .map(|i| weights[i] * (kernel[i][j] - coverage[i]).max(0.0))
                                    .sum::<f64>();
                                if gain > best_gain
                                    || (gain == best_gain
                                        && gain > 0.0
                                        && final_stage
                                        && expected.is_some_and(|b: usize| {
                                            coverage[j] < coverage[b]
                                                || (coverage[j] == coverage[b]
                                                    && positions[j] < positions[b])
                                        }))
                                {
                                    expected = Some(j);
                                    best_gain = gain;
                                }
                            }
                            let actual = lazy.best(
                                &kernel,
                                &weights,
                                &coverage,
                                &chosen,
                                final_stage.then_some(positions.as_slice()),
                            );
                            assert_eq!(
                                actual, expected,
                                "n={n}, shape={shape}, u={u}, final={final_stage}"
                            );
                            let Some(j) = actual else {
                                break;
                            };
                            chosen[j] = true;
                            for i in 0..n {
                                coverage[i] = coverage[i].max(kernel[i][j]);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn extended_visual_cache_preserves_every_cosine_and_local_score() {
        let embeddings = vec![
            vec![1.0, 0.0],
            vec![0.0, 1.0],
            vec![0.6, 0.8],
            vec![-1.0, 0.0],
        ];
        let mut cache = VisualAffinities::new(4);
        cache.extend(&embeddings[..2]);
        cache.extend(&embeddings);
        for i in 0..4 {
            for j in 0..4 {
                assert_eq!(cache.get(i, j), affinity(&embeddings[i], &embeddings[j]));
            }
        }
        let positions = [0, 30, 10, 20];
        let order = [0usize, 2, 3, 1];
        let scores = novelty_scores(&positions, &cache);
        for (rank, &i) in order.iter().enumerate() {
            let mut numerator = 0.0;
            let mut denominator = 0.0;
            for (other, &j) in order.iter().enumerate() {
                if i == j {
                    continue;
                }
                let weight = (rank.abs_diff(other) as f64 / 2.0).cosh().recip();
                numerator += weight * affinity(&embeddings[i], &embeddings[j]);
                denominator += weight;
            }
            assert_eq!(scores[i], 1.0 - numerator / denominator);
        }
    }
}
