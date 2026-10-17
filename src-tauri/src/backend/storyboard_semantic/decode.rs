//! Bounded RGB streaming: decode the next batch while the current one infers.
use super::*;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

// Transport granularity is independent of device batch size. This allows the
// consumer to change batch immediately without restarting or reseeking FFmpeg.
const DECODE_CHUNK: usize = 2;
const QUEUED_CHUNKS: usize = batch::MAX_BATCH / DECODE_CHUNK;

struct Registration {
    app: tauri::AppHandle,
    id: String,
}

impl Drop for Registration {
    fn drop(&mut self) {
        clear_running_ffmpeg(self.app.state::<AppState>().inner(), &self.id);
    }
}

#[derive(Clone)]
struct StreamRequest {
    program: String,
    args: Vec<String>,
    task_id: String,
    cancel: Arc<AtomicBool>,
    count: usize,
    side: usize,
}

async fn produce(
    app: tauri::AppHandle,
    mut request: StreamRequest,
    sender: mpsc::Sender<Vec<u8>>,
) -> AppResult<()> {
    let mut emitted = 0;
    let result = produce_attempt(app.clone(), request.clone(), sender.clone(), &mut emitted).await;
    if let Err(error) = result {
        ensure_not_cancelled(&request.cancel)?;
        // Unsupported hardware/codec combinations may fail before the first
        // frame. Retrying is safe only before any pixels reached inference.
        if !sender.is_closed() && software_retry_args(&mut request.args, emitted) {
            tracing::warn!(%error, "Retrying storyboard decode without hardware acceleration");
            return produce_attempt(app, request, sender, &mut emitted).await;
        }
        return Err(error);
    }
    Ok(())
}

fn software_retry_args(args: &mut Vec<String>, emitted: usize) -> bool {
    if emitted != 0 {
        return false;
    }
    let Some(position) = args
        .windows(2)
        .position(|args| args == ["-hwaccel", "d3d11va"])
    else {
        return false;
    };
    args.drain(position..position + 2);
    true
}

async fn produce_attempt(
    app: tauri::AppHandle,
    request: StreamRequest,
    sender: mpsc::Sender<Vec<u8>>,
    emitted: &mut usize,
) -> AppResult<()> {
    let StreamRequest {
        program,
        args,
        task_id,
        cancel,
        count,
        side,
    } = request;
    ensure_not_cancelled(&cancel)?;
    let mut child = hidden_command(&program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| app_error(ErrorCode::ExternalToolStartFailed, e.to_string()))?;
    let registration = Registration {
        app,
        id: Uuid::new_v4().to_string(),
    };
    if let Err(error) = register_running_ffmpeg(
        registration.app.state::<AppState>().inner(),
        registration.id.clone(),
        task_id,
        Arc::clone(&cancel),
        child.id(),
        Vec::new(),
    ) {
        let _ = child.kill().await;
        return Err(error);
    }
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| inference_error("Missing selection RGB pipe"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| inference_error("Missing selection diagnostic pipe"))?;
    // Drain concurrently so a full diagnostic pipe cannot stall the RGB reader.
    let diagnostics = tauri::async_runtime::spawn(async move {
        let mut text = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let n = stderr.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            let keep = n.min(65536usize.saturating_sub(text.len()));
            text.extend_from_slice(&buffer[..keep]);
        }
        Ok::<_, std::io::Error>(text)
    });
    let read = Box::pin(async {
        for start in (0..count).step_by(DECODE_CHUNK) {
            ensure_not_cancelled(&cancel)?;
            let mut batch = vec![0u8; (count - start).min(DECODE_CHUNK) * side * side * 3];
            stdout
                .read_exact(&mut batch)
                .await
                .map_err(|e| inference_error(format!("Incomplete storyboard frame decode: {e}")))?;
            sender
                .send(batch)
                .await
                .map_err(|_| inference_error("Selection inference receiver closed"))?;
            *emitted += (count - start).min(DECODE_CHUNK);
        }
        let mut extra = [0u8; 1];
        if stdout.read(&mut extra).await.map_err(inference_error)? != 0 {
            return Err(inference_error("Unexpected extra storyboard frame data"));
        }
        Ok(())
    });
    // Closing the consumer must interrupt even a long seek/read, not merely the
    // next send. Cancellation of read_exact is safe here: the child is killed.
    let read_result = match futures::future::select(read, Box::pin(sender.closed())).await {
        futures::future::Either::Left((result, _)) => result,
        futures::future::Either::Right(_) => {
            Err(inference_error("Selection inference receiver closed"))
        }
    };
    if read_result.is_err() {
        let _ = child.kill().await;
    }
    let status = child.wait().await;
    let diagnostics = diagnostics
        .await
        .map_err(inference_error)?
        .map_err(inference_error)?;
    ensure_not_cancelled(&cancel)?;
    let status = status.map_err(|e| app_error(ErrorCode::ExternalToolWaitFailed, e.to_string()))?;
    if !status.success() {
        return Err(app_error(
            ErrorCode::ExternalToolExecutionFailed,
            format!(
                "Storyboard decode failed: {}",
                String::from_utf8_lossy(&diagnostics)
            ),
        ));
    }
    read_result
}

pub(super) struct DecodeJob {
    pub(super) args: Vec<String>,
    pub(super) count: usize,
    pub(super) completed_shots: usize,
    pub(super) rgb: Option<Vec<u8>>,
}

/// Prefetch across shots and media while selection and the other encoder run.
/// Validation travels separately: no cache is committed before the corresponding
/// FFmpeg process exits successfully, even when its RGB has already been used.
pub(super) struct FrameStream {
    receiver: mpsc::Receiver<Vec<u8>>,
    validations: std::sync::mpsc::Receiver<AppResult<usize>>,
    producer: Option<tauri::async_runtime::JoinHandle<AppResult<()>>>,
    pending: Vec<u8>,
    offset: usize,
    consumed: usize,
    validated: usize,
}

impl FrameStream {
    pub(super) fn start(context: StreamContext<'_>, jobs: Vec<DecodeJob>) -> Self {
        let (sender, receiver) = mpsc::channel(QUEUED_CHUNKS);
        let (validated, validations) = std::sync::mpsc::channel();
        let app = context.app.clone();
        let program = context.program.to_owned();
        let task_id = context.task_id.to_owned();
        let cancel = Arc::clone(context.cancel);
        let producer = tauri::async_runtime::spawn(async move {
            for job in jobs {
                let outcome = produce(
                    app.clone(),
                    StreamRequest {
                        program: program.clone(),
                        args: job.args,
                        task_id: task_id.clone(),
                        cancel: Arc::clone(&cancel),
                        count: job.count,
                        side: 256,
                    },
                    sender.clone(),
                )
                .await;
                match outcome {
                    Ok(()) => {
                        let _ = validated.send(Ok(job.count));
                    }
                    Err(error) => {
                        let _ = validated.send(Err(error.clone()));
                        return Err(error);
                    }
                }
            }
            Ok(())
        });
        Self {
            receiver,
            validations,
            producer: Some(producer),
            pending: Vec::new(),
            offset: 0,
            consumed: 0,
            validated: 0,
        }
    }

    pub(super) fn append_frames(
        &mut self,
        rgb: &mut Vec<u8>,
        count: usize,
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let mut bytes = count
            .checked_mul(256 * 256 * 3)
            .ok_or_else(|| inference_error("Storyboard RGB allocation overflow"))?;
        while bytes > 0 {
            ensure_not_cancelled(cancel)?;
            if self.offset == self.pending.len() {
                self.pending = match self.receiver.blocking_recv() {
                    Some(pixels) => pixels,
                    None => {
                        // Preserve FFmpeg's diagnostic if it closed the pipe.
                        while let Ok(result) = self.validations.try_recv() {
                            self.validated += result?;
                        }
                        return Err(inference_error("Incomplete storyboard RGB stream"));
                    }
                };
                self.offset = 0;
                if self.pending.is_empty() || self.pending.len() % (256 * 256 * 3) != 0 {
                    return Err(inference_error("Misaligned storyboard RGB stream"));
                }
            }
            let take = bytes.min(self.pending.len() - self.offset);
            rgb.extend_from_slice(&self.pending[self.offset..self.offset + take]);
            self.offset += take;
            bytes -= take;
        }
        self.consumed += count;
        Ok(())
    }

    pub(super) fn validate(&mut self, cancel: &AtomicBool) -> AppResult<()> {
        while self.validated < self.consumed {
            ensure_not_cancelled(cancel)?;
            match self.validations.recv_timeout(Duration::from_millis(25)) {
                Ok(result) => self.validated += result?,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(error) => return Err(inference_error(error)),
            }
        }
        Ok(())
    }
}

impl Drop for FrameStream {
    fn drop(&mut self) {
        self.receiver.close();
        if let Some(producer) = self.producer.take() {
            // Closing the receiver interrupts FFmpeg even while it is seeking.
            let _ = tauri::async_runtime::block_on(producer);
        }
    }
}

pub(super) struct StreamContext<'a> {
    pub(super) app: &'a tauri::AppHandle,
    pub(super) program: &'a str,
    pub(super) task_id: &'a str,
    pub(super) cancel: &'a Arc<AtomicBool>,
}

/// A shared, bounded stream fills inference batches across storyboard and seek
/// boundaries. No media-wide RGB or duplicate vector result is retained.
pub(super) fn embed_jobs(
    context: StreamContext<'_>,
    jobs: Vec<DecodeJob>,
    side: usize,
    choose: impl FnMut(usize) -> AppResult<usize>,
    infer: impl FnMut(&[u8]) -> AppResult<Vec<Vec<f32>>>,
    mut publish: impl FnMut(&[Vec<f32>], usize) -> AppResult<()>,
) -> AppResult<()> {
    let started = std::time::Instant::now();
    let decode_jobs = jobs.len();
    let count = jobs.iter().map(|job| job.count).sum();
    let (sender, mut receiver) = mpsc::channel(QUEUED_CHUNKS);
    let validated = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let completed = Arc::clone(&validated);
    let app = context.app.clone();
    let program = context.program.to_owned();
    let task_id = context.task_id.to_owned();
    let cancel = Arc::clone(context.cancel);
    let producer = tauri::async_runtime::spawn(async move {
        for job in jobs {
            if let Some(rgb) = job.rgb {
                if rgb.len() != job.count * side * side * 3 {
                    return Err(inference_error("Invalid cached storyboard RGB"));
                }
                for chunk in rgb.chunks(DECODE_CHUNK * side * side * 3) {
                    ensure_not_cancelled(&cancel)?;
                    sender
                        .send(chunk.to_vec())
                        .await
                        .map_err(|_| inference_error("Selection inference receiver closed"))?;
                }
            } else {
                produce(
                    app.clone(),
                    StreamRequest {
                        program: program.clone(),
                        args: job.args,
                        task_id: task_id.clone(),
                        cancel: Arc::clone(&cancel),
                        count: job.count,
                        side,
                    },
                    sender.clone(),
                )
                .await?;
            }
            completed.store(job.completed_shots, Ordering::SeqCst);
        }
        Ok::<_, AppError>(())
    });
    let outcome = consume(
        &mut receiver,
        count,
        side,
        context.cancel,
        choose,
        infer,
        |batch| publish(&batch, validated.load(Ordering::SeqCst)),
    );
    drop(receiver);
    let decoded = tauri::async_runtime::block_on(producer).map_err(inference_error)?;
    outcome?;
    decoded?;
    publish(&[], validated.load(Ordering::SeqCst))?;
    tracing::info!(
        frames = count,
        decode_jobs,
        elapsed_ms = started.elapsed().as_millis(),
        "Completed storyboard media encoding stream"
    );
    Ok(())
}

fn consume(
    receiver: &mut mpsc::Receiver<Vec<u8>>,
    count: usize,
    side: usize,
    cancel: &AtomicBool,
    mut choose: impl FnMut(usize) -> AppResult<usize>,
    mut infer: impl FnMut(&[u8]) -> AppResult<Vec<Vec<f32>>>,
    mut publish: impl FnMut(Vec<Vec<f32>>) -> AppResult<()>,
) -> AppResult<()> {
    let mut completed = 0;
    let mut rgb = Vec::with_capacity(batch::MAX_BATCH * side * side * 3);
    let mut pending = Vec::new();
    let mut pending_offset = 0;
    while completed < count {
        ensure_not_cancelled(cancel)?;
        let target = choose(count - completed)?.min(count - completed);
        if target == 0 || target > batch::MAX_BATCH {
            return Err(inference_error("Invalid storyboard inference batch size"));
        }
        rgb.clear();
        while rgb.len() < target * side * side * 3 {
            if pending_offset == pending.len() {
                pending = receiver
                    .blocking_recv()
                    .ok_or_else(|| inference_error("Incomplete storyboard RGB stream"))?;
                pending_offset = 0;
                if pending.is_empty() || pending.len() % (side * side * 3) != 0 {
                    return Err(inference_error("Misaligned storyboard RGB batch"));
                }
            }
            let take = (target * side * side * 3 - rgb.len()).min(pending.len() - pending_offset);
            rgb.extend_from_slice(&pending[pending_offset..pending_offset + take]);
            pending_offset += take;
        }
        let vectors = infer(&rgb)?;
        if vectors.len() != target {
            return Err(inference_error("Incomplete storyboard embeddings"));
        }
        publish(vectors)?;
        completed += target;
    }
    if pending_offset != pending.len() || receiver.blocking_recv().is_some() {
        return Err(inference_error("Unexpected extra storyboard RGB batch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_stream_reuses_chunks_across_shots_and_validates_process_exit_separately() {
        const FRAME: usize = 256 * 256 * 3;
        let (sender, receiver) = mpsc::channel(QUEUED_CHUNKS);
        let (validated, validations) = std::sync::mpsc::channel();
        sender
            .blocking_send([vec![1; FRAME], vec![2; FRAME]].concat())
            .unwrap();
        sender.blocking_send(vec![3; FRAME]).unwrap();
        drop(sender);
        let mut stream = FrameStream {
            receiver,
            validations,
            producer: None,
            pending: Vec::new(),
            offset: 0,
            consumed: 0,
            validated: 0,
        };
        let cancel = AtomicBool::new(false);
        let mut shot = Vec::new();
        stream.append_frames(&mut shot, 1, &cancel).unwrap();
        assert_eq!(shot, vec![1; FRAME]);
        assert_eq!(stream.validated, 0);
        shot.clear();
        stream.append_frames(&mut shot, 2, &cancel).unwrap();
        assert_eq!(shot, [vec![2; FRAME], vec![3; FRAME]].concat());
        validated
            .send(Err(inference_error("decoder failed after emitting RGB")))
            .unwrap();
        assert!(stream
            .validate(&cancel)
            .unwrap_err()
            .to_string()
            .contains("decoder failed"));
        assert_eq!(stream.validated, 0);
        validated.send(Ok(3)).unwrap();
        stream.validate(&cancel).unwrap();
        assert_eq!(stream.validated, 3);
    }

    #[test]
    fn queue_prefetches_a_full_inference_batch_and_close_releases_backpressure() {
        let (sender, mut receiver) = mpsc::channel(QUEUED_CHUNKS);
        for _ in 0..QUEUED_CHUNKS {
            sender.try_send(vec![0; DECODE_CHUNK * 3]).unwrap();
        }
        assert_eq!(receiver.len() * DECODE_CHUNK, batch::MAX_BATCH);
        assert!(sender.try_send(vec![0; 6]).is_err());
        receiver.close();
        assert!(sender.is_closed());
    }

    fn stream(chunks: &[usize]) -> (mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
        let (sender, receiver) = mpsc::channel(2);
        let chunks = chunks.to_vec();
        let producer = std::thread::spawn(move || {
            let mut frame = 0u8;
            for count in chunks {
                let mut rgb = Vec::new();
                for _ in 0..count {
                    rgb.extend_from_slice(&[frame; 3]);
                    frame += 1;
                }
                if sender.blocking_send(rgb).is_err() {
                    break;
                }
            }
        });
        (receiver, producer)
    }

    #[test]
    fn batches_cross_chunks_and_seek_boundaries_and_preserve_single_frame_tails() {
        for sizes in [vec![4, 4, 1], vec![4, 1, 2, 2]] {
            let (mut receiver, producer) = stream(&[2, 1, 2, 1, 2, 1]);
            let cancel = AtomicBool::new(false);
            let mut choices = sizes.iter();
            let mut batches = Vec::new();
            let mut output = Vec::new();
            consume(
                &mut receiver,
                9,
                1,
                &cancel,
                |_| Ok(*choices.next().unwrap()),
                |rgb| {
                    batches.push(rgb.len() / 3);
                    Ok(rgb
                        .chunks_exact(3)
                        .map(|frame| {
                            assert_eq!(frame, &[frame[0]; 3]);
                            vec![f32::from(frame[0])]
                        })
                        .collect())
                },
                |vectors| {
                    output.extend(vectors);
                    Ok(())
                },
            )
            .unwrap();
            producer.join().unwrap();
            assert_eq!(batches, sizes);
            assert_eq!(
                output,
                (0..9).map(|frame| vec![frame as f32]).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn inference_failure_releases_a_producer_blocked_on_backpressure() {
        let (mut receiver, producer) = stream(&[2; 20]);
        let cancel = AtomicBool::new(false);
        let result = consume(
            &mut receiver,
            40,
            1,
            &cancel,
            |_| Ok(4),
            |_| Err(inference_error("inference failed")),
            |_| panic!("failed inference must not be published"),
        );
        assert!(result.is_err());
        drop(receiver);
        producer.join().unwrap();
    }

    #[test]
    fn missing_extra_or_misaligned_rgb_is_rejected() {
        for chunks in [vec![1], vec![2]] {
            let (mut receiver, producer) = stream(&chunks);
            let cancel = AtomicBool::new(false);
            assert!(consume(
                &mut receiver,
                if chunks == [1] { 2 } else { 1 },
                1,
                &cancel,
                |_| Ok(1),
                |_| Ok(vec![vec![1.0]]),
                |_| Ok(())
            )
            .is_err());
            drop(receiver);
            producer.join().unwrap();
        }
        let (sender, mut receiver) = mpsc::channel(2);
        sender.blocking_send(vec![0; 2]).unwrap();
        drop(sender);
        assert!(consume(
            &mut receiver,
            1,
            1,
            &AtomicBool::new(false),
            |_| Ok(1),
            |_| panic!("malformed RGB must not reach inference"),
            |_| Ok(())
        )
        .is_err());
    }
}
#[test]
fn hardware_decode_retry_is_allowed_only_before_any_pixels_are_published() {
    let hardware = vec![
        "-hwaccel".into(),
        "d3d11va".into(),
        "-i".into(),
        "media.mp4".into(),
    ];
    let mut args = hardware.clone();
    assert!(!software_retry_args(&mut args, 1));
    assert_eq!(args, hardware);
    assert!(software_retry_args(&mut args, 0));
    assert_eq!(args, ["-i", "media.mp4"]);
    assert!(!software_retry_args(&mut args, 0));
}
