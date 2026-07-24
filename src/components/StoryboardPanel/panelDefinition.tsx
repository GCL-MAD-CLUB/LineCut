import { definePanel } from "../DockLayout";
import { StoryboardPanel } from "./StoryboardPanel";

export const storyboardPanelType = "storyboard";

export const storyboardPanelDefinition = definePanel({
  type: storyboardPanelType,
  Component: StoryboardPanel,
  useTitle: () => "分镜",
});
