use super::UserNotice;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportAudioSource {
    pub(crate) source_path: String,
    /// Zero-based index among the input file's audio streams (`a:N`).
    #[serde(default)]
    pub(crate) audio_track_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportClip {
    pub(crate) id: String,
    pub(crate) source_path: String,
    /// `None` preserves compatibility with older callers by selecting the
    /// source file's first audio stream; `Some([])` explicitly means no audio.
    #[serde(default)]
    pub(crate) audio_sources: Option<Vec<ExportAudioSource>>,
    pub(crate) label: String,
    /// Full output filename (with extension) computed by the frontend rename
    /// rule; empty falls back to the legacy stem-based naming.
    #[serde(default)]
    pub(crate) output_name: String,
    #[serde(default)]
    pub(crate) start_us: i64,
    #[serde(default)]
    pub(crate) end_us: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportMode {
    Merge,
    Individual,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportContainer {
    Mp4H264,
    Mp4Hevc,
    MovProres,
    WebmVp9,
    Mp3Audio,
    AacAudio,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportResolution {
    MatchSource,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportQuality {
    Low,
    Medium,
    High,
    VeryHigh,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportEncoderSpeed {
    Fast,
    Balanced,
    Quality,
}

/// Hardware encoding policy for exports.  `Auto` probes the bundled (or
/// user-selected) FFmpeg once per export and falls back to software when a
/// driver, device, or codec is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportHardwareAcceleration {
    Auto,
    Software,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportAudioCodec {
    Aac,
    /// MPEG-1 Layer II (ffmpeg native `mp2` encoder).
    Mp2,
    /// MPEG-1 Layer III (`libmp3lame`).
    Mp3,
    Opus,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportAudioChannels {
    Stereo,
    Mono,
    #[serde(rename = "5.1")]
    FivePointOne,
}

/// Destination category for the 导出到 dropdown. The well-known Windows folder
/// variants are resolved by the `resolve_known_folder` command on the frontend;
/// the backend only consumes the resolved `output_dir`, so this is persisted for
/// UI state round-tripping rather than used for path logic here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportDestination {
    Specified,
    Source,
    Desktop,
    Documents,
    User,
    Videos,
    Pictures,
}

/// Output filename rule for the 重命名规则 group. The frontend resolves the
/// rule into a concrete per-clip `output_name`; this enum only round-trips the
/// persisted UI state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportRenameRule {
    Label,
    LabelKeywords,
    Time,
    TimeLabel,
    Filename,
    FilenameLabel,
    FilenameTime,
    Custom,
    CustomLabel,
    CustomTime,
    CustomFilename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportExtensionCase {
    Upper,
    Lower,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportExistingFileMode {
    Ask,
    #[serde(rename = "uniqueName")]
    UniqueName,
    Overwrite,
    Skip,
}

const fn default_export_existing_file_mode() -> ExportExistingFileMode {
    ExportExistingFileMode::Ask
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportOptions {
    pub(crate) mode: ExportMode,
    pub(crate) container: ExportContainer,
    pub(crate) resolution: ExportResolution,
    #[serde(default)]
    pub(crate) custom_width: i64,
    #[serde(default)]
    pub(crate) custom_height: i64,
    pub(crate) frame_rate: Option<f64>,
    pub(crate) quality: ExportQuality,
    pub(crate) encoder_speed: ExportEncoderSpeed,
    #[serde(default = "default_export_hardware_acceleration")]
    pub(crate) hardware_acceleration: ExportHardwareAcceleration,
    #[serde(default = "default_export_track_enabled")]
    pub(crate) include_video: bool,
    #[serde(default = "default_export_track_enabled")]
    pub(crate) include_audio: bool,
    #[serde(default = "default_export_audio_codec")]
    pub(crate) audio_codec: ExportAudioCodec,
    /// None means "match the source sample rate".
    #[serde(default)]
    pub(crate) audio_sample_rate_hz: Option<i64>,
    #[serde(default = "default_export_audio_channels")]
    pub(crate) audio_channels: ExportAudioChannels,
    #[serde(default = "default_export_audio_bitrate_kbps")]
    pub(crate) audio_bitrate_kbps: u32,
    /// Persisted with the project; the import itself runs on the frontend.
    #[serde(default)]
    pub(crate) import_into_project: bool,
    /// Persisted with the project; the frontend swaps clip sources to proxies.
    #[serde(default)]
    pub(crate) use_proxy: bool,
    /// UI state persisted with the project; the frontend resolves the folder.
    #[serde(default = "default_export_destination")]
    pub(crate) destination: ExportDestination,
    #[serde(default)]
    pub(crate) use_subfolder: bool,
    #[serde(default)]
    pub(crate) subfolder_name: String,
    #[serde(default)]
    pub(crate) output_dir: String,
    #[serde(default)]
    pub(crate) output_stem: String,
    /// UI state persisted with the project; the frontend resolves filenames.
    #[serde(default = "default_export_rename_rule")]
    pub(crate) rename_rule: ExportRenameRule,
    #[serde(default)]
    pub(crate) custom_name: String,
    #[serde(default = "default_export_start_number")]
    pub(crate) start_number: i64,
    #[serde(default = "default_export_extension_case")]
    pub(crate) extension_case: ExportExtensionCase,
    /// Explicit merged-output filename (with extension) sent by the frontend for
    /// merge exports, so the backend names the merged file exactly like the
    /// preview instead of after `probed[0]`.
    #[serde(default)]
    pub(crate) output_name: String,
    /// How to handle an output file that already exists (UI state round-trip;
    /// the conflict resolution itself runs on the frontend).
    #[serde(default = "default_export_existing_file_mode")]
    pub(crate) existing_file_mode: ExportExistingFileMode,
}

const fn default_export_hardware_acceleration() -> ExportHardwareAcceleration {
    ExportHardwareAcceleration::Auto
}

const fn default_export_track_enabled() -> bool {
    true
}

const fn default_export_audio_codec() -> ExportAudioCodec {
    ExportAudioCodec::Aac
}

const fn default_export_destination() -> ExportDestination {
    ExportDestination::Specified
}

const fn default_export_rename_rule() -> ExportRenameRule {
    ExportRenameRule::Filename
}

const fn default_export_start_number() -> i64 {
    1
}

const fn default_export_extension_case() -> ExportExtensionCase {
    ExportExtensionCase::Lower
}

const fn default_export_audio_channels() -> ExportAudioChannels {
    ExportAudioChannels::Stereo
}

const fn default_export_audio_bitrate_kbps() -> u32 {
    192
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportOutput {
    pub(crate) clip_id: Option<String>,
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) duration_us: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportResult {
    pub(crate) outputs: Vec<ExportOutput>,
    pub(crate) warnings: Vec<UserNotice>,
}
