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

export function motionCurvePath(values: readonly number[], pixelWidth = Infinity): string {
  if (values.length === 0) return "";
  const cumulative = [0];
  let total = 0;
  for (const value of values) {
    total += value;
    cumulative.push(total);
  }
  // Scale the entire cumulative curve uniformly; tanh applies only to its final value.
  const endpoint = Math.tanh(total / 2);
  const samples = pixelEnvelope(cumulative, pixelWidth).map(({ index, value }) => ({
    index,
    value: total > 0 ? (value / total) * endpoint : 0,
  }));
  return linePath(samples, cumulative.length, 1);
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
