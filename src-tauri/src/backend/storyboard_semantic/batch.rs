//! Online batch selection using real work, never synthetic inference probes.
pub(super) const SIZES: [usize; 5] = [8, 16, 32, 4, 2];
pub(super) const MAX_BATCH: usize = 32;
// All five tuned shapes, plus the one-row recovery shape. Keeping this finite
// set avoids recompiling either a challenger or a frequently used tail shape.
pub(super) const RESIDENT_SHAPES: usize = SIZES.len() + 1;

#[derive(Default)]
pub(super) struct BatchPolicy {
    samples: [usize; 5],
    timings: [usize; 5],
    seconds_per_frame: [f64; 5],
    blocked: [bool; 5],
}

impl BatchPolicy {
    pub(super) fn choose_resident(
        &self,
        remaining: usize,
        resident: impl Iterator<Item = usize>,
    ) -> usize {
        let chosen = self.choose(remaining);
        // A short source tail must not evict a warmed throughput session just
        // to compile a new two/four-row graph. Full work still tunes all sizes.
        if remaining < SIZES[0] {
            resident
                .filter(|&size| size >= remaining)
                .min()
                .unwrap_or(chosen)
        } else {
            chosen
        }
    }

    pub(super) fn best(&self) -> usize {
        (0..SIZES.len())
            .filter(|&i| !self.blocked[i] && self.timings[i] > 0)
            .min_by(|&a, &b| self.seconds_per_frame[a].total_cmp(&self.seconds_per_frame[b]))
            .map(|i| SIZES[i])
            .unwrap_or_else(|| {
                SIZES
                    .iter()
                    .enumerate()
                    .find(|(i, _)| !self.blocked[*i])
                    .map(|(_, &size)| size)
                    .unwrap_or(1)
            })
    }

    pub(super) fn choose(&self, remaining: usize) -> usize {
        if remaining < 4 && !self.blocked[3] {
            return remaining.max(2).next_power_of_two();
        }
        // Successful real batches establish a candidate, including its first
        // run. Only warmed, full batches contribute throughput measurements.
        for (i, &size) in SIZES.iter().enumerate() {
            if !self.blocked[i] && self.samples[i] < 3 && size <= remaining {
                return size;
            }
        }
        let best = self.best();
        if remaining >= best {
            return best;
        }
        // Do not deliberately split a three-frame tail into 2+1, for example.
        remaining.max(2).next_power_of_two().min(MAX_BATCH)
    }

    pub(super) fn observe(&mut self, size: usize, frames: usize, seconds: Option<f64>) {
        if let Some(i) = SIZES.iter().position(|&s| s == size) {
            if frames == 0 || frames > size || self.blocked[i] {
                return;
            }
            self.samples[i] = (self.samples[i] + 1).min(3);
            let Some(seconds) = seconds.filter(|_| frames == size) else {
                return;
            };
            let sample = seconds / size as f64;
            if !sample.is_finite() || sample <= 0.0 {
                return;
            }
            self.seconds_per_frame[i] = if self.timings[i] == 0 {
                sample
            } else {
                self.seconds_per_frame[i] * 0.75 + sample * 0.25
            };
            self.timings[i] += 1;
        }
    }

    pub(super) fn failed(&mut self, size: usize) {
        for (i, &candidate) in SIZES.iter().enumerate() {
            if candidate >= size {
                self.blocked[i] = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_real_run_counts_once_without_timing_or_duplicate_warmup_work() {
        let mut policy = BatchPolicy::default();
        policy.observe(8, 8, None);
        assert_eq!(policy.samples[0], 1);
        assert_eq!(policy.timings[0], 0);
        assert_eq!(policy.choose(64), 8);
        policy.observe(8, 8, Some(0.08));
        policy.observe(8, 8, Some(0.08));
        assert_eq!(policy.samples[0], 3);
        assert_eq!(policy.timings[0], 2);
        assert_eq!(policy.choose(64), 16);
        // Later real work updates throughput, without restarting calibration.
        policy.observe(8, 8, Some(0.04));
        assert_eq!(policy.samples[0], 3);
        assert_eq!(policy.timings[0], 3);
        assert_eq!(policy.choose(64), 16);
    }

    #[test]
    fn padding_and_untimed_challengers_never_bias_the_measured_winner() {
        let mut policy = BatchPolicy::default();
        policy.observe(8, 8, Some(0.08));
        policy.observe(16, 16, None);
        policy.observe(16, 3, Some(0.0001));
        assert_eq!(policy.samples[1], 2);
        assert_eq!(policy.timings[1], 0);
        assert_eq!(policy.best(), 8);
        policy.observe(16, 16, Some(0.032));
        assert_eq!(policy.best(), 16);
        for seconds in [0.0, f64::NAN, f64::INFINITY, -1.0] {
            policy.observe(32, 32, Some(seconds));
        }
        assert_eq!(policy.timings[2], 0);
        policy.observe(4, 0, Some(0.001));
        policy.observe(4, 5, Some(0.001));
        assert_eq!(policy.samples[3], 0);
    }

    #[test]
    fn fragmented_work_converges_and_repeated_builds_load_each_shape_only_once() {
        let mut policy = BatchPolicy::default();
        let mut resident = Vec::new();
        let mut calls = 0;
        for _build in 0..8 {
            for remaining in [64, 1, 64, 3, 64, 4, 64, 16, 64, 2, 64, 32] {
                let size = policy.choose_resident(remaining, resident.iter().copied());
                let first = !resident.contains(&size);
                if first {
                    resident.push(size);
                }
                policy.observe(
                    size,
                    size.min(remaining),
                    (!first).then_some(size as f64 * if size == 16 { 0.001 } else { 0.003 }),
                );
                calls += 1;
                assert!(resident.len() <= RESIDENT_SHAPES);
            }
        }
        assert_eq!(resident.len(), SIZES.len());
        assert!(calls > 50);
        assert!(policy.samples.iter().all(|&samples| samples == 3));
        assert_eq!(policy.choose(64), 16);
        assert_eq!(policy.best(), 16);
    }

    #[test]
    fn short_tails_reuse_warmed_shapes_while_full_batches_still_tune() {
        let policy = BatchPolicy::default();
        assert_eq!(policy.choose_resident(1, [8, 16].into_iter()), 8);
        assert_eq!(policy.choose_resident(4, [8, 2].into_iter()), 8);
        assert_eq!(policy.choose_resident(2, [8, 2].into_iter()), 2);
        assert_eq!(policy.choose_resident(3, [].into_iter()), 4);
        assert_eq!(policy.choose_resident(64, [16, 32].into_iter()), 8);
    }

    #[test]
    fn learns_throughput_instead_of_preferring_largest_batch() {
        let mut policy = BatchPolicy::default();
        for size in SIZES {
            assert_eq!(policy.choose(64), size);
            for _ in 0..3 {
                policy.observe(
                    size,
                    size,
                    Some(size as f64 * if size == 16 { 0.001 } else { 0.003 }),
                );
            }
        }
        assert_eq!(policy.choose(64), 16);
        assert_eq!(policy.choose(3), 4);
        assert_eq!(policy.choose(1), 2);
        policy.failed(16);
        assert!(policy.choose(64) < 16);
        policy.failed(2);
        assert_eq!(policy.choose(64), 1);
    }

    #[test]
    fn small_jobs_do_not_wait_for_large_calibration_batches() {
        let mut policy = BatchPolicy::default();
        assert_eq!(policy.choose(4), 4);
        for _ in 0..3 {
            policy.observe(4, 4, Some(0.01));
        }
        assert_eq!(policy.choose(4), 2);
        for _ in 0..3 {
            policy.observe(2, 2, Some(0.01));
        }
        assert_eq!(policy.choose(4), 4);
        assert_eq!(policy.choose(64), 8);
    }
}
