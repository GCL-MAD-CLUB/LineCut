import { definePanel } from "../../common/DockLayout";
import { SubtitlePanel } from "./SubtitlePanel";
import {
  usePanelMediaSourceSelection,
  usePanelMediaWorkspaceMenu,
} from "../../../application/media/panelMediaSources";
import { mediaPanelTitle } from "../../../core/editor/panelSourceSelection";

export const subtitlePanelType = "subtitles";

export const subtitlePanelDefinition = definePanel({
  type: subtitlePanelType,
  Component: SubtitlePanel,
  useMenuItems: () => usePanelMediaWorkspaceMenu("subtitles"),
  useTitle: () => {
    const { selectedSources } = usePanelMediaSourceSelection();
    return mediaPanelTitle("subtitles", selectedSources);
  },
});
