//! Shared ONNX provider selection and recovery for every production model.
use super::{app_error, available_cpu_threads, check_optional_cancel, AppResult, ErrorCode};
use ort::{
    execution_providers::DirectMLExecutionProvider,
    session::{builder::GraphOptimizationLevel, Session},
};
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
};

const MAX_DIRECTML_ADAPTERS: i32 = 8;
static PREFERRED_ADAPTER: AtomicI32 = AtomicI32::new(-1);

// Clones observe a runtime fallback too, so task completion reports the provider
// actually used rather than the provider selected at initialization.
#[derive(Clone)]
pub(super) struct SessionProvider {
    initial: Arc<str>,
    cpu: Arc<AtomicBool>,
}

impl From<String> for SessionProvider {
    fn from(name: String) -> Self {
        Self {
            cpu: Arc::new(AtomicBool::new(name == "CPU")),
            initial: name.into(),
        }
    }
}

impl From<&str> for SessionProvider {
    fn from(name: &str) -> Self {
        name.to_string().into()
    }
}

impl fmt::Display for SessionProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.cpu.load(Ordering::Relaxed) {
            formatter.write_str("CPU")
        } else {
            formatter.write_str(&self.initial)
        }
    }
}

pub(super) struct OnnxModel {
    session: Mutex<Session>,
    provider: SessionProvider,
    path: PathBuf,
    dimensions: Vec<(String, i64)>,
    error_code: ErrorCode,
    recover: bool,
}

impl OnnxModel {
    pub fn load(path: &Path, dimensions: &[(&str, i64)], error_code: ErrorCode) -> AppResult<Self> {
        let (session, provider) =
            create_model_session_with_dimensions(path, dimensions).map_err(|error| {
                app_error(
                    error_code,
                    format!("Load ONNX model {}: {error}", path.display()),
                )
            })?;
        Ok(Self {
            session: Mutex::new(session),
            provider: provider.into(),
            path: path.to_owned(),
            dimensions: dimensions
                .iter()
                .map(|&(name, size)| (name.to_owned(), size))
                .collect(),
            error_code,
            recover: true,
        })
    }

    pub fn provider(&self) -> SessionProvider {
        self.provider.clone()
    }

    // Return owned outputs: the failed session can be replaced only after every
    // output from its failed attempt has been dropped. Callers reuse the same
    // inputs and publish results only after this method succeeds.
    pub fn run<T>(
        &self,
        cancel: Option<&AtomicBool>,
        mut infer: impl FnMut(&Session) -> ort::Result<T>,
    ) -> AppResult<T> {
        let mut session = self
            .session
            .lock()
            .map_err(|error| app_error(self.error_code, error.to_string()))?;
        run_with_fallback(
            &mut *session,
            &self.provider,
            cancel,
            self.error_code,
            self.recover,
            |session| {
                infer(session).map_err(|error| {
                    ort::Error::new(format!("Model {}: {error}", self.path.display()))
                })
            },
            || {
                let dimensions = self
                    .dimensions
                    .iter()
                    .map(|(name, size)| (name.as_str(), *size))
                    .collect::<Vec<_>>();
                create_cpu_model_session_with_dimensions(&self.path, &dimensions)
            },
        )
    }

    // Provider-specific diagnostic tests intentionally bypass automatic recovery.
    #[cfg(test)]
    pub fn from_session(session: Session, error_code: ErrorCode) -> Self {
        Self {
            session: Mutex::new(session),
            provider: "Explicit test provider".into(),
            path: PathBuf::new(),
            dimensions: Vec::new(),
            error_code,
            recover: false,
        }
    }
}

fn run_with_fallback<S, T>(
    session: &mut S,
    provider: &SessionProvider,
    cancel: Option<&AtomicBool>,
    error_code: ErrorCode,
    recover: bool,
    mut infer: impl FnMut(&S) -> ort::Result<T>,
    cpu: impl FnOnce() -> ort::Result<S>,
) -> AppResult<T> {
    check_optional_cancel(cancel)?;
    let result = match infer(session) {
        Ok(result) => result,
        Err(error) => {
            check_optional_cancel(cancel)?;
            if !recover || provider.cpu.load(Ordering::Relaxed) {
                return Err(app_error(
                    error_code,
                    format!("ONNX inference on {provider} failed: {error}"),
                ));
            }
            tracing::warn!(%provider, %error, "ONNX inference failed; retrying the same inputs on CPU");
            let replacement = match cpu() {
                Ok(session) => session,
                Err(cpu_error) => {
                    check_optional_cancel(cancel)?;
                    return Err(app_error(error_code, format!(
                        "ONNX inference on {provider} failed: {error}; CPU initialization failed: {cpu_error}"
                    )));
                }
            };
            *session = replacement;
            provider.cpu.store(true, Ordering::Relaxed);
            check_optional_cancel(cancel)?;
            let retry = infer(session);
            check_optional_cancel(cancel)?;
            let result = retry.map_err(|cpu_error| {
                app_error(
                    error_code,
                    format!(
                        "ONNX accelerated inference failed: {error}; CPU retry failed: {cpu_error}"
                    ),
                )
            })?;
            tracing::info!(
                provider = "CPU",
                "ONNX CPU retry succeeded; retaining CPU for subsequent inference"
            );
            result
        }
    };
    check_optional_cancel(cancel)?;
    Ok(result)
}

pub(super) fn create_model_session_with_dimensions(
    path: &Path,
    dimensions: &[(&str, i64)],
) -> ort::Result<(Session, String)> {
    let preferred = PREFERRED_ADAPTER.load(Ordering::Relaxed);
    let adapters = (preferred >= 0)
        .then_some(preferred)
        .into_iter()
        .chain((0..MAX_DIRECTML_ADAPTERS).filter(|adapter| *adapter != preferred));
    let mut errors = Vec::new();
    for adapter in adapters {
        match create_directml_model_session_with_dimensions(path, adapter, dimensions) {
            Ok(session) => {
                PREFERRED_ADAPTER.store(adapter, Ordering::Relaxed);
                tracing::info!(provider = "DirectML", adapter, model_path = %path.display(), "Selected ONNX inference provider");
                return Ok((session, format!("DirectML (adapter {adapter})")));
            }
            Err(error) => {
                tracing::warn!(adapter, model_path = %path.display(), %error, "DirectML ONNX initialization failed for display adapter");
                errors.push(format!("adapter {adapter}: {error}"));
            }
        }
    }
    tracing::warn!(model_path = %path.display(), "No usable DirectML display adapter was found; retrying with CPU");
    create_cpu_model_session_with_dimensions(path, dimensions)
        .map(|session| {
            tracing::info!(provider = "CPU", model_path = %path.display(), "Selected ONNX inference provider after DirectML fallback");
            (session, "CPU".to_string())
        })
        .map_err(|error| ort::Error::new(format!("DirectML initialization failed ({}); CPU initialization failed: {error}", errors.join("; "))))
}

fn create_directml_model_session_with_dimensions(
    path: &Path,
    adapter: i32,
    dimensions: &[(&str, i64)],
) -> ort::Result<Session> {
    // DirectML requires sequential execution, disabled memory patterns, and
    // serialized Run calls (enforced by OnnxModel's session mutex).
    let mut builder = Session::builder()?
        .with_parallel_execution(false)?
        .with_memory_pattern(false)?
        .with_execution_providers([DirectMLExecutionProvider::default()
            .with_device_id(adapter)
            .build()
            .error_on_failure()])?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(1)?;
    for &(name, size) in dimensions {
        builder = builder.with_dimension_override(name, size)?;
    }
    builder.commit_from_file(path)
}

pub(super) fn create_cpu_model_session_with_dimensions(
    path: &Path,
    dimensions: &[(&str, i64)],
) -> ort::Result<Session> {
    let threads = cpu_thread_budget(available_cpu_threads());
    tracing::info!(threads, "Configured ONNX CPU inference threads");
    let mut builder = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(threads)?;
    for &(name, size) in dimensions {
        builder = builder.with_dimension_override(name, size)?;
    }
    builder.commit_from_file(path)
}

// Reserve CPU capacity for decoding and UI work.
pub(super) fn cpu_thread_budget(available: usize) -> usize {
    (available / 2).clamp(1, 8)
}

#[cfg(test)]
pub(super) fn create_model_session(path: &Path) -> ort::Result<(Session, String)> {
    create_model_session_with_dimensions(path, &[])
}

#[cfg(test)]
pub(super) fn create_cpu_model_session(path: &Path) -> ort::Result<Session> {
    create_cpu_model_session_with_dimensions(path, &[])
}

#[cfg(test)]
pub(super) fn create_directml_model_session(path: &Path, adapter: i32) -> ort::Result<Session> {
    create_directml_model_session_with_dimensions(path, adapter, &[])
}

#[cfg(test)]
#[path = "onnx_tests.rs"]
mod tests;
