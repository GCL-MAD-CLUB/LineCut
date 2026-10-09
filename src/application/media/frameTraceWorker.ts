import { FrameTraceAnalyzer, type PlaybackTraceSample } from "../../core/editor/frameTrace";

export type FrameTraceWorkerRequest = {
  frame: number;
  generation: number;
  pixels: Uint8ClampedArray;
  previousFrame?: number;
  previousPixels?: Uint8ClampedArray;
};
export type FrameTraceWorkerResponse =
  | { kind: "result"; generation: number; sample: PlaybackTraceSample }
  | { kind: "error"; message: string };

interface FrameTraceWorkerScope {
  onmessage: ((event: MessageEvent<FrameTraceWorkerRequest>) => void) | null;
  postMessage: (message: FrameTraceWorkerResponse) => void;
}
const scope = self as unknown as FrameTraceWorkerScope;
const analyzer = new FrameTraceAnalyzer();
let generation: number | null = null;
scope.onmessage = ({ data }) => {
  try {
    if (generation !== data.generation) {
      analyzer.reset();
      generation = data.generation;
    }
    let previousSample: PlaybackTraceSample | undefined;
    if (
      analyzer.lastFrame !== data.frame - 1 &&
      data.previousPixels &&
      data.previousFrame === data.frame - 1
    ) {
      analyzer.reset();
      previousSample = analyzer.sample(data.previousFrame, data.previousPixels);
    }
    const sample = analyzer.sample(data.frame, data.pixels);
    if (previousSample) sample.previousSample = previousSample;
    scope.postMessage({ kind: "result", generation: data.generation, sample });
  } catch (error) {
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
