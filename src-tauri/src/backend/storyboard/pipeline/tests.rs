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
        let (expected_windows, expected_predictions, expected_progress) = serial_reference(&frames);
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
                serde_json::to_value(detect_storyboard_cuts(&state.predictions, &config)).unwrap(),
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

fn receive(mut completion: tokio::sync::oneshot::Receiver<PredictionResult>) -> PredictionResult {
    let deadline = Instant::now() + TEST_TIMEOUT;
    loop {
        match completion.try_recv() {
            Ok(result) => return result,
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) if Instant::now() < deadline => {
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
    let consumer = Arc::new(StoryboardConsumer::default());
    let (sender, queue, cancel, task, completion) = task(&consumer, "prefetch");
    let (started_tx, started) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let mut first = true;
    consumer
        .submit_with(
            task,
            || Ok(((), "test".into())),
            move |_, window| {
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
    let consumer = Arc::new(StoryboardConsumer::default());
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
                        |_, window| predict(window),
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
    let consumer = Arc::new(StoryboardConsumer::default());
    let (_stalled_sender, _, cancel, stalled, stalled_result) = task(&consumer, "stalled");
    consumer
        .submit_with(
            stalled,
            || Ok(((), "test".into())),
            |_, window| predict(window),
        )
        .unwrap();
    let (sender, _, _, ready, ready_result) = task(&consumer, "ready");
    consumer
        .submit_with(
            ready,
            || Ok(((), "test".into())),
            |_, window| predict(window),
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
    let consumer = Arc::new(StoryboardConsumer::default());
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
            move |_, window| {
                window_order.lock().unwrap().push(window[0][0]);
                predict(window)
            },
        )
        .unwrap();
    let (b_sender, _, _, b, b_result) = task(&consumer, "b");
    consumer
        .submit_with(
            b,
            || -> AppResult<((), String)> { panic!("must reuse the session") },
            |_, window| predict(window),
        )
        .unwrap();
    let (failed_sender, _, _, failed, failed_result) = task(&consumer, "failed");
    consumer
        .submit_with(
            failed,
            || Ok(((), "unused".into())),
            |_, window| predict(window),
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
            |_, window| predict(window),
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
            |_, window| predict(window),
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
    let consumer = Arc::new(StoryboardConsumer::default());
    let (_sender, _, cancel, task, completion) = task(&consumer, "waiting");
    let (ready_tx, ready) = mpsc::channel();
    consumer
        .submit_with(
            task,
            move || {
                ready_tx.send(()).unwrap();
                Ok(((), "test".into()))
            },
            |_, window| predict(window),
        )
        .unwrap();
    ready.recv_timeout(TEST_TIMEOUT).unwrap();
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(receive(completion).unwrap_err().code(), "TASK_CANCELLED");
    wait_idle(&consumer);
}

#[test]
fn model_initialization_failure_fails_admitted_tasks_and_releases_queues() {
    let consumer = Arc::new(StoryboardConsumer::default());
    let (sender, queue, _, task, completion) = task(&consumer, "bad-model");
    consumer
        .submit_with(
            task,
            || -> AppResult<((), String)> {
                Err(app_error(
                    ErrorCode::StoryboardInferenceFailed,
                    "test initialization failure",
                ))
            },
            |_, window| predict(window),
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
