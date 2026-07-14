export type SubtitleSourceType = "embedded" | "external";
export type SubtitleKind = "text" | "bitmap";
export type ExportMode = "fast_copy" | "precise_encode";
export type ExportLayout = "individual" | "merged";
export type ExportNameRule = "source_time_range" | "source_dialogue" | "time_range" | "dialogue";

export interface MediaAsset {
  id: string;
  path: string;
  file_name: string;
  file_size: number;
  modified_at: number;
  fingerprint: string;
  duration_us: number;
  start_time_us: number;
  video_stream_index: number | null;
  audio_stream_index: number | null;
}

export interface MediaStream {
  index: number;
  codec_type: string;
  codec_name: string;
  avg_frame_rate?: string | null;
  r_frame_rate?: string | null;
  sample_aspect_ratio?: string | null;
  sample_rate?: string | null;
  channel_layout?: string | null;
  language: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
  disposition: Record<string, number>;
}

export interface SubtitleTrack {
  id: string;
  asset_id: string;
  source_type: SubtitleSourceType;
  stream_index: number | null;
  source_path: string | null;
  codec: string;
  language: string | null;
  title: string | null;
  kind: SubtitleKind;
  offset_us: number;
  cue_count: number;
  warning: string | null;
}

export interface SubtitleCue {
  id: string;
  track_id: string;
  sequence: number;
  start_us: number;
  end_us: number;
  raw_text: string;
  plain_text: string;
  speaker: string | null;
  style: string | null;
  layer: number | null;
}

export interface Project {
  asset: MediaAsset;
  streams: MediaStream[];
  tracks: SubtitleTrack[];
  cues: Record<string, SubtitleCue[]>;
  cache_dir: string;
  proxy_path: string | null;
}

export type MediaBinItemKind = "video" | "audio" | "subtitle";
export type MediaBinItemOrigin = "imported" | "decomposed";

export interface MediaBinItem {
  id: string;
  kind: MediaBinItemKind;
  enabled: boolean;
  hidden: boolean;
  path: string;
  file_name: string;
  duration_us: number;
  start_time_us: number;
  bound_to_video_id: string | null;
  source_video_id: string | null;
  stream_index: number | null;
  subtitle_track_id: string | null;
  codec: string | null;
  language: string | null;
  extracted: boolean;
  origin: MediaBinItemOrigin;
  color: string;
}

export interface ProjectMediaBinState {
  items: MediaBinItem[];
  read_only: boolean;
}

export interface ProjectPreviewState {
  use_proxy: boolean;
}

export interface ProjectEditorState {
  active_video_id: string;
  active_track_id: string;
  selected_cue_ids: string[];
  detached_video_ids: string[];
  preview: ProjectPreviewState;
}

export interface ProjectWorkspace {
  projects: Project[];
  media_bin: ProjectMediaBinState;
  editor: ProjectEditorState;
}

export interface DemuxedAudioTrack {
  path: string;
  file_name: string;
  duration_us: number;
  stream_index: number;
  codec: string;
  language: string | null;
  title: string | null;
}

export interface DemuxMediaResult {
  audio_tracks: DemuxedAudioTrack[];
  subtitle_tracks: SubtitleTrack[];
}

export interface ExportBoundMedia {
  kind: "audio" | "subtitle";
  path: string;
}

export interface ImportResult {
  project: Project;
  warnings: string[];
}

export interface OpenProjectResult {
  path: string;
  workspace: ProjectWorkspace;
  warnings: string[];
}

export interface ProxyResult {
  proxy_path: string;
}

export interface AddExternalSubtitlesResult {
  tracks: SubtitleTrack[];
  cues: Record<string, SubtitleCue[]>;
  warnings: string[];
}

export interface ExportOptions {
  head_padding_ms: number;
  tail_padding_ms: number;
  merge_gap_ms: number;
  mode: ExportMode;
  layout: ExportLayout;
  output_dir: string;
  output_dir_explicit: boolean;
  export_name_rule: ExportNameRule;
  dialogue_line_indexes: number[];
}

export interface ClipRange {
  index: number;
  start_us: number;
  end_us: number;
  cue_ids: string[];
  head_padding_us: number;
  tail_padding_us: number;
}

export interface ExportResult {
  ranges: ClipRange[];
  files: string[];
  output_dir: string;
  log: string[];
}

export interface Preferences {
  cache_dir: string;
  default_export_dir: string;
  ffmpeg_path: string;
  ffprobe_path: string;
}
