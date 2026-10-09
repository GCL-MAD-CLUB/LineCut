use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NoticeSeverity {
    Info,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UserNotice {
    pub(crate) code: String,
    pub(crate) severity: NoticeSeverity,
    pub(crate) message: String,
}

impl UserNotice {
    pub(crate) fn warning(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: NoticeSeverity::Warning,
            message: message.into(),
        }
    }

    pub(crate) fn warning_with_detail(
        code: &str,
        message: impl Into<String>,
        detail: impl AsRef<str>,
    ) -> Self {
        tracing::warn!(
            notice_code = code,
            detail = detail.as_ref(),
            "operation warning"
        );
        Self::warning(code, message)
    }
}
