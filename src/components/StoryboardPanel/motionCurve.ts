export function motionCurvePath(values: readonly number[]): string {
  if (values.length === 0) return "";
  const displayValues = values.map((value) => 2 * value - (value * value) / 2);
  if (displayValues.length === 1) return `M0,${2 - displayValues[0]} L1,${2 - displayValues[0]}`;
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
