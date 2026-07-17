import { definePanel } from "../DockLayout";
import { SubtitlePanel } from "./SubtitlePanel";

export const subtitlePanelType = "subtitles";

export const subtitlePanelDefinition = definePanel({
  type: subtitlePanelType,
  Component: SubtitlePanel,
  useTitle: () => "字幕轨",
});
