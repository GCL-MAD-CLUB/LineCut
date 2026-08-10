import { parseFrameRate } from "../../timeline";
import { expandedStoryboardKeywordText } from "../../components/StoryboardPanel/storyboardKeywords";
import type { MediaBinItem, MediaStream, Project, StoryboardState } from "../../types";
import {
  isMediaItemEnabled,
  isMediaItemOffline,
  mediaItemProject,
  resolvedMediaAudioSources,
  subtitleTrackContext,
  subtitleTrackCues,
} from "../../systems/ProjectSystem";
import type {
  ExportClip,
  ExportClipAudioSource,
  ExportSource,
  ExportSourceMedia,
} from "./exportTypes";

function parseAspectRatio(value?: string | null) {
  if (!value) {
    return null;
  }
  const [width, height] = value.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function sourceMediaFromProject(
  project: Project,
  resolvedAudioStream: MediaStream | null,
): ExportSourceMedia {
  const videoStream =
    project.asset.video_stream_index !== null
      ? project.streams.find((stream) => stream.index === project.asset.video_stream_index)
      : null;
  const audioStream = resolvedAudioStream;
  const extension = project.asset.file_name.split(".").pop()?.toLocaleLowerCase() ?? "";
  const audioSampleRateHz = audioStream?.sample_rate
    ? Number.parseInt(audioStream.sample_rate, 10) || null
    : null;
  return {
    fileName: project.asset.file_name,
    container: extension ? extension.toUpperCase() : "未知",
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    audioChannels: audioStream?.channels ?? null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    frameRate:
      parseFrameRate(videoStream?.avg_frame_rate) ??
      parseFrameRate(videoStream?.r_frame_rate) ??
      null,
    pixelAspectRatio: parseAspectRatio(videoStream?.sample_aspect_ratio),
    audioSampleRateHz,
    audioChannelLayout: audioStream?.channel_layout ?? null,
    fileSize: project.asset.file_size,
    durationUs: project.asset.duration_us,
  };
}

function clipFromProject(
  id: string,
  videoId: string,
  project: Project,
  label: string,
  startUs: number,
  endUs: number,
  sourceName: string,
  audioSources: ExportClipAudioSource[],
  audioStream: MediaStream | null,
  thumbnail?: ExportClip["thumbnail"],
  keywordText?: string,
): ExportClip {
  const durationUs = endUs > 0 ? Math.max(0, endUs - startUs) : project.asset.duration_us;
  return {
    id,
    videoId,
    sourcePath: project.asset.path,
    label,
    sourceName,
    keywordText,
    startUs,
    endUs,
    hasVideo: project.asset.video_stream_index !== null,
    hasAudio: audioSources.length > 0,
    audioSources,
    durationUs,
    videoStreamIndex: project.asset.video_stream_index,
    thumbnail,
    proxyPath: project.proxy_path ?? null,
    sourceMedia: sourceMediaFromProject(project, audioStream),
  };
}

function exportAudioContext(
  videoId: string,
  project: Project,
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
  detachedVideoIds: Set<string>,
) {
  const resolved = resolvedMediaAudioSources(
    videoId,
    project,
    projects,
    mediaItems,
    detachedVideoIds,
  );
  return {
    sources: resolved.map((source): ExportClipAudioSource => ({
      sourcePath: source.path,
      audioTrackIndex: source.audioTrackIndex,
      primary: source.primary,
    })),
    stream: resolved[0]?.stream ?? null,
  };
}

/** Media-bin display name of a source video (may be a virtual rename). */
function videoMediaBinName(mediaItems: MediaBinItem[], videoId: string, project: Project) {
  return (
    mediaItems.find((item) => item.id === videoId && item.kind === "video")?.file_name ??
    project.asset.file_name
  );
}

function activeVideoProject(
  mediaItems: MediaBinItem[],
  projects: Record<string, Project>,
  videoId: string,
) {
  const video = mediaItems.find(
    (item) =>
      item.id === videoId &&
      item.kind === "video" &&
      isMediaItemEnabled(item) &&
      !isMediaItemOffline(item),
  );
  return video ? mediaItemProject(video, projects, mediaItems) : undefined;
}

/** Matches the storyboard panel: the shot's annotation title, or a padded 分镜 N fallback. */
function storyboardShotTitle(
  shot: { sequence: number },
  shotCount: number,
  annotationTitle: string | null | undefined,
) {
  if (annotationTitle?.trim()) {
    return annotationTitle.trim();
  }
  const digits = Math.max(1, String(Math.max(1, shotCount)).length);
  return `分镜 ${String(shot.sequence).padStart(digits, "0")}`;
}

export interface StoryboardExportInput {
  videoId: string;
  assetId: string;
  fingerprint?: string;
  shotIds: string[];
  storyboards: Record<string, StoryboardState>;
  mediaItems: MediaBinItem[];
  projects: Record<string, Project>;
  detachedVideoIds: Set<string>;
}

/** Builds an export source from the storyboard shots currently selected in the editor. */
export function buildStoryboardExportSource({
  videoId,
  assetId,
  fingerprint = "",
  shotIds,
  storyboards,
  mediaItems,
  projects,
  detachedVideoIds,
}: StoryboardExportInput): ExportSource | null {
  const project = activeVideoProject(mediaItems, projects, videoId);
  if (!project || shotIds.length === 0) {
    return null;
  }
  const videoContext = `${videoId}:${assetId}:${fingerprint}`;
  const storyboard = storyboards[videoContext];
  const shots = storyboard?.shots ?? [];
  const audio = exportAudioContext(videoId, project, projects, mediaItems, detachedVideoIds);
  const shotIdsSet = new Set(shotIds);
  const clips = shots
    .filter((shot) => shotIdsSet.has(shot.id))
    .map((shot) =>
      clipFromProject(
        `shot:${shot.id}`,
        videoId,
        project,
        storyboardShotTitle(shot, shots.length, storyboard?.shotAnnotations?.[shot.id]?.title),
        shot.start_us,
        shot.end_us,
        videoMediaBinName(mediaItems, videoId, project),
        audio.sources,
        audio.stream,
        {
          kind: "storyboard",
          assetId: project.asset.id,
          timeUs: shot.start_us,
          fingerprint: project.asset.fingerprint,
        },
        // Filename keyword string: comma-joined without spaces (the shared
        // helper uses ", " for the panel display).
        expandedStoryboardKeywordText(
          storyboard?.shotAnnotations?.[shot.id]?.keywordIds,
          storyboard?.keywordNodes ?? [],
        ).replace(/,\s+/g, ","),
      ),
    );
  if (clips.length === 0) {
    return null;
  }
  return {
    kind: "storyboard",
    title: `${clips.length} 个分镜片段`,
    clips,
    assetId: project.asset.id,
  };
}

export interface SubtitleExportInput {
  videoId: string;
  trackId: string;
  cueIds: string[];
  mediaItems: MediaBinItem[];
  projects: Record<string, Project>;
  detachedVideoIds: Set<string>;
}

/** Builds an export source from the subtitle cues currently selected in the editor. */
export function buildSubtitleExportSource({
  videoId,
  trackId,
  cueIds,
  mediaItems,
  projects,
  detachedVideoIds,
}: SubtitleExportInput): ExportSource | null {
  const video = mediaItems.find(
    (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
  );
  const project = video ? mediaItemProject(video, projects, mediaItems) : undefined;
  if (!project || cueIds.length === 0 || !trackId) {
    return null;
  }
  const context = subtitleTrackContext(project, projects, mediaItems, videoId, trackId);
  if (!context) {
    return null;
  }
  const cues = subtitleTrackCues(project, projects, mediaItems, videoId, trackId);
  const audio = exportAudioContext(videoId, project, projects, mediaItems, detachedVideoIds);
  const cueIdsSet = new Set(cueIds);
  const clips = cues
    .filter((cue) => cueIdsSet.has(cue.id))
    .map((cue) =>
      clipFromProject(
        `cue:${cue.id}`,
        videoId,
        project,
        subtitleLabel(cue),
        cue.start_us,
        cue.end_us,
        videoMediaBinName(mediaItems, videoId, project),
        audio.sources,
        audio.stream,
        {
          kind: "subtitle",
          assetId: project.asset.id,
          timeUs: cue.start_us,
          fingerprint: project.asset.fingerprint,
        },
      ),
    );
  if (clips.length === 0) {
    return null;
  }
  return {
    kind: "subtitle",
    title: `${clips.length} 个字幕片段`,
    clips,
    assetId: project.asset.id,
  };
}

function subtitleLabel(cue: { sequence: number; plain_text: string }) {
  // Show the subtitle text itself (multi-line cues keep their line breaks).
  return cue.plain_text.trim();
}

export interface MediaBinExportInput {
  itemIds: string[];
  mediaItems: MediaBinItem[];
  projects: Record<string, Project>;
  detachedVideoIds: Set<string>;
}

/** Builds an export source from the full videos selected in the media bin. */
export function buildMediaBinExportSource({
  itemIds,
  mediaItems,
  projects,
  detachedVideoIds,
}: MediaBinExportInput): ExportSource | null {
  const selected = new Set(itemIds);
  const clips = mediaItems
    .filter(
      (item) =>
        selected.has(item.id) &&
        item.kind === "video" &&
        isMediaItemEnabled(item) &&
        !isMediaItemOffline(item),
    )
    .map((item) => {
      const project = mediaItemProject(item, projects, mediaItems);
      const audio = project
        ? exportAudioContext(item.id, project, projects, mediaItems, detachedVideoIds)
        : null;
      return project
        ? clipFromProject(
            `media:${item.id}`,
            item.id,
            project,
            item.file_name,
            0,
            0,
            item.file_name,
            audio?.sources ?? [],
            audio?.stream ?? null,
            {
              kind: "video",
              assetId: project.asset.id,
              timeUs: 0,
              fingerprint: project.asset.fingerprint,
            },
          )
        : null;
    })
    .filter((clip): clip is ExportClip => clip !== null);
  if (clips.length === 0) {
    return null;
  }
  return {
    kind: "media-bin",
    title: `${clips.length} 个视频`,
    clips,
    assetId: clips[0].thumbnail?.assetId,
  };
}

/** Refreshes a saved export selection from the media bin's current binding state. */
export function refreshExportClipAudioBindings(
  clips: ExportClip[],
  mediaItems: MediaBinItem[],
  projects: Record<string, Project>,
  detachedVideoIds: Set<string>,
): ExportClip[] {
  return clips.flatMap((clip) => {
    if (!clip.videoId) {
      return [clip];
    }
    const video = mediaItems.find(
      (item) =>
        item.id === clip.videoId &&
        item.kind === "video" &&
        isMediaItemEnabled(item) &&
        !isMediaItemOffline(item),
    );
    if (!video) {
      return [];
    }
    const project = mediaItemProject(video, projects, mediaItems);
    if (!project) {
      return [];
    }
    const audio = exportAudioContext(video.id, project, projects, mediaItems, detachedVideoIds);
    return [
      {
        ...clip,
        sourcePath: project.asset.path,
        hasVideo: project.asset.video_stream_index !== null,
        hasAudio: audio.sources.length > 0,
        audioSources: audio.sources,
        proxyPath: project.proxy_path ?? null,
        sourceMedia: sourceMediaFromProject(project, audio.stream),
      },
    ];
  });
}

export function refreshExportSourceAudioBindings(
  source: ExportSource,
  mediaItems: MediaBinItem[],
  projects: Record<string, Project>,
  detachedVideoIds: Set<string>,
): ExportSource {
  return {
    ...source,
    clips: refreshExportClipAudioBindings(source.clips, mediaItems, projects, detachedVideoIds),
  };
}
