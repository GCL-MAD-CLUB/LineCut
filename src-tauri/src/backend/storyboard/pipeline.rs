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
        provider: &SessionProvider,
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
                let session = OnnxModel::load(&runtime.model, &[], |detail| {
                    app_error(ErrorCode::StoryboardInferenceFailed, detail)
                })?;
                let provider = session.provider();
                let model = TransnetSession::new(session)?;
                tracing::info!(
                    provider = %provider,
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
        initialize: impl FnOnce() -> AppResult<(M, SessionProvider)> + Send + 'static,
        mut predict: impl FnMut(&mut M, &VecDeque<Vec<u8>>, &AtomicBool) -> AppResult<Vec<f32>>
            + Send
            + 'static,
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
                                    let cancel = task.cancel.clone();
                                    task.step(provider, &mut |window| {
                                        predict(model, window, &cancel)
                                    })
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
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    use super::*;

    trait PublicErrorCode {
        fn code(&self) -> String;
    }

    impl PublicErrorCode for AppError {
        fn code(&self) -> String {
            serde_json::to_value(self).unwrap()["code"]
                .as_str()
                .unwrap()
                .to_string()
        }
    }

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    fn test_consumer() -> Arc<StoryboardConsumer> {
        Arc::new(StoryboardConsumer {
            idle_timeout: Duration::from_millis(50),
            ..StoryboardConsumer::default()
        })
    }

    fn frames(marker: u8, count: usize) -> Vec<Vec<u8>> {
        (0..count)
            .map(|index| vec![marker, (index % 256) as u8, (index / 256) as u8])
            .collect()
    }

    fn predict(window: &VecDeque<Vec<u8>>) -> AppResult<Vec<f32>> {
        // All 100 frames affect the output, so misplaced context is observable.
        let context = window
            .iter()
            .flatten()
            .map(|byte| *byte as u64)
            .sum::<u64>();
        Ok(window
            .iter()
            .skip(25)
            .take(50)
            .map(|frame| ((context + frame[1] as u64 + frame[2] as u64 * 256) % 97) as f32 / 96.0)
            .collect())
    }

    /// Window snapshots, predictions, and `(predicted, decoded)` progress reports.
    type SerialReference = (Vec<VecDeque<Vec<u8>>>, Vec<f32>, Vec<(usize, usize)>);

    fn serial_reference(frames: &[Vec<u8>]) -> SerialReference {
        // Independent copy of the pre-refactor, frame-at-a-time algorithm.
        let mut window = VecDeque::new();
        let mut windows = Vec::new();
        let mut predictions = Vec::new();
        let mut progress = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            if index == 0 {
                window.extend(std::iter::repeat_n(frame.clone(), 25));
            }
            window.push_back(frame.clone());
            while window.len() >= 100 {
                windows.push(window.clone());
                predictions.extend(predict(&window).unwrap());
                for _ in 0..50 {
                    window.pop_front();
                }
                progress.push((predictions.len(), index + 1));
            }
        }
        while predictions.len() < frames.len() {
            while window.len() < 100 {
                window.push_back(frames.last().unwrap().clone());
            }
            windows.push(window.clone());
            predictions.extend(predict(&window).unwrap());
            for _ in 0..50 {
                window.pop_front();
            }
            progress.push((predictions.len(), frames.len()));
        }
        predictions.truncate(frames.len());
        (windows, predictions, progress)
    }

    #[test]
    fn chunked_windows_predictions_progress_and_cuts_match_serial_reference() {
        for count in [
            1, 24, 25, 26, 49, 50, 51, 74, 75, 76, 99, 100, 101, 124, 125, 126, 149, 150, 151, 199,
            200, 201, 999,
        ] {
            let frames = frames(7, count);
            let (expected_windows, expected_predictions, expected_progress) =
                serial_reference(&frames);
            for block_size in [1, 7, 50] {
                let mut state = StoryboardFrames::default();
                let mut windows = Vec::new();
                let mut progress = Vec::new();
                let mut infer = |window: &VecDeque<Vec<u8>>| {
                    windows.push(window.clone());
                    predict(window)
                };
                let mut report = |predicted, decoded| progress.push((predicted, decoded));
                let cancel = AtomicBool::new(false);
                for block in frames.chunks(block_size) {
                    state
                        .push_block(block.to_vec(), &cancel, &mut infer, &mut report)
                        .unwrap();
                }
                state.finish(&cancel, &mut infer, &mut report).unwrap();
                assert_eq!(
                    windows, expected_windows,
                    "count={count}, block={block_size}"
                );
                assert_eq!(state.predictions, expected_predictions);
                assert_eq!(progress, expected_progress);
                let config = StoryboardDecisionConfig::default();
                assert_eq!(
                    serde_json::to_value(detect_storyboard_cuts(&state.predictions, &config))
                        .unwrap(),
                    serde_json::to_value(detect_storyboard_cuts(&expected_predictions, &config))
                        .unwrap()
                );
            }
        }
        assert_eq!(
            StoryboardFrames::default()
                .finish(&AtomicBool::new(false), &mut predict, &mut |_, _| {})
                .unwrap_err()
                .code(),
            "STORYBOARD_FRAME_DECODE_FAILED"
        );
    }

    type TestTask = (
        FrameSender,
        Arc<FrameQueue>,
        Arc<AtomicBool>,
        InferenceTask,
        tokio::sync::oneshot::Receiver<PredictionResult>,
    );

    fn task(consumer: &StoryboardConsumer, id: &str) -> TestTask {
        let (sender, queue) = consumer.queue();
        let cancel = Arc::new(AtomicBool::new(false));
        let (task, completion) = InferenceTask::new(id.into(), queue.clone(), cancel.clone(), None);
        (sender, queue, cancel, task, completion)
    }

    fn feed(sender: &FrameSender, id: &str, marker: u8, count: usize) {
        for block in frames(marker, count).chunks(50) {
            sender
                .send(ProducerMessage::Frames(FrameBlock {
                    task_id: id.into(),
                    frames: block.to_vec(),
                }))
                .unwrap();
        }
        sender.send(ProducerMessage::Finished(Ok(()))).unwrap();
    }

    fn receive(
        mut completion: tokio::sync::oneshot::Receiver<PredictionResult>,
    ) -> PredictionResult {
        let deadline = Instant::now() + TEST_TIMEOUT;
        loop {
            match completion.try_recv() {
                Ok(result) => return result,
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                    if Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(2))
                }
                error => panic!("completion timed out or disconnected: {error:?}"),
            }
        }
    }

    fn wait_idle(consumer: &StoryboardConsumer) {
        let deadline = Instant::now() + TEST_TIMEOUT;
        while consumer.incoming.lock().unwrap().is_some() {
            assert!(Instant::now() < deadline, "consumer did not retire");
            thread::sleep(Duration::from_millis(2));
        }
    }

    struct ModelLifetime(Arc<AtomicUsize>);
    impl Drop for ModelLifetime {
        fn drop(&mut self) {
            assert_eq!(thread::current().name(), Some("storyboard-inference"));
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn decoding_prefetches_during_inference_and_cancellation_unblocks_full_queue() {
        struct CountingReader {
            reader: std::io::Cursor<Vec<u8>>,
            bytes: Arc<AtomicUsize>,
        }
        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = Read::read(&mut self.reader, buffer)?;
                self.bytes.fetch_add(count, Ordering::SeqCst);
                Ok(count)
            }
        }
        let consumer = test_consumer();
        let (sender, queue, cancel, task, completion) = task(&consumer, "prefetch");
        let (started_tx, started) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let mut first = true;
        consumer
            .submit_with(
                task,
                || Ok(((), "test".into())),
                move |_, window, _| {
                    if first {
                        first = false;
                        started_tx.send(()).unwrap();
                        gate.recv_timeout(TEST_TIMEOUT).unwrap();
                    }
                    predict(window)
                },
            )
            .unwrap();
        let bytes = Arc::new(AtomicUsize::new(0));
        let producer_bytes = bytes.clone();
        let producer_cancel = cancel.clone();
        let (done_tx, done) = mpsc::channel();
        let producer = thread::spawn(move || {
            let result = produce_storyboard_blocks(
                CountingReader {
                    reader: std::io::Cursor::new(vec![3; STORYBOARD_FRAME_BYTES * 400]),
                    bytes: producer_bytes,
                },
                &sender,
                "prefetch",
                &producer_cancel,
                &AtomicBool::new(false),
            );
            done_tx.send(result).unwrap();
        });
        started.recv_timeout(TEST_TIMEOUT).unwrap();
        let deadline = Instant::now() + TEST_TIMEOUT;
        // Two blocks were consumed, four queued, and one pending send. The model
        // remains blocked while stdout has already been read up through frame 350.
        while bytes.load(Ordering::SeqCst) < 350 * STORYBOARD_FRAME_BYTES {
            assert!(
                Instant::now() < deadline,
                "producer stopped during inference"
            );
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(bytes.load(Ordering::SeqCst), 350 * STORYBOARD_FRAME_BYTES);
        cancel.store(true, Ordering::SeqCst);
        queue.close();
        assert_eq!(
            done.recv_timeout(TEST_TIMEOUT).unwrap().unwrap_err().code(),
            "TASK_CANCELLED"
        );
        producer.join().unwrap();
        // Only release inference after checking producer cancellation: closing the
        // bounded queue must not depend on the consumer returning from inference.
        release.send(()).unwrap();
        assert_eq!(receive(completion).unwrap_err().code(), "TASK_CANCELLED");
        wait_idle(&consumer);
    }

    #[test]
    fn concurrent_admission_and_retirement_never_overlap_sessions() {
        struct ActiveModel(Arc<AtomicUsize>);
        impl Drop for ActiveModel {
            fn drop(&mut self) {
                assert_eq!(self.0.fetch_sub(1, Ordering::SeqCst), 1);
            }
        }
        let consumer = Arc::new(StoryboardConsumer {
            idle_timeout: Duration::ZERO,
            ..StoryboardConsumer::default()
        });
        let active = Arc::new(AtomicUsize::new(0));
        let mut submitters = Vec::new();
        for index in 0..4 {
            let consumer = consumer.clone();
            let active = active.clone();
            submitters.push(thread::spawn(move || {
                for iteration in 0..12 {
                    let id = format!("{index}:{iteration}");
                    let (sender, _, _, task, completion) = task(&consumer, &id);
                    let active = active.clone();
                    consumer
                        .submit_with(
                            task,
                            move || {
                                assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                                Ok((ActiveModel(active), "test".into()))
                            },
                            |_, window, _| predict(window),
                        )
                        .unwrap();
                    feed(&sender, &id, index, 1);
                    assert_eq!(receive(completion).unwrap().0, 1);
                }
            }));
        }
        for submitter in submitters {
            submitter.join().unwrap();
        }
        wait_idle(&consumer);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stalled_queue_does_not_delay_another_task() {
        let consumer = test_consumer();
        let (_stalled_sender, _, cancel, stalled, stalled_result) = task(&consumer, "stalled");
        consumer
            .submit_with(
                stalled,
                || Ok(((), "test".into())),
                |_, window, _| predict(window),
            )
            .unwrap();
        let (sender, _, _, ready, ready_result) = task(&consumer, "ready");
        consumer
            .submit_with(
                ready,
                || Ok(((), "test".into())),
                |_, window, _| predict(window),
            )
            .unwrap();
        feed(&sender, "ready", 8, 51);
        assert_eq!(
            receive(ready_result).unwrap().1,
            serial_reference(&frames(8, 51)).1
        );
        assert!(consumer.incoming.lock().unwrap().is_some());
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            receive(stalled_result).unwrap_err().code(),
            "TASK_CANCELLED"
        );
        wait_idle(&consumer);
    }

    #[test]
    fn one_session_round_robin_isolation_retirement_and_restart() {
        let consumer = test_consumer();
        let initialized = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(StdMutex::new(Vec::new()));
        let (release, gate) = mpsc::channel();
        let (a_sender, _, _, a, a_result) = task(&consumer, "a");
        let init_count = initialized.clone();
        let model_dropped = dropped.clone();
        let window_order = order.clone();
        consumer
            .submit_with(
                a,
                move || {
                    init_count.fetch_add(1, Ordering::SeqCst);
                    gate.recv_timeout(TEST_TIMEOUT).unwrap();
                    Ok((ModelLifetime(model_dropped), "test-provider".into()))
                },
                move |_, window, _| {
                    window_order.lock().unwrap().push(window[0][0]);
                    predict(window)
                },
            )
            .unwrap();
        let (b_sender, _, _, b, b_result) = task(&consumer, "b");
        consumer
            .submit_with(
                b,
                || -> AppResult<((), SessionProvider)> { panic!("must reuse the session") },
                |_, window, _| predict(window),
            )
            .unwrap();
        let (failed_sender, _, _, failed, failed_result) = task(&consumer, "failed");
        consumer
            .submit_with(
                failed,
                || Ok(((), "unused".into())),
                |_, window, _| predict(window),
            )
            .unwrap();
        failed_sender
            .send(ProducerMessage::Finished(Err(app_error(
                ErrorCode::ExternalToolExecutionFailed,
                "test extraction failure",
            ))))
            .unwrap();
        let (_cancel_sender, _, cancel, cancelled, cancelled_result) = task(&consumer, "cancelled");
        consumer
            .submit_with(
                cancelled,
                || Ok(((), "unused".into())),
                |_, window, _| predict(window),
            )
            .unwrap();
        cancel.store(true, Ordering::SeqCst);
        feed(&a_sender, "a", 11, 150);
        feed(&b_sender, "b", 22, 150);
        release.send(()).unwrap();
        let a = receive(a_result).unwrap();
        let b = receive(b_result).unwrap();
        assert_eq!(a.0, 150);
        assert_eq!(a.1, serial_reference(&frames(11, 150)).1);
        assert_eq!(b.1, serial_reference(&frames(22, 150)).1);
        assert_eq!(a.2, "test-provider");
        assert_eq!(b.2, "test-provider");
        assert_eq!(
            receive(failed_result).unwrap_err().code(),
            "EXTERNAL_TOOL_EXECUTION_FAILED"
        );
        assert_eq!(
            receive(cancelled_result).unwrap_err().code(),
            "TASK_CANCELLED"
        );
        assert_eq!(*order.lock().unwrap(), vec![11, 22, 11, 22, 11, 22]);
        wait_idle(&consumer);
        assert_eq!(initialized.load(Ordering::SeqCst), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        let (sender, _, _, next, result) = task(&consumer, "next");
        let init_count = initialized.clone();
        let model_dropped = dropped.clone();
        consumer
            .submit_with(
                next,
                move || {
                    init_count.fetch_add(1, Ordering::SeqCst);
                    Ok((ModelLifetime(model_dropped), "restarted".into()))
                },
                |_, window, _| predict(window),
            )
            .unwrap();
        feed(&sender, "next", 33, 1);
        assert_eq!(receive(result).unwrap().2, "restarted");
        wait_idle(&consumer);
        assert_eq!(initialized.load(Ordering::SeqCst), 2);
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn four_block_backpressure_and_close_unblock_only_own_producer() {
        let consumer = StoryboardConsumer::default();
        let (sender, queue) = consumer.queue();
        let message = || {
            ProducerMessage::Frames(FrameBlock {
                task_id: "a".into(),
                frames: frames(1, 50),
            })
        };
        for _ in 0..4 {
            sender.send(message()).unwrap();
        }
        assert!(matches!(
            sender.sender.try_send(message()),
            Err(mpsc::TrySendError::Full(_))
        ));
        let (started_tx, started) = mpsc::channel();
        let (done_tx, done) = mpsc::channel();
        let producer = thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx.send(sender.send(message()).is_err()).unwrap();
        });
        started.recv_timeout(TEST_TIMEOUT).unwrap();
        assert!(matches!(
            done.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        queue.close();
        assert!(done.recv_timeout(TEST_TIMEOUT).unwrap());
        producer.join().unwrap();
        assert!(matches!(queue.try_recv(), Err(TryRecvError::Disconnected)));
        let (other_sender, other_queue) = consumer.queue();
        other_sender
            .send(ProducerMessage::Finished(Ok(())))
            .unwrap();
        assert!(matches!(
            other_queue.try_recv(),
            Ok(ProducerMessage::Finished(Ok(())))
        ));
    }

    #[test]
    fn cancellation_while_all_queues_are_empty_finishes_without_producer_message() {
        let consumer = test_consumer();
        let (_sender, _, cancel, task, completion) = task(&consumer, "waiting");
        let (ready_tx, ready) = mpsc::channel();
        consumer
            .submit_with(
                task,
                move || {
                    ready_tx.send(()).unwrap();
                    Ok(((), "test".into()))
                },
                |_, window, _| predict(window),
            )
            .unwrap();
        ready.recv_timeout(TEST_TIMEOUT).unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(receive(completion).unwrap_err().code(), "TASK_CANCELLED");
        wait_idle(&consumer);
    }

    #[test]
    fn model_initialization_failure_fails_admitted_tasks_and_releases_queues() {
        let consumer = test_consumer();
        let (sender, queue, _, task, completion) = task(&consumer, "bad-model");
        consumer
            .submit_with(
                task,
                || -> AppResult<((), SessionProvider)> {
                    Err(app_error(
                        ErrorCode::StoryboardInferenceFailed,
                        "test initialization failure",
                    ))
                },
                |_, window, _| predict(window),
            )
            .unwrap();
        assert_eq!(
            receive(completion).unwrap_err().code(),
            "STORYBOARD_INFERENCE_FAILED"
        );
        wait_idle(&consumer);
        assert!(sender.send(ProducerMessage::Finished(Ok(()))).is_err());
        assert!(matches!(queue.try_recv(), Err(TryRecvError::Disconnected)));
    }

    #[test]
    fn producer_assembles_fifty_frame_blocks_and_rejects_partial_frame() {
        for count in [0, 1, 49, 50, 51, 100, 101] {
            let consumer = StoryboardConsumer::default();
            let (sender, queue) = consumer.queue();
            let bytes = (0..count)
                .flat_map(|index| vec![(index % 256) as u8; STORYBOARD_FRAME_BYTES])
                .collect::<Vec<_>>();
            produce_storyboard_blocks(
                std::io::Cursor::new(bytes),
                &sender,
                "decode",
                &AtomicBool::new(false),
                &AtomicBool::new(false),
            )
            .unwrap();
            let mut decoded = 0;
            while let Ok(ProducerMessage::Frames(block)) = queue.try_recv() {
                assert_eq!(block.task_id, "decode");
                assert_eq!(block.frames.len(), (count - decoded).min(50));
                for frame in block.frames {
                    assert_eq!(frame, vec![(decoded % 256) as u8; STORYBOARD_FRAME_BYTES]);
                    decoded += 1;
                }
            }
            assert_eq!(decoded, count);
        }
        let mut partial = std::io::Cursor::new(vec![0; STORYBOARD_FRAME_BYTES - 1]);
        assert_eq!(
            read_storyboard_frame(&mut partial, &mut vec![0; STORYBOARD_FRAME_BYTES])
                .unwrap_err()
                .code(),
            "STORYBOARD_FRAME_DECODE_FAILED"
        );
    }

    #[test]
    fn completed_tasks_reuse_warm_session_before_idle_retirement() {
        let consumer = Arc::new(StoryboardConsumer {
            idle_timeout: Duration::from_secs(1),
            ..StoryboardConsumer::default()
        });
        let dropped = Arc::new(AtomicUsize::new(0));
        let model_dropped = dropped.clone();
        let (sender, _, _, first, result) = task(&consumer, "first");
        consumer
            .submit_with(
                first,
                move || Ok((ModelLifetime(model_dropped), "warm".into())),
                |_, window, _| predict(window),
            )
            .unwrap();
        feed(&sender, "first", 1, 1);
        assert_eq!(receive(result).unwrap().2, "warm");
        thread::sleep(Duration::from_millis(100));
        assert_eq!(dropped.load(Ordering::SeqCst), 0);

        let (sender, _, _, second, result) = task(&consumer, "second");
        consumer
            .submit_with(
                second,
                || -> AppResult<((), SessionProvider)> { panic!("idle session must be reused") },
                |_, window, _| predict(window),
            )
            .unwrap();
        feed(&sender, "second", 2, 51);
        assert_eq!(
            receive(result).unwrap().1,
            serial_reference(&frames(2, 51)).1
        );
        wait_idle(&consumer);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }
}
