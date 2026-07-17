import { definePanel } from "../DockLayout";
import { useAppStore } from "../../store";
import { SourceMonitor } from "./SourceMonitor";

export const sourcePanelType = "source";

export const sourcePanelDefinition = definePanel({
  type: sourcePanelType,
  Component: SourceMonitor,
  useTitle: () => {
    const project = useAppStore((state) => state.project);
    return `源：${project?.asset.file_name ?? "（无剪辑）"}`;
  },
});
