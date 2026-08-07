import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PanelHost, PanelManagerProvider, type PanelManagerInitialState } from "../DockLayout";
import { eventSource } from "../../runtime/events/EventHub";
import { publishEvent } from "../../runtime/events/react";
import { sourcePanelType } from "../SourceMonitor";
import { isMediaItemOffline, useProjectPort } from "../../systems/ProjectSystem";
import {
  dirname,
  readRememberedExportDir,
  useExportWorkspaceState,
  type ExportClip,
  type ExportSource,
} from "../../systems/ExportSystem";
import { ExportActionBar } from "./ExportActionBar";
import { ExportMediaInfo } from "./ExportMediaInfo";
import { ExportSettingsSection } from "./ExportSettingsSection";
import { ExportSourceList } from "./ExportSourceList";
import "./ExportWorkspace.css";

function suggestedStem(projectFilePath: string | null, source: ExportSource | null) {
  if (projectFilePath) {
    const stem = projectFilePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.lcp$/i, "");
    if (stem) {
      return stem;
    }
  }
  const firstPath = source?.clips[0]?.sourcePath;
  if (firstPath) {
    const stem = firstPath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "");
    if (stem) {
      return stem;
    }
  }
  return "导出";
}

function clipDurationUs(clip: ExportClip) {
  if (clip.endUs > 0) {
    return Math.max(0, clip.endUs - clip.startUs);
  }
  return Math.max(0, clip.durationUs);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

interface ColumnDragState {
  seam: "left" | "settings";
  startClientX: number;
  startRatio: number;
  totalWidth: number;
}

/**
 * Minimal panel-manager context so the existing SourceMonitor can be embedded
 * in the export workspace without the full dock layout (no tabs, drag or menus).
 */
const exportWorkspaceEventSource = eventSource("export-workspace");

const exportSourcePanelState: PanelManagerInitialState = {
  instances: [{ id: "export-source", type: sourcePanelType, params: {} }],
  layout: {
    root: { type: "area", areaId: "export-source-area" },
    areas: {
      "export-source-area": { tabs: ["export-source"], activePanelId: "export-source" },
    },
  },
  focusedPanelId: "export-source",
};

function ExportSourceZone() {
  return (
    <PanelManagerProvider initialState={exportSourcePanelState}>
      <header className="export-zone-header export-zone-header-preview">
        <span className="export-preview-heading">预览</span>
      </header>
      <div className="export-zone-content">
        <PanelHost instanceId="export-source" active />
      </div>
    </PanelManagerProvider>
  );
}

export function ExportWorkspace() {
  const source = useExportWorkspaceState((state) => state.source);
  const selectedClipIds = useExportWorkspaceState((state) => state.selectedClipIds);
  const settings = useExportWorkspaceState((state) => state.settings);
  const previewClipId = useExportWorkspaceState((state) => state.previewClipId);
  const toggleClip = useExportWorkspaceState((state) => state.toggleClip);
  const setAllSelected = useExportWorkspaceState((state) => state.setAllSelected);
  const setPreviewClip = useExportWorkspaceState((state) => state.setPreviewClip);
  const updateSettings = useExportWorkspaceState((state) => state.updateSettings);
  const { projectFilePath, mediaItems, activeVideoId, activeVideoChanged } = useProjectPort(
    ["projectFilePath", "mediaItems", "activeVideoId"],
    ["activeVideoChanged"],
  );

  const mainRef = useRef<HTMLDivElement | null>(null);
  const [leftRatio, setLeftRatio] = useState(0.3);
  const [settingsRatio, setSettingsRatio] = useState(0.38);
  const leftRatioRef = useRef(leftRatio);
  leftRatioRef.current = leftRatio;
  const settingsRatioRef = useRef(settingsRatio);
  settingsRatioRef.current = settingsRatio;
  const dragRef = useRef<ColumnDragState | null>(null);
  const dragListenersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: () => void;
  } | null>(null);

  function endColumnDrag() {
    const listeners = dragListenersRef.current;
    dragListenersRef.current = null;
    dragRef.current = null;
    document.body.classList.remove("is-resizing-x");
    if (listeners) {
      window.removeEventListener("pointermove", listeners.onMove);
      window.removeEventListener("pointerup", listeners.onUp);
      window.removeEventListener("pointercancel", listeners.onUp);
    }
  }

  // If the workspace unmounts mid-drag, drop the window listeners and the
  // resizing class so nothing is left stuck behind the component.
  useEffect(() => {
    return () => {
      const listeners = dragListenersRef.current;
      dragListenersRef.current = null;
      dragRef.current = null;
      document.body.classList.remove("is-resizing-x");
      if (listeners) {
        window.removeEventListener("pointermove", listeners.onMove);
        window.removeEventListener("pointerup", listeners.onUp);
        window.removeEventListener("pointercancel", listeners.onUp);
      }
    };
  }, []);

  function beginColumnDrag(seam: "left" | "settings", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const container = mainRef.current;
    if (!container) {
      return;
    }
    event.preventDefault();
    const totalWidth = container.clientWidth;
    const startRatio = seam === "left" ? leftRatioRef.current : settingsRatioRef.current;
    const pointerId = event.pointerId;
    const seamElement = event.currentTarget;
    // Capture the pointer so pointermove/pointerup keep firing even when the
    // cursor leaves the window mid-drag; otherwise the resizing state can stick.
    seamElement.setPointerCapture(pointerId);
    dragRef.current = { seam, startClientX: event.clientX, startRatio, totalWidth };
    document.body.classList.add("is-resizing-x");

    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const deltaRatio = (moveEvent.clientX - drag.startClientX) / drag.totalWidth;
      if (drag.seam === "left") {
        setLeftRatio(clamp(drag.startRatio + deltaRatio, 0.15, 0.7));
      } else {
        setSettingsRatio(clamp(drag.startRatio + deltaRatio, 0.15, 0.85));
      }
    };
    const onUp = () => {
      if (seamElement.hasPointerCapture(pointerId)) {
        seamElement.releasePointerCapture(pointerId);
      }
      endColumnDrag();
    };
    dragListenersRef.current = { onMove, onUp };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  const sourceKey = source ? `${source.kind}:${source.clips.length}:${source.assetId ?? ""}` : null;
  const lastSourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!source || sourceKey === lastSourceKeyRef.current) {
      return;
    }
    lastSourceKeyRef.current = sourceKey;
    const updates: Partial<typeof settings> = {};
    if (settings.destination === "source") {
      // 原始照片所在的文件夹 follows the first clip's source file.
      const dir = dirname(source.clips[0]?.sourcePath ?? "");
      if (dir && dir !== settings.outputDir) {
        updates.outputDir = dir;
      }
    } else if (settings.destination === "specified" && !settings.outputDir.trim()) {
      const remembered = readRememberedExportDir();
      if (remembered) {
        updates.outputDir = remembered;
      }
    }
    if (!settings.outputStem.trim()) {
      updates.outputStem = suggestedStem(projectFilePath, source);
    }
    if (Object.keys(updates).length > 0) {
      updateSettings(updates);
    }
  }, [
    projectFilePath,
    settings.destination,
    settings.outputDir,
    settings.outputStem,
    source,
    sourceKey,
    updateSettings,
  ]);

  const previewClip = source
    ? (source.clips.find((clip) => clip.id === previewClipId) ?? source.clips[0] ?? null)
    : null;
  const mediaItemsRef = useRef(mediaItems);
  mediaItemsRef.current = mediaItems;
  const [previewRequestId, setPreviewRequestId] = useState(0);

  function handlePreviewClip(clipId: string) {
    setPreviewClip(clipId);
    setPreviewRequestId((count) => count + 1);
  }

  useEffect(() => {
    if (!previewClip) {
      return;
    }
    // Focus the reused source player on the selected clip: load its source video
    // (if different from the active one) and constrain playback to [startUs, endUs].
    const sourceItem = mediaItemsRef.current.find(
      (item) =>
        item.kind === "video" && item.path === previewClip.sourcePath && !isMediaItemOffline(item),
    );
    if (sourceItem && sourceItem.id !== activeVideoId) {
      activeVideoChanged(sourceItem.id);
      return;
    }
    void publishEvent(
      "playback.seek.requested",
      {
        timeUs: previewClip.startUs,
        focusEndUs: previewClip.endUs > 0 ? previewClip.endUs : undefined,
        play: false,
      },
      exportWorkspaceEventSource,
    );
  }, [activeVideoChanged, activeVideoId, previewClip, previewRequestId]);

  const selectedDurationUs = source
    ? source.clips
        .filter((clip) => selectedClipIds.has(clip.id))
        .reduce((sum, clip) => sum + clipDurationUs(clip), 0)
    : 0;

  const settingsTrack = settingsRatio * (1 - leftRatio);
  const previewTrack = (1 - settingsRatio) * (1 - leftRatio);
  const mainGridStyle: CSSProperties = {
    gridTemplateColumns: `minmax(180px, ${leftRatio}fr) var(--resizer-size) minmax(240px, ${settingsTrack}fr) var(--resizer-size) minmax(220px, ${previewTrack}fr)`,
  };

  return (
    <section className={`export-workspace ${source ? "" : "is-empty"}`} aria-label="导出工作区">
      <div className="export-workspace-main" ref={mainRef} style={mainGridStyle}>
        <section className="export-zone">
          <header className="export-zone-header export-zone-header-preview">
            <span className="export-preview-heading">导出</span>
          </header>
          <div className="export-zone-content">
            {source ? (
              <ExportSourceList
                source={source}
                selectedClipIds={selectedClipIds}
                previewClipId={previewClip?.id ?? null}
                onToggleClip={toggleClip}
                onSetAllSelected={setAllSelected}
                onPreviewClip={handlePreviewClip}
              />
            ) : (
              <div className="export-workspace-empty" />
            )}
          </div>
        </section>

        <div
          className="export-zone-seam export-zone-seam-v"
          onPointerDown={(event) => beginColumnDrag("left", event)}
          title="拖动调整宽度"
        />

        <section className="export-zone">
          <header className="export-zone-header export-zone-header-preview">
            <span className="export-preview-heading">设置</span>
          </header>
          <div className="export-zone-content">
            <ExportSettingsSection
              settings={settings}
              onUpdateSettings={updateSettings}
              sourceChannels={previewClip?.sourceMedia?.audioChannels ?? null}
              source={source}
              selectedClipIds={selectedClipIds}
              previewClip={previewClip}
            />
          </div>
        </section>

        <div
          className="export-zone-seam export-zone-seam-v"
          onPointerDown={(event) => beginColumnDrag("settings", event)}
          title="拖动调整宽度"
        />

        <section className="export-zone export-zone-stack">
          <div className="export-zone-sub">
            <ExportSourceZone />
          </div>
          <div className="export-zone-seam" aria-hidden="true" />
          <div className="export-zone-sub">
            <div className="export-zone-content">
              <ExportMediaInfo
                clip={previewClip}
                settings={settings}
                selectedDurationUs={selectedDurationUs}
                mediaItems={mediaItems}
              />
            </div>
          </div>
        </section>
      </div>

      <ExportActionBar />
    </section>
  );
}
