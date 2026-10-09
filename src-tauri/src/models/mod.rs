//! Shared serialized contracts, grouped by domain.

mod export;
mod media;
mod notice;
mod preferences;
mod probe;
mod proxy;
mod workspace;

pub(crate) use export::*;
pub(crate) use media::*;
pub(crate) use notice::*;
pub(crate) use preferences::*;
pub(crate) use probe::*;
pub(crate) use proxy::*;
pub(crate) use workspace::*;
