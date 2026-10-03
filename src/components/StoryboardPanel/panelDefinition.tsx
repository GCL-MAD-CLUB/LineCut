import { definePanel } from "../DockLayout";
import { StoryboardPanel } from "./StoryboardPanel";
import { usePanelMediaSourceSelection } from "../../application/media/panelMediaSources";
import { mediaPanelTitle } from "../../core/editor/panelSourceSelection";

export const storyboardPanelType = "storyboard";

export const storyboardPanelDefinition = definePanel({
  type: storyboardPanelType,
  Component: StoryboardPanel,
  useTitle: () => {
    const { selectedSources } = usePanelMediaSourceSelection();
    return mediaPanelTitle("storyboard", selectedSources);
  },
});
