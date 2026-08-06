import { parseFrameRate } from "../../timeline";
import type { MediaBinItem, Project, StoryboardState } from "../../types";
import {
  isMediaItemEnabled,
  isMediaItemOffline,
  mediaItemProject,
  subtitleTrackContext,
  subtitleTrackCues,
} from "../../systems/ProjectSystem";
import type { ExportClip, ExportSource, ExportSourceMedia } from "./exportTypes";

function parseAspectRatio(value?: string | null) {
  if (!value) {
    return null;
  }
  const [width, height] = value.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function sourceMediaFromProject(project: Project): ExportSourceMedia {
  const videoStream =
    project.asset.video_stream_index !== null
      ? project.streams.find((stream) => stream.index === project.asset.video_stream_index)
      : null;
  const audioStream =
    project.asset.audio_stream_index !== null
      ? project.streams.find((stream) => stream.index === project.asset.audio_stream_index)
      : null;
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
  project: Project,
  label: string,
  startUs: number,
  endUs: number,
  thumbnail?: ExportClip["thumbnail"],
): ExportClip {
  const durationUs = endUs > 0 ? Math.max(0, endUs - startUs) : project.asset.duration_us;
  return {
    id,
    sourcePath: project.asset.path,
    label,
    startUs,
    endUs,
    hasVideo: project.asset.video_stream_index !== null,
    hasAudio: project.asset.audio_stream_index !== null,
    durationUs,
    videoStreamIndex: project.asset.video_stream_index,
    thumbnail,
    proxyPath: project.proxy_path ?? null,
    sourceMedia: sourceMediaFromProject(project),
  };
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
}: StoryboardExportInput): ExportSource | null {
  const project = activeVideoProject(mediaItems, projects, videoId);
  if (!project || shotIds.length === 0) {
    return null;
  }
  const videoContext = `${videoId}:${assetId}:${fingerprint}`;
  const storyboard = storyboards[videoContext];
  const shots = storyboard?.shots ?? [];
  const shotIdsSet = new Set(shotIds);
  const clips = shots
    .filter((shot) => shotIdsSet.has(shot.id))
    .map((shot) =>
      clipFromProject(
        `shot:${shot.id}`,
        project,
        storyboardShotTitle(shot, shots.length, storyboard?.shotAnnotations?.[shot.id]?.title),
        shot.start_us,
        shot.end_us,
        {
          kind: "storyboard",
          assetId: project.asset.id,
          timeUs: shot.start_us,
          fingerprint: project.asset.fingerprint,
        },
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
}

/** Builds an export source from the subtitle cues currently selected in the editor. */
export function buildSubtitleExportSource({
  videoId,
  trackId,
  cueIds,
  mediaItems,
  projects,
}: SubtitleExportInput): ExportSource | null {
  const video = mediaItems.find(
    (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
  );
  const project = video ? mediaItemProject(video, projects, mediaItems) : undefined;
  if (!project || cueIds.length === 0 || !trackId) {
    return null;
  }
  const context = subtitleTrackContext(project, projects, mediaItems, videoId, trackId);
  const sourceProject = context?.project ?? project;
  const cues = subtitleTrackCues(project, projects, mediaItems, videoId, trackId);
  const cueIdsSet = new Set(cueIds);
  const clips = cues
    .filter((cue) => cueIdsSet.has(cue.id))
    .map((cue) =>
      clipFromProject(
        `cue:${cue.id}`,
        sourceProject,
        subtitleLabel(cue),
        cue.start_us,
        cue.end_us,
        {
          kind: "subtitle",
          assetId: sourceProject.asset.id,
          timeUs: cue.start_us,
          fingerprint: sourceProject.asset.fingerprint,
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
    assetId: sourceProject.asset.id,
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
}

/** Builds an export source from the full videos selected in the media bin. */
export function buildMediaBinExportSource({
  itemIds,
  mediaItems,
  projects,
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
      return project
        ? clipFromProject(`media:${item.id}`, project, item.file_name, 0, 0, {
            kind: "video",
            assetId: project.asset.id,
            timeUs: 0,
            fingerprint: project.asset.fingerprint,
          })
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
