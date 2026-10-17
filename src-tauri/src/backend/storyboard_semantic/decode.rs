//! Bounded RGB streaming: decode the next batch while the current one infers.
use super::*;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

// Transport granularity is independent of device batch size. This allows the
// consumer to change batch immediately without restarting or reseeking FFmpeg.
const DECODE_CHUNK: usize = 2;

struct Registration {
    app: tauri::AppHandle,
    id: String,
}

impl Drop for Registration {
    fn drop(&mut self) {
        clear_running_ffmpeg(self.app.state::<AppState>().inner(), &self.id);
    }
}

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
    request: StreamRequest,
    sender: mpsc::Sender<Vec<u8>>,
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

pub(super) fn embed_stream(
    app: &tauri::AppHandle,
    program: &str,
    args: Vec<String>,
    task_id: &str,
    cancel: &Arc<AtomicBool>,
    count: usize,
    mut report: impl FnMut(usize),
) -> AppResult<Vec<Vec<f32>>> {
    let mut completed = 0;
    embed_stream_with(
        app,
        StreamRequest {
            program: program.to_owned(),
            args,
            task_id: task_id.to_owned(),
            cancel: Arc::clone(cancel),
            count,
            side: SIDE,
        },
        |remaining| preferred_batch(remaining, cancel),
        |rgb| {
            let vectors = embed(app, rgb, cancel)?;
            completed += vectors.len();
            report(completed);
            Ok(vectors)
        },
    )
}

fn embed_stream_with(
    app: &tauri::AppHandle,
    request: StreamRequest,
    mut choose: impl FnMut(usize) -> AppResult<usize>,
    mut infer: impl FnMut(&[u8]) -> AppResult<Vec<Vec<f32>>>,
) -> AppResult<Vec<Vec<f32>>> {
    let count = request.count;
    let side = request.side;
    let cancel = Arc::clone(&request.cancel);
    // Two small queued chunks plus at most MAX_BATCH inference frames. Device
    // tuning cannot accidentally grow the decoder's prefetch allocation.
    let (sender, mut receiver) = mpsc::channel(2);
    let producer = tauri::async_runtime::spawn(produce(app.clone(), request, sender));
    let mut embeddings = Vec::with_capacity(count);
    let outcome = consume(
        &mut receiver,
        count,
        side,
        &cancel,
        &mut choose,
        &mut infer,
        |batch| {
            embeddings.extend(batch);
            Ok(())
        },
    );
    // On inference failure, release a producer blocked on backpressure. Always
    // await its cleanup before returning or releasing the task's queue slot.
    drop(receiver);
    let decoded = tauri::async_runtime::block_on(producer).map_err(inference_error)?;
    outcome?;
    decoded?;
    if embeddings.len() != count {
        return Err(inference_error("Incomplete storyboard embeddings"));
    }
    Ok(embeddings)
}

pub(super) struct DecodeJob {
    pub(super) args: Vec<String>,
    pub(super) count: usize,
    pub(super) completed_shots: usize,
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
    let (sender, mut receiver) = mpsc::channel(2);
    let validated = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let completed = Arc::clone(&validated);
    let app = context.app.clone();
    let program = context.program.to_owned();
    let task_id = context.task_id.to_owned();
    let cancel = Arc::clone(context.cancel);
    let producer = tauri::async_runtime::spawn(async move {
        for job in jobs {
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
