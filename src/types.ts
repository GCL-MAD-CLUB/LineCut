export type SubtitleSourceType = "embedded" | "external";
export type SubtitleKind = "text" | "bitmap";

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

export type SubtitleCueColorLabel = "red" | "yellow" | "green" | "blue" | "purple";

export interface SubtitleCueAnnotation {
  rating: number;
  retained: boolean;
  excluded?: boolean;
  colorLabel?: SubtitleCueColorLabel | null;
  customLabel?: string | null;
}

export interface SubtitleState {
  cueAnnotations: Record<string, SubtitleCueAnnotation>;
}

export interface StoryboardShot {
  id: string;
  sequence: number;
  start_frame: number;
  end_frame: number;
  start_us: number;
  end_us: number;
}

export type StoryboardShotColorLabel = "red" | "yellow" | "green" | "blue" | "purple";

export interface StoryboardKeywordNode {
  id: string;
  name: string;
  parentId: string | null;
  synonyms?: string[];
}

export interface StoryboardKeywordUsageCounters {
  counts: Record<string, number>;
  total: number;
}

export interface StoryboardShotAnnotation {
  rating: number;
  retained: boolean;
  excluded?: boolean;
  title?: string | null;
  keywordIds?: string[] | null;
  colorLabel?: StoryboardShotColorLabel | null;
  customLabel?: string | null;
}

export interface StoryboardShotStackState {
  id: string;
  shotIds: string[];
}

export interface StoryboardState {
  shots: StoryboardShot[];
  shotStacks: StoryboardShotStackState[];
  keywordNodes: StoryboardKeywordNode[];
  recentKeywordIds: string[];
  keywordUsageCounters?: StoryboardKeywordUsageCounters;
  shotAnnotations: Record<string, StoryboardShotAnnotation>;
}

export interface StoryboardCut {
  cut_frame: number;
  confidence: number;
  event_start: number;
  event_end: number;
  peak_probability: number;
  robust_prominence: number;
  event_area: number;
  event_width: number;
}

export interface StoryboardDetectionResult {
  asset_id: string;
  duration_us: number;
  frame_count: number;
  frame_rate: number;
  provider: string;
  cuts: StoryboardCut[];
  shots: StoryboardShot[];
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
  bin_id: string | null;
  kind: MediaBinItemKind;
  enabled: boolean;
  hidden: boolean;
  offline: boolean;
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

export interface MediaBinFolder {
  id: string;
  name: string;
  parent_id: string | null;
  color: string;
  hidden: boolean;
}

export interface ProjectMediaBinState {
  items: MediaBinItem[];
  folders: MediaBinFolder[];
}

export interface ProjectPreviewState {
  use_proxy: boolean;
}

export interface ProjectEditorState {
  active_video_id: string;
  active_track_id: string;
  detached_video_ids: string[];
  preview: ProjectPreviewState;
}

/** The export settings recorded with the last completed export of this project. */
export interface ProjectExportState {
  mode: "merge" | "individual";
  container: "mp4_h264" | "mp4_hevc" | "mov_prores" | "webm_vp9";
  resolution: "match_source" | "custom";
  customWidth: number;
  customHeight: number;
  frameRate: number | null;
  quality: "low" | "medium" | "high" | "very_high";
  encoderSpeed: "fast" | "balanced" | "quality";
  includeAudio: boolean;
  audioCodec: "aac" | "mp2" | "mp3" | "opus";
  /** null means "match the source sample rate". */
  audioSampleRateHz: number | null;
  audioChannels: "stereo" | "mono" | "5.1";
  audioBitrateKbps: number;
  importIntoProject: boolean;
  useProxy: boolean;
  destination:
    | "specified"
    | "source"
    | "choose_later"
    | "desktop"
    | "documents"
    | "user"
    | "videos"
    | "pictures";
  useSubfolder: boolean;
  subfolderName: string;
  outputDir: string;
  outputStem: string;
  renameRule:
    | "label"
    | "label_keywords"
    | "time"
    | "time_label"
    | "filename"
    | "filename_label"
    | "filename_time"
    | "custom"
    | "custom_label"
    | "custom_time"
    | "custom_filename";
  customName: string;
  startNumber: number;
  extensionCase: "upper" | "lower";
  /** Explicit merged-output filename (with extension) round-tripped from the backend. */
  outputName: string;
  existingFileMode: "ask" | "uniqueName" | "overwrite" | "skip";
}

export interface ProjectWorkspace {
  projects: Project[];
  media_bin: ProjectMediaBinState;
  editor: ProjectEditorState;
  subtitles?: Record<string, SubtitleState>;
  storyboards?: Record<string, StoryboardState>;
}

export interface DemuxedAudioTrack {
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

export interface ImportResult {
  project: Project;
  warnings: UserNotice[];
}

export interface UserNotice {
  code: string;
  severity: "info" | "warning";
  message: string;
}

export interface OpenProjectResult {
  path: string;
  /** Stable per-document identity (generated for files that predate it). */
  project_id: string;
  workspace: ProjectWorkspace;
  warnings: UserNotice[];
}

/**
 * One entry in the recently-opened projects list. The project id lets the
 * global per-project state store key data to the document, not its path.
 */
export interface RecentProjectEntry {
  path: string;
  projectId: string;
}

/**
 * Fixed template for the global state stored under one project document id.
 * Only `exportState` is defined today; future state kinds are added as fields.
 */
export interface ProjectStateConfig {
  exportState: ProjectExportState | null;
}

export interface ProxyResult {
  proxy_path: string;
}

export interface AddExternalSubtitlesResult {
  tracks: SubtitleTrack[];
  cues: Record<string, SubtitleCue[]>;
  warnings: UserNotice[];
}

export interface Preferences {
  cache_dir: string;
  ffmpeg_path: string;
  ffprobe_path: string;
  auto_save_interval_minutes: number;
  auto_save_max_snapshots: number;
}
