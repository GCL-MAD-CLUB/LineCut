use serde::{Serialize, Serializer};
use tauri::Manager;
use tracing::error;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use uuid::Uuid;

pub(crate) type AppResult<T> = Result<T, AppError>;
pub(crate) type CommandResult<T> = AppResult<T>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ErrorCategory {
    Cancelled,
    Validation,
    Resource,
    State,
    Io,
    Format,
    Security,
    ExternalTool,
    Media,
    Platform,
    Runtime,
    Unsupported,
}

impl ErrorCategory {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Validation => "validation",
            Self::Resource => "resource",
            Self::State => "state",
            Self::Io => "io",
            Self::Format => "format",
            Self::Security => "security",
            Self::ExternalTool => "externalTool",
            Self::Media => "media",
            Self::Platform => "platform",
            Self::Runtime => "runtime",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ErrorDefinition {
    name: &'static str,
    category: ErrorCategory,
    retryable: bool,
}

macro_rules! define_error_codes {
    ($($variant:ident => ($name:literal, $category:ident, $retryable:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(crate) enum ErrorCode {
            $($variant),+
        }

        impl ErrorCode {
            pub(crate) const fn definition(self) -> ErrorDefinition {
                match self {
                    $(Self::$variant => ErrorDefinition {
                        name: $name,
                        category: ErrorCategory::$category,
                        retryable: $retryable,
                    }),+
                }
            }
        }
    };
}

define_error_codes! {
    TaskCancelled => ("TASK_CANCELLED", Cancelled, false),
    PreferencesInvalid => ("PREFERENCES_INVALID", Validation, false),
    TaskIdInvalid => ("TASK_ID_INVALID", Validation, false),
    ExportSelectionEmpty => ("EXPORT_SELECTION_EMPTY", Validation, false),
    ExportBoundMediaInvalid => ("EXPORT_BOUND_MEDIA_INVALID", Validation, false),
    ProxyOutputRequired => ("PROXY_OUTPUT_REQUIRED", Validation, false),
    ProxyDimensionsInvalid => ("PROXY_DIMENSIONS_INVALID", Validation, false),
    ProjectPathInvalid => ("PROJECT_PATH_INVALID", Validation, false),
    ThumbnailCacheInvalid => ("THUMBNAIL_CACHE_INVALID", Validation, false),
    FileNotFound => ("FILE_NOT_FOUND", Resource, true),
    MediaNotFound => ("MEDIA_NOT_FOUND", Resource, true),
    VideoStreamMissing => ("VIDEO_STREAM_MISSING", Resource, false),
    ProjectNotLoaded => ("PROJECT_NOT_LOADED", Resource, true),
    ExportTrackNotFound => ("EXPORT_TRACK_NOT_FOUND", Resource, false),
    TaskNotFound => ("TASK_NOT_FOUND", Resource, false),
    TaskAlreadyRunning => ("TASK_ALREADY_RUNNING", State, false),
    PreferencesStateUnavailable => ("PREFERENCES_STATE_UNAVAILABLE", State, true),
    LaunchPathStateUnavailable => ("LAUNCH_PATH_STATE_UNAVAILABLE", State, true),
    ProjectStateUnavailable => ("PROJECT_STATE_UNAVAILABLE", State, true),
    TaskStateUnavailable => ("TASK_STATE_UNAVAILABLE", State, true),
    ThumbnailCacheStateUnavailable => ("THUMBNAIL_CACHE_STATE_UNAVAILABLE", State, true),
    DropRegionStateUnavailable => ("DROP_REGION_STATE_UNAVAILABLE", State, true),
    PreferencesReadFailed => ("PREFERENCES_READ_FAILED", Io, true),
    PreferencesWriteFailed => ("PREFERENCES_WRITE_FAILED", Io, true),
    LoggingInitializationFailed => ("LOGGING_INITIALIZATION_FAILED", Io, false),
    CacheMaintenanceFailed => ("CACHE_MAINTENANCE_FAILED", Io, true),
    AutoSaveReadFailed => ("AUTO_SAVE_READ_FAILED", Io, true),
    AutoSaveWriteFailed => ("AUTO_SAVE_WRITE_FAILED", Io, true),
    ProjectReadFailed => ("PROJECT_READ_FAILED", Io, true),
    ProjectWriteFailed => ("PROJECT_WRITE_FAILED", Io, true),
    MediaReadFailed => ("MEDIA_READ_FAILED", Io, true),
    SubtitleReadFailed => ("SUBTITLE_READ_FAILED", Io, true),
    ThumbnailCacheReadFailed => ("THUMBNAIL_CACHE_READ_FAILED", Io, true),
    ThumbnailCacheWriteFailed => ("THUMBNAIL_CACHE_WRITE_FAILED", Io, true),
    ExportWriteFailed => ("EXPORT_WRITE_FAILED", Io, true),
    ProxyWriteFailed => ("PROXY_WRITE_FAILED", Io, true),
    TaskCleanupFailed => ("TASK_CLEANUP_FAILED", Io, true),
    ProjectFormatInvalid => ("PROJECT_FORMAT_INVALID", Format, false),
    ProjectVersionUnsupported => ("PROJECT_VERSION_UNSUPPORTED", Unsupported, false),
    ProjectIntegrityFailed => ("PROJECT_INTEGRITY_FAILED", Format, false),
    ProjectEncodeFailed => ("PROJECT_ENCODE_FAILED", Format, true),
    ProjectDecodeFailed => ("PROJECT_DECODE_FAILED", Format, false),
    ProjectMigrationFailed => ("PROJECT_MIGRATION_FAILED", Format, false),
    PreferencesDecodeFailed => ("PREFERENCES_DECODE_FAILED", Format, false),
    MediaProbeDecodeFailed => ("MEDIA_PROBE_DECODE_FAILED", Format, false),
    ThumbnailDataInvalid => ("THUMBNAIL_DATA_INVALID", Format, true),
    ProjectRandomFailed => ("PROJECT_RANDOM_FAILED", Security, true),
    ProjectKeyDerivationFailed => ("PROJECT_KEY_DERIVATION_FAILED", Security, false),
    ProjectEncryptionFailed => ("PROJECT_ENCRYPTION_FAILED", Security, false),
    ProjectAuthenticationFailed => ("PROJECT_AUTHENTICATION_FAILED", Security, false),
    ExternalToolStartFailed => ("EXTERNAL_TOOL_START_FAILED", ExternalTool, true),
    ExternalToolWaitFailed => ("EXTERNAL_TOOL_WAIT_FAILED", ExternalTool, true),
    ExternalToolExecutionFailed => ("EXTERNAL_TOOL_EXECUTION_FAILED", ExternalTool, true),
    ExternalToolOutputUnavailable => ("EXTERNAL_TOOL_OUTPUT_UNAVAILABLE", ExternalTool, true),
    ExternalToolOutputInvalid => ("EXTERNAL_TOOL_OUTPUT_INVALID", ExternalTool, true),
    ThumbnailNoFrame => ("THUMBNAIL_NO_FRAME", Media, true),
    ThumbnailExtractionFailed => ("THUMBNAIL_EXTRACTION_FAILED", Media, true),
    FileRevealFailed => ("FILE_REVEAL_FAILED", Platform, true),
    ExecutablePathUnavailable => ("EXECUTABLE_PATH_UNAVAILABLE", Platform, true),
    WorkingDirectoryUnavailable => ("WORKING_DIRECTORY_UNAVAILABLE", Platform, true),
    SystemClockInvalid => ("SYSTEM_CLOCK_INVALID", Platform, true),
    WindowThemeFailed => ("WINDOW_THEME_FAILED", Platform, true),
    WindowHandleUnavailable => ("WINDOW_HANDLE_UNAVAILABLE", Platform, true),
    NativeDragRegistrationFailed => ("NATIVE_DRAG_REGISTRATION_FAILED", Platform, true),
    ProcessTerminationFailed => ("PROCESS_TERMINATION_FAILED", Platform, true),
    SystemSoundPlayFailed => ("SYSTEM_SOUND_PLAY_FAILED", Platform, true),
    BlockingTaskFailed => ("BLOCKING_TASK_FAILED", Runtime, true),
    EventEmitFailed => ("EVENT_EMIT_FAILED", Runtime, true),
    ApplicationRunFailed => ("APPLICATION_RUN_FAILED", Runtime, false),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicError {
    error_id: String,
    code: &'static str,
    category: &'static str,
    retryable: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AppError {
    error_id: String,
    code: ErrorCode,
    detail: String,
}

impl AppError {
    pub(crate) fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        let error_id = format!("ERR-{}", Uuid::new_v4().simple());
        let definition = code.definition();
        error!(
            error_id = %error_id,
            public_code = definition.name,
            error_category = definition.category.as_str(),
            detail = %detail,
            "application error created"
        );
        Self {
            error_id,
            code,
            detail,
        }
    }

    pub(crate) fn is(&self, code: ErrorCode) -> bool {
        self.code == code
    }

    pub(crate) fn detail(&self) -> &str {
        &self.detail
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let definition = self.code.definition();
        PublicError {
            error_id: self.error_id.clone(),
            code: definition.name,
            category: definition.category.as_str(),
            retryable: definition.retryable,
        }
        .serialize(serializer)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for AppError {}

pub(crate) fn app_error(code: ErrorCode, detail: impl Into<String>) -> AppError {
    AppError::new(code, detail)
}

pub(crate) fn init_logging(app: &tauri::AppHandle) -> AppResult<()> {
    let log_dir = app.path().app_log_dir().map_err(|error| {
        app_error(
            ErrorCode::LoggingInitializationFailed,
            format!("Failed to resolve the application log directory: {error}"),
        )
    })?;
    std::fs::create_dir_all(&log_dir).map_err(|error| {
        app_error(
            ErrorCode::LoggingInitializationFailed,
            format!(
                "Failed to create application log directory {}: {error}",
                log_dir.display()
            ),
        )
    })?;
    let file_appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("linecut")
        .filename_suffix("log")
        .max_log_files(5)
        .build(log_dir)
        .map_err(|error| {
            app_error(
                ErrorCode::LoggingInitializationFailed,
                format!("Failed to create the rolling application log writer: {error}"),
            )
        })?;
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(file_appender)
        .try_init()
        .map_err(|error| {
            app_error(
                ErrorCode::LoggingInitializationFailed,
                format!("Failed to install the application log subscriber: {error}"),
            )
        })?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendIncident {
    error_id: String,
    operation: String,
    code: String,
    category: ErrorCategory,
    detail: String,
    occurrences: u32,
    last_seen_at_ms: u64,
}

#[tauri::command]
pub(crate) fn record_frontend_incident(incident: FrontendIncident) {
    let detail = incident.detail.chars().take(4096).collect::<String>();
    let occurrences = incident.occurrences.clamp(1, 10_000);
    error!(
        error_id = %incident.error_id,
        operation = %incident.operation,
        public_code = %incident.code,
        error_category = incident.category.as_str(),
        occurrences,
        last_seen_at_ms = incident.last_seen_at_ms,
        detail = %detail,
        "frontend incident"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_error_never_contains_private_detail() {
        let private_detail = "Project authentication rejected secret value: super-secret-value";
        let value = serde_json::to_value(AppError::new(
            ErrorCode::ProjectAuthenticationFailed,
            private_detail,
        ))
        .expect("application error should serialize");
        let serialized = value.to_string();

        assert!(!serialized.contains(private_detail));
        assert!(!serialized.contains("super-secret-value"));
        assert_eq!(value.as_object().map(serde_json::Map::len), Some(4));
        assert!(value.get("detail").is_none());
        assert_eq!(
            value.get("code").and_then(|value| value.as_str()),
            Some("PROJECT_AUTHENTICATION_FAILED")
        );
        assert_eq!(
            value.get("category").and_then(|value| value.as_str()),
            Some("security")
        );
        assert_eq!(
            value.get("retryable").and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn cancellation_classification_is_declared_by_its_code() {
        let definition = ErrorCode::TaskCancelled.definition();
        assert_eq!(definition.name, "TASK_CANCELLED");
        assert_eq!(definition.category, ErrorCategory::Cancelled);
        assert!(!definition.retryable);
    }

    #[test]
    fn representative_error_classifications_are_declared_by_code() {
        let cases = [
            (ErrorCode::FileNotFound, ErrorCategory::Resource, true),
            (ErrorCode::PreferencesReadFailed, ErrorCategory::Io, true),
            (
                ErrorCode::ProjectFormatInvalid,
                ErrorCategory::Format,
                false,
            ),
            (
                ErrorCode::ProjectAuthenticationFailed,
                ErrorCategory::Security,
                false,
            ),
            (
                ErrorCode::ExternalToolExecutionFailed,
                ErrorCategory::ExternalTool,
                true,
            ),
        ];

        for (code, expected_category, expected_retryable) in cases {
            let definition = code.definition();
            assert_eq!(definition.category, expected_category);
            assert_eq!(definition.retryable, expected_retryable);
        }
    }
}
