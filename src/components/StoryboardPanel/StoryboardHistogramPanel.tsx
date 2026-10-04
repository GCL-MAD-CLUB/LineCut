import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { usePlaybackStatus } from "../../runtime/capabilities/PlaybackCapability";
import { usePanelInstanceId } from "../../runtime/systems/PanelState";
import { usePublishProjection, useStableIdentity } from "../../runtime/state/react";
import { PLAYBACK_HISTOGRAM_DEMAND_PROJECTION } from "../../runtime/state/contracts";

const layers = [
  { channel: 2, name: "blue" },
  { channel: 0, name: "red" },
  { channel: 1, name: "green" },
  { channel: 3, name: "gray" },
] as const;

export function StoryboardHistogramPanel({ visible }: { visible: boolean }) {
  const [open, setOpen] = useState(true);
  const identity = useStableIdentity("playback-histogram", usePanelInstanceId());
  const demand = useMemo(() => ({ enabled: visible && open }), [visible, open]);
  usePublishProjection(PLAYBACK_HISTOGRAM_DEMAND_PROJECTION, identity, demand);
  const histogram = usePlaybackStatus()?.histogram;
  const paths = useMemo(() => {
    if (!histogram) return [];
    const maximum = Math.max(1, ...histogram.flat());
    return layers.map(({ channel, name }) => ({
      name,
      path: histogram[channel]
        .map(
          (count, index) => `${index === 0 ? "M" : "L"}${index / 255},${2 * (1 - count / maximum)}`,
        )
        .join(" "),
    }));
  }, [histogram]);
  return (
    <section
      className={`storyboard-motion-section ${open ? "" : "is-collapsed"}`.trim()}
      data-preserve-panel-focus
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="storyboard-keyword-panel-heading">
        <button
          type="button"
          className="storyboard-keyword-panel-heading-title"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>直方图</span>
          <ChevronDown className={open ? "" : "is-collapsed"} aria-hidden="true" />
        </button>
      </header>
      {open && (
        <div className="storyboard-motion-chart">
          <svg
            viewBox="0 0 1 2"
            preserveAspectRatio="none"
            role="img"
            aria-label="源播放器当前帧的直方图"
          >
            {paths.map(({ name, path }) => (
              <path
                key={`fill-${name}`}
                className={`frame-trace-area frame-trace-${name} histogram-area`}
                d={`${path} L1,2 L0,2 Z`}
              />
            ))}
            {paths.map(({ name, path }) => (
              <path
                key={`line-${name}`}
                className={`frame-trace-line frame-trace-${name}`}
                d={path}
              />
            ))}
          </svg>
        </div>
      )}
    </section>
  );
}
