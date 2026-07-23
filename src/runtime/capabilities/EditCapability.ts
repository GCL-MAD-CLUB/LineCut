import { useMemo } from "react";
import { useBroadcastEvent } from "../events/react";
import type { SystemIdentity } from "../systems/identity";
import { EDIT_CAPABILITY_PROJECTION, type EditCapabilityProjection } from "../state/contracts";
import { usePublishProjection } from "../state/react";

type EditOperation = keyof EditCapabilityProjection["capabilities"];
type EditHandler = () => void | Promise<void>;

export interface EditCapabilityOptions {
  identity: SystemIdentity;
  active: boolean;
  selectedCount: number;
  visibleCount: number;
  readOnly?: boolean;
  pasteCount?: number;
  handlers: Partial<Record<EditOperation, EditHandler>>;
}

export function useEditCapability(options: EditCapabilityOptions) {
  const {
    identity,
    active,
    selectedCount,
    visibleCount,
    readOnly = false,
    pasteCount = 0,
    handlers,
  } = options;
  const can = {
    copy: Boolean(handlers.copy && selectedCount > 0),
    paste: Boolean(handlers.paste && !readOnly && pasteCount > 0),
    clear: Boolean(handlers.clear && !readOnly && selectedCount > 0),
    duplicate: Boolean(handlers.duplicate && !readOnly && selectedCount > 0),
    selectAll: Boolean(handlers.selectAll && visibleCount > 0),
    clearSelection: Boolean(handlers.clearSelection && selectedCount > 0),
  };
  const projection = useMemo<EditCapabilityProjection>(
    () => ({ active, selectedCount, visibleCount, capabilities: can }),
    [
      active,
      can.clear,
      can.clearSelection,
      can.copy,
      can.duplicate,
      can.paste,
      can.selectAll,
      selectedCount,
      visibleCount,
    ],
  );
  usePublishProjection(EDIT_CAPABILITY_PROJECTION, identity, projection);

  async function run(operation: EditOperation) {
    const handler = handlers[operation];
    if (!active || !can[operation] || !handler) {
      return "ignored" as const;
    }
    await handler();
    return "handled" as const;
  }

  useBroadcastEvent(identity, "edit.copy.requested", () => run("copy"));
  useBroadcastEvent(identity, "edit.paste.requested", () => run("paste"));
  useBroadcastEvent(identity, "edit.clear.requested", () => run("clear"));
  useBroadcastEvent(identity, "edit.duplicate.requested", () => run("duplicate"));
  useBroadcastEvent(identity, "edit.select-all.requested", () => run("selectAll"));
  useBroadcastEvent(identity, "edit.clear-selection.requested", () => run("clearSelection"));
}
