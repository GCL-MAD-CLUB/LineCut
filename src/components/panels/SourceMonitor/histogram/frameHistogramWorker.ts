import { frameHistogram, type FrameHistogram } from "../../../../core/editor/frameHistogram";

export type FrameHistogramWorkerResponse =
  { kind: "result"; histogram: FrameHistogram } | { kind: "error"; message: string };

interface FrameHistogramWorkerScope {
  onmessage: ((event: MessageEvent<Uint8ClampedArray>) => void) | null;
  postMessage: (message: FrameHistogramWorkerResponse) => void;
}

const workerScope = self as unknown as FrameHistogramWorkerScope;

workerScope.onmessage = ({ data }) => {
  try {
    workerScope.postMessage({ kind: "result", histogram: frameHistogram(data) });
  } catch (error) {
    workerScope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
