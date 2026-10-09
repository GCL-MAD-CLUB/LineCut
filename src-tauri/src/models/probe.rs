use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Default)]
pub(crate) struct ProbeOutput {
    #[serde(default)]
    pub(crate) streams: Vec<ProbeStream>,
    pub(crate) format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct ProbeFormat {
    pub(crate) duration: Option<String>,
    pub(crate) start_time: Option<String>,
    #[serde(default)]
    pub(crate) tags: HashMap<String, String>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct ProbeStream {
    pub(crate) index: i32,
    pub(crate) codec_name: Option<String>,
    pub(crate) codec_type: Option<String>,
    pub(crate) avg_frame_rate: Option<String>,
    pub(crate) r_frame_rate: Option<String>,
    pub(crate) sample_aspect_ratio: Option<String>,
    pub(crate) sample_rate: Option<String>,
    pub(crate) channel_layout: Option<String>,
    pub(crate) width: Option<i64>,
    pub(crate) height: Option<i64>,
    pub(crate) channels: Option<i64>,
    #[serde(default)]
    pub(crate) tags: HashMap<String, String>,
    #[serde(default)]
    pub(crate) disposition: HashMap<String, i32>,
}
