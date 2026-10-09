//! CPU budgets shared by FFmpeg callers.

const FFMPEG_MAX_PROCESSING_THREADS: usize = 16;

pub(crate) fn available_cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

/// Splits the CPU budget between concurrent FFmpeg processes. Keep the upper
/// bound aligned with the export path so an unusually high core count does not
/// make one short-lived helper process monopolize the machine.
pub(crate) fn ffmpeg_worker_thread_budget(worker_count: usize) -> usize {
    let worker_count = worker_count.max(1);
    let cpu_threads = available_cpu_threads();
    ((cpu_threads + worker_count.saturating_sub(1)) / worker_count)
        .clamp(1, FFMPEG_MAX_PROCESSING_THREADS)
}

pub(crate) fn append_ffmpeg_processing_thread_args(args: &mut Vec<String>, threads: usize) {
    let threads = threads.clamp(1, FFMPEG_MAX_PROCESSING_THREADS).to_string();
    args.extend([
        "-threads".to_string(),
        threads.clone(),
        "-filter_threads".to_string(),
        threads.clone(),
        "-filter_complex_threads".to_string(),
        threads,
    ]);
}

pub(crate) fn append_ffmpeg_video_output_thread_args(args: &mut Vec<String>, threads: usize) {
    args.extend([
        "-threads:v".to_string(),
        threads.clamp(1, FFMPEG_MAX_PROCESSING_THREADS).to_string(),
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processing_thread_arguments_cover_input_filters_and_software_output() {
        let mut args = Vec::new();
        append_ffmpeg_processing_thread_args(&mut args, usize::MAX);
        append_ffmpeg_video_output_thread_args(&mut args, usize::MAX);
        assert_eq!(
            args,
            [
                "-threads",
                "16",
                "-filter_threads",
                "16",
                "-filter_complex_threads",
                "16",
                "-threads:v",
                "16",
            ]
        );
    }
}
