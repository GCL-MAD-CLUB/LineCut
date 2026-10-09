use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::sync::Condvar;
use std::thread;
use std::time::Instant;

use super::*;

pub(super) const POLL_INTERVAL: Duration = Duration::from_millis(50);
const PREFETCH_BLOCKS: usize = 4;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct FrameBlock {
    pub task_id: String,
    pub frames: Vec<Vec<u8>>,
}

pub(super) enum ProducerMessage {
    Frames(FrameBlock),
    Finished(AppResult<()>),
}

#[derive(Default)]
struct ConsumerWake {
    generation: StdMutex<u64>,
    ready: Condvar,
}

impl ConsumerWake {
    fn generation(&self) -> u64 {
        *self
            .generation
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn notify(&self) {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *generation = generation.wrapping_add(1);
        self.ready.notify_one();
    }

    fn wait(&self, observed: u64, timeout: Duration) {
        let generation = self
            .generation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *generation == observed {
            let _ = self.ready.wait_timeout(generation, timeout);
        }
    }
}

pub(super) struct FrameSender {
    sender: SyncSender<ProducerMessage>,
    wake: Arc<ConsumerWake>,
}

impl FrameSender {
    pub fn send(&self, message: ProducerMessage) -> Result<(), mpsc::SendError<ProducerMessage>> {
        self.sender.send(message)?;
        self.wake.notify();
        Ok(())
    }
}

// The receiver can be closed independently of the inference thread. In
// particular, cancellation must unblock a producer even during model loading.
pub(super) struct FrameQueue {
    receiver: StdMutex<Option<Receiver<ProducerMessage>>>,
    wake: Arc<ConsumerWake>,
}

impl FrameQueue {
    fn new(wake: Arc<ConsumerWake>) -> (FrameSender, Arc<Self>) {
        let (sender, receiver) = mpsc::sync_channel(PREFETCH_BLOCKS);
        (
            FrameSender {
                sender,
                wake: wake.clone(),
            },
            Arc::new(Self {
                receiver: StdMutex::new(Some(receiver)),
                wake,
            }),
        )
    }

    fn try_recv(&self) -> Result<ProducerMessage, TryRecvError> {
        self.receiver
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .ok_or(TryRecvError::Disconnected)?
            .try_recv()
    }

    pub fn close(&self) {
        self.receiver
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        self.wake.notify();
    }
}

#[derive(Default)]
struct StoryboardFrames {
    window: VecDeque<Vec<u8>>,
    decoded_frames: usize,
    predictions: Vec<f32>,
}

impl StoryboardFrames {
    fn push_block(
        &mut self,
        frames: Vec<Vec<u8>>,
        cancel: &AtomicBool,
        infer: &mut impl FnMut(&VecDeque<Vec<u8>>) -> AppResult<Vec<f32>>,
        progress: &mut impl FnMut(usize, usize),
    ) -> AppResult<()> {
        // Keep the original per-frame assembly: a block boundary must never
        // change the 100-frame tensors, their order, or the 50 center outputs.
        for frame in frames {
            ensure_not_cancelled(cancel)?;
            if self.decoded_frames == 0 {
                for _ in 0..TRANSNET_CENTER_START {
                    self.window.push_back(frame.clone());
                }
            }
            self.decoded_frames += 1;
            self.window.push_back(frame);
            self.run_ready(cancel, infer, progress)?;
        }
        Ok(())
    }

    fn run_ready(
        &mut self,
        cancel: &AtomicBool,
        infer: &mut impl FnMut(&VecDeque<Vec<u8>>) -> AppResult<Vec<f32>>,
        progress: &mut impl FnMut(usize, usize),
    ) -> AppResult<()> {
        while self.window.len() >= TRANSNET_WINDOW_FRAMES {
            ensure_not_cancelled(cancel)?;
            self.predictions.extend(infer(&self.window)?);
            for _ in 0..TRANSNET_STRIDE_FRAMES {
                self.window.pop_front();
            }
            progress(self.predictions.len(), self.decoded_frames);
        }
        Ok(())
    }

    fn finish(
        &mut self,
        cancel: &AtomicBool,
        infer: &mut impl FnMut(&VecDeque<Vec<u8>>) -> AppResult<Vec<f32>>,
        progress: &mut impl FnMut(usize, usize),
    ) -> AppResult<()> {
        let last_frame = self
            .window
            .back()
            .ok_or_else(|| {
                app_error(
                    ErrorCode::StoryboardFrameDecodeFailed,
                    "FFmpeg decoded no frames for storyboard detection",
                )
            })?
            .clone();
        while self.predictions.len() < self.decoded_frames {
            ensure_not_cancelled(cancel)?;
            while self.window.len() < TRANSNET_WINDOW_FRAMES {
                self.window.push_back(last_frame.clone());
            }
            self.run_ready(cancel, infer, progress)?;
        }
        self.predictions.truncate(self.decoded_frames);
        Ok(())
    }
}

type PredictionResult = AppResult<(usize, Vec<f32>, String)>;

pub(super) struct InferenceTask {
    task_id: String,
    queue: Arc<FrameQueue>,
    cancel: Arc<AtomicBool>,
    frames: StoryboardFrames,
    progress: Option<StoryboardProgressReporter>,
    completion: Option<tokio::sync::oneshot::Sender<PredictionResult>>,
}

impl InferenceTask {
    pub fn new(
        task_id: String,
        queue: Arc<FrameQueue>,
        cancel: Arc<AtomicBool>,
        progress: Option<StoryboardProgressReporter>,
    ) -> (Self, tokio::sync::oneshot::Receiver<PredictionResult>) {
        let (completion, receiver) = tokio::sync::oneshot::channel();
        (
            Self {
                task_id,
                queue,
                cancel,
                frames: StoryboardFrames::default(),
                progress,
                completion: Some(completion),
            },
            receiver,
        )
    }

    fn complete(&mut self, result: PredictionResult) {
        self.queue.close();
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(result);
        }
    }

    fn step(
        &mut self,
        provider: &str,
        infer: &mut impl FnMut(&VecDeque<Vec<u8>>) -> AppResult<Vec<f32>>,
    ) -> AppResult<bool> {
        ensure_not_cancelled(&self.cancel)?;
        if self
            .completion
            .as_ref()
            .is_some_and(|sender| sender.is_closed())
        {
            return Err(app_error(
                ErrorCode::TaskCancelled,
                "Storyboard request was dropped",
            ));
        }
        let message = match self.queue.try_recv() {
            Ok(message) => message,
            Err(TryRecvError::Empty) => return Ok(false),
            Err(TryRecvError::Disconnected) => {
                return Err(app_error(
                    ErrorCode::StoryboardFrameDecodeFailed,
                    "Storyboard producer stopped without a completion message",
                ))
            }
        };
        let progress = &mut self.progress;
        let mut report = |predicted, decoded| {
            if let Some(progress) = progress {
                progress.report_predicted(predicted, decoded);
            }
        };
        match message {
            ProducerMessage::Frames(block) => {
                if block.task_id != self.task_id {
                    return Err(app_error(
                        ErrorCode::StoryboardInferenceFailed,
                        "Storyboard frame block belongs to another task",
                    ));
                }
                self.frames
                    .push_block(block.frames, &self.cancel, infer, &mut report)?;
            }
            ProducerMessage::Finished(result) => {
                result?;
                self.frames.finish(&self.cancel, infer, &mut report)?;
                ensure_not_cancelled(&self.cancel)?;
                if let Some(progress) = &mut self.progress {
                    progress.report_prediction_complete();
                }
                let predictions = std::mem::take(&mut self.frames.predictions);
                self.complete(Ok((
                    self.frames.decoded_frames,
                    predictions,
                    provider.to_string(),
                )));
            }
        }
        Ok(true)
    }
}

impl Drop for InferenceTask {
    fn drop(&mut self) {
        self.queue.close();
    }
}

pub(super) struct StoryboardConsumer {
    incoming: StdMutex<Option<Sender<InferenceTask>>>,
    wake: Arc<ConsumerWake>,
    idle_timeout: Duration,
}

impl Default for StoryboardConsumer {
    fn default() -> Self {
        Self {
            incoming: StdMutex::new(None),
            wake: Arc::default(),
            idle_timeout: SESSION_IDLE_TIMEOUT,
        }
    }
}

impl StoryboardConsumer {
    pub fn queue(&self) -> (FrameSender, Arc<FrameQueue>) {
        FrameQueue::new(self.wake.clone())
    }

    pub fn submit(
        self: &Arc<Self>,
        task: InferenceTask,
        runtime: StoryboardRuntimePaths,
    ) -> AppResult<()> {
        self.submit_with(
            task,
            move || {
                let started = Instant::now();
                init_storyboard_ort(&runtime)?;
                let (session, provider) = create_model_session(&runtime.model)?;
                let model = TransnetSession::new(session)?;
                tracing::info!(
                    provider,
                    initialization_ms = started.elapsed().as_millis() as u64,
                    "Storyboard inference session ready"
                );
                Ok((model, provider))
            },
            run_transnet_window,
        )
    }

    fn submit_with<M: 'static>(
        self: &Arc<Self>,
        task: InferenceTask,
        initialize: impl FnOnce() -> AppResult<(M, String)> + Send + 'static,
        mut predict: impl FnMut(&mut M, &VecDeque<Vec<u8>>) -> AppResult<Vec<f32>> + Send + 'static,
    ) -> AppResult<()> {
        let mut incoming = self
            .incoming
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(sender) = incoming.as_ref() {
            sender.send(task).map_err(|_| {
                app_error(
                    ErrorCode::BlockingTaskFailed,
                    "Storyboard consumer stopped while accepting a task",
                )
            })?;
            self.wake.notify();
            return Ok(());
        }
        let (sender, receiver) = mpsc::channel();
        sender.send(task).map_err(|_| {
            app_error(
                ErrorCode::BlockingTaskFailed,
                "Failed to enqueue the first storyboard task",
            )
        })?;
        let consumer = self.clone();
        thread::Builder::new()
            .name("storyboard-inference".into())
            .spawn(move || {
                // Session is created, used and dropped exclusively on this thread.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut model = Some(initialize());
                    let mut tasks = VecDeque::<InferenceTask>::new();
                    let mut idle_since = None;
                    loop {
                        let observed = consumer.wake.generation();
                        tasks.extend(receiver.try_iter());
                        if tasks.is_empty() {
                            let idle = *idle_since.get_or_insert_with(Instant::now);
                            let remaining = consumer.idle_timeout.saturating_sub(idle.elapsed());
                            // Keep a successful session across frontend queue refills
                            // and nearby user requests. Failed initialization must
                            // retire immediately so the next request can retry.
                            if model.as_ref().is_some_and(Result::is_ok) && !remaining.is_zero() {
                                consumer.wake.wait(observed, remaining);
                                continue;
                            }
                            // Admission and retirement share this lock. Drop the
                            // Session before allowing a replacement worker to start.
                            let mut incoming = consumer
                                .incoming
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            tasks.extend(receiver.try_iter());
                            if tasks.is_empty() {
                                drop(model.take());
                                *incoming = None;
                                return;
                            }
                        }
                        idle_since = None;
                        let mut did_work = false;
                        for _ in 0..tasks.len() {
                            let mut task = tasks.pop_front().expect("round-robin task exists");
                            let result = match model.as_mut().expect("model lives until retirement")
                            {
                                Ok((model, provider)) => {
                                    task.step(provider, &mut |window| predict(model, window))
                                }
                                Err(error) => Err(error.clone()),
                            };
                            match result {
                                Ok(worked) => did_work |= worked,
                                Err(error) => {
                                    task.complete(Err(error));
                                    did_work = true;
                                }
                            }
                            if task.completion.is_some() {
                                tasks.push_back(task);
                            }
                        }
                        if !tasks.is_empty() && !did_work {
                            // Never wait indefinitely: cancellation also needs to
                            // work when all producers are blocked reading stdout.
                            consumer.wake.wait(observed, POLL_INTERVAL);
                        }
                    }
                }));
                if let Err(panic) = outcome {
                    let mut incoming = consumer
                        .incoming
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    *incoming = None;
                    drop(incoming);
                    let panic_message = panic
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
                        .unwrap_or("non-string panic payload");
                    tracing::error!(panic_message, "Storyboard consumer panicked");
                }
            })
            .map_err(|error| {
                app_error(
                    ErrorCode::BlockingTaskFailed,
                    format!("Failed to start storyboard consumer: {error}"),
                )
            })?;
        *incoming = Some(sender);
        Ok(())
    }
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;
