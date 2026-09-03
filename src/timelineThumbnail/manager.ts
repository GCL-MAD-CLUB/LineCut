import { runOperation, type OperationKey } from "../errors";
import { timelineThumbnailResolutions, type TimelineThumbnailResolution } from "./resolution";

const maximumCachedThumbnails = 4096;
const maximumCachedThumbnailBytes = 64 * 1024 * 1024;
const defaultThumbnailPriority = Number.MAX_SAFE_INTEGER;
const fallbackLogicalProcessorCount = 4;
const logicalProcessorCount =
  typeof navigator === "undefined"
    ? fallbackLogicalProcessorCount
    : Math.max(1, navigator.hardwareConcurrency || fallbackLogicalProcessorCount);
const minimumTimelineThumbnailConcurrency = logicalProcessorCount <= 2 ? 1 : 2;

// Start with enough decoding threads per extraction for a fast first result,
// then widen the burst after the first thumbnail completes to fill the visible
// list. The active value is sent to FFmpeg with every extraction so its thread
// budget remains synchronized with this controller.
const initialTimelineThumbnailConcurrency = Math.min(
  8,
  Math.max(minimumTimelineThumbnailConcurrency, Math.ceil(logicalProcessorCount / 4)),
);
const maximumTimelineThumbnailConcurrency = Math.min(
  8,
  Math.max(initialTimelineThumbnailConcurrency, Math.ceil(logicalProcessorCount / 3)),
);

interface TimelineThumbnailWorkerSource {
  startNext: () => boolean;
}

const timelineThumbnailWorkerSources: TimelineThumbnailWorkerSource[] = [];
let activeTimelineThumbnailExtractions = 0;
let currentTimelineThumbnailConcurrency = initialTimelineThumbnailConcurrency;
let nextTimelineThumbnailWorkerSource = 0;
let timelineThumbnailWorkerMicrotaskScheduled = false;

function scheduleTimelineThumbnailWorkers() {
  if (timelineThumbnailWorkerMicrotaskScheduled) {
    return;
  }
  timelineThumbnailWorkerMicrotaskScheduled = true;
  // Let a synchronous render/prefetch batch enter the queues before choosing
  // the jobs closest to the viewport instead of starting its first rows.
  queueMicrotask(() => {
    timelineThumbnailWorkerMicrotaskScheduled = false;
    startTimelineThumbnailWorkers();
  });
}

function startTimelineThumbnailWorkers() {
  let sourcesWithoutWork = 0;
  while (
    activeTimelineThumbnailExtractions < currentTimelineThumbnailConcurrency &&
    sourcesWithoutWork < timelineThumbnailWorkerSources.length
  ) {
    const source = timelineThumbnailWorkerSources[nextTimelineThumbnailWorkerSource];
    nextTimelineThumbnailWorkerSource =
      (nextTimelineThumbnailWorkerSource + 1) % timelineThumbnailWorkerSources.length;
    if (!source.startNext()) {
      sourcesWithoutWork += 1;
      continue;
    }
    sourcesWithoutWork = 0;
    activeTimelineThumbnailExtractions += 1;
  }
  if (
    activeTimelineThumbnailExtractions === 0 &&
    sourcesWithoutWork >= timelineThumbnailWorkerSources.length
  ) {
    currentTimelineThumbnailConcurrency = initialTimelineThumbnailConcurrency;
  }
}

function completeTimelineThumbnailExtraction() {
  activeTimelineThumbnailExtractions = Math.max(0, activeTimelineThumbnailExtractions - 1);
  currentTimelineThumbnailConcurrency = maximumTimelineThumbnailConcurrency;
  scheduleTimelineThumbnailWorkers();
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
  resolution: TimelineThumbnailResolution;
}

export interface TimelineThumbnailResult {
  url: string;
  resolution: TimelineThumbnailResolution;
}

export interface TimelineThumbnailRequest {
  promise: Promise<TimelineThumbnailResult>;
  cancel: () => void;
  reprioritize: (priority: number) => void;
}

export interface TimelineThumbnailBackfillRequest {
  promise: Promise<void>;
  cancel: () => void;
  reprioritize: (priority: number) => void;
}

interface CachedThumbnail {
  url: string;
  timeUs: number;
  byteLength: number;
  pins: Set<number>;
  resolution: TimelineThumbnailResolution;
  groupKey: string;
  superseded: boolean;
}

interface ThumbnailConsumer {
  priority: number;
  retainInMemory: boolean;
}

interface ThumbnailJob<Options extends TimelineThumbnailOptions> {
  key: string;
  options: Options;
  resolution: TimelineThumbnailResolution;
  resolutions: TimelineThumbnailResolution[];
  consumers: Map<number, ThumbnailConsumer>;
  sequence: number;
  settled: boolean;
  resolvedCacheKey?: string;
  promise: Promise<TimelineThumbnailResult>;
  resolve: (result: TimelineThumbnailResult) => void;
  reject: (error: unknown) => void;
}

interface TimelineThumbnailManagerOptions<Options extends TimelineThumbnailOptions> {
  operation: OperationKey;
  cancelledError: () => unknown;
  cacheKey: (options: Options, resolution: TimelineThumbnailResolution) => string;
  cacheGroupKey: (options: Options, timeUs: number) => string;
  candidateCacheKeys: (options: Options, resolution: TimelineThumbnailResolution) => string[];
  cacheMatches: (cachedTimeUs: number, options: Options) => boolean;
  extract: (
    options: Options,
    resolutions: TimelineThumbnailResolution[],
    workerCount: number,
  ) => Promise<ExtractedTimelineThumbnail[]>;
}

export function createTimelineThumbnailManager<Options extends TimelineThumbnailOptions>(
  configuration: TimelineThumbnailManagerOptions<Options>,
) {
  const thumbnailCache = new Map<string, CachedThumbnail>();
  const activeCacheKeyByGroup = new Map<string, string>();
  const pendingJobs = new Map<string, ThumbnailJob<Options>>();
  const thumbnailQueue: ThumbnailJob<Options>[] = [];

  let cachedThumbnailBytes = 0;
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
    for (const consumer of job.consumers.values()) {
      priority = Math.min(priority, consumer.priority);
    }
    return priority;
  }

  function sortThumbnailQueue() {
    if (!queueOrderDirty) {
      return;
    }
    // A visible target-resolution request must beat offscreen prefetch work.
    // Width is only a tie-breaker after viewport priority.
    thumbnailQueue.sort(
      (left, right) =>
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

  function cachedThumbnail(
    options: Options,
    resolution: TimelineThumbnailResolution,
    allowHigherResolution: boolean,
  ) {
    const candidateResolutions = allowHigherResolution
      ? timelineThumbnailResolutions.filter((candidate) => candidate.width >= resolution.width)
      : [resolution];
    for (const candidateResolution of candidateResolutions) {
      for (const key of configuration.candidateCacheKeys(options, candidateResolution)) {
        const cached = thumbnailCache.get(key);
        if (!cached || cached.superseded || !configuration.cacheMatches(cached.timeUs, options)) {
          continue;
        }
        touchCachedThumbnail(key, cached);
        return { key, cached };
      }
    }
    return null;
  }

  function pendingThumbnailJob(options: Options, resolution: TimelineThumbnailResolution) {
    // A completed higher-resolution image may satisfy a lower target, but a
    // queued higher-resolution extraction must not survive a target downgrade.
    for (const key of configuration.candidateCacheKeys(options, resolution)) {
      const job = pendingJobs.get(key);
      if (job) {
        return job;
      }
    }
    return null;
  }

  function removeCachedThumbnail(key: string, cached: CachedThumbnail) {
    thumbnailCache.delete(key);
    cachedThumbnailBytes -= cached.byteLength;
    if (activeCacheKeyByGroup.get(cached.groupKey) === key) {
      activeCacheKeyByGroup.delete(cached.groupKey);
    }
    URL.revokeObjectURL(cached.url);
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
        removeCachedThumbnail(key, cached);
        evicted = true;
        break;
      }
      if (!evicted) {
        break;
      }
    }
  }

  function rememberThumbnail(
    options: Options,
    key: string,
    url: string,
    timeUs: number,
    byteLength: number,
    resolution: TimelineThumbnailResolution,
    pins: Iterable<number>,
  ) {
    const groupKey = configuration.cacheGroupKey(options, timeUs);
    const activeKey = activeCacheKeyByGroup.get(groupKey);
    const active = activeKey ? thumbnailCache.get(activeKey) : undefined;
    if (active && active.resolution.width >= resolution.width) {
      URL.revokeObjectURL(url);
      const match = { key: activeKey!, cached: active };
      pinCachedThumbnail(match, pins);
      return match;
    }

    if (active && activeKey) {
      active.superseded = true;
      if (active.pins.size === 0) {
        removeCachedThumbnail(activeKey, active);
      }
    }

    const cached: CachedThumbnail = {
      url,
      timeUs,
      byteLength,
      pins: new Set(pins),
      resolution,
      groupKey,
      superseded: false,
    };
    thumbnailCache.set(key, cached);
    activeCacheKeyByGroup.set(groupKey, key);
    cachedThumbnailBytes += byteLength;
    evictCachedThumbnails();
    return { key, cached };
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
    if (cached.superseded && cached.pins.size === 0) {
      removeCachedThumbnail(key, cached);
      return;
    }
    evictCachedThumbnails();
  }

  function createJob(options: Options, resolutions: TimelineThumbnailResolution[], key?: string) {
    const resolution = resolutions.at(-1);
    if (resolution === undefined) {
      throw new Error("A timeline thumbnail job requires at least one resolution");
    }
    const cacheKey = key ?? configuration.cacheKey(options, resolution);
    let resolve!: (result: TimelineThumbnailResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<TimelineThumbnailResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: ThumbnailJob<Options> = {
      key: cacheKey,
      options,
      resolution,
      resolutions,
      consumers: new Map(),
      sequence: nextJobSequence++,
      settled: false,
      promise,
      resolve,
      reject,
    };
    pendingJobs.set(cacheKey, job);
    thumbnailQueue.push(job);
    queueOrderDirty = true;
    return job;
  }

  function request(options: Options): TimelineThumbnailRequest {
    const resolution = options.resolution ?? timelineThumbnailResolutions[0];
    const consumerId = nextConsumerId++;
    const priority = normalizedPriority(options.priority);
    const cached = cachedThumbnail(options, resolution, true);
    if (cached) {
      cached.cached.pins.add(consumerId);
      let cancelled = false;
      return {
        promise: Promise.resolve({
          url: cached.cached.url,
          resolution: cached.cached.resolution,
        }),
        cancel: () => {
          if (cancelled) {
            return;
          }
          cancelled = true;
          releaseCachedThumbnail(cached.key, consumerId);
        },
        reprioritize: () => undefined,
      };
    }

    let job = pendingThumbnailJob(options, resolution);
    if (!job) {
      job = createJob(options, [resolution]);
    }
    job.consumers.set(consumerId, { priority, retainInMemory: true });
    queueOrderDirty = true;
    scheduleTimelineThumbnailWorkers();

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
      reprioritize: (nextPriority) => {
        if (cancelled || job!.settled) {
          return;
        }
        const consumer = job!.consumers.get(consumerId);
        if (!consumer) {
          return;
        }
        consumer.priority = normalizedPriority(nextPriority);
        queueOrderDirty = true;
        scheduleTimelineThumbnailWorkers();
      },
    };
  }

  function completedBackfillRequest(): TimelineThumbnailBackfillRequest {
    return {
      promise: Promise.resolve(),
      cancel: () => undefined,
      reprioritize: () => undefined,
    };
  }

  function attachBackfillConsumer(
    job: ThumbnailJob<Options>,
    consumerId: number,
    priority: number,
  ): TimelineThumbnailBackfillRequest {
    job.consumers.set(consumerId, { priority, retainInMemory: false });
    queueOrderDirty = true;
    scheduleTimelineThumbnailWorkers();

    let cancelled = false;
    return {
      promise: job.promise.then(() => undefined),
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        if (!job.settled) {
          job.consumers.delete(consumerId);
          queueOrderDirty = true;
        }
      },
      reprioritize: (nextPriority) => {
        if (cancelled || job.settled) {
          return;
        }
        const consumer = job.consumers.get(consumerId);
        if (!consumer) {
          return;
        }
        consumer.priority = normalizedPriority(nextPriority);
        queueOrderDirty = true;
        scheduleTimelineThumbnailWorkers();
      },
    };
  }

  function backfill(
    options: Options,
    resolutions: readonly TimelineThumbnailResolution[],
  ): TimelineThumbnailBackfillRequest {
    const requestedResolutions = Array.from(
      new Map(resolutions.map((resolution) => [resolution.width, resolution])).values(),
    ).sort((left, right) => left.width - right.width);
    if (requestedResolutions.length === 0) {
      return completedBackfillRequest();
    }
    if (requestedResolutions.length === 1) {
      const resolution = requestedResolutions[0];
      const consumerId = nextConsumerId++;
      const priority = normalizedPriority(options.priority);
      if (cachedThumbnail(options, resolution, true)) {
        return completedBackfillRequest();
      }
      let job = pendingThumbnailJob(options, resolution);
      if (!job) {
        job = createJob(options, [resolution]);
      }
      return attachBackfillConsumer(job, consumerId, priority);
    }

    const batchKey = `${configuration.cacheGroupKey(options, options.timeUs)}\u0000batch\u0000${requestedResolutions
      .map((resolution) => resolution.width)
      .join(",")}`;
    let job = pendingJobs.get(batchKey);
    if (!job) {
      job = createJob(options, requestedResolutions, batchKey);
    }
    return attachBackfillConsumer(job, nextConsumerId++, normalizedPriority(options.priority));
  }

  function nextJob() {
    sortThumbnailQueue();
    while (thumbnailQueue.length > 0) {
      const job = thumbnailQueue.shift()!;
      if (job.consumers.size > 0) {
        return job;
      }
      pendingJobs.delete(job.key);
      job.settled = true;
      job.reject(configuration.cancelledError());
    }
    return null;
  }

  async function runJob(job: ThumbnailJob<Options>) {
    // A cache write can complete while this job is waiting in the queue.
    const cached =
      job.resolutions.length === 1 ? cachedThumbnail(job.options, job.resolution, true) : null;
    if (cached) {
      const retainedConsumerIds = Array.from(job.consumers)
        .filter(([, consumer]) => consumer.retainInMemory)
        .map(([consumerId]) => consumerId);
      pinCachedThumbnail(cached, retainedConsumerIds);
      pendingJobs.delete(job.key);
      job.resolvedCacheKey = cached.key;
      job.settled = true;
      job.resolve({ url: cached.cached.url, resolution: cached.cached.resolution });
      return;
    }

    const outcome = await runOperation(configuration.operation, () =>
      configuration.extract(job.options, job.resolutions, currentTimelineThumbnailConcurrency),
    );
    try {
      if (outcome.status !== "success") {
        job.reject(outcome.status === "failed" ? outcome.error : configuration.cancelledError());
        return;
      }
      const extracted = outcome.value;
      let targetResult: TimelineThumbnailResult | undefined;
      for (const item of extracted) {
        const key = configuration.cacheKey(job.options, item.resolution);
        const isTarget = item.resolution.width === job.resolution.width;
        const retainedConsumerIds = isTarget
          ? Array.from(job.consumers)
              .filter(([, consumer]) => consumer.retainInMemory)
              .map(([consumerId]) => consumerId)
          : [];
        if (retainedConsumerIds.length > 0) {
          const url = URL.createObjectURL(item.blob);
          const remembered = rememberThumbnail(
            job.options,
            key,
            url,
            item.timeUs,
            item.blob.size,
            item.resolution,
            retainedConsumerIds,
          );
          if (isTarget) {
            targetResult = {
              url: remembered.cached.url,
              resolution: remembered.cached.resolution,
            };
            job.resolvedCacheKey = remembered.key;
          }
        } else if (isTarget) {
          targetResult = { url: "", resolution: item.resolution };
        }
      }
      if (targetResult !== undefined) {
        job.resolve(targetResult);
      } else {
        job.reject(configuration.cancelledError());
      }
    } finally {
      pendingJobs.delete(job.key);
      job.settled = true;
    }
  }

  function peek(options: Options, resolution: TimelineThumbnailResolution) {
    const targetIndex = timelineThumbnailResolutions.findIndex(
      (candidate) => candidate.width === resolution.width,
    );
    const higher = cachedThumbnail(options, resolution, true);
    if (higher) {
      return { url: higher.cached.url, resolution: higher.cached.resolution };
    }
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const lower = cachedThumbnail(options, timelineThumbnailResolutions[index], false);
      if (lower) {
        return { url: lower.cached.url, resolution: lower.cached.resolution };
      }
    }
    return null;
  }

  timelineThumbnailWorkerSources.push({
    startNext: () => {
      const job = nextJob();
      if (!job) {
        return false;
      }
      void runJob(job).finally(completeTimelineThumbnailExtraction);
      return true;
    },
  });

  return { request, backfill, peek };
}
