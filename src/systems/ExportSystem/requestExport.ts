import { publishEvent } from "../../runtime/events/react";
import type { ExportSource } from "./exportTypes";
import { exportWorkspaceStore } from "./exportWorkspaceState";

/** The editor-area entry point: stores the source synchronously (so the export workspace renders immediately), then broadcasts `export.requested` for the app shell to switch to the export workspace. */
export function requestExport(source: ExportSource) {
  exportWorkspaceStore.getState().setSource(source);
  publishEvent("export.requested", { source }, { system: "export-system" });
}
