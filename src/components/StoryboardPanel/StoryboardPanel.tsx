import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckCheck, Film, ListFilter, Loader2, Scissors, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand } from "../../errors";
import { useEditCapability } from "../../runtime/capabilities/EditCapability";
import { usePlaybackStatus } from "../../runtime/capabilities/PlaybackCapability";
import { eventSource } from "../../runtime/events/EventHub";
import { publishEvent } from "../../runtime/events/react";
import { useStableIdentity } from "../../runtime/state/react";
import { usePanelActive, usePanelInstanceId } from "../../runtime/systems/PanelState";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { useProjectPort } from "../../systems/ProjectSystem";
import { createTaskProgress, useTaskProgressStatus } from "../../systems/TaskSystem";
import { requestStoryboardThumbnail } from "../../storyboardThumbnail";
import { isTauriRuntime } from "../../tauriRuntime";
import { formatDuration } from "../../time";
import { normalizeFrameRate } from "../../timeline";
import type { StoryboardDetectionResult, StoryboardShot } from "../../types";
import { usePanelManagerState } from "../DockLayout";
import "./StoryboardPanel.css";
import {
  MAX_STORYBOARD_DISPLAY_THRESHOLD,
  MIN_STORYBOARD_DISPLAY_THRESHOLD,
  useStoryboardPanelState,
} from "./storyboardPanelState";

const storyboardEventSource = eventSource("storyboard-panel");
const MIN_UPCOMING_SCROLL_DURATION_MS = 1000;
const MAX_UPCOMING_SCROLL_DURATION_MS = 1200;
const THUMBNAIL_PREFETCH_ROWS_BEFORE = 10;
const THUMBNAIL_PREFETCH_ROWS_AFTER = 28;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function shotLabel(shot: StoryboardShot) {
  return `镜头 ${shot.sequence.toString().padStart(3, "0")}`;
}

function shotMatches(shot: StoryboardShot, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = `${shotLabel(shot)} ${formatDuration(shot.start_us)} ${formatDuration(
    shot.end_us,
  )} ${shot.start_frame} ${shot.end_frame}`.toLocaleLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function seekToShot(shot: StoryboardShot, focusRange = false) {
  void publishEvent(
    "playback.seek.requested",
    {
      timeUs: shot.start_us,
      focusEndUs: focusRange ? shot.end_us : undefined,
      play: focusRange,
    },
    storyboardEventSource,
  );
}

function shotIndexAtFrame(shots: StoryboardShot[], currentFrame: number) {
  let low = 0;
  let high = shots.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shot = shots[middle];
    if (currentFrame < shot.start_frame) {
      high = middle - 1;
    } else if (currentFrame > shot.end_frame) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

function nextShotIndexAfterFrame(shots: StoryboardShot[], currentFrame: number) {
  let low = 0;
  let high = shots.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (shots[middle].start_frame <= currentFrame) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && low < shots.length ? low : -1;
}

function nextShotIndexAfterCurrentShot(
  shots: StoryboardShot[],
  currentShotIndex: number,
  currentFrame: number,
) {
  for (let index = currentShotIndex + 1; index < shots.length; index += 1) {
    if (shots[index].end_frame >= currentFrame) {
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

function closestShotIndexToViewportCenter(
  rows: readonly { index: number; start: number; end: number }[],
  scrollOffset: number,
  viewportHeight: number,
) {
  if (rows.length === 0) {
    return 0;
  }
  const centerOffset = scrollOffset + Math.max(0, viewportHeight) / 2;
  return rows.reduce((best, row) => {
    const bestDistance = Math.abs((best.start + best.end) / 2 - centerOffset);
    const rowDistance = Math.abs((row.start + row.end) / 2 - centerOffset);
    return rowDistance < bestDistance ? row : best;
  }).index;
}

function formatShotDuration(shot: StoryboardShot) {
  return formatDuration(Math.max(0, shot.end_us - shot.start_us));
}

function shotsAtDisplayThreshold(shots: StoryboardShot[], threshold: number) {
  if (shots.length === 0) {
    return [];
  }

  const displayedShots: StoryboardShot[] = [];
  let startShot = shots[0];
  for (let index = 0; index < shots.length - 1; index += 1) {
    const boundaryShot = shots[index];
    if (boundaryShot.score <= threshold) {
      continue;
    }
    displayedShots.push({
      ...startShot,
      id:
        startShot.id === boundaryShot.id
          ? startShot.id
          : `shot:${startShot.start_frame}:${boundaryShot.end_frame}`,
      sequence: displayedShots.length + 1,
      end_frame: boundaryShot.end_frame,
      end_us: boundaryShot.end_us,
      score: boundaryShot.score,
    });
    startShot = shots[index + 1];
  }
  const finalShot = shots.at(-1)!;
  displayedShots.push({
    ...startShot,
    id:
      startShot.id === finalShot.id
        ? startShot.id
        : `shot:${startShot.start_frame}:${finalShot.end_frame}`,
    sequence: displayedShots.length + 1,
    end_frame: finalShot.end_frame,
    end_us: finalShot.end_us,
    score: finalShot.score,
  });
  return displayedShots;
}

interface ShotFrameButtonProps {
  shot: StoryboardShot;
  assetId: string;
  fingerprint: string;
  videoPath: string;
  priority: number;
}

function ShotFrameButton({
  shot,
  assetId,
  fingerprint,
  videoPath,
  priority,
}: ShotFrameButtonProps) {
  const [thumbnailSrc, setThumbnailSrc] = useState("");

  useEffect(() => {
    let active = true;
    setThumbnailSrc("");
    const request = requestStoryboardThumbnail({
      assetId,
      fingerprint,
      videoPath,
      timeUs: shot.start_us,
      priority,
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
  }, [assetId, fingerprint, priority, shot.start_us, videoPath]);

  return (
    <button
      type="button"
      className="shot-frame-button"
      onClick={() => seekToShot(shot, true)}
      title="播放此镜头"
      aria-label={`从 ${formatDuration(shot.start_us)} 播放此镜头`}
    >
      {thumbnailSrc && (
        <img
          className="shot-frame"
          src={thumbnailSrc}
          alt=""
          width={160}
          height={90}
          decoding="async"
          draggable={false}
        />
      )}
      <Film className="shot-frame-placeholder" aria-hidden="true" />
    </button>
  );
}

export function StoryboardPanel() {
  const panelInstanceId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const focusedPanelId = usePanelManagerState((state) => state.focusedPanelId);
  const identity = useStableIdentity("storyboard-panel", panelInstanceId);
  const { project, activeVideoId } = useProjectPort(["project", "activeVideoId"], []);
  const {
    query,
    threshold,
    showOnlySelected,
    activeShotId,
    shots,
    selectedShotIds,
    detectingVideoContext,
    syncVideoContext,
    setQuery,
    setThreshold,
    setShowOnlySelected,
    setActiveShotId,
    detectionStarted,
    detectionCompleted,
    detectionFinished,
    shotSelectionToggled,
    shotSelectionCleared,
    shotSelectionReplaced,
  } = useStoryboardPanelState((state) => state);
  const { isRunning: isDetecting } = useTaskProgressStatus("storyboard.detect");
  const playback = usePlaybackStatus();
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);
  const [isThresholdEditing, setIsThresholdEditing] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState("");
  const videoContext = `${activeVideoId}:${project?.asset.id ?? ""}:${project?.asset.fingerprint ?? ""}`;
  const hasVideo = Boolean(
    project?.asset.video_stream_index !== null && project?.asset.video_stream_index !== undefined,
  );
  const videoLabel = project?.asset.file_name ?? "未选择视频";
  const canDetect = isTauriRuntime() && Boolean(project) && hasVideo && !isDetecting;
  const selectedCount = selectedShotIds.size;
  const displayShots = useMemo(() => shotsAtDisplayThreshold(shots, threshold), [shots, threshold]);
  const filteredShots = useMemo(
    () =>
      displayShots.filter(
        (shot) => (!showOnlySelected || selectedShotIds.has(shot.id)) && shotMatches(shot, query),
      ),
    [displayShots, query, selectedShotIds, showOnlySelected],
  );
  const currentFrame = playback?.currentFrame ?? 0;
  const isPlaying = playback?.isPlaying ?? false;
  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;
  const currentShotIndex = useMemo(
    () => shotIndexAtFrame(filteredShots, currentFrame),
    [currentFrame, filteredShots],
  );
  const upcomingShotIndex = useMemo(
    () => nextShotIndexAfterFrame(filteredShots, currentFrame),
    [currentFrame, filteredShots],
  );
  const nextShotAfterCurrentIndex = useMemo(
    () =>
      currentShotIndex >= 0
        ? nextShotIndexAfterCurrentShot(filteredShots, currentShotIndex, currentFrame)
        : -1,
    [currentFrame, currentShotIndex, filteredShots],
  );
  const followShotIndex = useMemo(() => {
    if (currentShotIndex < 0) {
      return upcomingShotIndex;
    }
    if (
      currentFrame >= filteredShots[currentShotIndex].end_frame &&
      nextShotAfterCurrentIndex >= 0
    ) {
      return nextShotAfterCurrentIndex;
    }
    return currentShotIndex;
  }, [currentFrame, currentShotIndex, filteredShots, nextShotAfterCurrentIndex, upcomingShotIndex]);
  const followShotId = followShotIndex >= 0 ? filteredShots[followShotIndex]?.id : undefined;
  const thumbnailAssetId = project?.asset.id ?? "";
  const thumbnailFingerprint = project?.asset.fingerprint ?? "";
  const thumbnailVideoPath = project?.asset.path ?? "";
  const frameRate = useMemo(() => {
    const videoStream =
      project?.streams.find((stream) => stream.index === project.asset.video_stream_index) ??
      project?.streams.find((stream) => stream.codec_type === "video");
    return normalizeFrameRate(videoStream?.avg_frame_rate, videoStream?.r_frame_rate);
  }, [project]);
  const rowVirtualizer = useVirtualizer({
    count: filteredShots.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 88,
    getItemKey: (index) => filteredShots[index].id,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 4,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstRenderedShotIndex = virtualRows[0]?.index ?? 0;
  const lastRenderedShotIndex = virtualRows.at(-1)?.index ?? 0;
  const thumbnailPriorityCenterIndex = closestShotIndexToViewportCenter(
    virtualRows,
    rowVirtualizer.scrollOffset ?? 0,
    rowVirtualizer.scrollRect?.height ?? 0,
  );
  const thumbnailPrefetchStart = Math.max(
    0,
    firstRenderedShotIndex - THUMBNAIL_PREFETCH_ROWS_BEFORE,
  );
  const thumbnailPrefetchEnd = Math.min(
    filteredShots.length,
    lastRenderedShotIndex + 1 + THUMBNAIL_PREFETCH_ROWS_AFTER,
  );
  const isEditAuthority = panelActive && focusedPanelId === panelInstanceId;

  useEffect(() => {
    syncVideoContext(videoContext);
  }, [syncVideoContext, videoContext]);

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
    const shot = filteredShots[followShotIndex];
    if (!list || !shot || followShotIndex < 0) {
      return;
    }
    const offsetInfo = rowVirtualizer.getOffsetForIndex(followShotIndex, "center");
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
    const isUpcomingShot =
      animationStartFrame < shot.start_frame || followShotIndex !== currentShotIndex;
    const viewportDistance = distance / Math.max(1, list.clientHeight);
    const distanceDuration = clamp(180 + Math.sqrt(viewportDistance) * 300, 160, 900);
    const preferredArrivalFrame = shot.start_frame - 1;
    const latestArrivalFrame = shot.end_frame - 1;
    const preferredDuration =
      (Math.max(0, preferredArrivalFrame - animationStartFrame) / frameRate) * 1000;
    const latestDuration =
      (Math.max(0, latestArrivalFrame - animationStartFrame) / frameRate) * 1000;
    const duration = isUpcomingShot
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
      const currentOffsetInfo = rowVirtualizer.getOffsetForIndex(followShotIndex, "center");
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
  }, [
    currentShotIndex,
    filteredShots,
    followShotId,
    followShotIndex,
    frameRate,
    isPlaying,
    rowVirtualizer,
  ]);

  useEffect(() => {
    if (!thumbnailVideoPath || thumbnailPrefetchStart >= thumbnailPrefetchEnd) {
      return;
    }
    const requests = filteredShots
      .slice(thumbnailPrefetchStart, thumbnailPrefetchEnd)
      .map((shot, offset) =>
        requestStoryboardThumbnail({
          assetId: thumbnailAssetId,
          fingerprint: thumbnailFingerprint,
          videoPath: thumbnailVideoPath,
          timeUs: shot.start_us,
          priority: Math.abs(thumbnailPrefetchStart + offset - thumbnailPriorityCenterIndex),
        }),
      );
    for (const request of requests) {
      void request.promise.then(
        () => undefined,
        () => undefined,
      );
    }
    return () => {
      for (const request of requests) {
        request.cancel();
      }
    };
  }, [
    filteredShots,
    thumbnailAssetId,
    thumbnailFingerprint,
    thumbnailPrefetchEnd,
    thumbnailPrefetchStart,
    thumbnailPriorityCenterIndex,
    thumbnailVideoPath,
  ]);

  useEditCapability({
    identity,
    active: isEditAuthority,
    selectedCount,
    visibleCount: filteredShots.length,
    handlers: {
      selectAll: () => shotSelectionReplaced(filteredShots.map((shot) => shot.id)),
      clearSelection: shotSelectionCleared,
    },
  });

  async function detectStoryboard() {
    if (!project || !canDetect) {
      return;
    }
    const taskId = createFfmpegTaskId("storyboard-detect");
    const context = videoContext;
    let cancelled = false;
    detectionStarted(context);
    const task = await createTaskProgress({
      operation: "storyboard.detect",
      label: `分镜拆分 ${project.asset.file_name}`,
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(taskId),
      on_cancel: async () => {
        cancelled = true;
        await cancelFfmpegTask(taskId);
      },
    });
    try {
      const result = await invokeCommand<StoryboardDetectionResult>("detect_storyboard_shots", {
        assetId: project.asset.id,
        taskId,
      });
      if (cancelled) {
        task.remove();
        detectionFinished(context);
        return;
      }
      detectionCompleted(context, result.shots);
      task.remove();
    } catch (error) {
      if (cancelled) {
        task.remove();
      } else {
        task.fail(error, { displayName: project.asset.file_name, resourceKind: "media" });
      }
      detectionFinished(context);
    }
  }

  function startThresholdEditing() {
    if (isDetecting) {
      return;
    }
    setThresholdDraft(threshold.toFixed(2));
    setIsThresholdEditing(true);
  }

  function finishThresholdEditing(commit: boolean) {
    if (commit) {
      const nextThreshold = Number(thresholdDraft);
      if (Number.isFinite(nextThreshold)) {
        setThreshold(nextThreshold);
      }
    }
    setIsThresholdEditing(false);
  }

  return (
    <section className="storyboard-panel">
      <div className="storyboard-project-row">
        <Film aria-hidden="true" />
        <span>分镜</span>
        <span className="storyboard-video-name" title={videoLabel}>
          {videoLabel}
        </span>
      </div>

      <div className="storyboard-search-row">
        <label className="storyboard-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索镜头编号、时间、帧号"
            disabled={shots.length === 0}
          />
        </label>
        <div className="storyboard-threshold">
          <span>阈值</span>
          <input
            type="range"
            min={MIN_STORYBOARD_DISPLAY_THRESHOLD}
            max={MAX_STORYBOARD_DISPLAY_THRESHOLD}
            step={0.01}
            value={threshold}
            disabled={isDetecting}
            onChange={(event) => setThreshold(Number(event.currentTarget.value))}
          />
          {isThresholdEditing ? (
            <input
              className="storyboard-threshold-value-input"
              type="number"
              min={MIN_STORYBOARD_DISPLAY_THRESHOLD}
              max={MAX_STORYBOARD_DISPLAY_THRESHOLD}
              step={0.01}
              value={thresholdDraft}
              onChange={(event) => setThresholdDraft(event.currentTarget.value)}
              onBlur={() => finishThresholdEditing(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  finishThresholdEditing(false);
                }
              }}
              autoFocus
              aria-label="分镜显示阈值"
            />
          ) : (
            <button
              type="button"
              className="storyboard-threshold-value"
              onDoubleClick={startThresholdEditing}
              disabled={isDetecting}
              title="双击编辑阈值"
              aria-label={`分镜显示阈值 ${threshold.toFixed(2)}，双击编辑`}
            >
              {threshold.toFixed(2)}
            </button>
          )}
        </div>
        <button
          type="button"
          className={`storyboard-detect-button ${isDetecting ? "is-detecting" : ""}`}
          onClick={() => void detectStoryboard()}
          disabled={!canDetect}
          title={
            isDetecting
              ? "正在切分"
              : canDetect
                ? shots.length > 0
                  ? "重新切分"
                  : "切分"
                : "请先导入可用视频"
          }
          aria-busy={isDetecting}
        >
          {isDetecting || detectingVideoContext === videoContext ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Scissors aria-hidden="true" />
          )}
          <span className="storyboard-detect-label">
            {isDetecting ? "正在切分" : shots.length > 0 ? "重新切分" : "切分"}
          </span>
        </button>
      </div>

      <div className="storyboard-content">
        <div className="storyboard-list-frame">
          <div className="storyboard-list-header" aria-hidden="true"></div>

          <div ref={listRef} className="shot-list">
            {filteredShots.length === 0 ? (
              <div className="empty-list">
                <Film size={36} />
                <strong>{project ? "没有可显示的分镜" : "分镜区为空"}</strong>
                <span>
                  {project
                    ? "点击切分后会在这里显示镜头段落。"
                    : "导入视频后可以使用 TransNetV2 进行分镜切分。"}
                </span>
              </div>
            ) : (
              <div
                className="virtual-spacer"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {virtualRows.map((virtualRow) => {
                  const shot = filteredShots[virtualRow.index];
                  const checked = selectedShotIds.has(shot.id);
                  const isCurrentShot = virtualRow.index === currentShotIndex;
                  const confidence = clamp(shot.score, 0, 1);
                  return (
                    <div
                      key={shot.id}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className={`shot-row ${shot.id === activeShotId ? "is-active" : ""} ${
                        isCurrentShot ? "is-current" : ""
                      }`}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <label className="shot-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => shotSelectionToggled(shot.id)}
                          aria-label="选择镜头"
                        />
                      </label>
                      {thumbnailVideoPath && (
                        <ShotFrameButton
                          shot={shot}
                          assetId={thumbnailAssetId}
                          fingerprint={thumbnailFingerprint}
                          videoPath={thumbnailVideoPath}
                          priority={Math.abs(virtualRow.index - thumbnailPriorityCenterIndex)}
                        />
                      )}
                      <button
                        type="button"
                        className="shot-content"
                        onClick={() => {
                          setActiveShotId(shot.id);
                          seekToShot(shot);
                        }}
                        onDoubleClick={() => seekToShot(shot, true)}
                      >
                        <span className="shot-time">
                          {formatDuration(shot.start_us)} - {formatDuration(shot.end_us)}
                        </span>
                        <span className="shot-title">{shotLabel(shot)}</span>
                        <span className="shot-meta">
                          {formatShotDuration(shot)} · {shot.start_frame}-{shot.end_frame} 帧 ·{" "}
                          {(confidence * 100).toFixed(0)}%
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="storyboard-footer">
        <div className="storyboard-selection-tools">
          <button
            type="button"
            onClick={() => shotSelectionReplaced(filteredShots.map((shot) => shot.id))}
            disabled={filteredShots.length === 0}
            title="全选分镜"
          >
            <CheckCheck aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={shotSelectionCleared}
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
            title="仅展示选中分镜"
            aria-pressed={showOnlySelected}
          >
            <ListFilter aria-hidden="true" />
          </button>
        </div>
        <span>
          {selectedCount} 条已选择，共 {filteredShots.length} 条
        </span>
      </footer>
    </section>
  );
}
