import {
  mediaDisplayName,
  useProjectPort,
  visibleSubtitleTracks,
} from "../../systems/ProjectSystem";
import { definePanel } from "../DockLayout";
import { SubtitlePanel } from "./SubtitlePanel";

export const subtitlePanelType = "subtitles";

export const subtitlePanelDefinition = definePanel({
  type: subtitlePanelType,
  Component: SubtitlePanel,
  useTitle: () => {
    const { activeVideoId, mediaItems, project, projects } = useProjectPort(
      ["activeVideoId", "mediaItems", "project", "projects"],
      [],
    );
    if (!project) {
      return "字幕：（无剪辑）";
    }
    const hasSubtitles =
      visibleSubtitleTracks(project, mediaItems, activeVideoId, projects).length > 0;
    return `字幕：${hasSubtitles ? mediaDisplayName(project, mediaItems, activeVideoId) : "（无字幕）"}`;
  },
});
