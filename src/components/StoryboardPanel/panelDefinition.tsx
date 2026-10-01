import { mediaDisplayName, useProjectPort } from "../../systems/ProjectSystem";
import { definePanel } from "../DockLayout";
import { StoryboardPanel } from "./StoryboardPanel";
import { usePanelMediaSourceSelection } from "../../application/media/panelMediaSources";

export const storyboardPanelType = "storyboard";

export const storyboardPanelDefinition = definePanel({
  type: storyboardPanelType,
  Component: StoryboardPanel,
  useTitle: () => {
    const { activeVideoId, project } = usePanelMediaSourceSelection();
    const { mediaItems, storyboards } = useProjectPort(["mediaItems", "storyboards"], []);
    if (!project) {
      return "分镜：（无剪辑）";
    }
    const videoContext = `${activeVideoId}:${project.asset.id}:${project.asset.fingerprint ?? ""}`;
    return `分镜：${storyboards[videoContext]?.shots.length ? mediaDisplayName(project, mediaItems, activeVideoId) : "（无）"}`;
  },
});
