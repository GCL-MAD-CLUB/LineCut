import type { PlaybackTraceSample } from "../../../../core/editor/frameTrace";
import { normalizeMotion, pixelEnvelope, smoothMotionValues } from "./motionCurve";
import type { FrameTraceData } from "../../../../application/media/browserFrameTrace";

export function completeTraceSamples(
  data: FrameTraceData,
  startFrame: number,
): PlaybackTraceSample[] {
  return data.colors.map((colors, index) => ({
    frame: startFrame + index,
    colors,
    sharpness: data.sharpness[index],
    motion: index > 0 ? data.motion[index - 1] : null,
    previousFrame: index > 0 ? startFrame + index - 1 : null,
  }));
}

export interface PlaybackTracePaths {
  motion: { line: string; area: string };
  colors: { line: string; area: string }[];
  sharpness: { line: string; area: string };
}

export function playbackTracePaths(
  samples: readonly PlaybackTraceSample[],
  startFrame: number,
  endFrame: number,
  playbackFrame: number,
  pixelWidth: number,
  mode?: "motion" | "colors" | "sharpness",
  sorted = false,
): PlaybackTracePaths {
  const limit = Math.min(endFrame, playbackFrame);
  const inRange =
    sorted &&
    (samples.length === 0 ||
      (samples[0].frame >= startFrame && samples[samples.length - 1].frame <= limit));
  const frames = inRange
    ? samples
    : samples
        .filter((sample) => sample.frame >= startFrame && sample.frame <= limit)
        .sort((left, right) => left.frame - right.frame);
  const maximumSharpness =
    mode && mode !== "sharpness"
      ? 1
      : frames.reduce((max, sample) => Math.max(max, sample.sharpness), 1e-12);
  const span = Math.max(1, endFrame - startFrame);
  const segments: { start: number; end: number }[] = [];
  for (let start = 0; start < frames.length;) {
    let end = start + 1;
    while (end < frames.length && frames[end].previousFrame === frames[end - 1].frame) end++;
    segments.push({ start, end });
    start = end;
  }
  function paths(values: readonly number[], baseline: number, smooth = false) {
    const lines: string[] = [];
    const areas: string[] = [];
    for (const { start, end } of segments) {
      const width = Math.max(
        1,
        ((frames[end - 1].frame - frames[start].frame) / span) * pixelWidth,
      );
      const segment = start === 0 && end === values.length ? values : values.slice(start, end);
      const plotted = smooth
        ? smoothMotionValues(segment, width, (index) => frames[start + index].frame)
        : segment;
      let line = pixelEnvelope(plotted, width)
        .map(
          ({ index, value }, position) =>
            `${position === 0 ? "M" : "L"}${(frames[start + index].frame - startFrame) / span},${baseline - value}`,
        )
        .join(" ");
      lines.push(line);
      const first = (frames[start].frame - startFrame) / span;
      const last = (frames[end - 1].frame - startFrame) / span;
      if (end === start + 1 && first > 0) {
        line += ` L${Math.max(0, first - 1 / Math.max(1, pixelWidth))},${baseline - values[start]}`;
        lines[lines.length - 1] = line;
      }
      areas.push(`${line} L${last},${baseline} L${first},${baseline} Z`);
    }
    return { line: lines.join(" "), area: areas.join(" ") };
  }
  return {
    motion:
      mode && mode !== "motion"
        ? { line: "", area: "" }
        : paths(
            frames.map((sample) => normalizeMotion(sample.motion ?? 0)),
            1,
            true,
          ),
    colors: [0, 1, 2, 3].map((channel) =>
      mode && mode !== "colors"
        ? { line: "", area: "" }
        : paths(
            frames.map((sample) => sample.colors[channel] * 2),
            2,
          ),
    ),
    sharpness:
      mode && mode !== "sharpness"
        ? { line: "", area: "" }
        : paths(
            frames.map((sample) => (sample.sharpness / maximumSharpness) * 2),
            2,
          ),
  };
}
