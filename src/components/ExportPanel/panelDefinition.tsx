import { definePanel } from "../DockLayout";
import { ExportPanel } from "./ExportPanel";

export const exportPanelType = "export";

export const exportPanelDefinition = definePanel({
  type: exportPanelType,
  Component: ExportPanel,
  useTitle: () => "导出设置",
});
