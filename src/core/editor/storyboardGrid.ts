export interface StoryboardGridLayout {
  columns: number;
  cardWidth: number;
}

export function fitStoryboardGrid(itemCount: number, availableWidth: number, targetWidth: number) {
  // Preserve the existing fit rule: a column can shrink enough to admit one more card.
  // Solving the inequality avoids searching backwards through every shot on each resize.
  const columns = Math.min(
    Math.max(1, itemCount),
    Math.max(1, Math.floor(availableWidth / Math.max(1, targetWidth - 1)) + 1),
  );
  const minimumWidth = ((targetWidth - 1) * (columns - 1)) / columns;
  return {
    columns,
    cardWidth: Math.min(targetWidth, Math.max(minimumWidth, availableWidth / columns)),
  };
}

export function storyboardGridRenderRange(
  itemCount: number,
  columns: number,
  visibleRange: { startIndex: number; endIndex: number },
  overscanRows = 2,
) {
  const lastItemRow = Math.max(0, Math.ceil(itemCount / columns) - 1);
  const firstRow = Math.min(
    lastItemRow,
    Math.floor(Math.max(0, visibleRange.startIndex) / columns),
  );
  const lastRow = Math.max(
    firstRow,
    Math.min(lastItemRow, Math.floor(Math.max(0, visibleRange.endIndex) / columns)),
  );
  return {
    startIndex: Math.max(0, firstRow - overscanRows) * columns,
    endIndex: Math.min(itemCount, (lastRow + overscanRows + 1) * columns),
  };
}

export function storyboardGridScrollOffset(
  index: number,
  layout: StoryboardGridLayout,
  scrollTop: number,
  viewportHeight: number,
  align: "center" | "nearest",
) {
  const top = Math.floor(index / layout.columns) * layout.cardWidth;
  if (align === "center") return Math.max(0, top + layout.cardWidth / 2 - viewportHeight / 2);
  if (top < scrollTop) return top;
  if (top + layout.cardWidth > scrollTop + viewportHeight)
    return Math.max(0, top - Math.max(0, viewportHeight - layout.cardWidth));
  return scrollTop;
}

export function storyboardGridHitIndices(
  itemCount: number,
  layout: StoryboardGridLayout,
  rect: { left: number; right: number; top: number; bottom: number },
) {
  const { columns, cardWidth } = layout;
  const rowCount = Math.ceil(itemCount / columns);
  if (
    itemCount === 0 ||
    cardWidth <= 0 ||
    rect.right < 0 ||
    rect.bottom < 0 ||
    rect.left > columns * cardWidth ||
    rect.top > rowCount * cardWidth
  )
    return [];
  // Inclusive edges match the DOM rectangle intersection used by the list view.
  const firstColumn = Math.max(0, Math.ceil(rect.left / cardWidth) - 1);
  const lastColumn = Math.min(columns - 1, Math.floor(rect.right / cardWidth));
  const firstRow = Math.max(0, Math.ceil(rect.top / cardWidth) - 1);
  const lastRow = Math.min(rowCount - 1, Math.floor(rect.bottom / cardWidth));
  const indices: number[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const index = row * columns + column;
      if (index < itemCount) indices.push(index);
    }
  }
  return indices;
}
