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

async fn produce(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    task_id: String,
    cancel: Arc<AtomicBool>,
    count: usize,
    sender: mpsc::Sender<Vec<u8>>,
) -> AppResult<()> {
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
            let mut batch = vec![0u8; (count - start).min(DECODE_CHUNK) * SIDE * SIDE * 3];
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
) -> AppResult<Vec<Vec<f32>>> {
    // Two small queued chunks plus at most MAX_BATCH inference frames. Device
    // tuning cannot accidentally grow the decoder's prefetch allocation.
    let (sender, mut receiver) = mpsc::channel(2);
    let producer = tauri::async_runtime::spawn(produce(
        app.clone(),
        program.to_owned(),
        args,
        task_id.to_owned(),
        Arc::clone(cancel),
        count,
        sender,
    ));
    let outcome = (|| {
        let mut embeddings = Vec::with_capacity(count);
        let mut rgb = Vec::with_capacity(batch::MAX_BATCH * SIDE * SIDE * 3);
        let mut pending = Vec::new();
        let mut pending_offset = 0;
        while embeddings.len() < count {
            ensure_not_cancelled(cancel)?;
            let target =
                preferred_batch(count - embeddings.len(), cancel)?.min(count - embeddings.len());
            rgb.clear();
            while rgb.len() < target * SIDE * SIDE * 3 {
                if pending_offset == pending.len() {
                    pending = receiver
                        .blocking_recv()
                        .ok_or_else(|| inference_error("Incomplete storyboard RGB stream"))?;
                    pending_offset = 0;
                }
                let take =
                    (target * SIDE * SIDE * 3 - rgb.len()).min(pending.len() - pending_offset);
                rgb.extend_from_slice(&pending[pending_offset..pending_offset + take]);
                pending_offset += take;
            }
            // The cursor also preserves the second frame when memory-pressure
            // recovery must fall back to single-row execution.
            if rgb.len() != target * SIDE * SIDE * 3 {
                return Err(inference_error("Misaligned storyboard RGB batch"));
            }
            embeddings.extend(embed(app, &rgb, cancel)?);
        }
        // Keep the receiver alive until the producer validates EOF and exits.
        // Otherwise sender.closed() could kill a successfully decoded process.
        if pending_offset != pending.len() || receiver.blocking_recv().is_some() {
            return Err(inference_error("Unexpected extra storyboard RGB batch"));
        }
        Ok(embeddings)
    })();
    // On inference failure, release a producer blocked on backpressure. Always
    // await its cleanup before returning or releasing the task's queue slot.
    drop(receiver);
    let decoded = tauri::async_runtime::block_on(producer).map_err(inference_error)?;
    let embeddings = outcome?;
    decoded?;
    if embeddings.len() != count {
        return Err(inference_error("Incomplete storyboard embeddings"));
    }
    Ok(embeddings)
}
