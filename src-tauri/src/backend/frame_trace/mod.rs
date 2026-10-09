//! Frame trace extraction: commands coordinate source lookup, caching and decoding.
//! Streaming and metric modules do not depend on application state or cache policy.
mod cache;
mod command;
mod decode;
mod metrics;
mod source;
mod ssim;
mod stream;
mod types;

pub(crate) use command::*;

const TRACE_WIDTH: usize = 96;
const TRACE_HEIGHT: usize = 54;
const COLOR_FRAME_BYTES: usize = TRACE_WIDTH * TRACE_HEIGHT * 3;
