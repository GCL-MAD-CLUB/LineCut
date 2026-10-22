import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { PopupMenu, PopupMenuItem, useCloseOnOutsidePointer } from "../../../common/PopupMenu";
import { StoryboardSidebarHeading } from "../StoryboardSidebarSection";
import { StoryboardHistogramPanel } from "./StoryboardHistogramPanel";
import { frameTraceModes, StoryboardMotionPanel } from "./StoryboardMotionPanel";

interface Props extends Omit<ComponentProps<typeof StoryboardMotionPanel>, "mode"> {
  histogramVisible: boolean;
}

const frameDataModes = [{ mode: "histogram", label: "直方图" }, ...frameTraceModes] as const;
type FrameDataMode = (typeof frameDataModes)[number]["mode"];

export function StoryboardFrameDataPanel({ histogramVisible, ...motionProps }: Props) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<FrameDataMode>("histogram");
  const [modeMenu, setModeMenu] = useState<{ x: number; y: number } | null>(null);
  const histogramSelected = mode === "histogram";
  const modeLabel = frameDataModes.find((option) => option.mode === mode)!.label;
  useCloseOnOutsidePointer(Boolean(modeMenu), () => setModeMenu(null));

  useEffect(() => {
    if (!motionProps.visible || !open) setModeMenu(null);
  }, [motionProps.visible, open]);

  return (
    <section className={`storyboard-frame-data-panel ${open ? "" : "is-collapsed"}`.trim()}>
      <StoryboardSidebarHeading
        title="帧数据"
        open={open}
        onToggle={() => setOpen((current) => !current)}
        className="storyboard-frame-data-heading"
        control={
          <button
            type="button"
            className={`storyboard-keyword-dropdown-shell storyboard-keyword-mode-trigger ${modeMenu ? "is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(modeMenu)}
            aria-label="帧数据类型"
            title="选择帧数据类型"
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
        }
      />
      <div hidden={!open}>
        <div hidden={!histogramSelected}>
          <StoryboardHistogramPanel visible={histogramVisible && open && histogramSelected} />
        </div>
        <div hidden={histogramSelected}>
          <StoryboardMotionPanel
            {...motionProps}
            mode={histogramSelected ? "motion" : mode}
            visible={motionProps.visible && open && !histogramSelected}
          />
        </div>
      </div>
      {open &&
        modeMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-keyword-mode-menu"
            contextMenuAnchor={modeMenu}
            ariaLabel="帧数据类型"
            style={{ position: "fixed", left: modeMenu.x, top: modeMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {frameDataModes.map((option) => (
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
