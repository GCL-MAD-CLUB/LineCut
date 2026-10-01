import {
  mediaDisplayName,
  useProjectPort,
  visibleSubtitleTracks,
} from "../../systems/ProjectSystem";
import { definePanel } from "../DockLayout";
import { SubtitlePanel } from "./SubtitlePanel";
import { usePanelMediaSourceSelection } from "../../application/media/panelMediaSources";

export const subtitlePanelType = "subtitles";

export const subtitlePanelDefinition = definePanel({
  type: subtitlePanelType,
  Component: SubtitlePanel,
  useTitle: () => {
    const { activeVideoId, project } = usePanelMediaSourceSelection();
    const { mediaItems, projects } = useProjectPort(["mediaItems", "projects"], []);
    if (!project) {
      return "字幕：（无剪辑）";
    }
    const hasSubtitles =
      visibleSubtitleTracks(project, mediaItems, activeVideoId, projects).length > 0;
    return `字幕：${hasSubtitles ? mediaDisplayName(project, mediaItems, activeVideoId) : "（无字幕）"}`;
  },
});
