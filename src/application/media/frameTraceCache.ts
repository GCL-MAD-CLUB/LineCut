import type { PlaybackTraceSample } from "../../core/editor/frameTrace";
import type { FrameTraceData } from "./browserFrameTrace";

// Fixed-size pages share partial and complete results across shots and panels.
// Six f64 metrics plus a presence byte per frame; the global LRU bounds payload
// memory to 8 MiB, without scanning all cached frames on every insertion.
const PAGE_FRAMES = 256;
const PAGE_BYTES = PAGE_FRAMES * (6 * 8 + 1);
const MAX_PAGES = Math.floor((8 * 1024 * 1024) / PAGE_BYTES);
interface Page {
  values: Float64Array;
  present: Uint8Array;
}
const pages = new Map<string, Page>();
const caches = new Map<string, FrameTraceCache>();

export function frameTraceCacheKey(
  source: string,
  frameRate: number,
  fingerprint = "",
  assetId?: string,
) {
  // Decoder and preview/proxy URL are not part of the identity: both producers
  // populate the same per-asset frame slots. URLs only identify browser-only media.
  return JSON.stringify(["rgb96x54-weber11-v3", assetId || source, frameRate, fingerprint]);
}

export function getFrameTraceCache(key: string): FrameTraceCache {
  let cache = caches.get(key);
  if (!cache) {
    cache = new FrameTraceCache(key);
    caches.set(key, cache);
  }
  // Only discard idle metadata. Page payloads have their own global budget.
  if (caches.size > 32) {
    for (const [id, entry] of caches) {
      if (entry !== cache && !entry.observed) caches.delete(id);
      if (caches.size <= 32) break;
    }
  }
  return cache;
}

export class FrameTraceCache {
  private listeners = new Set<() => void>();
  private users = 0;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly key: string) {}
  get observed() {
    return this.listeners.size > 0 || this.users > 0;
  }
  retain() {
    this.users++;
    return () => {
      this.users--;
    };
  }
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };
  private page(frame: number, create = false) {
    const key = `${this.key}:${Math.floor(frame / PAGE_FRAMES)}`;
    let page = pages.get(key);
    if (!page && create) {
      page = { values: new Float64Array(PAGE_FRAMES * 6), present: new Uint8Array(PAGE_FRAMES) };
    }
    if (page) {
      pages.delete(key);
      pages.set(key, page);
      if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
    }
    return page;
  }
  get(frame: number): PlaybackTraceSample | undefined {
    const page = this.page(frame);
    const slot = frame % PAGE_FRAMES;
    if (!page?.present[slot]) return;
    return this.sample(page, frame);
  }
  has(frame: number, requireMotion = false) {
    const page = this.page(frame),
      slot = frame % PAGE_FRAMES;
    return Boolean(
      page?.present[slot] && (!requireMotion || !Number.isNaN(page.values[slot * 6 + 5])),
    );
  }
  private sample(page: Page, frame: number): PlaybackTraceSample {
    const slot = frame % PAGE_FRAMES;
    const offset = slot * 6,
      values = page.values;
    const motion = values[offset + 5];
    return {
      frame,
      colors: [values[offset], values[offset + 1], values[offset + 2], values[offset + 3]],
      sharpness: values[offset + 4],
      motion: Number.isNaN(motion) ? null : motion,
      previousFrame: Number.isNaN(motion) ? null : frame - 1,
    };
  }
  put(sample: PlaybackTraceSample) {
    if (!Number.isSafeInteger(sample.frame) || sample.frame < 0) return;
    if (sample.previousSample) this.put(sample.previousSample);
    const page = this.page(sample.frame, true)!;
    const slot = sample.frame % PAGE_FRAMES,
      offset = slot * 6;
    // First complete observation wins across producers. An isolated browser
    // frame can acquire its missing motion without replacing colors/sharpness.
    if (page.present[slot]) {
      if (!Number.isNaN(page.values[offset + 5]) || sample.motion === null) return;
    } else {
      page.values.set(sample.colors, offset);
      page.values[offset + 4] = sample.sharpness;
    }
    page.values[offset + 5] = sample.motion ?? NaN;
    page.present[slot] = 1;
    this.revision++;
    // Sampling stays at video cadence; only chart notifications are coalesced.
    if (this.timer === null && this.listeners.size) {
      this.timer = setTimeout(() => {
        this.timer = null;
        for (const listener of this.listeners) listener();
      }, 32);
    }
  }
  samples(start: number, end: number): PlaybackTraceSample[] {
    const result: PlaybackTraceSample[] = [];
    for (let first = start; first <= end;) {
      const page = this.page(first);
      const limit = Math.min(end + 1, (Math.floor(first / PAGE_FRAMES) + 1) * PAGE_FRAMES);
      if (page) {
        for (let frame = first; frame < limit; frame++) {
          if (page.present[frame % PAGE_FRAMES]) result.push(this.sample(page, frame));
        }
      }
      first = limit;
    }
    return result;
  }
  complete(start: number, end: number): FrameTraceData | null {
    const data: FrameTraceData = { colors: [], motion: [], sharpness: [] };
    for (let first = start; first <= end;) {
      const page = this.page(first);
      if (!page) return null;
      const limit = Math.min(end + 1, (Math.floor(first / PAGE_FRAMES) + 1) * PAGE_FRAMES);
      for (let frame = first; frame < limit; frame++) {
        const slot = frame % PAGE_FRAMES,
          offset = slot * 6,
          values = page.values;
        if (!page.present[slot] || (frame > start && Number.isNaN(values[offset + 5]))) return null;
        data.colors.push([
          values[offset],
          values[offset + 1],
          values[offset + 2],
          values[offset + 3],
        ]);
        data.sharpness.push(values[offset + 4]);
        if (frame > start) data.motion.push(values[offset + 5]);
      }
      first = limit;
    }
    return data;
  }
}
