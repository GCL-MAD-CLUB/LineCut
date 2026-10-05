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

function linePath(samples: readonly CurveSample[], frameCount: number): string {
  return samples
    .map(
      ({ index, value }, position) =>
        `${position === 0 ? "M" : "L"}${index / (frameCount - 1)},${2 - value}`,
    )
    .join(" ");
}

export function motionCurvePath(values: readonly number[], pixelWidth = Infinity): string {
  if (values.length === 0) return "";
  const displayValues = values.map((value) => 2 * value - (value * value) / 2);
  if (displayValues.length === 1) return `M0,${2 - displayValues[0]} L1,${2 - displayValues[0]}`;
  const samples = pixelEnvelope(displayValues, pixelWidth);
  // Dense curves use an unsmoothed envelope so narrow peaks are not averaged away.
  if (samples.length < values.length) return linePath(samples, values.length);
  const points = displayValues.map((value, index) => ({
    x: index / (values.length - 1),
    y:
      2 -
      (index === 0 || index === values.length - 1
        ? value
        : (displayValues[index - 1] + 6 * value + displayValues[index + 1]) / 8),
  }));
  const differences = points.slice(1).map((point, index) => point.y - points[index].y);
  const tangents = points.map((_, index) => {
    if (index === 0) return differences[0];
    if (index === points.length - 1) return differences[index - 1];
    const before = differences[index - 1];
    const after = differences[index];
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });
  let path = `M${points[0].x},${points[0].y}`;
  // Monotone tangents keep interpolation within the sample range and preserve local peaks.
  for (let index = 0; index < points.length - 1; index++) {
    const point = points[index];
    const next = points[index + 1];
    const third = (next.x - point.x) / 3;
    path += ` C${point.x + third},${point.y + tangents[index] / 3} ${next.x - third},${next.y - tangents[index + 1] / 3} ${next.x},${next.y}`;
  }
  return path;
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
