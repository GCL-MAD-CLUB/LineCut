//! Online batch selection using real work, never synthetic inference probes.
pub(super) const SIZES: [usize; 5] = [8, 16, 32, 4, 2];
pub(super) const MAX_BATCH: usize = 32;

#[derive(Default)]
pub(super) struct BatchPolicy {
    samples: [usize; 5],
    seconds_per_frame: [f64; 5],
    blocked: [bool; 5],
}

impl BatchPolicy {
    pub(super) fn best(&self) -> usize {
        (0..SIZES.len())
            .filter(|&i| !self.blocked[i] && self.samples[i] > 0)
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
        // Warmup is excluded by the caller. Three full, real batches establish
        // a candidate; padding/decoder wait/session creation never bias ranking.
        for i in 0..SIZES.len() {
            if !self.blocked[i] && self.samples[i] < 3 && SIZES[i] <= remaining {
                return SIZES[i];
            }
        }
        let best = self.best();
        if remaining >= best {
            return best;
        }
        // Do not deliberately split a three-frame tail into 2+1, for example.
        remaining.max(2).next_power_of_two().min(MAX_BATCH)
    }

    pub(super) fn observe(&mut self, size: usize, seconds: f64) {
        if let Some(i) = SIZES.iter().position(|&s| s == size) {
            let sample = seconds / size as f64;
            if !sample.is_finite() || sample <= 0.0 {
                return;
            }
            self.seconds_per_frame[i] = if self.samples[i] == 0 {
                sample
            } else {
                self.seconds_per_frame[i] * 0.75 + sample * 0.25
            };
            self.samples[i] += 1;
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
    fn learns_throughput_instead_of_preferring_largest_batch() {
        let mut policy = BatchPolicy::default();
        for size in SIZES {
            assert_eq!(policy.choose(64), size);
            for _ in 0..3 {
                policy.observe(size, size as f64 * if size == 16 { 0.001 } else { 0.003 });
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
            policy.observe(4, 0.01);
        }
        assert_eq!(policy.choose(4), 2);
        for _ in 0..3 {
            policy.observe(2, 0.01);
        }
        assert_eq!(policy.choose(4), 4);
        assert_eq!(policy.choose(64), 8);
    }
}
