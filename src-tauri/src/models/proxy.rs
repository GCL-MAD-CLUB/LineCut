use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyOptions {
    pub(crate) frame_size: ProxyFrameSize,
    pub(crate) custom_width: i64,
    pub(crate) custom_height: i64,
    pub(crate) preset: ProxyPreset,
    pub(crate) watermark: ProxyWatermark,
    pub(crate) location: ProxyLocation,
    pub(crate) custom_location: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyFrameSize {
    Full,
    Half,
    Quarter,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyPreset {
    H264Mp4,
    H264Mp4AllIntra,
    H264Quicktime,
    Vp8Webm,
    Vp9Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyWatermark {
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyLocation {
    SourceProxyFolder,
    Custom,
    PreferencesCache,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProxyResult {
    pub(crate) proxy_path: String,
}
