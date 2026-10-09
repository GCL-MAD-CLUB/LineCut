import { ChevronDown, ChevronsUpDown, RotateCw } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { runOperation } from "../../../../errors";
import {
  decodeBrowserFrameTrace,
  type FrameTraceData,
} from "../../../../application/media/browserFrameTrace";
import {
  frameTraceCacheKey,
  getFrameTraceCache,
} from "../../../../application/media/frameTraceCache";
import { NativeFrameTraceSession } from "../../../../application/media/nativeFrameTrace";
import { isTauriRuntime } from "../../../../platform/tauri/runtime";
import type { StoryboardShot } from "../../../../types";
import { eventSource } from "../../../../runtime/events/EventHub";
import { publishEvent } from "../../../../runtime/events/react";
import { motionHoverFrame } from "./motionCurve";
import { PopupMenu, PopupMenuItem, useCloseOnOutsidePointer } from "../../../common/PopupMenu";
import { usePublishProjection, useStableIdentity } from "../../../../runtime/state/react";
import { PLAYBACK_TRACE_DEMAND_PROJECTION } from "../../../../runtime/state/contracts";
import { usePanelInstanceId } from "../../../../runtime/systems/PanelState";
import { completeTraceSamples, playbackTracePaths } from "./playbackTraceCurve";

const motionEventSource = eventSource("storyboard-motion");

interface Props {
  visible: boolean;
  shot?: StoryboardShot;
  assetId?: string;
  fingerprint?: string;
  videoSource?: string;
  frameRate?: number;
  playbackFrame?: number;
  isPlaying: boolean;
  onSeekFrame: (frame: number) => void;
}

type TraceMode = "motion" | "colors" | "sharpness";
type FrameColors = number[];
type TraceData =
  { mode: "motion" | "sharpness"; values: number[] } | { mode: "colors"; values: FrameColors[] };

const traceModes = [
  { mode: "motion", label: "动势" },
  { mode: "colors", label: "四色" },
  { mode: "sharpness", label: "清晰度" },
] as const;
const colorLayers = [
  { channel: 2, name: "blue" },
  { channel: 0, name: "red" },
  { channel: 1, name: "green" },
  { channel: 3, name: "gray" },
] as const;

interface TraceResult {
  key: string;
  data: FrameTraceData | null;
  failed: boolean;
}

const noTraceSubscription = () => () => {};
const noTraceRevision = () => 0;

function rememberTrace(cache: Map<string, FrameTraceData>, key: string, data: FrameTraceData) {
  cache.delete(key);
  cache.set(key, data);
  // Include the nested JS color arrays and references, not just their f64 values.
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.colors.length * 96;
  while (cache.size > 8 || bytes > 8 * 1024 * 1024) {
    const oldest = cache.keys().next().value!;
    bytes -= cache.get(oldest)!.colors.length * 96;
    cache.delete(oldest);
  }
}

export function StoryboardMotionPanel({
  visible,
  shot,
  assetId,
  fingerprint,
  videoSource,
  frameRate = 25,
  playbackFrame,
  isPlaying,
  onSeekFrame,
}: Props) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<TraceMode>("motion");
  const [modeMenu, setModeMenu] = useState<{ x: number; y: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<TraceResult | null>(null);
  const cache = useRef(new Map<string, FrameTraceData>());
  const native = isTauriRuntime();
  const nativeSession = useRef<NativeFrameTraceSession | null>(null);
  const sourceCache = useMemo(
    () =>
      getFrameTraceCache(frameTraceCacheKey(videoSource ?? "", frameRate, fingerprint, assetId)),
    [assetId, videoSource, frameRate, fingerprint],
  );
  const identity = useStableIdentity("playback-trace", usePanelInstanceId());
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [pixelWidth, setPixelWidth] = useState(1);
  const startFrame = shot?.start_frame;
  const endFrame = shot?.end_frame;
  const key = JSON.stringify([assetId, fingerprint, startFrame, endFrame, videoSource, frameRate]);
  const knownCompleteData =
    (result?.key === key ? result.data : null) ?? cache.current.get(key) ?? null;
  const observeLive = visible && open && !knownCompleteData;
  const liveVersion = useSyncExternalStore(
    observeLive ? sourceCache.subscribe : noTraceSubscription,
    observeLive ? sourceCache.getSnapshot : noTraceRevision,
  );
  const hasPlaybackFrame =
    playbackFrame !== undefined &&
    startFrame !== undefined &&
    endFrame !== undefined &&
    playbackFrame >= startFrame &&
    playbackFrame <= endFrame;
  const demand = useMemo(() => ({ enabled: visible && open }), [visible, open]);
  usePublishProjection(PLAYBACK_TRACE_DEMAND_PROJECTION, identity, demand);
  const [hover, setHover] = useState<{ key: string; progress: number } | null>(null);
  const hoverSession = useRef<{ sessionId: string; assetId: string; frame: number } | null>(null);
  useCloseOnOutsidePointer(Boolean(modeMenu), () => setModeMenu(null));

  useEffect(() => {
    if (!visible || !open) setModeMenu(null);
  }, [visible, open]);

  function finishHover() {
    const session = hoverSession.current;
    hoverSession.current = null;
    setHover(null);
    if (session) {
      publishEvent(
        "playback.frame-preview.requested",
        { ...session, frame: null },
        motionEventSource,
      );
    }
  }

  useEffect(() => {
    window.addEventListener("blur", finishHover);
    return () => {
      window.removeEventListener("blur", finishHover);
      finishHover();
    };
  }, [key, mode, open, visible]);

  useLayoutEffect(() => {
    if (isPlaying) finishHover();
  }, [isPlaying]);

  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart || !visible || !open) return;
    const measure = () =>
      setPixelWidth(
        Math.max(1, Math.ceil((chart.getBoundingClientRect().width - 2) * window.devicePixelRatio)),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(chart);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visible, open]);

  function chartProgress(event: { currentTarget: SVGSVGElement; clientX: number }) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left - 1) / Math.max(1, bounds.width - 2)),
    );
  }

  function seekFromChart(event: MouseEvent<SVGSVGElement>) {
    if (!visible || !open || !shot || !assetId || event.button !== 0) return;
    event.stopPropagation();
    const progress = chartProgress(event);
    finishHover();
    if (!isPlaying) setHover({ key, progress });
    onSeekFrame(motionHoverFrame(shot.start_frame, shot.end_frame, progress));
  }

  function updateHover(event: PointerEvent<SVGSVGElement>) {
    if (
      !visible ||
      isPlaying ||
      !open ||
      !shot ||
      !assetId ||
      !videoSource ||
      event.buttons !== 0 ||
      event.pointerType === "touch"
    )
      return;
    const progress = chartProgress(event);
    setHover({ key, progress });
    const frame = motionHoverFrame(shot.start_frame, shot.end_frame, progress);
    if (!hoverSession.current) {
      hoverSession.current = { sessionId: crypto.randomUUID(), assetId, frame };
    } else if (hoverSession.current.frame === frame) {
      return;
    }
    hoverSession.current.frame = frame;
    publishEvent(
      "playback.frame-preview.requested",
      { ...hoverSession.current },
      motionEventSource,
    );
  }

  useEffect(() => {
    if (
      !native ||
      !visible ||
      !open ||
      !assetId ||
      startFrame === undefined ||
      endFrame === undefined
    )
      return;
    const cached = cache.current.get(key);
    if (cached) {
      setResult({ key, data: cached, failed: false });
      return;
    }
    const session = new NativeFrameTraceSession(
      assetId,
      startFrame,
      endFrame,
      frameRate,
      sourceCache,
      (data) => {
        rememberTrace(cache.current, key, data);
        setResult({ key, data, failed: false });
      },
      () => setResult({ key, data: null, failed: true }),
    );
    nativeSession.current = session;
    setResult({ key, data: cache.current.get(key) ?? null, failed: false });
    return () => {
      session.dispose();
      if (nativeSession.current === session) nativeSession.current = null;
    };
  }, [native, visible, open, assetId, startFrame, endFrame, frameRate, sourceCache, key, retry]);

  useEffect(() => {
    nativeSession.current?.update(playbackFrame, isPlaying);
  }, [
    native,
    visible,
    open,
    assetId,
    startFrame,
    endFrame,
    frameRate,
    sourceCache,
    key,
    retry,
    playbackFrame,
    isPlaying,
  ]);

  useEffect(() => {
    if (
      native ||
      isPlaying ||
      !visible ||
      !open ||
      !assetId ||
      !videoSource ||
      startFrame === undefined ||
      endFrame === undefined
    )
      return;
    const cached = cache.current.get(key) ?? sourceCache.complete(startFrame, endFrame);
    if (cached) {
      rememberTrace(cache.current, key, cached);
      setResult({ key, data: cached, failed: false });
      return;
    }
    let disposed = false;
    const controller = new AbortController();
    setResult({ key, data: null, failed: false });
    const timer = window.setTimeout(() => {
      void runOperation<FrameTraceData>("storyboard.trace", () =>
        decodeBrowserFrameTrace(
          videoSource!,
          frameRate,
          startFrame,
          endFrame,
          controller.signal,
          sourceCache,
        ),
      ).then((outcome) => {
        if (disposed) return;
        if (outcome.status === "success") {
          rememberTrace(cache.current, key, outcome.value);
          setResult({ key, data: outcome.value, failed: false });
        } else {
          setResult({ key, data: null, failed: true });
        }
      });
    }, 180);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    native,
    isPlaying,
    visible,
    open,
    assetId,
    videoSource,
    frameRate,
    startFrame,
    endFrame,
    key,
    retry,
    sourceCache,
  ]);

  const current = result?.key === key ? result : null;
  const completeData = knownCompleteData;
  const useLiveTrace = !completeData;
  const fullSamples = useMemo(
    () => (completeData ? completeTraceSamples(completeData, startFrame ?? 0) : null),
    [completeData, startFrame],
  );
  const plotEndFrame = fullSamples || !isPlaying ? (endFrame ?? 0) : (playbackFrame ?? -1);
  const liveSamples = useMemo(
    () =>
      fullSamples ??
      (observeLive
        ? sourceCache.samples(startFrame ?? 0, Math.min(endFrame ?? -1, plotEndFrame))
        : []),
    [fullSamples, sourceCache, startFrame, endFrame, plotEndFrame, liveVersion, observeLive],
  );
  const livePaths = useMemo(
    () =>
      playbackTracePaths(
        liveSamples,
        startFrame ?? 0,
        endFrame ?? 0,
        plotEndFrame,
        pixelWidth,
        mode,
        true,
      ),
    [liveSamples, startFrame, endFrame, plotEndFrame, pixelWidth, mode],
  );
  const hasLiveSamples = (!isPlaying || hasPlaybackFrame) && liveSamples.length > 0;
  const hasTrace = useLiveTrace ? hasLiveSamples : Boolean(completeData);
  const data = useMemo<TraceData | null>(() => {
    if (!completeData) return null;
    return mode === "colors"
      ? { mode, values: completeData.colors }
      : { mode, values: completeData[mode] };
  }, [completeData, mode]);
  const curvePath = livePaths.motion.line;
  const colorPaths = colorLayers.map(({ channel, name }) => ({
    name,
    path: livePaths.colors[channel].line,
    area: livePaths.colors[channel].area,
  }));
  const sharpnessPath = livePaths.sharpness.line;
  const modeLabel = traceModes.find((option) => option.mode === mode)!.label;
  const chartMaximum = mode === "motion" ? 1 : 2;
  const hoverProgress = !isPlaying && hover?.key === key ? hover.progress : null;
  const playbackProgress =
    shot &&
    playbackFrame !== undefined &&
    playbackFrame >= shot.start_frame &&
    playbackFrame <= shot.end_frame
      ? (playbackFrame - shot.start_frame) / Math.max(1, shot.end_frame - shot.start_frame)
      : null;
  const status =
    !shot || !assetId
      ? ""
      : isPlaying
        ? null
        : current?.failed
          ? "计算失败"
          : !data
            ? ""
            : data.values.length === 0
              ? "无相邻帧"
              : null;

  return (
    <section className={`storyboard-motion-section ${open ? "" : "is-collapsed"}`.trim()}>
      <header className="storyboard-keyword-panel-heading storyboard-frame-trace-heading">
        <button
          type="button"
          className={`storyboard-keyword-dropdown-shell storyboard-keyword-mode-trigger ${modeMenu ? "is-open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(modeMenu)}
          aria-label="帧迹图类型"
          title="选择帧迹图类型"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (modeMenu) {
              setModeMenu(null);
              return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            setModeMenu({ x: bounds.left, y: bounds.bottom });
          }}
        >
          <span className="storyboard-keyword-dropdown-value">{modeLabel}</span>
          <span className="storyboard-keyword-dropdown-arrows" aria-hidden="true">
            <ChevronsUpDown />
          </span>
        </button>
        <button
          type="button"
          className="storyboard-keyword-panel-heading-title"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>帧迹图</span>
          <ChevronDown className={open ? "" : "is-collapsed"} aria-hidden="true" />
        </button>
      </header>
      {open && (
        <div
          className="storyboard-motion-chart"
          aria-busy={Boolean(!isPlaying && shot && assetId && !current?.failed && !data)}
        >
          <svg
            ref={chartRef}
            viewBox={`0 0 1 ${chartMaximum}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`当前分镜的${modeLabel}帧迹图`}
            onPointerEnter={updateHover}
            onPointerMove={updateHover}
            onPointerLeave={finishHover}
            onPointerCancel={finishHover}
            onClick={seekFromChart}
          >
            {mode === "motion" && hasTrace && curvePath && (
              <>
                <path className="motion-area" d={livePaths.motion.area} />
                <path className="motion-line" d={curvePath} />
              </>
            )}
            {mode === "sharpness" && hasTrace && sharpnessPath && (
              <>
                <path
                  className="frame-trace-area frame-trace-sharpness"
                  d={livePaths.sharpness.area}
                />
                <path className="frame-trace-line frame-trace-sharpness" d={sharpnessPath} />
              </>
            )}
            {mode === "colors" && hasTrace && (
              <>
                {colorPaths.map(({ name, path, area }) => (
                  <path
                    key={`fill-${name}`}
                    className={`frame-trace-area frame-trace-${name}`}
                    d={area ?? `${path} L1,2 L0,2 Z`}
                  />
                ))}
                {colorPaths
                  .filter(({ name }) => name === "gray")
                  .map(({ name, path }) => (
                    <path
                      key={`line-${name}`}
                      className={`frame-trace-line frame-trace-${name}`}
                      d={path}
                    />
                  ))}
                {colorPaths
                  .filter(({ name }) => name !== "gray")
                  .map(({ name, path }) => (
                    <path
                      key={`line-${name}`}
                      className={`frame-trace-line frame-trace-${name}`}
                      d={path}
                    />
                  ))}
              </>
            )}
            {hoverProgress !== null && (
              <line
                className="motion-hover-line"
                x1={hoverProgress}
                x2={hoverProgress}
                y1="0"
                y2={chartMaximum}
              />
            )}
            {playbackProgress !== null && (
              <line
                className="frame-trace-playback-line"
                x1={playbackProgress}
                x2={playbackProgress}
                y1="0"
                y2={chartMaximum}
              />
            )}
          </svg>
          {status && (
            <div className="storyboard-motion-status" role="status">
              <span>{status}</span>
              {current?.failed && (
                <button
                  type="button"
                  title="重新计算"
                  aria-label="重新计算"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RotateCw size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {open &&
        modeMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-keyword-mode-menu"
            contextMenuAnchor={modeMenu}
            ariaLabel="帧迹图类型"
            style={{ position: "fixed", left: modeMenu.x, top: modeMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {traceModes.map((option) => (
              <PopupMenuItem
                key={option.mode}
                checked={mode === option.mode}
                indicator="check"
                onSelect={() => {
                  setMode(option.mode);
                  setModeMenu(null);
                }}
              >
                {option.label}
              </PopupMenuItem>
            ))}
          </PopupMenu>,
          document.body,
        )}
    </section>
  );
}
