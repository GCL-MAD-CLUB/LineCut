import type { MediaBinItem, Project, StoryboardState } from "../../types";
import {
  isMediaItemEnabled,
  isMediaItemOffline,
  mediaItemProject,
  subtitleTrackContext,
  subtitleTrackCues,
} from "../../systems/ProjectSystem";
import type { ExportClip, ExportSource } from "./exportTypes";

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
        `分镜 ${shot.sequence}`,
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
  const text = cue.plain_text.trim().replace(/\s+/g, " ");
  const excerpt = text.length > 20 ? `${text.slice(0, 20)}…` : text;
  return excerpt ? `字幕 ${cue.sequence} ${excerpt}` : `字幕 ${cue.sequence}`;
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
