export const MIN_TICK_FRAMES = 1;
export const MIN_TICK_WIDTH_PX = 4;
export const MAX_TICK_WIDTH_PX = 16;
export const DEFAULT_FRAME_RATE = 24;

const US_PER_SECOND = 1_000_000;

export interface TimelineTick {
  frame: number;
  leftPx: number;
  major: boolean;
}

export interface TimelineRuler {
  ticks: TimelineTick[];
  tickStepFrames: number;
  tickSpacingPx: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function actualFrameRate(frameRate: number) {
  return Number.isFinite(frameRate) ? Math.max(1, frameRate) : DEFAULT_FRAME_RATE;
}

export function parseFrameRate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "0/0") {
    return null;
  }

  if (trimmed.includes("/")) {
    const [numerator, denominator] = trimmed.split("/").map(Number);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return null;
    }
    const parsed = numerator / denominator;
    return parsed > 0 ? parsed : null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeFrameRate(...candidates: Array<string | null | undefined>) {
  for (const candidate of candidates) {
    const parsed = parseFrameRate(candidate);
    if (parsed) {
      return clamp(parsed, 1, 240);
    }
  }
  return DEFAULT_FRAME_RATE;
}

export function frameDurationUs(frameRate: number) {
  return US_PER_SECOND / actualFrameRate(frameRate);
}

export function timeUsToFrame(timeUs: number, frameRate: number) {
  const safeTimeUs = Number.isFinite(timeUs) ? Math.max(0, timeUs) : 0;
  return Math.max(0, Math.round((safeTimeUs / US_PER_SECOND) * actualFrameRate(frameRate)));
}

export function frameToTimeUs(frame: number, frameRate: number) {
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.round(frame)) : 0;
  return Math.round((safeFrame / actualFrameRate(frameRate)) * US_PER_SECOND);
}

export function minTimelineSpanFrames(widthPx: number, durationFrames: number) {
  const width = Math.max(1, widthPx);
  const minSpan = Math.max(MIN_TICK_FRAMES, Math.ceil(width / MAX_TICK_WIDTH_PX));
  return durationFrames > 0 ? Math.min(durationFrames, minSpan) : minSpan;
}

export function clampTimelineSpanFrames(
  spanFrames: number,
  widthPx: number,
  durationFrames: number,
) {
  const minSpan = minTimelineSpanFrames(widthPx, durationFrames);
  const safeSpan = Number.isFinite(spanFrames) ? spanFrames : minSpan;
  const maxSpan = durationFrames > 0 ? durationFrames : Math.max(minSpan, safeSpan);
  return clamp(safeSpan, minSpan, maxSpan);
}

export function clampTimelineStartFrame(
  startFrame: number,
  spanFrames: number,
  durationFrames: number,
) {
  if (durationFrames <= 0) {
    return 0;
  }
  const safeStart = Number.isFinite(startFrame) ? startFrame : 0;
  const safeSpan = Number.isFinite(spanFrames) ? spanFrames : 0;
  return clamp(safeStart, 0, Math.max(0, durationFrames - safeSpan));
}

export function buildTimelineRuler({
  startFrame,
  spanFrames,
  durationFrames,
  widthPx,
}: {
  startFrame: number;
  spanFrames: number;
  durationFrames: number;
  widthPx: number;
}): TimelineRuler {
  if (durationFrames <= 0 || widthPx <= 0 || spanFrames <= 0) {
    return { ticks: [], tickStepFrames: MIN_TICK_FRAMES, tickSpacingPx: MAX_TICK_WIDTH_PX };
  }

  const pxPerFrame = widthPx / Math.max(1, spanFrames);
  let tickStepFrames = MIN_TICK_FRAMES;
  let tickSpacingPx = tickStepFrames * pxPerFrame;

  while (tickSpacingPx < MIN_TICK_WIDTH_PX) {
    tickStepFrames *= 4;
    tickSpacingPx = tickStepFrames * pxPerFrame;
  }

  const firstVisibleFrame = Math.max(0, Math.floor(startFrame));
  const lastVisibleFrame = Math.ceil(Math.min(durationFrames, startFrame + spanFrames));
  const firstTickFrame = Math.floor(firstVisibleFrame / tickStepFrames) * tickStepFrames;
  const lastTickFrame = Math.ceil(lastVisibleFrame / tickStepFrames) * tickStepFrames;
  const ticks: TimelineTick[] = [];
  const majorStepFrames = tickStepFrames * 10;

  for (let frame = firstTickFrame; frame <= lastTickFrame; frame += tickStepFrames) {
    if (frame < 0 || frame > durationFrames) {
      continue;
    }
    const leftPx = ((frame - startFrame) / spanFrames) * widthPx;
    if (leftPx < -tickSpacingPx || leftPx > widthPx + tickSpacingPx) {
      continue;
    }
    ticks.push({
      frame,
      leftPx,
      major: frame % majorStepFrames === 0,
    });
  }

  return { ticks, tickStepFrames, tickSpacingPx };
}
