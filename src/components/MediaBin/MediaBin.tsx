import { invoke } from "@tauri-apps/api/core";
import {
  Grid2X2,
  Link2,
  List,
  Loader2,
  Menu,
  PanelTopOpen,
  PenLine,
  Plus,
  Search,
  SplitSquareVertical,
  Trash2,
  Unlink2,
} from "lucide-react";
import { useEffect, useMemo, type CSSProperties, type DragEvent } from "react";
import { emitAppEvent } from "../../appEvents";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { AddExternalSubtitlesResult, DemuxMediaResult, MediaBinItem } from "../../types";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";
import "./MediaBin.css";
import { MediaBinTable } from "./MediaBinTable";
import { activeMediaDragItemIds, markMediaDragHandled } from "./mediaDrag";
import { useMediaBinState } from "./mediaBinState";

const mediaDragType = "application/x-linecut-media";

function MediaBinLockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
        d="M7 10V7a5 5 0 0 1 10 0v3h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2Zm3 0h4V7a2 2 0 1 0-4 0v3Zm1 4h2v4h-2v-4Z"
      />
    </svg>
  );
}

function readDraggedMediaIds(event: DragEvent) {
  const serialized = event.dataTransfer.getData(mediaDragType);
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized);
      if (Array.isArray(parsed)) {
        return parsed.filter((itemId): itemId is string => typeof itemId === "string");
      }
    } catch {
      // Fall through to the text/plain representation used by some WebViews.
    }
  }
  const plainText = event.dataTransfer.getData("text/plain").trim();
  if (!plainText) {
    return activeMediaDragItemIds();
  }
  try {
    const parsed = JSON.parse(plainText);
    return Array.isArray(parsed)
      ? parsed.filter((itemId): itemId is string => typeof itemId === "string")
      : [];
  } catch {
    return [plainText];
  }
}

export function MediaBin() {
  const projects = useAppStore((state) => state.projects);
  const mediaItems = useAppStore((state) => state.mediaItems);
  const activeVideoId = useAppStore((state) => state.activeVideoId);
  const detachedVideoIds = useAppStore((state) => state.detachedVideoIds);
  const mediaItemRenamed = useAppStore((state) => state.actions.mediaItemRenamed);
  const mediaItemsBound = useAppStore((state) => state.actions.mediaItemsBound);
  const mediaItemsUnbound = useAppStore((state) => state.actions.mediaItemsUnbound);
  const mediaItemsRemoved = useAppStore((state) => state.actions.mediaItemsRemoved);
  const mediaDemuxed = useAppStore((state) => state.actions.mediaDemuxed);
  const activeVideoChanged = useAppStore((state) => state.actions.activeVideoChanged);
  const subtitleTracksAddedToVideo = useAppStore(
    (state) => state.actions.subtitleTracksAddedToVideo,
  );
  const messagePublished = useAppStore((state) => state.actions.messagePublished);
  const warningsAppended = useAppStore((state) => state.actions.warningsAppended);
  const isReadOnly = useAppStore((state) => state.mediaBinReadOnly);
  const setReadOnly = useAppStore((state) => state.actions.mediaBinReadOnlyChanged);

  const query = useMediaBinState((state) => state.query);
  const selectedIds = useMediaBinState((state) => state.selectedIds);
  const viewMode = useMediaBinState((state) => state.viewMode);
  const listSize = useMediaBinState((state) => state.listSize);
  const gridSize = useMediaBinState((state) => state.gridSize);
  const bindingPopoverOpen = useMediaBinState((state) => state.bindingPopoverOpen);
  const bindingVideoId = useMediaBinState((state) => state.bindingVideoId);
  const setQuery = useMediaBinState((state) => state.setQuery);
  const selectOnly = useMediaBinState((state) => state.selectOnly);
  const toggleSelected = useMediaBinState((state) => state.toggleSelected);
  const clearSelection = useMediaBinState((state) => state.clearSelection);
  const setViewMode = useMediaBinState((state) => state.setViewMode);
  const setListSize = useMediaBinState((state) => state.setListSize);
  const setGridSize = useMediaBinState((state) => state.setGridSize);
  const setBindingPopoverOpen = useMediaBinState((state) => state.setBindingPopoverOpen);
  const setBindingVideoId = useMediaBinState((state) => state.setBindingVideoId);
  const { isRunning: isImporting } = getTaskProgressStatus("media_import");
  const { isRunning: isBinding } = getTaskProgressStatus("media_bin_bind");
  const { isRunning: isDemuxing } = getTaskProgressStatus("media_bin_demux");
  const isBusy = isImporting || isBinding || isDemuxing;

  const selectedItems = useMemo(
    () => mediaItems.filter((item) => selectedIds.has(item.id)),
    [mediaItems, selectedIds],
  );
  const selectedAuxiliary = selectedItems.filter((item) => item.kind !== "video");
  const selectedVideos = selectedItems.filter((item) => item.kind === "video");
  const videos = useMemo(() => mediaItems.filter((item) => item.kind === "video"), [mediaItems]);
  const selectedBindingVideoId =
    selectedVideos.length === 1
      ? selectedVideos[0].id
      : bindingVideoId || activeVideoId || videos[0]?.id || "";
  const canBind = selectedAuxiliary.length > 0 && Boolean(selectedBindingVideoId);
  const canUnbind = selectedAuxiliary.some((item) => item.bound_to_video_id);
  const bindingActionIsUnbind = canUnbind;
  const canManageBinding = canBind || canUnbind;
  const selectedDemuxVideo = selectedVideos.length === 1 ? selectedVideos[0] : null;
  const sizeValue = viewMode === "list" ? listSize : gridSize;
  const gridScale = gridSize < 34 ? 1 : gridSize < 67 ? 1.3 : 1.6;
  const gridCardWidth = 200 * gridScale;
  const listIconScale = 1 + listSize * 0.015;
  const contentStyle = {
    "--media-list-row-height": `${24 + listSize * 0.36}px`,
    "--media-list-icon-size": `${16 * listIconScale}px`,
    "--media-list-status-icon-size": `${12 * listIconScale}px`,
    "--media-list-bind-branch-width": `${12.5 * listIconScale}px`,
    "--media-list-bind-branch-margin": `${2 * listIconScale}px`,
    "--media-list-bind-branch-line-position": `${7 * listIconScale}px`,
    "--media-list-bind-branch-horizontal-left": `${8 * listIconScale}px`,
    "--media-list-bind-branch-horizontal-width": `${8 * listIconScale}px`,
    "--media-list-bind-branch-line-width": `${listIconScale}px`,
    "--media-list-bind-branch-overhang": `-${listIconScale}px`,
    "--media-list-bind-branch-last-width": `${9 * listIconScale}px`,
    "--media-list-bind-branch-radius": `${4 * listIconScale}px`,
    "--media-list-title-icon-gap": `${6 * (1 + listSize * 0.01)}px`,
    "--media-grid-card-width": `${gridCardWidth}px`,
  } as CSSProperties;

  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = (item: MediaBinItem) => {
      if (!normalizedQuery) {
        return true;
      }
      const haystack = `${item.file_name} ${item.codec ?? ""} ${item.language ?? ""}`;
      return haystack.toLocaleLowerCase().includes(normalizedQuery);
    };
    const result: Array<{ item: MediaBinItem; depth: number }> = [];
    const rendered = new Set<string>();
    for (const video of mediaItems.filter((item) => item.kind === "video")) {
      const children = mediaItems.filter((item) => item.bound_to_video_id === video.id);
      const matchingChildren = children.filter(matches);
      if (!matches(video) && matchingChildren.length === 0) {
        continue;
      }
      result.push({ item: video, depth: 0 });
      rendered.add(video.id);
      for (const child of normalizedQuery ? matchingChildren : children) {
        result.push({ item: child, depth: 1 });
        rendered.add(child.id);
      }
    }
    for (const item of mediaItems) {
      if (!rendered.has(item.id) && matches(item)) {
        result.push({ item, depth: 0 });
      }
    }
    return result;
  }, [mediaItems, query]);

  useEffect(() => {
    if (!bindingPopoverOpen) {
      return;
    }
    const close = () => {
      setBindingPopoverOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [bindingPopoverOpen, setBindingPopoverOpen]);

  useEffect(() => {
    if (isReadOnly && bindingPopoverOpen) {
      setBindingPopoverOpen(false);
    }
  }, [bindingPopoverOpen, isReadOnly, setBindingPopoverOpen]);

  async function bindItemsToVideo(itemIds: string[], videoId: string) {
    if (isReadOnly || isBusy || !projects[videoId]) {
      return;
    }
    const selectedItemsToBind = mediaItems.filter(
      (item) => itemIds.includes(item.id) && item.kind !== "video" && item.id !== videoId,
    );
    if (selectedItemsToBind.length === 0) {
      messagePublished("只有音频和字幕可以绑定到视频。");
      return;
    }
    const subtitlesToParse = selectedItemsToBind.filter(
      (item) =>
        item.kind === "subtitle" && (!item.subtitle_track_id || item.bound_to_video_id !== videoId),
    );
    const directItems = selectedItemsToBind.filter(
      (item) => item.kind === "audio" || !subtitlesToParse.includes(item),
    );

    if (subtitlesToParse.length > 0) {
      const taskId = createFfmpegTaskId("media-bin-bind");
      let cancelled = false;
      const task = await createTaskProgress({
        operation: "media_bin_bind",
        label: `正在解析并绑定 ${subtitlesToParse.length} 个字幕`,
        current: 0,
        total: 1,
        listener: listenToFfmpegTaskProgress(taskId),
        on_cancel: async () => {
          cancelled = true;
          await cancelFfmpegTask(taskId);
        },
      });
      try {
        const result = await invoke<AddExternalSubtitlesResult>("add_external_subtitles", {
          assetId: videoId,
          paths: subtitlesToParse.map((item) => item.path),
          taskId,
        });
        subtitleTracksAddedToVideo(
          videoId,
          result.tracks,
          result.cues,
          subtitlesToParse.map((item) => item.id),
        );
        warningsAppended(result.warnings);
        task.update({ current: 1 });
        task.remove();
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          task.fail("字幕绑定失败", message);
          messagePublished(message);
        }
        return;
      }
    }
    if (directItems.length > 0) {
      mediaItemsBound(
        directItems.map((item) => item.id),
        videoId,
      );
    }
    const targetName = projects[videoId]?.asset.file_name ?? "视频";
    messagePublished(`已将 ${selectedItemsToBind.length} 个素材绑定到 ${targetName}`);
  }

  async function bindSelectedItems() {
    if (!canBind) {
      return;
    }
    await bindItemsToVideo(
      selectedAuxiliary.map((item) => item.id),
      selectedBindingVideoId,
    );
    setBindingPopoverOpen(false);
  }

  function unbindItems(itemIds: string[]) {
    if (isReadOnly) {
      return;
    }
    const boundItemIds = mediaItems
      .filter(
        (item) => itemIds.includes(item.id) && item.kind !== "video" && item.bound_to_video_id,
      )
      .map((item) => item.id);
    if (boundItemIds.length === 0) {
      return;
    }
    mediaItemsUnbound(boundItemIds);
    messagePublished(`已解除 ${boundItemIds.length} 个素材的绑定`);
  }

  function handleContentDragOver(event: DragEvent<HTMLDivElement>) {
    if (isReadOnly) {
      return;
    }
    if (
      activeMediaDragItemIds().length === 0 &&
      !event.dataTransfer.types.includes(mediaDragType) &&
      !event.dataTransfer.types.includes("text/plain")
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleContentDrop(event: DragEvent<HTMLDivElement>) {
    if (isReadOnly) {
      return;
    }
    const itemIds = readDraggedMediaIds(event);
    if (itemIds.length === 0) {
      return;
    }
    event.preventDefault();
    markMediaDragHandled();
    unbindItems(itemIds);
  }

  async function demuxSelectedVideo() {
    if (isReadOnly) {
      return;
    }
    const video = selectedDemuxVideo;
    if (!video || detachedVideoIds.has(video.id)) {
      return;
    }
    const taskId = createFfmpegTaskId("media-bin-demux");
    let cancelled = false;
    const task = await createTaskProgress({
      operation: "media_bin_demux",
      label: `正在分解 ${video.file_name}`,
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(taskId),
      on_cancel: async () => {
        cancelled = true;
        await cancelFfmpegTask(taskId);
      },
    });
    try {
      const result = await invoke<DemuxMediaResult>("demux_media_streams", {
        assetId: video.id,
        taskId,
      });
      mediaDemuxed(video.id, result);
      task.update({ current: 1 });
      task.remove();
      messagePublished(
        `已拆出 ${result.audio_tracks.length} 条音轨和 ${result.subtitle_tracks.length} 条字幕`,
      );
    } catch (error) {
      if (cancelled) {
        messagePublished("分解已取消");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      task.fail("分解失败", message);
      messagePublished(message);
    }
  }

  async function removeSelection() {
    if (isReadOnly || selectedItems.length === 0) {
      return;
    }
    if (isTauriRuntime()) {
      await Promise.all(
        selectedItems
          .filter((item) => item.origin === "imported" && item.kind !== "subtitle")
          .map((item) => invoke("close_project", { assetId: item.id }).catch(() => false)),
      );
    }
    mediaItemsRemoved(selectedItems.map((item) => item.id));
    clearSelection();
    messagePublished(`已从素材箱移除 ${selectedItems.length} 个素材`);
  }

  function previewVideo(videoId: string) {
    activeVideoChanged(videoId);
    messagePublished(`源预览已切换到 ${projects[videoId]?.asset.file_name ?? "所选视频"}`);
  }

  return (
    <section className="media-bin-panel">
      <div className="media-bin-project-row">
        <PanelTopOpen aria-hidden="true" />
        <span>项目素材</span>
        <Menu aria-hidden="true" />
      </div>

      <div className="media-bin-search-row">
        <label className="media-bin-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索素材"
            aria-label="搜索素材"
          />
        </label>
        <span>
          {selectedIds.size} 项已选择，共 {mediaItems.length} 项
        </span>
      </div>

      <div
        className={`media-bin-content ${viewMode}-view ${isBinding ? "is-binding" : ""}`}
        style={contentStyle}
        onDragOver={handleContentDragOver}
        onDrop={handleContentDrop}
      >
        <MediaBinTable
          rows={rows}
          hasItems={mediaItems.length > 0}
          mediaItems={mediaItems}
          projects={projects}
          detachedVideoIds={detachedVideoIds}
          gridCardWidth={gridCardWidth}
          selectedIds={selectedIds}
          viewMode={viewMode}
          isReadOnly={isReadOnly}
          onSelectOnly={selectOnly}
          onToggleSelected={toggleSelected}
          onRenameItem={mediaItemRenamed}
          onPreviewVideo={previewVideo}
          onBindItems={bindItemsToVideo}
          onUnbindItems={unbindItems}
        />
      </div>

      <footer className="media-bin-footer">
        <div className="media-bin-view-tools">
          <button
            type="button"
            className={isReadOnly ? "media-bin-lock" : "media-bin-pen"}
            title={isReadOnly ? "解除素材箱只读" : "将素材箱设为只读"}
            aria-pressed={isReadOnly}
            onClick={() => setReadOnly(!isReadOnly)}
          >
            {isReadOnly ? <MediaBinLockIcon /> : <PenLine aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
            title="列表视图"
          >
            <List aria-hidden="true" />
          </button>
          <button
            type="button"
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
            title="图标视图"
          >
            <Grid2X2 aria-hidden="true" />
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={sizeValue}
            aria-label={viewMode === "list" ? "列表行高" : "图标大小"}
            onChange={(event) => {
              const size = Number(event.currentTarget.value);
              if (viewMode === "list") {
                setListSize(size);
              } else {
                setGridSize(size);
              }
            }}
          />
        </div>

        <div className="media-bin-action-tools">
          <div className="media-bin-bind-wrap" onPointerDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className={!bindingActionIsUnbind && bindingPopoverOpen ? "active" : ""}
              onClick={() => {
                if (bindingActionIsUnbind) {
                  setBindingPopoverOpen(false);
                  unbindItems(selectedAuxiliary.map((item) => item.id));
                  return;
                }
                setBindingPopoverOpen(!bindingPopoverOpen);
              }}
              disabled={isReadOnly || !canManageBinding || isBusy}
              title={bindingActionIsUnbind ? "解除绑定" : "绑定媒体（也可直接拖到视频标题上）"}
            >
              {bindingActionIsUnbind ? (
                <Unlink2 aria-hidden="true" />
              ) : (
                <Link2 aria-hidden="true" />
              )}
            </button>
            {!bindingActionIsUnbind && bindingPopoverOpen && (
              <div className="media-bin-bind-popover">
                <div className="media-bin-bind-heading">
                  <Link2 aria-hidden="true" />
                  <strong>绑定媒体</strong>
                </div>
                <span className="media-bin-bind-summary">
                  {selectedAuxiliary.length > 0
                    ? `已选择 ${selectedAuxiliary.length} 个音频或字幕`
                    : "先在列表中选择音频或字幕"}
                </span>
                <label>
                  <span>目标视频</span>
                  <select
                    value={selectedBindingVideoId}
                    onChange={(event) => setBindingVideoId(event.currentTarget.value)}
                    disabled={selectedVideos.length === 1}
                  >
                    {videos.map((video) => (
                      <option key={video.id} value={video.id}>
                        {video.file_name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="media-bin-bind-confirm"
                  disabled={isReadOnly || !canBind || isBusy}
                  onClick={() => void bindSelectedItems()}
                >
                  {isBinding ? (
                    <Loader2 className="spin" aria-hidden="true" />
                  ) : (
                    <Link2 aria-hidden="true" />
                  )}
                  绑定
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void demuxSelectedVideo()}
            disabled={
              isReadOnly ||
              !selectedDemuxVideo ||
              detachedVideoIds.has(selectedDemuxVideo.id) ||
              isBusy
            }
            title="分解音轨和字幕"
          >
            {isDemuxing ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <SplitSquareVertical aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => emitAppEvent("media:import", {})}
            disabled={isReadOnly || isBusy}
            title="导入素材（视频、音频或字幕）"
          >
            {isImporting ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Plus aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void removeSelection()}
            disabled={isReadOnly || selectedItems.length === 0 || isBusy}
            title="移除所选素材"
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      </footer>
    </section>
  );
}
