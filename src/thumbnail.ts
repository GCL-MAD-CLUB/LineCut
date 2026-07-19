import { invokeCommand } from "./errors";

const maximumCachedVideoCovers = 200;
const videoCoverCache = new Map<string, Uint8Array>();
const pendingVideoCovers = new Map<string, Promise<Uint8Array>>();
let videoCoverQueue: Promise<void> = Promise.resolve();

function enqueueVideoCover<Value>(task: () => Promise<Value>) {
  const result = videoCoverQueue.then(task, task);
  videoCoverQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function rememberVideoCover(cacheKey: string, bytes: Uint8Array) {
  videoCoverCache.delete(cacheKey);
  videoCoverCache.set(cacheKey, bytes);
  while (videoCoverCache.size > maximumCachedVideoCovers) {
    const oldestAssetId = videoCoverCache.keys().next().value;
    if (oldestAssetId === undefined) {
      break;
    }
    videoCoverCache.delete(oldestAssetId);
  }
}

export function extractVideoCover(assetId: string, fingerprint: string): Promise<Uint8Array> {
  const cached = videoCoverCache.get(fingerprint);
  if (cached) {
    rememberVideoCover(fingerprint, cached);
    return Promise.resolve(cached);
  }

  const pending = pendingVideoCovers.get(fingerprint);
  if (pending) {
    return pending;
  }

  const request = enqueueVideoCover(() =>
    invokeCommand<number[]>("generate_video_cover_thumbnail", { assetId }),
  ).then((serializedBytes) => {
    const bytes = new Uint8Array(serializedBytes);
    rememberVideoCover(fingerprint, bytes);
    return bytes;
  });
  pendingVideoCovers.set(fingerprint, request);
  void request.then(
    () => pendingVideoCovers.delete(fingerprint),
    () => pendingVideoCovers.delete(fingerprint),
  );
  return request;
}
