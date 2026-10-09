import { clientError } from "../../errors/model";

export const TRACE_WIDTH = 96;
export const TRACE_HEIGHT = 54;
export type FrameColors = readonly [number, number, number, number];

const PIXELS = TRACE_WIDTH * TRACE_HEIGHT;
const STRIDE = TRACE_WIDTH + 1;
const WINDOW = 11;
const WINDOWS = (TRACE_WIDTH - WINDOW + 1) * (TRACE_HEIGHT - WINDOW + 1);
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function frameBuffers() {
  return {
    channels: new Uint8Array(PIXELS * 3),
    means: new Float64Array(WINDOWS * 3),
    variances: new Int32Array(WINDOWS * 3),
  };
}

function windowSum(integral: Int32Array, index: number) {
  return (
    integral[index + WINDOW * STRIDE + WINDOW] -
    integral[index + WINDOW] -
    integral[index + WINDOW * STRIDE] +
    integral[index]
  );
}

export interface PlaybackTraceSample {
  frame: number;
  colors: readonly number[];
  sharpness: number;
  motion: number | null;
  previousFrame: number | null;
  previousSample?: PlaybackTraceSample;
}

export class FrameTraceAnalyzer {
  private previousFrame: number | null = null;
  private previous = frameBuffers();
  private current = frameBuffers();
  private gray = new Float64Array(PIXELS);
  private sums = new Int32Array(STRIDE * (TRACE_HEIGHT + 1));
  private squares = new Int32Array(STRIDE * (TRACE_HEIGHT + 1));
  private products = new Int32Array(STRIDE * (TRACE_HEIGHT + 1));

  get lastFrame() {
    return this.previousFrame;
  }

  reset() {
    this.previousFrame = null;
  }

  sample(frame: number, pixels: Uint8ClampedArray): PlaybackTraceSample {
    if (pixels.length !== TRACE_WIDTH * TRACE_HEIGHT * 4) {
      throw clientError("VIDEO_FRAME_DIMENSIONS_INVALID", "Invalid frame trace pixel dimensions");
    }
    const { channels, means, variances } = this.current;
    const gray = this.gray;
    let redSum = 0,
      greenSum = 0,
      blueSum = 0,
      graySum = 0;
    for (let index = 0; index < gray.length; index++) {
      const offset = index * 4;
      const r = pixels[offset],
        g = pixels[offset + 1],
        b = pixels[offset + 2];
      channels[index] = r;
      channels[PIXELS + index] = g;
      channels[2 * PIXELS + index] = b;
      redSum += r;
      greenSum += g;
      blueSum += b;
      gray[index] = 0.3 * r + 0.59 * g + 0.11 * b;
      graySum += gray[index];
    }
    const red = redSum / PIXELS / 255,
      green = greenSum / PIXELS / 255,
      blue = blueSum / PIXELS / 255;
    const mean = graySum / PIXELS;
    let sum = 0;
    let laplacianSquares = 0;
    for (let y = 1; y < TRACE_HEIGHT - 1; y++) {
      for (let x = 1; x < TRACE_WIDTH - 1; x++) {
        const index = y * TRACE_WIDTH + x;
        const laplacian =
          gray[index - TRACE_WIDTH] +
          gray[index + TRACE_WIDTH] +
          gray[index - 1] +
          gray[index + 1] -
          4 * gray[index];
        sum += laplacian;
        laplacianSquares += laplacian * laplacian;
      }
    }
    const count = (TRACE_WIDTH - 2) * (TRACE_HEIGHT - 2);
    const sharpness =
      mean === 0 ? 0 : Math.max(0, laplacianSquares / count - (sum / count) ** 2) / mean ** 2;
    const previous = this.previous;
    const adjacent = this.previousFrame === frame - 1;
    let motion: number | null = null;
    let similarity = 0;
    // The same 11x11 Weber SSIM as ssim.js, including its 1/1024 truncation.
    // Cache each frame's moments; only cross-products depend on the frame pair.
    // Integral images and ping-pong buffers keep this O(pixels), allocation-free.
    const { sums, squares, products } = this;
    for (let channel = 0; channel < 3; channel++) {
      const base = channel * PIXELS;
      for (let y = 0; y < TRACE_HEIGHT; y++) {
        let sum = 0,
          square = 0,
          product = 0;
        for (let x = 0; x < TRACE_WIDTH; x++) {
          const pixel = base + y * TRACE_WIDTH + x;
          const value = channels[pixel];
          const index = (y + 1) * STRIDE + x + 1;
          sum += value;
          square += value * value;
          sums[index] = sums[index - STRIDE] + sum;
          squares[index] = squares[index - STRIDE] + square;
          if (adjacent) {
            product += value * previous.channels[pixel];
            products[index] = products[index - STRIDE] + product;
          }
        }
      }
      let ssim = 0,
        window = 0;
      for (let y = 0; y <= TRACE_HEIGHT - WINDOW; y++) {
        for (let x = 0; x <= TRACE_WIDTH - WINDOW; x++, window++) {
          const index = y * STRIDE + x;
          const target = channel * WINDOWS + window;
          const mean = windowSum(sums, index) / (WINDOW * WINDOW);
          means[target] = mean;
          variances[target] = 1024 * (windowSum(squares, index) / (WINDOW * WINDOW) - mean * mean);
          if (adjacent) {
            const oldMean = previous.means[target];
            const covariance =
              (1024 * (windowSum(products, index) / (WINDOW * WINDOW) - mean * oldMean)) | 0;
            const value =
              ((2 * oldMean * mean + C1) * ((2 * covariance) / 1024 + C2)) /
              (oldMean * oldMean + mean * mean + C1) /
              ((previous.variances[target] + variances[target]) / 1024 + C2);
            ssim += (value - ssim) / (window + 1);
          }
        }
      }
      similarity += ssim / 3;
    }
    if (adjacent) motion = Math.max(0, Math.min(2, 1 - similarity));
    const previousFrame = motion === null ? null : this.previousFrame;
    this.previous = this.current;
    this.current = previous;
    this.previousFrame = frame;
    return {
      frame,
      colors: [red, green, blue, 0.3 * red + 0.59 * green + 0.11 * blue],
      sharpness,
      motion,
      previousFrame,
    };
  }
}
