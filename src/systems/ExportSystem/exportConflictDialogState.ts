import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ExportConflict, ExportConflictAction } from "./exportConflict";

interface PendingConflictRequest {
  conflicts: ExportConflict[];
  resolve: (action: ExportConflictAction) => void;
}

interface ExportConflictDialogState {
  pending: PendingConflictRequest | null;
}

export const exportConflictDialogStore = createStore<ExportConflictDialogState>()(() => ({
  pending: null,
}));

/** Asks the user what to do with conflicting output files, resolving when the dialog picks an action. */
export function requestExportConflictAction(
  conflicts: ExportConflict[],
): Promise<ExportConflictAction> {
  return new Promise((resolve) => {
    // The store holds a single dialog slot. If a request is already outstanding
    // (e.g. a workspace export races a quick export), cancel it rather than
    // orphaning its resolve callback and hanging that export forever.
    const current = exportConflictDialogStore.getState().pending;
    if (current) {
      current.resolve("cancel");
    }
    exportConflictDialogStore.setState({ pending: { conflicts, resolve } });
  });
}

export function resolveExportConflict(action: ExportConflictAction) {
  const pending = exportConflictDialogStore.getState().pending;
  if (!pending) {
    return;
  }
  pending.resolve(action);
  exportConflictDialogStore.setState({ pending: null });
}

export function useExportConflictDialog<Selection>(
  selector: (state: ExportConflictDialogState) => Selection,
) {
  return useStore(exportConflictDialogStore, selector);
}
