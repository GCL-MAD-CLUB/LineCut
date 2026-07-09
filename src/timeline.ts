export const MIN_TICK_FRAMES = 1;
export const MIN_TICK_WIDTH_PX = 4;
export const MAX_TICK_WIDTH_PX = 16;
export const DEFAULT_FRAME_RATE = 24;

const US_PER_SECOND = 1_000_000;

export interface TimelineTick {
  frame: number;
  timeUs: number;
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
  return US_PER_SECOND / Math.max(1, frameRate);
}

export function minTimelineSpanUs(widthPx: number, frameRate: number, durationUs: number) {
  const width = Math.max(1, widthPx);
  const minSpan = (width * frameDurationUs(frameRate)) / MAX_TICK_WIDTH_PX;
  return durationUs > 0 ? Math.min(durationUs, minSpan) : minSpan;
}

export function clampTimelineSpan(
  spanUs: number,
  widthPx: number,
  frameRate: number,
  durationUs: number,
) {
  const minSpan = minTimelineSpanUs(widthPx, frameRate, durationUs);
  const maxSpan = durationUs > 0 ? durationUs : Math.max(minSpan, spanUs);
  return clamp(spanUs, minSpan, maxSpan);
}

export function clampTimelineStart(startUs: number, spanUs: number, durationUs: number) {
  if (durationUs <= 0) {
    return 0;
  }
  return clamp(startUs, 0, Math.max(0, durationUs - spanUs));
}

export function buildTimelineRuler({
  startUs,
  spanUs,
  durationUs,
  widthPx,
  frameRate,
}: {
  startUs: number;
  spanUs: number;
  durationUs: number;
  widthPx: number;
  frameRate: number;
}): TimelineRuler {
  if (durationUs <= 0 || widthPx <= 0 || spanUs <= 0) {
    return { ticks: [], tickStepFrames: MIN_TICK_FRAMES, tickSpacingPx: MAX_TICK_WIDTH_PX };
  }

  const frameUs = frameDurationUs(frameRate);
  const pxPerFrame = widthPx / Math.max(1, spanUs / frameUs);
  let tickStepFrames = MIN_TICK_FRAMES;
  let tickSpacingPx = tickStepFrames * pxPerFrame;

  while (tickSpacingPx < MIN_TICK_WIDTH_PX) {
    tickStepFrames *= 4;
    tickSpacingPx = tickStepFrames * pxPerFrame;
  }

  const firstVisibleFrame = Math.max(0, Math.floor(startUs / frameUs));
  const lastVisibleFrame = Math.ceil(Math.min(durationUs, startUs + spanUs) / frameUs);
  const firstTickFrame = Math.floor(firstVisibleFrame / tickStepFrames) * tickStepFrames;
  const lastTickFrame = Math.ceil(lastVisibleFrame / tickStepFrames) * tickStepFrames;
  const ticks: TimelineTick[] = [];
  const majorStepFrames = tickStepFrames * 10;

  for (let frame = firstTickFrame; frame <= lastTickFrame; frame += tickStepFrames) {
    const timeUs = frame * frameUs;
    if (timeUs < 0 || timeUs > durationUs) {
      continue;
    }
    const leftPx = ((timeUs - startUs) / spanUs) * widthPx;
    if (leftPx < -tickSpacingPx || leftPx > widthPx + tickSpacingPx) {
      continue;
    }
    ticks.push({
      frame,
      timeUs,
      leftPx,
      major: frame % majorStepFrames === 0,
    });
  }

  return { ticks, tickStepFrames, tickSpacingPx };
}
