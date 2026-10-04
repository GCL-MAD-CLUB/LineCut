import { definePanel } from "../../common/DockLayout";
import { StoryboardPanel } from "./StoryboardPanel";
import {
  usePanelMediaSourceSelection,
  usePanelMediaWorkspaceMenu,
} from "../../../application/media/panelMediaSources";
import { mediaPanelTitle } from "../../../core/editor/panelSourceSelection";

export const storyboardPanelType = "storyboard";

export const storyboardPanelDefinition = definePanel({
  type: storyboardPanelType,
  Component: StoryboardPanel,
  useMenuItems: () => usePanelMediaWorkspaceMenu("storyboard"),
  useTitle: () => {
    const { selectedSources } = usePanelMediaSourceSelection();
    return mediaPanelTitle("storyboard", selectedSources);
  },
});
