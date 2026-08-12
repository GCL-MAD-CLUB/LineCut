import { useMemo } from "react";
import { useBroadcastEvent } from "../events/react";
import type { SystemIdentity } from "../systems/identity";
import {
  MEDIA_SELECTION_CAPABILITY_PROJECTION,
  type MediaSelectionCapabilityProjection,
} from "../state/contracts";
import { usePublishProjection } from "../state/react";

type MediaSelectionOperation = keyof MediaSelectionCapabilityProjection["capabilities"];
type MediaSelectionHandler = () => void | Promise<void>;

export interface MediaSelectionCapabilityOptions {
  identity: SystemIdentity;
  active: boolean;
  offlineSelectionCount: number;
  onlineSelectionCount: number;
  disabled?: boolean;
  handlers: Record<MediaSelectionOperation, MediaSelectionHandler>;
}

/** Makes the focused media-bin selection available to the top-level File menu. */
export function useMediaSelectionCapability(options: MediaSelectionCapabilityOptions) {
  const {
    identity,
    active,
    offlineSelectionCount,
    onlineSelectionCount,
    disabled = false,
    handlers,
  } = options;
  const capabilities = {
    replaceMedia: !disabled && offlineSelectionCount === 0 && onlineSelectionCount === 1,
    linkMedia: !disabled && offlineSelectionCount > 0,
    makeOffline: !disabled && onlineSelectionCount > 0,
  };
  const projection = useMemo<MediaSelectionCapabilityProjection>(
    () => ({
      active,
      selectedCount: offlineSelectionCount + onlineSelectionCount,
      capabilities,
    }),
    [
      active,
      capabilities.linkMedia,
      capabilities.makeOffline,
      capabilities.replaceMedia,
      offlineSelectionCount,
      onlineSelectionCount,
    ],
  );
  usePublishProjection(MEDIA_SELECTION_CAPABILITY_PROJECTION, identity, projection);

  async function run(operation: MediaSelectionOperation) {
    const handler = handlers[operation];
    if (!active || !capabilities[operation] || !handler) {
      return "ignored" as const;
    }
    await handler();
    return "handled" as const;
  }

  useBroadcastEvent(identity, "media.replace-selection.requested", () => run("replaceMedia"));
  useBroadcastEvent(identity, "media.link-selection.requested", () => run("linkMedia"));
  useBroadcastEvent(identity, "media.make-selection-offline.requested", () => run("makeOffline"));
}
