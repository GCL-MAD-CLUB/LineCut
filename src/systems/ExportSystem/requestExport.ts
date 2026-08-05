import { publishEvent } from "../../runtime/events/react";
import type { ExportSource } from "./exportTypes";
import { exportWorkspaceStore } from "./exportWorkspaceState";

/**
 * The interface the editor area uses to hand clips to the export page.
 *
 * It stores the source synchronously (so the export workspace renders immediately),
 * then broadcasts `export.requested` for the app shell to switch to the export workspace.
 * Any future entry point only needs to construct an `ExportSource` and call this.
 */
export function requestExport(source: ExportSource) {
  exportWorkspaceStore.getState().setSource(source);
  publishEvent("export.requested", { source }, { system: "export-system" });
}
