interface CurveSample {
  index: number;
  value: number;
}

export function pixelEnvelope(values: readonly number[], pixelWidth: number): CurveSample[] {
  const columns = Math.max(1, Math.ceil(pixelWidth));
  if (!Number.isFinite(columns) || values.length <= columns * 4) {
    return values.map((value, index) => ({ index, value }));
  }
  const samples: CurveSample[] = [];
  for (let column = 0; column < columns; column++) {
    const start = Math.floor((column * values.length) / columns);
    const end = Math.floor(((column + 1) * values.length) / columns);
    let minimum = start;
    let maximum = start;
    for (let index = start + 1; index < end; index++) {
      if (values[index] < values[minimum]) minimum = index;
      if (values[index] > values[maximum]) maximum = index;
    }
    const indices = [start, minimum, maximum, end - 1].sort((a, b) => a - b);
    for (let position = 0; position < indices.length; position++) {
      const index = indices[position];
      if (position === 0 || index !== indices[position - 1]) {
        samples.push({ index, value: values[index] });
      }
    }
  }
  return samples;
}

function linePath(samples: readonly CurveSample[], frameCount: number, yMaximum = 2): string {
  return samples
    .map(
      ({ index, value }, position) =>
        `${position === 0 ? "M" : "L"}${index / (frameCount - 1)},${yMaximum - value}`,
    )
    .join(" ");
}

export function normalizeMotion(value: number): number {
  return value - (value * value) / 4;
}

export function smoothMotionValues(
  values: readonly number[],
  pixelWidth: number,
  frameAt: (index: number) => number = (index) => index,
): readonly number[] {
  if (values.length < 2 || !Number.isFinite(pixelWidth)) return values;
  // Average within a three-pixel window using frame positions, including irregular sampling.
  const radius = (1.5 * (frameAt(values.length - 1) - frameAt(0))) / Math.max(1, pixelWidth);
  if (radius <= 0) return values;
  const smoothed = new Array<number>(values.length);
  let left = 0;
  let right = 0;
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    const frame = frameAt(index);
    while (right < values.length && frameAt(right) <= frame + radius) sum += values[right++];
    while (left < right && frameAt(left) < frame - radius) sum -= values[left++];
    smoothed[index] = Math.max(0, Math.min(1, sum / (right - left)));
  }
  return smoothed;
}

export function motionCurvePath(values: readonly number[], pixelWidth = Infinity): string {
  if (values.length === 0) return "";
  return linePath(
    pixelEnvelope(smoothMotionValues([0, ...values.map(normalizeMotion)], pixelWidth), pixelWidth),
    values.length + 1,
    1,
  );
}

export function motionHoverFrame(startFrame: number, endFrame: number, progress: number): number {
  return Math.round(startFrame + Math.max(0, Math.min(1, progress)) * (endFrame - startFrame));
}

export function frameColorCurvePath(values: readonly number[], pixelWidth = Infinity): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `M0,${2 * (1 - values[0])} L1,${2 * (1 - values[0])}`;
  return linePath(
    pixelEnvelope(values, pixelWidth).map(({ index, value }) => ({
      index,
      value: 2 * value,
    })),
    values.length,
  );
}
