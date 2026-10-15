//! Recovery state tests: no model files, runtime DLLs, GPU, or media decoding.
use super::*;
use std::cell::{Cell, RefCell};

const CODE: ErrorCode = ErrorCode::SemanticInferenceFailed;

#[test]
fn successful_gpu_run_does_not_initialize_cpu() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML");
    let result = run_with_fallback(
        &mut session,
        &provider,
        None,
        CODE,
        true,
        |_| Ok(42),
        || -> ort::Result<i32> { panic!("CPU is unnecessary") },
    )
    .unwrap();
    assert_eq!(result, 42);
    assert_eq!(provider.to_string(), "DirectML");
}

#[test]
fn failed_gpu_batch_retries_identical_inputs_and_keeps_cpu_for_next_batch() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML (adapter 2)");
    let status = provider.clone();
    let calls = RefCell::new(Vec::new());
    let cpu_loads = Cell::new(0);
    for input in [vec![3, 7, 11], vec![19]] {
        let output = run_with_fallback(
            &mut session,
            &provider,
            None,
            CODE,
            true,
            |session| {
                calls.borrow_mut().push((*session, input.clone()));
                if *session == 0 {
                    Err(ort::Error::new("GPU reshape failed"))
                } else {
                    Ok(input.clone())
                }
            },
            || {
                cpu_loads.set(cpu_loads.get() + 1);
                Ok(1)
            },
        )
        .unwrap();
        assert_eq!(output, input);
    }
    assert_eq!(
        *calls.borrow(),
        [(0, vec![3, 7, 11]), (1, vec![3, 7, 11]), (1, vec![19])]
    );
    assert_eq!(cpu_loads.get(), 1);
    assert_eq!(status.to_string(), "CPU");
}

#[test]
fn cancellation_after_gpu_failure_skips_cpu_loading_and_retry() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML");
    let cancel = AtomicBool::new(false);
    let error = run_with_fallback(
        &mut session,
        &provider,
        Some(&cancel),
        CODE,
        true,
        |_| -> ort::Result<()> {
            cancel.store(true, Ordering::SeqCst);
            Err(ort::Error::new("GPU failed"))
        },
        || -> ort::Result<i32> { panic!("Cancelled work must not load a model") },
    )
    .unwrap_err();
    assert!(error.is(ErrorCode::TaskCancelled));
    assert_eq!(provider.to_string(), "DirectML");
}

#[test]
fn cancellation_during_cpu_loading_skips_retry() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML");
    let cancel = AtomicBool::new(false);
    let calls = Cell::new(0);
    let error = run_with_fallback(
        &mut session,
        &provider,
        Some(&cancel),
        CODE,
        true,
        |_| -> ort::Result<()> {
            calls.set(calls.get() + 1);
            Err(ort::Error::new("GPU failed"))
        },
        || {
            cancel.store(true, Ordering::SeqCst);
            Ok(1)
        },
    )
    .unwrap_err();
    assert!(error.is(ErrorCode::TaskCancelled));
    assert_eq!(calls.get(), 1);
    assert_eq!(provider.to_string(), "CPU");
}

#[test]
fn failed_cpu_retry_keeps_both_causes_and_does_not_retry_cpu_forever() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML");
    let error = run_with_fallback(
        &mut session,
        &provider,
        None,
        CODE,
        true,
        |session| -> ort::Result<()> {
            Err(ort::Error::new(if *session == 0 {
                "GPU reshape"
            } else {
                "CPU kernel"
            }))
        },
        || Ok(1),
    )
    .unwrap_err();
    assert!(error.is(CODE));
    assert!(error.detail().contains("GPU reshape"));
    assert!(error.detail().contains("CPU kernel"));
    assert_eq!(provider.to_string(), "CPU");
    let error = run_with_fallback(
        &mut session,
        &provider,
        None,
        CODE,
        true,
        |_| -> ort::Result<()> { Err(ort::Error::new("CPU kernel")) },
        || -> ort::Result<i32> { panic!("Already on CPU") },
    )
    .unwrap_err();
    assert!(error.is(CODE));
}

#[test]
fn cpu_load_failure_retains_gpu_state_and_reports_both_causes() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML");
    let error = run_with_fallback(
        &mut session,
        &provider,
        None,
        CODE,
        true,
        |_| -> ort::Result<()> { Err(ort::Error::new("GPU run failed")) },
        || Err(ort::Error::new("CPU load failed")),
    )
    .unwrap_err();
    assert!(error.detail().contains("GPU run failed"));
    assert!(error.detail().contains("CPU load failed"));
    assert_eq!(session, 0);
    assert_eq!(provider.to_string(), "DirectML");
}

#[test]
fn cancellation_during_cpu_retry_wins_over_inference_error() {
    let mut session = 0;
    let provider = SessionProvider::from("DirectML");
    let cancel = AtomicBool::new(false);
    let error = run_with_fallback(
        &mut session,
        &provider,
        Some(&cancel),
        CODE,
        true,
        |session| -> ort::Result<()> {
            if *session == 1 {
                cancel.store(true, Ordering::SeqCst);
            }
            Err(ort::Error::new("Inference failed"))
        },
        || Ok(1),
    )
    .unwrap_err();
    assert!(error.is(ErrorCode::TaskCancelled));
    assert_eq!(provider.to_string(), "CPU");
}
