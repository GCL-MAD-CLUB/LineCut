import { useMemo } from "react";
import type { ApplicationEventMap } from "../events/contracts";
import { useBroadcastEvent } from "../events/react";
import { useProjections } from "../state/StateHub";
import { PLAYBACK_STATUS_PROJECTION, type PlaybackStatusProjection } from "../state/contracts";
import { usePublishProjection } from "../state/react";
import type { SystemIdentity } from "../systems/identity";
import { systemIdentityKey } from "../systems/identity";

function useActivePlaybackProjection() {
  return [...useProjections<PlaybackStatusProjection>(PLAYBACK_STATUS_PROJECTION)].sort(
    (left, right) => {
      if (left.value.active !== right.value.active) {
        return left.value.active ? -1 : 1;
      }
      if (left.value.lastFocusedAt !== right.value.lastFocusedAt) {
        return right.value.lastFocusedAt - left.value.lastFocusedAt;
      }
      return systemIdentityKey(left.owner).localeCompare(systemIdentityKey(right.owner));
    },
  )[0];
}

export function usePlaybackStatus() {
  return useActivePlaybackProjection()?.value;
}

export interface PlaybackCapabilityOptions extends PlaybackStatusProjection {
  identity: SystemIdentity;
  fallbackAuthority?: boolean;
  onSeek: (
    request: Readonly<ApplicationEventMap["playback.seek.requested"]>,
  ) => boolean | void | Promise<boolean | void>;
}

export function usePlaybackCapability(options: PlaybackCapabilityOptions) {
  const {
    identity,
    active,
    lastFocusedAt,
    currentFrame,
    isPlaying,
    fallbackAuthority = false,
    onSeek,
  } = options;
  const projection = useMemo<PlaybackStatusProjection>(
    () => ({ active, lastFocusedAt, currentFrame, isPlaying }),
    [active, currentFrame, isPlaying, lastFocusedAt],
  );
  usePublishProjection(PLAYBACK_STATUS_PROJECTION, identity, projection);

  const authority = useActivePlaybackProjection();
  const isAuthority = authority
    ? systemIdentityKey(authority.owner) === systemIdentityKey(identity)
    : fallbackAuthority;
  useBroadcastEvent(identity, "playback.seek.requested", async ({ payload }) => {
    if (!isAuthority) {
      return "ignored";
    }
    return (await onSeek(payload)) === false ? "ignored" : "handled";
  });

  return { isAuthority };
}
