export type FrameHistogram = [number[], number[], number[], number[]];

export function frameHistogram(pixels: Uint8ClampedArray): FrameHistogram {
  const bins: FrameHistogram = Array.from({ length: 4 }, () =>
    Array<number>(256).fill(0),
  ) as FrameHistogram;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    bins[0][red]++;
    bins[1][green]++;
    bins[2][blue]++;
    bins[3][Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)]++;
  }
  return bins;
}
