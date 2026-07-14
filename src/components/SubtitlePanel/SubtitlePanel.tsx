import { useVirtualizer } from "@tanstack/react-virtual";
import { Captions, CheckCheck, ListFilter, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { emitAppEvent, useAppEvent } from "../../appEvents";
import { useAppStore, visibleSubtitleTracks } from "../../store";
import { requestSubtitleThumbnail } from "../../subtitleThumbnail";
import { formatDuration } from "../../time";
import { normalizeFrameRate, timeUsToFrame } from "../../timeline";
import type { SubtitleCue } from "../../types";
import { SelectDropdown } from "../SelectDropdown";
import { useSourceMonitorState } from "../SourceMonitor/sourceMonitorState";
import "./SubtitlePanel.css";
import { useSubtitlePanelState } from "./subtitlePanelState";

function cueLabelValue(cue: SubtitleCue) {
  return cue.style?.trim() || cue.speaker?.trim() || "";
}

function seekToCue(cue: SubtitleCue, focusRange = false) {
  emitAppEvent("monitor:seek", {
    timeUs: cue.start_us,
    focusEndUs: focusRange ? cue.end_us : undefined,
    play: focusRange,
  });
}

interface CueFrameRange {
  startFrame: number;
  endFrame: number;
  maximumEndFrame: number;
}

const MIN_UPCOMING_SCROLL_DURATION_MS = 1000;
const MAX_UPCOMING_SCROLL_DURATION_MS = 1200;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function currentCueIndexAtFrame(ranges: CueFrameRange[], currentFrame: number) {
  let low = 0;
  let high = ranges.length - 1;
  let latestStartedIndex = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].startFrame <= currentFrame) {
      latestStartedIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  let earliestActiveIndex = -1;
  for (let index = latestStartedIndex; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range.maximumEndFrame < currentFrame) {
      break;
    }
    if (currentFrame <= range.endFrame) {
      earliestActiveIndex = index;
    }
  }
  return earliestActiveIndex;
}

function nextCueIndexAfterFrame(ranges: CueFrameRange[], currentFrame: number) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].startFrame <= currentFrame) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && low < ranges.length ? low : -1;
}

function nextCueIndexAfterCurrentCue(
  ranges: CueFrameRange[],
  currentCueIndex: number,
  currentFrame: number,
) {
  for (let index = currentCueIndex + 1; index < ranges.length; index += 1) {
    if (ranges[index].endFrame >= currentFrame) {
      return index;
    }
  }
  return -1;
}

function easeInOutCubic(progress: number) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

interface CueFrameButtonProps {
  cue: SubtitleCue;
  assetId: string;
  fingerprint: string;
  videoPath: string;
}

function CueFrameButton({ cue, assetId, fingerprint, videoPath }: CueFrameButtonProps) {
  const [thumbnailSrc, setThumbnailSrc] = useState("");

  useEffect(() => {
    let active = true;
    setThumbnailSrc("");
    const request = requestSubtitleThumbnail({
      assetId,
      fingerprint,
      videoPath,
      timeUs: cue.start_us,
    });
    void request.promise.then(
      (url) => {
        if (active) {
          setThumbnailSrc(url);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
      request.cancel();
    };
  }, [assetId, cue.start_us, fingerprint, videoPath]);

  return (
    <button
      type="button"
      className="cue-frame-button"
      onClick={() => seekToCue(cue, true)}
      title="播放此条字幕"
      aria-label={`从 ${formatDuration(cue.start_us)} 播放此条字幕`}
    >
      {thumbnailSrc && (
        <img
          className="cue-frame"
          src={thumbnailSrc}
          alt=""
          width={160}
          height={90}
          decoding="async"
          draggable={false}
        />
      )}
    </button>
  );
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

function useFilteredCues(visibleTrackId: string) {
  const project = useAppStore((state) => state.project);
  const query = useSubtitlePanelState((state) => state.query);
  const selectedCueIds = useAppStore((state) => state.selectedCueIds);
  const showOnlySelected = useSubtitlePanelState((state) => state.showOnlySelected);
  const cues = useMemo(
    () => (visibleTrackId && project ? (project.cues[visibleTrackId] ?? []) : []),
    [project, visibleTrackId],
  );
  const matchingCues = useMemo(() => cues.filter((cue) => cueMatches(cue, query)), [cues, query]);
  return useMemo(
    () =>
      showOnlySelected ? matchingCues.filter((cue) => selectedCueIds.has(cue.id)) : matchingCues,
    [matchingCues, selectedCueIds, showOnlySelected],
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
  const activeCueId = useSubtitlePanelState((state) => state.activeCueId);
  const setQuery = useSubtitlePanelState((state) => state.setQuery);
  const setShowOnlySelected = useSubtitlePanelState((state) => state.setShowOnlySelected);
  const setActiveCueId = useSubtitlePanelState((state) => state.setActiveCueId);
  const syncTrackContext = useSubtitlePanelState((state) => state.syncTrackContext);
  const activeTrackChanged = useAppStore((state) => state.actions.activeTrackChanged);
  const cueSelectionToggled = useAppStore((state) => state.actions.cueSelectionToggled);
  const cueSelectionCleared = useAppStore((state) => state.actions.cueSelectionCleared);
  const cueSelectionReplaced = useAppStore((state) => state.actions.cueSelectionReplaced);
  const activeTrack = useActiveTrack();
  const visibleActiveTrackId = activeTrack?.id ?? "";
  const filteredCues = useFilteredCues(visibleActiveTrackId);
  const selectedCount = useAppStore((state) => state.selectedCueIds.size);
  const currentFrame = useSourceMonitorState.useInstance("source", (state) => state.currentFrame);
  const isPlaying = useSourceMonitorState.useInstance("source", (state) => state.isPlaying);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);
  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const rowVirtualizer = useVirtualizer({
    count: filteredCues.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 88,
    getItemKey: (index) => filteredCues[index].id,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 4,
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
  const thumbnailAssetId = project?.asset.id ?? "";
  const thumbnailFingerprint = project?.asset.fingerprint ?? "";
  const thumbnailVideoPath = project?.proxy_path || project?.asset.path || "";
  const frameRate = useMemo(() => {
    const videoStream =
      project?.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
      project?.streams.find((stream) => stream.codec_type === "video");
    return normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate);
  }, [project]);
  const cueFrameRanges = useMemo(() => {
    let maximumEndFrame = 0;
    return filteredCues.map((cue) => {
      const startFrame = timeUsToFrame(cue.start_us, frameRate);
      const endFrame = timeUsToFrame(cue.end_us, frameRate);
      maximumEndFrame = Math.max(maximumEndFrame, endFrame);
      return { startFrame, endFrame, maximumEndFrame };
    });
  }, [filteredCues, frameRate]);
  const currentCueIndex = useMemo(
    () => currentCueIndexAtFrame(cueFrameRanges, currentFrame),
    [cueFrameRanges, currentFrame],
  );
  const upcomingCueIndex = useMemo(
    () => nextCueIndexAfterFrame(cueFrameRanges, currentFrame),
    [cueFrameRanges, currentFrame],
  );
  const nextCueAfterCurrentIndex = useMemo(
    () =>
      currentCueIndex >= 0
        ? nextCueIndexAfterCurrentCue(cueFrameRanges, currentCueIndex, currentFrame)
        : -1,
    [cueFrameRanges, currentCueIndex, currentFrame],
  );
  const followCueIndex = useMemo(() => {
    if (currentCueIndex < 0) {
      return upcomingCueIndex;
    }
    if (currentFrame >= cueFrameRanges[currentCueIndex].endFrame && nextCueAfterCurrentIndex >= 0) {
      return nextCueAfterCurrentIndex;
    }
    return currentCueIndex;
  }, [cueFrameRanges, currentCueIndex, currentFrame, nextCueAfterCurrentIndex, upcomingCueIndex]);
  const followCueId = followCueIndex >= 0 ? filteredCues[followCueIndex]?.id : undefined;

  useEffect(() => {
    syncTrackContext(`${activeVideoId}:${project?.asset.id ?? ""}:${visibleActiveTrackId}`);
  }, [activeVideoId, project?.asset.id, syncTrackContext, visibleActiveTrackId]);

  useEffect(() => {
    if (showOnlySelected && selectedCount === 0) {
      setShowOnlySelected(false);
    }
  }, [selectedCount, setShowOnlySelected, showOnlySelected]);

  useEffect(
    () => () => {
      if (scrollAnimationRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const list = listRef.current;
    const range = cueFrameRanges[followCueIndex];
    if (!list || !range || followCueIndex < 0) {
      return;
    }
    const offsetInfo = rowVirtualizer.getOffsetForIndex(followCueIndex, "center");
    if (!offsetInfo) {
      return;
    }

    if (scrollAnimationRef.current !== null) {
      cancelAnimationFrame(scrollAnimationRef.current);
    }
    const startOffset = list.scrollTop;
    const initialTargetOffset = offsetInfo[0];
    const distance = Math.abs(initialTargetOffset - startOffset);
    const animationStartFrame = currentFrameRef.current;
    const isUpcomingCue =
      animationStartFrame < range.startFrame || followCueIndex !== currentCueIndex;
    const viewportDistance = distance / Math.max(1, list.clientHeight);
    const distanceDuration = clamp(180 + Math.sqrt(viewportDistance) * 300, 160, 900);
    const preferredArrivalFrame = range.startFrame - 1;
    const latestArrivalFrame = range.endFrame - 1;
    const preferredDuration =
      (Math.max(0, preferredArrivalFrame - animationStartFrame) / frameRate) * 1000;
    const latestDuration =
      (Math.max(0, latestArrivalFrame - animationStartFrame) / frameRate) * 1000;
    const duration = isUpcomingCue
      ? Math.min(
          clamp(
            preferredDuration,
            MIN_UPCOMING_SCROLL_DURATION_MS,
            MAX_UPCOMING_SCROLL_DURATION_MS,
          ),
          latestDuration,
        )
      : distanceDuration;
    if (distance < 1 || duration <= 0) {
      list.scrollTop = initialTargetOffset;
      scrollAnimationRef.current = null;
      return;
    }
    let startedAt: number | null = null;

    const animate = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = clamp((timestamp - startedAt) / duration, 0, 1);
      const currentOffsetInfo = rowVirtualizer.getOffsetForIndex(followCueIndex, "center");
      const targetOffset = currentOffsetInfo?.[0] ?? initialTargetOffset;
      list.scrollTop = startOffset + (targetOffset - startOffset) * easeInOutCubic(progress);
      if (progress < 1) {
        scrollAnimationRef.current = requestAnimationFrame(animate);
      } else {
        list.scrollTop = targetOffset;
        scrollAnimationRef.current = null;
      }
    };

    scrollAnimationRef.current = requestAnimationFrame(animate);
    return () => {
      if (scrollAnimationRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRef.current);
        scrollAnimationRef.current = null;
      }
    };
  }, [cueFrameRanges, followCueId, followCueIndex, frameRate, isPlaying, rowVirtualizer]);

  useAppEvent("subtitle:select-all", () => {
    cueSelectionReplaced(filteredCues.map((cue) => cue.id));
  });
  useAppEvent("subtitle:clear-selection", cueSelectionCleared);

  return (
    <section className="subtitle-panel">
      <div className="subtitle-project-row">
        <Captions aria-hidden="true" />
        <span>字幕轨</span>
        <div className="track-select">
          <SelectDropdown
            ariaLabel="字幕轨"
            className="track-select-dropdown"
            menuClassName="track-select-menu"
            disabled={!project}
            value={visibleActiveTrackId}
            items={trackItems}
            onChange={activeTrackChanged}
          />
        </div>
      </div>

      <div className="subtitle-search-row">
        <label className="subtitle-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索台词、角色、样式"
            disabled={!activeTrack}
          />
        </label>
        <span>
          {selectedCount} 条已选择，共 {filteredCues.length} 条
        </span>
      </div>

      <div className="subtitle-content">
        <div className="subtitle-list-frame">
          <div className="subtitle-list-header" aria-hidden="true"></div>

          {activeTrack?.warning && <div className="warning-line">{activeTrack.warning}</div>}

          <div ref={listRef} className="cue-list">
            {filteredCues.length === 0 ? (
              <div className="empty-list">
                <Captions size={36} />
                <strong>{project ? "没有可显示的字幕" : "字幕区为空"}</strong>
                <span>
                  {project ? "当前字幕轨没有匹配的台词。" : "导入视频后会在这里显示全部台词。"}
                </span>
              </div>
            ) : (
              <div
                className="virtual-spacer"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const cue = filteredCues[virtualRow.index];
                  const checked = selectedCueIds.has(cue.id);
                  const isCurrentCue = virtualRow.index === currentCueIndex;
                  const cueTag = cueLabelValue(cue);
                  return (
                    <div
                      key={cue.id}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className={`cue-row ${cue.id === activeCueId ? "is-active" : ""} ${
                        isCurrentCue ? "is-current" : ""
                      }`}
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
                      {thumbnailVideoPath && (
                        <CueFrameButton
                          cue={cue}
                          assetId={thumbnailAssetId}
                          fingerprint={thumbnailFingerprint}
                          videoPath={thumbnailVideoPath}
                        />
                      )}
                      <button
                        type="button"
                        className="cue-content"
                        onClick={() => {
                          setActiveCueId(cue.id);
                          seekToCue(cue);
                        }}
                        onDoubleClick={() => seekToCue(cue, true)}
                      >
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
        </div>
      </div>

      <footer className="subtitle-footer">
        <div className="subtitle-selection-tools">
          <button
            type="button"
            onClick={() => cueSelectionReplaced(filteredCues.map((cue) => cue.id))}
            disabled={filteredCues.length === 0}
            title="全选字幕"
          >
            <CheckCheck aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={cueSelectionCleared}
            disabled={selectedCount === 0}
            title="清空选择"
          >
            <X aria-hidden="true" />
          </button>
          <button
            type="button"
            className={showOnlySelected ? "active" : ""}
            onClick={() => setShowOnlySelected(!showOnlySelected)}
            disabled={selectedCount === 0}
            title="仅展示选中字幕"
            aria-pressed={showOnlySelected}
          >
            <ListFilter aria-hidden="true" />
          </button>
        </div>
      </footer>
    </section>
  );
}
