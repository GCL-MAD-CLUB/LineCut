import {
  prepareMediaAutoBindings,
  type MediaAutoBindPreference,
  type MediaAutoBindPreset,
  type MediaAutoBindType,
} from "./mediaAutoBinding";
import type { MediaBinItem } from "../../types";

export interface MediaAutoBindingWorkerRequest {
  items: MediaBinItem[];
  type: MediaAutoBindType;
  preset: MediaAutoBindPreset;
  preference: MediaAutoBindPreference;
}

export type MediaAutoBindingWorkerResponse =
  | { kind: "progress"; completed: number; total: number }
  | { kind: "result"; result: ReturnType<typeof prepareMediaAutoBindings> }
  | { kind: "error"; message: string };

interface MediaAutoBindingWorkerScope {
  onmessage: ((event: MessageEvent<MediaAutoBindingWorkerRequest>) => void) | null;
  postMessage: (message: MediaAutoBindingWorkerResponse) => void;
}

const workerScope = self as unknown as MediaAutoBindingWorkerScope;

workerScope.onmessage = ({ data }) => {
  try {
    const result = prepareMediaAutoBindings(
      data.items,
      data.type,
      data.preset,
      data.preference,
      (completed, total) => {
        if (completed === total || completed % 8 === 0) {
          workerScope.postMessage({ kind: "progress", completed, total });
        }
      },
    );
    workerScope.postMessage({ kind: "result", result });
  } catch (error) {
    workerScope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
