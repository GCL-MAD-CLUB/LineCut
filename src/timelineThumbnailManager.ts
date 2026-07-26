import { runBackgroundOperation, runOperation, type OperationKey } from "./errors";
import {
  baseTimelineThumbnailResolution,
  timelineThumbnailResolutions,
  type TimelineThumbnailResolution,
} from "./timelineThumbnailResolution";

const maximumCachedThumbnails = 4096;
const maximumCachedThumbnailBytes = 64 * 1024 * 1024;
const defaultThumbnailPriority = Number.MAX_SAFE_INTEGER;
const idleUpgradeTimeoutMs = 1_000;

let timelineThumbnailBaseJobCount = 0;
let timelineThumbnailUpgradeRunning = false;
const timelineThumbnailSchedulers = new Set<() => void>();

function scheduleTimelineThumbnailManagers() {
  for (const schedule of timelineThumbnailSchedulers) {
    schedule();
  }
}

export interface TimelineThumbnailOptions {
  fingerprint: string;
  timeUs: number;
  priority?: number;
  resolution?: TimelineThumbnailResolution;
}

export interface ExtractedTimelineThumbnail {
  blob: Blob;
  timeUs: number;
}

export interface TimelineThumbnailRequest {
  promise: Promise<string>;
  cancel: () => void;
}

interface CachedThumbnail {
  url: string;
  timeUs: number;
  byteLength: number;
  pins: Set<number>;
}

interface ThumbnailJob<Options extends TimelineThumbnailOptions> {
  key: string;
  options: Options;
  resolution: TimelineThumbnailResolution;
  consumers: Map<number, number>;
  background: boolean;
  basePressureTracked: boolean;
  sequence: number;
  settled: boolean;
  resolvedCacheKey?: string;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

interface TimelineThumbnailManagerOptions<Options extends TimelineThumbnailOptions> {
  operation: OperationKey;
  cancelledError: () => unknown;
  cacheKey: (options: Options, resolution: TimelineThumbnailResolution) => string;
  candidateCacheKeys: (options: Options, resolution: TimelineThumbnailResolution) => string[];
  cacheMatches: (cachedTimeUs: number, options: Options) => boolean;
  extract: (
    options: Options,
    resolution: TimelineThumbnailResolution,
  ) => Promise<ExtractedTimelineThumbnail>;
}

interface IdleCallbackHost {
  requestIdleCallback?: (
    callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
}

export function createTimelineThumbnailManager<Options extends TimelineThumbnailOptions>(
  configuration: TimelineThumbnailManagerOptions<Options>,
) {
  const thumbnailCache = new Map<string, CachedThumbnail>();
  const pendingJobs = new Map<string, ThumbnailJob<Options>>();
  const thumbnailQueue: ThumbnailJob<Options>[] = [];

  let cachedThumbnailBytes = 0;
  let workerRunning = false;
  let microtaskScheduled = false;
  let idleCallbackId: number | null = null;
  let idleCallbackUsesTimeout = false;
  let queueOrderDirty = false;
  let nextConsumerId = 0;
  let nextJobSequence = 0;

  function normalizedPriority(priority: number | undefined) {
    return priority !== undefined && Number.isFinite(priority)
      ? Math.max(0, priority)
      : defaultThumbnailPriority;
  }

  function activeJobPriority(job: ThumbnailJob<Options>) {
    let priority = defaultThumbnailPriority;
    for (const consumerPriority of job.consumers.values()) {
      priority = Math.min(priority, consumerPriority);
    }
    return priority;
  }

  function isBaseJob(job: ThumbnailJob<Options>) {
    return job.resolution.width === baseTimelineThumbnailResolution.width;
  }

  function sortThumbnailQueue() {
    if (!queueOrderDirty) {
      return;
    }
    thumbnailQueue.sort(
      (left, right) =>
        Number(!isBaseJob(left)) - Number(!isBaseJob(right)) ||
        activeJobPriority(left) - activeJobPriority(right) ||
        left.resolution.width - right.resolution.width ||
        left.sequence - right.sequence,
    );
    queueOrderDirty = false;
  }

  function touchCachedThumbnail(key: string, cached: CachedThumbnail) {
    thumbnailCache.delete(key);
    thumbnailCache.set(key, cached);
  }

  function cachedThumbnail(options: Options, resolution: TimelineThumbnailResolution) {
    for (const key of configuration.candidateCacheKeys(options, resolution)) {
      const cached = thumbnailCache.get(key);
      if (!cached || !configuration.cacheMatches(cached.timeUs, options)) {
        continue;
      }
      touchCachedThumbnail(key, cached);
      return { key, cached };
    }
    return null;
  }

  function evictCachedThumbnails() {
    while (
      thumbnailCache.size > maximumCachedThumbnails ||
      cachedThumbnailBytes > maximumCachedThumbnailBytes
    ) {
      let evicted = false;
      for (const [key, cached] of thumbnailCache) {
        if (cached.pins.size > 0) {
          continue;
        }
        thumbnailCache.delete(key);
        cachedThumbnailBytes -= cached.byteLength;
        URL.revokeObjectURL(cached.url);
        evicted = true;
        break;
      }
      if (!evicted) {
        break;
      }
    }
  }

  function rememberThumbnail(
    key: string,
    url: string,
    timeUs: number,
    byteLength: number,
    pins: Iterable<number>,
  ) {
    const previous = thumbnailCache.get(key);
    if (previous) {
      cachedThumbnailBytes -= previous.byteLength;
      if (previous.url !== url) {
        URL.revokeObjectURL(previous.url);
      }
    }
    thumbnailCache.delete(key);
    thumbnailCache.set(key, {
      url,
      timeUs,
      byteLength,
      pins: new Set(pins),
    });
    cachedThumbnailBytes += byteLength;
    evictCachedThumbnails();
  }

  function pinCachedThumbnail(
    match: { key: string; cached: CachedThumbnail },
    consumerIds: Iterable<number>,
  ) {
    for (const consumerId of consumerIds) {
      match.cached.pins.add(consumerId);
    }
    touchCachedThumbnail(match.key, match.cached);
  }

  function releaseCachedThumbnail(key: string | undefined, consumerId: number) {
    if (!key) {
      return;
    }
    const cached = thumbnailCache.get(key);
    if (!cached) {
      return;
    }
    cached.pins.delete(consumerId);
    evictCachedThumbnails();
  }

  function releaseBasePressure(job: ThumbnailJob<Options>) {
    if (!job.basePressureTracked) {
      return;
    }
    job.basePressureTracked = false;
    timelineThumbnailBaseJobCount = Math.max(0, timelineThumbnailBaseJobCount - 1);
    scheduleTimelineThumbnailManagers();
  }

  function cancelIdleWorker() {
    if (idleCallbackId === null) {
      return;
    }
    const idleWindow = window as unknown as IdleCallbackHost;
    if (idleCallbackUsesTimeout) {
      window.clearTimeout(idleCallbackId);
    } else {
      idleWindow.cancelIdleCallback?.(idleCallbackId);
    }
    idleCallbackId = null;
  }

  function scheduleIdleWorker() {
    if (idleCallbackId !== null) {
      return;
    }
    const idleWindow = window as unknown as IdleCallbackHost;
    if (idleWindow.requestIdleCallback) {
      idleCallbackUsesTimeout = false;
      idleCallbackId = idleWindow.requestIdleCallback(
        () => {
          idleCallbackId = null;
          runBackgroundOperation(configuration.operation, drainIdleThumbnailUpgrade);
        },
        { timeout: idleUpgradeTimeoutMs },
      );
      return;
    }
    idleCallbackUsesTimeout = true;
    idleCallbackId = window.setTimeout(() => {
      idleCallbackId = null;
      runBackgroundOperation(configuration.operation, drainIdleThumbnailUpgrade);
    }, 50);
  }

  function scheduleThumbnailWorker() {
    if (workerRunning) {
      return;
    }
    const hasBaseWork = thumbnailQueue.some(isBaseJob);
    if (timelineThumbnailBaseJobCount > 0) {
      cancelIdleWorker();
      if (!hasBaseWork || microtaskScheduled) {
        return;
      }
      microtaskScheduled = true;
      queueMicrotask(() => {
        microtaskScheduled = false;
        runBackgroundOperation(configuration.operation, () => drainThumbnailQueue(false));
      });
    } else if (
      thumbnailQueue.length > 0 &&
      !microtaskScheduled &&
      !timelineThumbnailUpgradeRunning
    ) {
      scheduleIdleWorker();
    }
  }

  function createJob(
    options: Options,
    resolution: TimelineThumbnailResolution,
    background: boolean,
  ) {
    const key = configuration.cacheKey(options, resolution);
    let resolve!: (url: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: ThumbnailJob<Options> = {
      key,
      options,
      resolution,
      consumers: new Map(),
      background,
      basePressureTracked: resolution.width === baseTimelineThumbnailResolution.width,
      sequence: nextJobSequence++,
      settled: false,
      promise,
      resolve,
      reject,
    };
    pendingJobs.set(key, job);
    thumbnailQueue.push(job);
    if (job.basePressureTracked) {
      timelineThumbnailBaseJobCount += 1;
    }
    queueOrderDirty = true;
    scheduleTimelineThumbnailManagers();
    return job;
  }

  function enqueueBackgroundUpgrade(options: Options, resolution: TimelineThumbnailResolution) {
    if (cachedThumbnail(options, resolution)) {
      return;
    }
    const key = configuration.cacheKey(options, resolution);
    const pending = pendingJobs.get(key);
    if (pending) {
      pending.background = true;
      return;
    }
    const job = createJob(options, resolution, true);
    void job.promise.catch(() => undefined);
  }

  function enqueueBackgroundUpgrades(options: Options) {
    for (const resolution of timelineThumbnailResolutions.slice(1)) {
      enqueueBackgroundUpgrade(options, resolution);
    }
  }

  function request(options: Options): TimelineThumbnailRequest {
    const resolution = options.resolution ?? baseTimelineThumbnailResolution;
    const consumerId = nextConsumerId++;
    const priority = normalizedPriority(options.priority);
    const cached = cachedThumbnail(options, resolution);
    if (cached) {
      cached.cached.pins.add(consumerId);
      if (resolution.width === baseTimelineThumbnailResolution.width) {
        enqueueBackgroundUpgrades(options);
      }
      let cancelled = false;
      return {
        promise: Promise.resolve(cached.cached.url),
        cancel: () => {
          if (cancelled) {
            return;
          }
          cancelled = true;
          releaseCachedThumbnail(cached.key, consumerId);
        },
      };
    }

    const key = configuration.cacheKey(options, resolution);
    let job = pendingJobs.get(key);
    if (!job) {
      job = createJob(options, resolution, false);
    }
    job.consumers.set(consumerId, priority);
    queueOrderDirty = true;
    scheduleThumbnailWorker();

    let cancelled = false;
    return {
      promise: job.promise,
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        if (job!.settled) {
          releaseCachedThumbnail(job!.resolvedCacheKey, consumerId);
        } else {
          job!.consumers.delete(consumerId);
          queueOrderDirty = true;
        }
      },
    };
  }

  function nextJob(allowUpgrade: boolean) {
    sortThumbnailQueue();
    const index = thumbnailQueue.findIndex((job) => isBaseJob(job) || allowUpgrade);
    if (index < 0) {
      return null;
    }
    return thumbnailQueue.splice(index, 1)[0];
  }

  async function drainThumbnailQueue(allowUpgrade: boolean) {
    if (workerRunning) {
      return;
    }
    workerRunning = true;
    let upgradeStarted = false;
    try {
      while (thumbnailQueue.length > 0) {
        const job = nextJob(allowUpgrade && !upgradeStarted);
        if (!job) {
          break;
        }
        if (!isBaseJob(job)) {
          upgradeStarted = true;
        }
        if (job.consumers.size === 0 && !job.background) {
          pendingJobs.delete(job.key);
          job.settled = true;
          job.reject(configuration.cancelledError());
          releaseBasePressure(job);
          continue;
        }

        const cached = cachedThumbnail(job.options, job.resolution);
        if (cached) {
          pinCachedThumbnail(cached, job.consumers.keys());
          pendingJobs.delete(job.key);
          job.resolvedCacheKey = cached.key;
          job.settled = true;
          job.resolve(cached.cached.url);
          releaseBasePressure(job);
          if (isBaseJob(job)) {
            enqueueBackgroundUpgrades(job.options);
          }
          continue;
        }

        const outcome = await runOperation(configuration.operation, () =>
          configuration.extract(job.options, job.resolution),
        );
        try {
          if (outcome.status !== "success") {
            job.reject(
              outcome.status === "failed" ? outcome.error : configuration.cancelledError(),
            );
            continue;
          }
          const extracted = outcome.value;
          const url = URL.createObjectURL(extracted.blob);
          rememberThumbnail(
            job.key,
            url,
            extracted.timeUs,
            extracted.blob.size,
            job.consumers.keys(),
          );
          job.resolvedCacheKey = job.key;
          job.resolve(url);
          if (isBaseJob(job)) {
            enqueueBackgroundUpgrades(job.options);
          }
        } finally {
          pendingJobs.delete(job.key);
          job.settled = true;
          releaseBasePressure(job);
        }
      }
    } finally {
      workerRunning = false;
      scheduleThumbnailWorker();
    }
  }

  async function drainIdleThumbnailUpgrade() {
    if (timelineThumbnailBaseJobCount > 0 || timelineThumbnailUpgradeRunning) {
      scheduleThumbnailWorker();
      return;
    }
    timelineThumbnailUpgradeRunning = true;
    try {
      await drainThumbnailQueue(true);
    } finally {
      timelineThumbnailUpgradeRunning = false;
      scheduleTimelineThumbnailManagers();
    }
  }

  timelineThumbnailSchedulers.add(scheduleThumbnailWorker);

  return { request };
}
