//! Backend domain modules and their command entry points.
use crate::error::*;
use crate::models::*;
#[cfg(windows)]
use crate::CREATE_NO_WINDOW;
use crate::{
    DEFAULT_FFMPEG_PROGRAM, DEFAULT_FFPROBE_PROGRAM, HEAD_TAIL_HASH_BYTES, PROXY_FILE_NAME,
};
use encoding_rs::{BIG5, GBK, SHIFT_JIS, WINDOWS_1252};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Command as StdCommand;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

mod browser_visual;
mod cache;
mod commands;
mod export;
mod ffmpeg;
mod frame_trace;
mod import_browser;
mod import_copy;
mod media;
mod media_ingest;
mod native_drag_drop;
mod proxy;
mod rolling_pcm;
mod state;
mod storage;
mod storyboard;
mod subtitles;
mod tasks;
mod thumbnail;
mod workspace;

pub(crate) use browser_visual::*;
pub(crate) use commands::*;
pub(crate) use export::*;
pub(crate) use ffmpeg::*;
pub(crate) use frame_trace::*;
pub(crate) use import_browser::*;
pub(crate) use import_copy::*;
pub(crate) use media::*;
pub(crate) use media_ingest::*;
pub(crate) use native_drag_drop::*;
pub(crate) use proxy::*;
pub(crate) use rolling_pcm::*;
pub(crate) use state::*;
pub(crate) use storage::*;
pub(crate) use storyboard::*;
pub(crate) use subtitles::*;
pub(crate) use tasks::*;
pub(crate) use thumbnail::*;
pub(crate) use workspace::*;
