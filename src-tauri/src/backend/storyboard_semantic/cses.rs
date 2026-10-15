//! CSES, arXiv:2608.00714v1, Eqs. 1–9 and Algorithms 1–2.
//! The only score substitution is fixed-reference visual novelty v_i.
use super::*;

const DELTA: f64 = 1e-6;
const TAU: f64 = 2.0;
const KAPPA: f64 = 0.005;
const EPSILON: f64 = 0.05;
const K_MIN: usize = 1;

struct Budgets {
    probes: usize,
    scored: usize,
    grid: usize,
    selected: usize,
    bandwidth_max: f64,
}

impl Budgets {
    fn for_shot(frames: usize, rate: f64) -> Self {
        let duration = frames as f64 / rate;
        let probes = ((duration * 2.0).ceil() as usize).clamp(4, 64).min(frames);
        Self {
            probes,
            scored: (2 * probes).min(128).min(frames),
            grid: 512.min(frames - probes),
            selected: ((duration * 2.0).ceil() as usize).clamp(1, 32).min(frames),
            bandwidth_max: (duration / 4.0).clamp(1.0, 38.0),
        }
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

fn novelty(vector: &[f32], probes: &[Vec<f32>], own_probe: Option<usize>) -> f64 {
    let count = probes.len() - usize::from(own_probe.is_some());
    if count == 0 {
        return 0.0;
    }
    1.0 - probes
        .iter()
        .enumerate()
        .filter(|(j, _)| Some(*j) != own_probe)
        .map(|(_, other)| affinity(vector, other))
        .sum::<f64>()
        / count as f64
}

pub(super) fn select(
    frames: usize,
    rate: f64,
    cancel: &AtomicBool,
    mut encode: impl FnMut(&[usize]) -> AppResult<Vec<Vec<f32>>>,
) -> AppResult<Vec<usize>> {
    ensure_not_cancelled(cancel)?;
    if frames == 1 {
        return Ok(vec![0]);
    }
    let budget = Budgets::for_shot(frames, rate);
    let mut observed = uniform(frames, budget.probes);
    let probes = encode(&observed)?;
    if probes.len() != observed.len() {
        return Err(inference_error("Incomplete probe embeddings"));
    }
    let mut scores: Vec<f64> = probes
        .iter()
        .enumerate()
        .map(|(i, e)| novelty(e, &probes, Some(i)))
        .collect();
    let background = median(&scores);
    let mad = median(
        &scores
            .iter()
            .map(|v| (v - background).abs())
            .collect::<Vec<_>>(),
    );
    let peak = scores.iter().copied().fold(0.0, f64::max);
    let (u, bandwidth) = concentration(peak, background, mad, budget.bandwidth_max);

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
    for (c, &frame) in grid.iter().enumerate() {
        ensure_not_cancelled(cancel)?;
        let affinities: Vec<f64> = observed
            .iter()
            .map(|&j| temporal(frame, j, rate, bandwidth))
            .collect();
        coverage[c] = affinities.iter().copied().fold(0.0, f64::max);
        // Log-sum-exp stabilization of Eq. 6 preserves Gaussian regression even
        // when every unscaled affinity underflows in a very long temporal gap.
        let logs: Vec<f64> = observed
            .iter()
            .map(|&j| {
                let distance = (frame as f64 - j as f64) / rate / bandwidth;
                -0.5 * distance * distance
            })
            .collect();
        let max_log = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let weights: Vec<f64> = logs.iter().map(|v| (v - max_log).exp()).collect();
        predicted[c] = weights.iter().zip(&scores).map(|(a, v)| a * v).sum::<f64>()
            / weights.iter().sum::<f64>();
        let right = observed
            .partition_point(|&j| j < frame)
            .min(observed.len() - 1);
        let left = right.saturating_sub(1);
        visual[c] = 1.0 - affinity(&probes[left], &probes[right]);
    }
    let temporal_grid: Vec<Vec<f64>> = grid
        .iter()
        .map(|&x| {
            grid.iter()
                .map(|&c| temporal(x, c, rate, bandwidth))
                .collect()
        })
        .collect();
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
        let mut best = None;
        let mut gain = 0.0;
        for x in 0..grid.len() {
            if planned[x] {
                continue;
            }
            let candidate = (0..grid.len())
                .map(|c| weights[c] * (temporal_grid[x][c] - coverage[c]).max(0.0))
                .sum::<f64>();
            if candidate > gain {
                gain = candidate;
                best = Some(x);
            }
        }
        let Some(x) = best else {
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
    // O0 never changes, including the leave-one-out definition for probe scores.
    scores.extend(acquired.iter().map(|e| novelty(e, &probes, None)));
    observed.extend(acquisition);
    let mut embeddings = probes;
    embeddings.extend(acquired);
    let peak = scores.iter().copied().fold(0.0, f64::max);
    let (_, bandwidth) = concentration(peak, background, mad, budget.bandwidth_max);
    let n = observed.len();
    let kernel: Vec<Vec<f64>> = (0..n)
        .map(|i| {
            (0..n)
                .map(|j| {
                    if i == j {
                        1.0
                    } else {
                        affinity(&embeddings[i], &embeddings[j])
                            * temporal(observed[i], observed[j], rate, bandwidth)
                    }
                })
                .collect()
        })
        .collect();
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
        let mut best = None;
        let mut best_gain = 0.0;
        for j in 0..n {
            if selected[j] {
                continue;
            }
            let gain = (0..n)
                .map(|i| weights[i] * (kernel[i][j] - coverage[i]).max(0.0))
                .sum::<f64>();
            // Appendix Algorithm 2: equal gains prefer minimum max K(j,S).
            if gain > best_gain
                || (gain == best_gain
                    && gain > 0.0
                    && best.is_some_and(|b: usize| {
                        coverage[j] < coverage[b]
                            || (coverage[j] == coverage[b] && observed[j] < observed[b])
                    }))
            {
                best = Some(j);
                best_gain = gain;
            }
        }
        let Some(j) = best else {
            break;
        };
        selected[j] = true;
        result.push(observed[j]);
        for i in 0..n {
            coverage[i] = coverage[i].max(kernel[i][j]);
        }
    }
    result.sort_unstable();
    Ok(result)
}
