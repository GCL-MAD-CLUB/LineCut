import {
  isMediaItemEnabled,
  isMediaItemOffline,
  mediaItemProject,
  visibleSubtitleTracks,
} from "../../systems/ProjectSystem";
import type { MediaBinItem, Project } from "../../types";

export interface PanelMediaSource {
  item: MediaBinItem;
  project: Project;
  tracks: ReturnType<typeof visibleSubtitleTracks>;
}

/**
 * Videos a panel may offer as a source, paired with the subtitle tracks visible for each.
 *
 * Offline videos stay listed when a proxy exists, because panels can still scrub and display them.
 * Callers that need the original file — storyboard detection, for instance — must narrow this
 * further with their own eligibility predicate.
 */
export function panelMediaSources(
  projects: Record<string, Project>,
  mediaItems: MediaBinItem[],
): PanelMediaSource[] {
  return mediaItems.flatMap((item) => {
    if (item.kind !== "video" || !isMediaItemEnabled(item)) return [];
    const project = mediaItemProject(item, projects, mediaItems);
    if (!project || project.asset.video_stream_index == null) return [];
    if (isMediaItemOffline(item) && !project.proxy_path) return [];
    return [
      { item, project, tracks: visibleSubtitleTracks(project, mediaItems, item.id, projects) },
    ];
  });
}

export function subtitleTrackLabel(
  mediaItems: MediaBinItem[],
  videoId: string,
  track: Project["tracks"][number],
) {
  const item = mediaItems.find(
    (candidate) =>
      candidate.kind === "subtitle" &&
      candidate.bound_to_video_id === videoId &&
      candidate.subtitle_track_id === track.id &&
      isMediaItemEnabled(candidate),
  );
  return `${item?.file_name || track.title || track.language || track.codec} ${track.cue_count} 条`;
}
