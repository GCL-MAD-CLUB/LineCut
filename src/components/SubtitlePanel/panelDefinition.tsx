import { useProjectPort } from "../../systems/ProjectSystem";
import { definePanel } from "../DockLayout";
import { SubtitlePanel } from "./SubtitlePanel";

export const subtitlePanelType = "subtitles";

export const subtitlePanelDefinition = definePanel({
  type: subtitlePanelType,
  Component: SubtitlePanel,
  useTitle: () => {
    const { project } = useProjectPort(["project"], []);
    return `字幕：${project?.asset.file_name ?? "（无剪辑）"}`;
  },
});
