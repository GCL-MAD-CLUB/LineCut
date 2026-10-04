/** Finish centering before playback leaves the target, including very short items. */
export function playbackFollowScrollDuration(
  distance: number,
  viewportHeight: number,
  currentFrame: number,
  startFrame: number,
  endFrame: number,
  frameRate: number,
) {
  const remainingMs = (Math.max(0, endFrame - 1 - currentFrame) / frameRate) * 1000;
  const preferredMs =
    currentFrame < startFrame
      ? Math.min(1200, Math.max(1000, ((startFrame - 1 - currentFrame) / frameRate) * 1000))
      : Math.min(900, 180 + Math.sqrt(Math.abs(distance) / Math.max(1, viewportHeight)) * 300);
  // Leave a paint frame for arrival. One-frame items must center immediately.
  return Math.max(0, Math.min(preferredMs, remainingMs - 1000 / 60));
}
