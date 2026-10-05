import { ChevronDown, ChevronsUpDown, RotateCw } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { invokeCommand, runOperation } from "../../../../errors";
import type { StoryboardShot } from "../../../../types";
import { eventSource } from "../../../../runtime/events/EventHub";
import { publishEvent } from "../../../../runtime/events/react";
import { frameColorCurvePath, motionCurvePath, motionHoverFrame } from "./motionCurve";
import { PopupMenu, PopupMenuItem, useCloseOnOutsidePointer } from "../../../common/PopupMenu";

const motionEventSource = eventSource("storyboard-motion");

interface Props {
  visible: boolean;
  shot?: StoryboardShot;
  assetId?: string;
  fingerprint?: string;
  playbackFrame?: number;
  onSeekFrame: (frame: number) => void;
}

type TraceMode = "motion" | "colors" | "sharpness";
type FrameColors = [number, number, number, number];
type TraceData =
  { mode: "motion" | "sharpness"; values: number[] } | { mode: "colors"; values: FrameColors[] };

interface FrameTraceData {
  motion: number[];
  colors: FrameColors[];
  sharpness: number[];
}

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

export function StoryboardMotionPanel({
  visible,
  shot,
  assetId,
  fingerprint,
  playbackFrame,
  onSeekFrame,
}: Props) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<TraceMode>("motion");
  const [modeMenu, setModeMenu] = useState<{ x: number; y: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<TraceResult | null>(null);
  const cache = useRef(new Map<string, FrameTraceData>());
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [pixelWidth, setPixelWidth] = useState(1);
  const startFrame = shot?.start_frame;
  const endFrame = shot?.end_frame;
  const key = JSON.stringify([assetId, fingerprint, startFrame, endFrame]);
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
    setHover({ key, progress });
    onSeekFrame(motionHoverFrame(shot.start_frame, shot.end_frame, progress));
  }

  function updateHover(event: PointerEvent<SVGSVGElement>) {
    if (
      !visible ||
      !open ||
      !shot ||
      !assetId ||
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
    if (!visible || !open || !assetId || startFrame === undefined || endFrame === undefined) return;
    const cached = cache.current.get(key);
    if (cached) {
      cache.current.delete(key);
      cache.current.set(key, cached);
      setResult({ key, data: cached, failed: false });
      return;
    }
    let disposed = false;
    let started = false;
    const taskId = `storyboard-frame-trace-${crypto.randomUUID()}`;
    setResult({ key, data: null, failed: false });
    const timer = window.setTimeout(() => {
      started = true;
      void runOperation<FrameTraceData>("storyboard.trace", () =>
        invokeCommand<FrameTraceData>("storyboard_frame_trace", {
          assetId,
          startFrame,
          endFrame,
          taskId,
        }),
      ).then((outcome) => {
        if (disposed) return;
        if (outcome.status === "success") {
          cache.current.set(key, outcome.value);
          let bytes = Array.from(cache.current.values()).reduce(
            (total, entry) =>
              total + (entry.motion.length + entry.colors.length * 4 + entry.sharpness.length) * 8,
            0,
          );
          while (cache.current.size > 8 || bytes > 8 * 1024 * 1024) {
            const oldest = cache.current.keys().next().value!;
            const entry = cache.current.get(oldest)!;
            bytes -= (entry.motion.length + entry.colors.length * 4 + entry.sharpness.length) * 8;
            cache.current.delete(oldest);
          }
          setResult({ key, data: outcome.value, failed: false });
        } else {
          setResult({ key, data: null, failed: true });
        }
      });
    }, 180);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (started) {
        void runOperation("task.cancel", () => invokeCommand("cancel_task", { taskId }));
      }
    };
  }, [visible, open, assetId, startFrame, endFrame, key, retry]);

  const current = result?.key === key ? result : null;
  const data = useMemo<TraceData | null>(() => {
    if (!current?.data) return null;
    return mode === "colors"
      ? { mode, values: current.data.colors }
      : { mode, values: current.data[mode] };
  }, [current?.data, mode]);
  const curvePath = useMemo(
    () => motionCurvePath(data?.mode === "motion" ? data.values : [], pixelWidth),
    [data, pixelWidth],
  );
  const colorPaths = useMemo(
    () =>
      data?.mode === "colors"
        ? colorLayers.map(({ channel, name }) => ({
            name,
            path: frameColorCurvePath(
              data.values.map((frame) => frame[channel]),
              pixelWidth,
            ),
          }))
        : [],
    [data, pixelWidth],
  );
  const sharpnessPath = useMemo(() => {
    if (data?.mode !== "sharpness") return "";
    // Fit the unbounded score to the chart; cached values keep their original units.
    const maximum = data.values.reduce((max, value) => Math.max(max, value), 0) || 1;
    return frameColorCurvePath(
      data.values.map((value) => value / maximum),
      pixelWidth,
    );
  }, [data, pixelWidth]);
  const modeLabel = traceModes.find((option) => option.mode === mode)!.label;
  const hoverProgress = hover?.key === key ? hover.progress : null;
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
      : current?.failed
        ? "计算失败"
        : !data
          ? "计算中…"
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
          aria-busy={Boolean(shot && assetId && !current?.failed && !data)}
        >
          <svg
            ref={chartRef}
            viewBox="0 0 1 2"
            preserveAspectRatio="none"
            role="img"
            aria-label={`当前主选中分镜的${modeLabel}帧迹图`}
            onPointerEnter={updateHover}
            onPointerMove={updateHover}
            onPointerLeave={finishHover}
            onPointerCancel={finishHover}
            onClick={seekFromChart}
          >
            {data?.mode === "motion" && data.values.length > 0 && (
              <>
                <path className="motion-area" d={`${curvePath} L1,2 L0,2 Z`} />
                <path className="motion-line" d={curvePath} />
              </>
            )}
            {data?.mode === "sharpness" && data.values.length > 0 && (
              <>
                <path
                  className="frame-trace-area frame-trace-sharpness"
                  d={`${sharpnessPath} L1,2 L0,2 Z`}
                />
                <path className="frame-trace-line frame-trace-sharpness" d={sharpnessPath} />
              </>
            )}
            {data?.mode === "colors" && data.values.length > 0 && (
              <>
                {colorPaths.map(({ name, path }) => (
                  <path
                    key={`fill-${name}`}
                    className={`frame-trace-area frame-trace-${name}`}
                    d={`${path} L1,2 L0,2 Z`}
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
                y2="2"
              />
            )}
            {playbackProgress !== null && (
              <line
                className="frame-trace-playback-line"
                x1={playbackProgress}
                x2={playbackProgress}
                y1="0"
                y2="2"
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
