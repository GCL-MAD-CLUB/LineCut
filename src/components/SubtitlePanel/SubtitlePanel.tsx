import { useVirtualizer } from "@tanstack/react-virtual";
import { Captions, Play, Search } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { emitAppEvent, useAppEvent } from "../../appEvents";
import { useAppStore, visibleSubtitleTracks } from "../../store";
import { formatDuration } from "../../time";
import type { SubtitleCue } from "../../types";
import { SelectDropdown } from "../SelectDropdown";
import "./SubtitlePanel.css";
import { useSubtitlePanelState } from "./subtitlePanelState";

function cueLabelValue(cue: SubtitleCue) {
  return cue.style?.trim() || cue.speaker?.trim() || "";
}

function seekToCue(cue: SubtitleCue, focusRange = false) {
  emitAppEvent("monitor:seek", {
    timeUs: cue.start_us,
    focusEndUs: focusRange ? cue.end_us : undefined,
  });
}

function cueMatches(cue: SubtitleCue, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = `${cue.plain_text} ${cue.speaker ?? ""} ${cue.style ?? ""}`.toLocaleLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function useActiveTrack() {
  const project = useAppStore((state) => state.project);
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  const mediaItems = useAppStore((state) => state.mediaItems);
  const activeVideoId = useAppStore((state) => state.activeVideoId);
  return useMemo(
    () =>
      visibleSubtitleTracks(project, mediaItems, activeVideoId).find(
        (track) => track.id === activeTrackId,
      ) ?? null,
    [activeTrackId, activeVideoId, mediaItems, project],
  );
}

function useFilteredCues() {
  const project = useAppStore((state) => state.project);
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  const query = useSubtitlePanelState((state) => state.query);
  const selectedCueIds = useAppStore((state) => state.selectedCueIds);
  const showOnlySelected = useSubtitlePanelState((state) => state.showOnlySelected);
  const cues = useMemo(
    () => (activeTrackId && project ? (project.cues[activeTrackId] ?? []) : []),
    [activeTrackId, project],
  );
  return useMemo(
    () =>
      cues.filter(
        (cue) => cueMatches(cue, query) && (!showOnlySelected || selectedCueIds.has(cue.id)),
      ),
    [cues, query, selectedCueIds, showOnlySelected],
  );
}

export function SubtitlePanel() {
  const project = useAppStore((state) => state.project);
  const mediaItems = useAppStore((state) => state.mediaItems);
  const activeVideoId = useAppStore((state) => state.activeVideoId);
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  const query = useSubtitlePanelState((state) => state.query);
  const selectedCueIds = useAppStore((state) => state.selectedCueIds);
  const showOnlySelected = useSubtitlePanelState((state) => state.showOnlySelected);
  const setQuery = useSubtitlePanelState((state) => state.setQuery);
  const setShowOnlySelected = useSubtitlePanelState((state) => state.setShowOnlySelected);
  const syncTrackContext = useSubtitlePanelState((state) => state.syncTrackContext);
  const activeTrackChanged = useAppStore((state) => state.actions.activeTrackChanged);
  const cueSelectionToggled = useAppStore((state) => state.actions.cueSelectionToggled);
  const cueSelectionCleared = useAppStore((state) => state.actions.cueSelectionCleared);
  const cueSelectionReplaced = useAppStore((state) => state.actions.cueSelectionReplaced);
  const activeTrack = useActiveTrack();
  const filteredCues = useFilteredCues();
  const selectedCount = useAppStore((state) => state.selectedCueIds.size);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredCues.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 88,
    overscan: 12,
  });
  const visibleTracks = useMemo(
    () => visibleSubtitleTracks(project, mediaItems, activeVideoId),
    [activeVideoId, mediaItems, project],
  );
  const trackItems = visibleTracks.map((track) => ({
    type: "option" as const,
    value: track.id,
    label: `${track.source_type === "embedded" ? `流 ${track.stream_index}` : "外挂"} · ${
      track.title || track.language || track.codec
    } · ${track.cue_count} 条`,
  }));

  useEffect(() => {
    syncTrackContext(`${project?.asset.id ?? ""}:${activeTrackId}`);
  }, [activeTrackId, project?.asset.id, syncTrackContext]);

  useEffect(() => {
    if (showOnlySelected && selectedCount === 0) {
      setShowOnlySelected(false);
    }
  }, [selectedCount, setShowOnlySelected, showOnlySelected]);

  useAppEvent("subtitle:select-all", () => {
    cueSelectionReplaced(filteredCues.map((cue) => cue.id));
  });
  useAppEvent("subtitle:clear-selection", cueSelectionCleared);

  return (
    <section className="subtitle-panel">
      <div className="list-toolbar">
        <div className="track-select">
          <SelectDropdown
            ariaLabel="字幕轨"
            className="track-select-dropdown"
            menuClassName="track-select-menu"
            disabled={!project}
            value={activeTrackId}
            items={trackItems}
            onChange={activeTrackChanged}
          />
        </div>
        <div className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索台词、角色、样式"
            disabled={!activeTrack}
          />
        </div>
      </div>

      <div className="selection-toolbar">
        <button
          className="toolbar-button"
          onClick={() => cueSelectionReplaced(filteredCues.map((cue) => cue.id))}
          disabled={filteredCues.length === 0}
        >
          全选
        </button>
        <button
          className="toolbar-button"
          onClick={cueSelectionCleared}
          disabled={selectedCount === 0}
        >
          清空
        </button>
        <button
          className={`toolbar-button ${showOnlySelected ? "active" : ""}`}
          onClick={() => setShowOnlySelected(!showOnlySelected)}
          disabled={selectedCount === 0}
        >
          仅展示选中
        </button>
        <span>
          {showOnlySelected
            ? `${filteredCues.length} 条结果`
            : `${selectedCount} / ${filteredCues.length} 条结果`}
        </span>
      </div>

      {activeTrack?.warning && <div className="warning-line">{activeTrack.warning}</div>}

      <div ref={listRef} className="cue-list">
        {filteredCues.length === 0 ? (
          <div className="empty-list">
            <Captions size={36} />
            <span>{project ? "当前字幕轨没有可显示台词" : "导入视频后会显示全部台词"}</span>
          </div>
        ) : (
          <div className="virtual-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const cue = filteredCues[virtualRow.index];
              const checked = selectedCueIds.has(cue.id);
              const cueTag = cueLabelValue(cue);
              return (
                <div
                  key={cue.id}
                  className={`cue-row ${checked ? "selected" : ""}`}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <label className="cue-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => cueSelectionToggled(cue.id)}
                      aria-label="选择台词"
                    />
                  </label>
                  <button
                    className="cue-play"
                    onClick={() => seekToCue(cue, true)}
                    title="跳转预览"
                  >
                    <Play size={15} />
                  </button>
                  <button className="cue-content" onClick={() => seekToCue(cue)}>
                    <span className="cue-time">
                      {formatDuration(cue.start_us)} - {formatDuration(cue.end_us)}
                    </span>
                    <span className="cue-text">{cue.plain_text}</span>
                    {cueTag && (
                      <span className="cue-tags">
                        <span>{cueTag}</span>
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
