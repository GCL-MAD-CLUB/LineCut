import { ChevronDown, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invokeCommand, runOperation } from "../../errors";
import type { StoryboardShot } from "../../types";
import { eventSource } from "../../runtime/events/EventHub";
import { publishEvent } from "../../runtime/events/react";
import { motionCurvePath, motionHoverFrame } from "./motionCurve";

const motionEventSource = eventSource("storyboard-motion");

interface Props {
  visible: boolean;
  shot?: StoryboardShot;
  assetId?: string;
  fingerprint?: string;
}

interface MotionResult {
  key: string;
  values: number[] | null;
  failed: boolean;
}

export function StoryboardMotionPanel({ visible, shot, assetId, fingerprint }: Props) {
  const [open, setOpen] = useState(true);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<MotionResult | null>(null);
  const cache = useRef(new Map<string, number[]>());
  const startFrame = shot?.start_frame;
  const endFrame = shot?.end_frame;
  const key = JSON.stringify([assetId, fingerprint, startFrame, endFrame]);
  const [hover, setHover] = useState<{ key: string; progress: number } | null>(null);
  const hoverSession = useRef<{ sessionId: string; assetId: string; frame: number } | null>(null);

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
  }, [key, open, visible]);

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
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left - 1) / Math.max(1, bounds.width - 2)),
    );
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
      setResult({ key, values: cached, failed: false });
      return;
    }
    let disposed = false;
    let started = false;
    const taskId = `storyboard-motion-${crypto.randomUUID()}`;
    setResult({ key, values: null, failed: false });
    const timer = window.setTimeout(() => {
      started = true;
      void runOperation("storyboard.motion", () =>
        invokeCommand<number[]>("storyboard_motion", { assetId, startFrame, endFrame, taskId }),
      ).then((outcome) => {
        if (disposed) return;
        if (outcome.status === "success") {
          cache.current.set(key, outcome.value);
          if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
          setResult({ key, values: outcome.value, failed: false });
        } else {
          setResult({ key, values: null, failed: true });
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
  const values = current?.values;
  const curvePath = useMemo(() => motionCurvePath(values ?? []), [values]);
  const hoverProgress = hover?.key === key ? hover.progress : null;
  const status =
    !shot || !assetId
      ? "未选中分镜"
      : current?.failed
        ? "计算失败"
        : !values
          ? "计算中…"
          : values.length === 0
            ? "无相邻帧"
            : null;

  return (
    <section className="storyboard-motion-section">
      <header className="storyboard-keyword-panel-heading">
        <button
          type="button"
          className="storyboard-keyword-panel-heading-title"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>动势图</span>
          <ChevronDown className={open ? "" : "is-collapsed"} aria-hidden="true" />
        </button>
      </header>
      {open && (
        <div
          className="storyboard-motion-chart"
          aria-busy={Boolean(shot && !current?.failed && !values)}
        >
          <svg
            viewBox="0 0 1 2"
            preserveAspectRatio="none"
            role="img"
            aria-label="当前主选中分镜的动势图"
            onPointerEnter={updateHover}
            onPointerMove={updateHover}
            onPointerLeave={finishHover}
            onPointerCancel={finishHover}
          >
            {values && values.length > 0 && (
              <>
                <path className="motion-area" d={`${curvePath} L1,2 L0,2 Z`} />
                <path className="motion-line" d={curvePath} />
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
          </svg>
          {status && (
            <div className="storyboard-motion-status" role="status">
              <span>{status}</span>
              {current?.failed && (
                <button
                  type="button"
                  title="重新计算动势图"
                  aria-label="重新计算动势图"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RotateCw size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
