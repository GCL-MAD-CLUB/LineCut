use crate::backend::default_cache_root;
use crate::{DEFAULT_FFMPEG_PROGRAM, DEFAULT_FFPROBE_PROGRAM};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Preferences {
    pub(crate) cache_dir: String,
    pub(crate) ffmpeg_path: String,
    pub(crate) ffprobe_path: String,
    #[serde(default = "default_auto_save_interval_minutes")]
    pub(crate) auto_save_interval_minutes: u32,
    #[serde(default = "default_auto_save_max_snapshots")]
    pub(crate) auto_save_max_snapshots: u32,
}

const fn default_auto_save_interval_minutes() -> u32 {
    5
}

const fn default_auto_save_max_snapshots() -> u32 {
    20
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            cache_dir: default_cache_root().to_string_lossy().into_owned(),
            ffmpeg_path: DEFAULT_FFMPEG_PROGRAM.to_string(),
            ffprobe_path: DEFAULT_FFPROBE_PROGRAM.to_string(),
            auto_save_interval_minutes: default_auto_save_interval_minutes(),
            auto_save_max_snapshots: default_auto_save_max_snapshots(),
        }
    }
}
