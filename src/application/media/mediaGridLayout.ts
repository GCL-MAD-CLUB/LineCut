/** Preserve the media-bin edge compression before wrapping to fewer columns. */
export function mediaGridLayout(
  availableWidth: number,
  itemCount: number,
  targetWidth: number,
  gap: number,
) {
  for (let columns = Math.max(1, itemCount); columns >= 1; columns -= 1) {
    const minimum =
      (targetWidth * (columns - 1) + gap * Math.max(0, columns - 2) - (columns - 1)) / columns;
    const fitted = (availableWidth - (columns - 1) * gap) / columns;
    if (fitted >= minimum)
      return { columns, cardWidth: Math.min(targetWidth, Math.max(minimum, fitted)) };
  }
  return { columns: 1, cardWidth: Math.max(0, availableWidth) };
}
