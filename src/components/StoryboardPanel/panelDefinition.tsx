import { mediaDisplayName, useProjectPort } from "../../systems/ProjectSystem";
import { definePanel } from "../DockLayout";
import { StoryboardPanel } from "./StoryboardPanel";

export const storyboardPanelType = "storyboard";

export const storyboardPanelDefinition = definePanel({
  type: storyboardPanelType,
  Component: StoryboardPanel,
  useTitle: () => {
    const { activeVideoId, mediaItems, project, storyboards } = useProjectPort(
      ["activeVideoId", "mediaItems", "project", "storyboards"],
      [],
    );
    if (!project) {
      return "分镜：（无剪辑）";
    }
    const videoContext = `${activeVideoId}:${project.asset.id}:${project.asset.fingerprint ?? ""}`;
    return `分镜：${storyboards[videoContext]?.shots.length ? mediaDisplayName(project, mediaItems, activeVideoId) : "（未识别）"}`;
  },
});
