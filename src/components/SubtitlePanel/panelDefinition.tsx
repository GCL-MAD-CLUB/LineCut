import { definePanel } from "../DockLayout";
import { SubtitlePanel } from "./SubtitlePanel";
import { usePanelMediaSourceSelection } from "../../application/media/panelMediaSources";
import { mediaPanelTitle } from "../../core/editor/panelSourceSelection";

export const subtitlePanelType = "subtitles";

export const subtitlePanelDefinition = definePanel({
  type: subtitlePanelType,
  Component: SubtitlePanel,
  useTitle: () => {
    const { selectedSources } = usePanelMediaSourceSelection();
    return mediaPanelTitle("subtitles", selectedSources);
  },
});
