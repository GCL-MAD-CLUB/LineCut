import { useMemo } from "react";
import type { ApplicationEventMap } from "../events/contracts";
import { useBroadcastEvent } from "../events/react";
import { useProjections } from "../state/StateHub";
import {
  PLAYBACK_STATUS_PROJECTION,
  PLAYBACK_HISTOGRAM_DEMAND_PROJECTION,
  PLAYBACK_TRACE_DEMAND_PROJECTION,
  type PlaybackTraceDemandProjection,
  type PlaybackHistogramDemandProjection,
  type PlaybackStatusProjection,
} from "../state/contracts";
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

export function usePlaybackTraceStatus() {
  const projections = useProjections<PlaybackStatusProjection>(PLAYBACK_STATUS_PROJECTION);
  const playing = [...projections]
    .filter(({ value }) => value.isPlaying && Boolean(value.videoId))
    .sort((left, right) => right.value.lastFocusedAt - left.value.lastFocusedAt)[0];
  const active = useActivePlaybackProjection();
  return playing?.value ?? active?.value;
}

export function usePlaybackHistogramRequested() {
  return useProjections<PlaybackHistogramDemandProjection>(
    PLAYBACK_HISTOGRAM_DEMAND_PROJECTION,
  ).some(({ value }) => value.enabled);
}

export function usePlaybackTraceRequested() {
  return useProjections<PlaybackTraceDemandProjection>(PLAYBACK_TRACE_DEMAND_PROJECTION).some(
    ({ value }) => value.enabled,
  );
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
    videoId,
    sourcePanelId,
    histogram,
    videoSource,
    fallbackAuthority = false,
    onSeek,
  } = options;
  const projection = useMemo<PlaybackStatusProjection>(
    () => ({
      active,
      lastFocusedAt,
      currentFrame,
      isPlaying,
      videoId,
      sourcePanelId,
      histogram,
      videoSource,
    }),
    [
      active,
      currentFrame,
      isPlaying,
      lastFocusedAt,
      sourcePanelId,
      videoId,
      histogram,
      videoSource,
    ],
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
