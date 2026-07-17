import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Grid2X2,
  FolderPlus,
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
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { emitAppEvent, useAppEvent } from "../../appEvents";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import {
  defaultMediaBinFolderColor,
  isMediaItemEnabled,
  isMediaItemHidden,
  isMediaItemOffline,
  isMediaVideoDetached,
  isVirtualMediaItem,
  mediaItemProject,
  getProjectWorkspaceSnapshot,
  useAppStore,
} from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import { usePanelActive, usePanelInstanceId } from "../../panelState";
import type {
  AddExternalSubtitlesResult,
  DemuxMediaResult,
  MediaBinFolder,
  MediaBinItem,
} from "../../types";
import { runMediaImportTask } from "../../mediaImportTask";
import { MediaLinkDialog, type MediaLinkCandidate, type MediaLinkMode } from "../MediaLinkDialog";
import { ModalDialog } from "../ModalDialog";
import { PopupMenu, PopupMenuItem, PopupMenuSeparator, PopupMenuSubmenu } from "../PopupMenu";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";
import "./MediaBin.css";
import { MediaBinTable, type MediaBinTableRow } from "./MediaBinTable";
import { activeMediaDragItemIds, markMediaDragHandled } from "./mediaDrag";
import { setMediaBinClipboardItemCount, useMediaBinState } from "./mediaBinState";

const mediaDragType = "application/x-linecut-media";
interface MediaBinClipboard {
  folders: MediaBinFolder[];
  items: MediaBinItem[];
}

let mediaBinClipboard: MediaBinClipboard = { folders: [], items: [] };
const duplicateSuffixPattern = /^(.*) 复制(\d+)$/;

interface MediaBinContextMenuState {
  x: number;
  y: number;
  itemId: string | null;
  folderId: string | null;
  bindingSubmenuOpen: boolean;
  proxySubmenuOpen: boolean;
  moveSubmenuOpen: boolean;
}

interface MediaBinProps {
  rootFolderId?: string | null;
  onOpenFolder?: (folderId: string) => void;
}

interface MediaLinkDialogState {
  mode: MediaLinkMode;
  itemIds: string[];
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return (
    element?.tagName === "INPUT" ||
    element?.tagName === "TEXTAREA" ||
    element?.tagName === "SELECT" ||
    Boolean(element?.isContentEditable)
  );
}

function copiedMediaItemId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `media-copy:${random}`;
}

function copiedMediaFolderId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `media-bin-copy:${random}`;
}

function mediaFolderAndDescendantIds(mediaFolders: MediaBinFolder[], folderIds: Iterable<string>) {
  const result = new Set(folderIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of mediaFolders) {
      if (folder.parent_id && result.has(folder.parent_id) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

function duplicateFileName(
  item: MediaBinItem,
  mediaItems: MediaBinItem[],
  counts: Map<string, number>,
) {
  const sourceName = item.file_name.match(duplicateSuffixPattern)?.[1] ?? item.file_name;
  const key = `${item.path}\u0000${sourceName}`;
  const currentCount = counts.get(key);
  if (currentCount !== undefined) {
    const nextCount = currentCount + 1;
    counts.set(key, nextCount);
    return `${sourceName} 复制${String(nextCount).padStart(2, "0")}`;
  }

  const nextCount =
    mediaItems.reduce((maximum, candidate) => {
      if (candidate.path !== item.path) {
        return maximum;
      }
      const match = candidate.file_name.match(duplicateSuffixPattern);
      return match?.[1] === sourceName ? Math.max(maximum, Number(match[2])) : maximum;
    }, 0) + 1;
  counts.set(key, nextCount);
  return `${sourceName} 复制${String(nextCount).padStart(2, "0")}`;
}

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

export function MediaBin({ rootFolderId = null, onOpenFolder }: MediaBinProps) {
  const panelInstanceId = usePanelInstanceId();
  const panelActive = usePanelActive();
  const projects = useAppStore((state) => state.projects);
  const mediaFolders = useAppStore((state) => state.mediaFolders);
  const mediaItems = useAppStore((state) => state.mediaItems);
  const activeVideoId = useAppStore((state) => state.activeVideoId);
  const detachedVideoIds = useAppStore((state) => state.detachedVideoIds);
  const mediaItemRenamed = useAppStore((state) => state.actions.mediaItemRenamed);
  const mediaBinEntriesAdded = useAppStore((state) => state.actions.mediaBinEntriesAdded);
  const mediaBinEntriesRemoved = useAppStore((state) => state.actions.mediaBinEntriesRemoved);
  const mediaFolderAdded = useAppStore((state) => state.actions.mediaFolderAdded);
  const mediaFolderRenamed = useAppStore((state) => state.actions.mediaFolderRenamed);
  const mediaFoldersHiddenChanged = useAppStore((state) => state.actions.mediaFoldersHiddenChanged);
  const mediaEntriesMovedToFolder = useAppStore((state) => state.actions.mediaEntriesMovedToFolder);
  const mediaItemsMovedToFolder = useAppStore((state) => state.actions.mediaItemsMovedToFolder);
  const mediaItemsEnabledChanged = useAppStore((state) => state.actions.mediaItemsEnabledChanged);
  const mediaItemsHiddenChanged = useAppStore((state) => state.actions.mediaItemsHiddenChanged);
  const mediaItemsOfflineChanged = useAppStore((state) => state.actions.mediaItemsOfflineChanged);
  const mediaItemRelinked = useAppStore((state) => state.actions.mediaItemRelinked);
  const mediaProxyPathChanged = useAppStore((state) => state.actions.mediaProxyPathChanged);
  const mediaItemsBound = useAppStore((state) => state.actions.mediaItemsBound);
  const mediaItemsUnbound = useAppStore((state) => state.actions.mediaItemsUnbound);
  const mediaDemuxed = useAppStore((state) => state.actions.mediaDemuxed);
  const activeVideoChanged = useAppStore((state) => state.actions.activeVideoChanged);
  const proxyDialogOpened = useAppStore((state) => state.actions.proxyDialogOpened);
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
  const showHidden = useMediaBinState((state) => state.showHidden);
  const bindingPopoverOpen = useMediaBinState((state) => state.bindingPopoverOpen);
  const bindingVideoId = useMediaBinState((state) => state.bindingVideoId);
  const setQuery = useMediaBinState((state) => state.setQuery);
  const setVisibleItemCount = useMediaBinState((state) => state.setVisibleItemCount);
  const selectOnly = useMediaBinState((state) => state.selectOnly);
  const toggleSelected = useMediaBinState((state) => state.toggleSelected);
  const selectItems = useMediaBinState((state) => state.selectItems);
  const clearSelection = useMediaBinState((state) => state.clearSelection);
  const setViewMode = useMediaBinState((state) => state.setViewMode);
  const setListSize = useMediaBinState((state) => state.setListSize);
  const setGridSize = useMediaBinState((state) => state.setGridSize);
  const setShowHidden = useMediaBinState((state) => state.setShowHidden);
  const setBindingPopoverOpen = useMediaBinState((state) => state.setBindingPopoverOpen);
  const setBindingVideoId = useMediaBinState((state) => state.setBindingVideoId);
  const { isRunning: isImporting } = getTaskProgressStatus("media_import");
  const { isRunning: isBinding } = getTaskProgressStatus("media_bin_bind");
  const { isRunning: isDemuxing } = getTaskProgressStatus("media_bin_demux");
  const { isRunning: isRelinking } = getTaskProgressStatus("media_relink");
  const { isRunning: isGeneratingProxy } = getTaskProgressStatus("proxy");
  const isBusy = isImporting || isBinding || isDemuxing || isRelinking;
  const panelRef = useRef<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<MediaBinContextMenuState | null>(null);
  const [linkDialog, setLinkDialog] = useState<MediaLinkDialogState | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(rootFolderId);
  const rootFolder = rootFolderId
    ? (mediaFolders.find((folder) => folder.id === rootFolderId) ?? null)
    : null;
  const rootFolderAvailable = rootFolderId === null || rootFolder !== null;
  const scopedFolderIds = useMemo(() => {
    if (rootFolderId === null) {
      return new Set(mediaFolders.map((folder) => folder.id));
    }
    const folderIds = mediaFolderAndDescendantIds(mediaFolders, [rootFolderId]);
    folderIds.delete(rootFolderId);
    return folderIds;
  }, [mediaFolders, rootFolderId]);
  const scopedFolders = useMemo(
    () => mediaFolders.filter((folder) => scopedFolderIds.has(folder.id)),
    [mediaFolders, scopedFolderIds],
  );
  const scopedItems = useMemo(
    () =>
      rootFolderId === null
        ? mediaItems
        : mediaItems.filter(
            (item) =>
              item.bin_id === rootFolderId ||
              Boolean(item.bin_id && scopedFolderIds.has(item.bin_id)),
          ),
    [mediaItems, rootFolderId, scopedFolderIds],
  );
  const scopedEntryIds = useMemo(
    () =>
      new Set([...scopedFolders.map((folder) => folder.id), ...scopedItems.map((item) => item.id)]),
    [scopedFolders, scopedItems],
  );

  const directlySelectedItems = useMemo(
    () => mediaItems.filter((item) => selectedIds.has(item.id)),
    [mediaItems, selectedIds],
  );
  const selectedFolders = useMemo(
    () => mediaFolders.filter((folder) => selectedIds.has(folder.id)),
    [mediaFolders, selectedIds],
  );
  const selectedFolderTreeIds = useMemo(
    () =>
      mediaFolderAndDescendantIds(
        mediaFolders,
        selectedFolders.map((folder) => folder.id),
      ),
    [mediaFolders, selectedFolders],
  );
  const selectedItems = useMemo(
    () =>
      mediaItems.filter(
        (item) =>
          selectedIds.has(item.id) ||
          Boolean(item.bin_id && selectedFolderTreeIds.has(item.bin_id)),
      ),
    [mediaItems, selectedFolderTreeIds, selectedIds],
  );
  const selectedAuxiliary = selectedItems.filter((item) => item.kind !== "video");
  const selectedAudioCount = selectedAuxiliary.filter((item) => item.kind === "audio").length;
  const selectedSubtitleCount = selectedAuxiliary.filter((item) => item.kind === "subtitle").length;
  const selectedAuxiliaryTypeSummary = [
    selectedAudioCount > 0 ? `音频 ${selectedAudioCount} 个` : "",
    selectedSubtitleCount > 0 ? `字幕 ${selectedSubtitleCount} 个` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const selectedAuxiliaryNames = selectedAuxiliary.map((item) => item.file_name).join("、");
  const selectedVideos = selectedItems.filter((item) => item.kind === "video");
  const videos = useMemo(() => mediaItems.filter((item) => item.kind === "video"), [mediaItems]);
  const selectedFileItems = selectedItems.filter(
    (item) => item.origin === "imported" && !item.extracted,
  );
  const selectedOfflineItems = selectedFileItems.filter(isMediaItemOffline);
  const selectedOnlineItems = selectedFileItems.filter((item) => !isMediaItemOffline(item));
  const selectedProjectVideos = selectedVideos.filter((item) =>
    Boolean(mediaItemProject(item, projects, mediaItems)),
  );
  const selectedVideosWithProxy = selectedProjectVideos.filter((item) =>
    Boolean(mediaItemProject(item, projects, mediaItems)?.proxy_path),
  );
  const selectedOfflineProjectVideos = selectedProjectVideos.filter(isMediaItemOffline);
  const allItemsEnabled = scopedItems.every(isMediaItemEnabled);
  const selectedBindingVideoId =
    selectedVideos.length === 1
      ? selectedVideos[0].id
      : bindingVideoId || activeVideoId || videos[0]?.id || "";
  const bindingVideoItems = useMemo(
    () => selectDropdownItems(videos.map((video) => [video.id, video.file_name] as const)),
    [videos],
  );
  const canBind = selectedAuxiliary.length > 0 && Boolean(selectedBindingVideoId);
  const canUnbind = selectedAuxiliary.some((item) => item.bound_to_video_id);
  const bindingActionIsUnbind = canUnbind;
  const canManageBinding = canBind || canUnbind;
  const selectedDemuxVideo = selectedVideos.length === 1 ? selectedVideos[0] : null;
  const canDemuxSelectedVideo = Boolean(
    selectedDemuxVideo && !isMediaVideoDetached(selectedDemuxVideo, detachedVideoIds),
  );
  const sizeValue = viewMode === "list" ? listSize : gridSize;
  const gridScale = gridSize < 34 ? 1 : gridSize < 67 ? 1.3 : 1.6;
  const gridCardWidth = 200 * gridScale;
  const listIconScale = 1 + listSize * 0.015;
  const linkDialogCandidates = useMemo(() => {
    if (!linkDialog) {
      return [];
    }
    const ids = new Set(linkDialog.itemIds);
    return mediaItems
      .filter((item) => ids.has(item.id))
      .map((item): MediaLinkCandidate => {
        const project = mediaItemProject(item, projects, mediaItems);
        const filePath =
          linkDialog.mode === "proxy"
            ? (project?.proxy_path ?? item.path)
            : linkDialog.mode === "full-resolution"
              ? (project?.asset.path ?? item.path)
              : item.path;
        return {
          id: item.id,
          clipName: item.file_name,
          filePath,
          kind: item.kind,
          mediaStartUs: item.start_time_us,
        };
      });
  }, [linkDialog, mediaItems, projects]);
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
    if (!rootFolderAvailable) {
      return [];
    }
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const displayedItems = showHidden
      ? scopedItems
      : scopedItems.filter((item) => !isMediaItemHidden(item));
    const displayedFolders = showHidden
      ? scopedFolders
      : scopedFolders.filter((folder) => folder.hidden !== true);
    const matches = (item: MediaBinItem) => {
      if (!normalizedQuery) {
        return true;
      }
      const haystack = `${item.file_name} ${item.codec ?? ""} ${item.language ?? ""}`;
      return haystack.toLocaleLowerCase().includes(normalizedQuery);
    };
    const result: MediaBinTableRow[] = [];
    const displayedIds = new Set(displayedItems.map((item) => item.id));
    const boundChildren = new Map<string, MediaBinItem[]>();
    for (const item of displayedItems) {
      if (item.bound_to_video_id && displayedIds.has(item.bound_to_video_id)) {
        const children = boundChildren.get(item.bound_to_video_id) ?? [];
        children.push(item);
        boundChildren.set(item.bound_to_video_id, children);
      }
    }
    const directItems = displayedItems.filter(
      (item) => !item.bound_to_video_id || !displayedIds.has(item.bound_to_video_id),
    );
    const itemsByFolder = new Map<string | null, MediaBinItem[]>();
    for (const item of directItems) {
      const folderItems = itemsByFolder.get(item.bin_id) ?? [];
      folderItems.push(item);
      itemsByFolder.set(item.bin_id, folderItems);
    }
    const foldersByParent = new Map<string | null, MediaBinFolder[]>();
    for (const folder of displayedFolders) {
      const children = foldersByParent.get(folder.parent_id) ?? [];
      children.push(folder);
      foldersByParent.set(folder.parent_id, children);
    }
    const itemGroupMatches = (item: MediaBinItem) =>
      matches(item) || (boundChildren.get(item.id) ?? []).some(matches);
    const folderMatchCache = new Map<string, boolean>();
    const folderHasMatch = (folder: MediaBinFolder): boolean => {
      const cached = folderMatchCache.get(folder.id);
      if (cached !== undefined) {
        return cached;
      }
      const matchesFolder = folder.name.toLocaleLowerCase().includes(normalizedQuery);
      const matchesItems = (itemsByFolder.get(folder.id) ?? []).some(itemGroupMatches);
      const matchesChildren = (foldersByParent.get(folder.id) ?? []).some(folderHasMatch);
      const matched = matchesFolder || matchesItems || matchesChildren;
      folderMatchCache.set(folder.id, matched);
      return matched;
    };
    const appendItems = (items: MediaBinItem[], depth: number, includeAll: boolean) => {
      for (const item of items) {
        const children = boundChildren.get(item.id) ?? [];
        const matchingChildren = includeAll ? children : children.filter(matches);
        if (!includeAll && !matches(item) && matchingChildren.length === 0) {
          continue;
        }
        result.push({ type: "item", item, depth, boundChild: false });
        for (const child of matchingChildren) {
          result.push({ type: "item", item: child, depth: depth + 1, boundChild: true });
        }
      }
    };

    if (viewMode === "grid") {
      for (const folder of foldersByParent.get(rootFolderId) ?? []) {
        if (!normalizedQuery || folder.name.toLocaleLowerCase().includes(normalizedQuery)) {
          result.push({ type: "folder", folder, depth: 0 });
        }
      }
      appendItems(itemsByFolder.get(rootFolderId) ?? [], 0, !normalizedQuery);
      return result;
    }

    const appendFolder = (folder: MediaBinFolder, depth: number, ancestorMatched: boolean) => {
      const matchesFolder = folder.name.toLocaleLowerCase().includes(normalizedQuery);
      if (normalizedQuery && !ancestorMatched && !folderHasMatch(folder)) {
        return;
      }
      result.push({ type: "folder", folder, depth });
      const includeAll = ancestorMatched || matchesFolder;
      if (!normalizedQuery && !expandedFolderIds.has(folder.id)) {
        return;
      }
      for (const child of foldersByParent.get(folder.id) ?? []) {
        appendFolder(child, depth + 1, includeAll);
      }
      appendItems(itemsByFolder.get(folder.id) ?? [], depth + 1, includeAll || !normalizedQuery);
    };
    for (const folder of foldersByParent.get(rootFolderId) ?? []) {
      appendFolder(folder, 0, false);
    }
    appendItems(itemsByFolder.get(rootFolderId) ?? [], 0, !normalizedQuery);
    return result;
  }, [
    expandedFolderIds,
    query,
    rootFolderAvailable,
    rootFolderId,
    scopedFolders,
    scopedItems,
    showHidden,
    viewMode,
  ]);

  useEffect(() => {
    setVisibleItemCount(rows.length);
  }, [rows, setVisibleItemCount]);

  useEffect(() => {
    if (isReadOnly && bindingPopoverOpen) {
      setBindingPopoverOpen(false);
    }
  }, [bindingPopoverOpen, isReadOnly, setBindingPopoverOpen]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const nextSelection = Array.from(selectedIds).filter((itemId) => scopedEntryIds.has(itemId));
    if (nextSelection.length !== selectedIds.size) {
      selectItems(nextSelection);
    }
  }, [scopedEntryIds, selectItems, selectedIds]);

  useEffect(() => {
    const validFolderTargets = new Set(scopedFolderIds).add(rootFolderId ?? "");
    if (
      currentFolderId !== rootFolderId &&
      (!currentFolderId || !validFolderTargets.has(currentFolderId))
    ) {
      setCurrentFolderId(rootFolderId);
    }
    setExpandedFolderIds((current) => {
      const next = new Set(Array.from(current).filter((folderId) => scopedFolderIds.has(folderId)));
      return next.size === current.size ? current : next;
    });
  }, [currentFolderId, rootFolderId, scopedFolderIds]);

  function focusMediaBinEntry(entryId: string) {
    const folder = scopedFolders.find((candidate) => candidate.id === entryId);
    if (folder) {
      setCurrentFolderId(folder.parent_id);
      return;
    }
    const item = scopedItems.find((candidate) => candidate.id === entryId);
    if (item) {
      setCurrentFolderId(item.bin_id);
    }
  }

  function toggleFolder(folderId: string) {
    setCurrentFolderId(folderId);
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function newMediaFolder(parentId: string | null) {
    const siblingNames = new Set(
      mediaFolders
        .filter((folder) => folder.parent_id === parentId)
        .map((folder) => folder.name.toLocaleLowerCase()),
    );
    let name = "新建媒体箱";
    let suffix = 2;
    while (siblingNames.has(name.toLocaleLowerCase())) {
      name = `新建媒体箱 ${suffix}`;
      suffix += 1;
    }
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    return {
      id: `media-bin:${random}`,
      name,
      parent_id: parentId,
      color: defaultMediaBinFolderColor,
      hidden: false,
    };
  }

  function createFolder(parentId: string | null = currentFolderId) {
    if (isReadOnly || isBusy || !rootFolderAvailable) {
      return;
    }
    const folder = newMediaFolder(parentId);
    mediaFolderAdded(folder);
    if (parentId && parentId !== rootFolderId) {
      setExpandedFolderIds((current) => new Set(current).add(parentId));
    }
    selectOnly(folder.id);
    setRenamingFolderId(folder.id);
    messagePublished(`已新建媒体箱“${folder.name}”`);
  }

  function moveItemsToFolder(itemIds: string[], folderId: string | null) {
    if (isReadOnly || isBusy || itemIds.length === 0) {
      return;
    }
    mediaItemsMovedToFolder(itemIds, folderId);
    const folderName = folderId
      ? mediaFolders.find((folder) => folder.id === folderId)?.name
      : "项目媒体";
    messagePublished(`已将 ${itemIds.length} 个媒体移到“${folderName ?? "项目媒体"}”`);
  }

  function moveEntriesToFolder(itemIds: string[], folderIds: string[], folderId: string | null) {
    if (isReadOnly || isBusy || (itemIds.length === 0 && folderIds.length === 0)) {
      return;
    }
    if (folderId && mediaFolderAndDescendantIds(mediaFolders, folderIds).has(folderId)) {
      messagePublished("不能将媒体箱移动到自身或其子媒体箱中");
      return;
    }
    mediaEntriesMovedToFolder(itemIds, folderIds, folderId);
    if (folderId && folderId !== rootFolderId) {
      setExpandedFolderIds((current) => new Set(current).add(folderId));
    }
    setCurrentFolderId(folderId);
    const folderName = folderId
      ? mediaFolders.find((folder) => folder.id === folderId)?.name
      : "项目媒体";
    messagePublished(
      `已将 ${itemIds.length + folderIds.length} 个项目条目移到“${folderName ?? "项目媒体"}”`,
    );
  }

  async function bindItemsToVideo(itemIds: string[], videoId: string) {
    const targetVideo = mediaItems.find((item) => item.id === videoId && item.kind === "video");
    const targetProject = targetVideo
      ? mediaItemProject(targetVideo, projects, mediaItems)
      : undefined;
    if (isReadOnly || isBusy || !targetVideo || !targetProject) {
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
        item.kind === "subtitle" &&
        !isVirtualMediaItem(item) &&
        (!item.subtitle_track_id || item.bound_to_video_id !== videoId),
    );
    const directItems = selectedItemsToBind.filter(
      (item) => item.kind === "audio" || !subtitlesToParse.includes(item),
    );

    if (subtitlesToParse.length > 0) {
      const taskId = createFfmpegTaskId("media-bin-bind");
      let cancelled = false;
      const task = await createTaskProgress({
        operation: "media_bin_bind",
        label: `解析并绑定 ${subtitlesToParse.length} 个字幕`,
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
          assetId: targetProject.asset.id,
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
    const targetName = targetVideo.file_name;
    messagePublished(`已将 ${selectedItemsToBind.length} 个媒体绑定到 ${targetName}`);
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
    messagePublished(`已解除 ${boundItemIds.length} 个媒体的绑定`);
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
    if (isReadOnly || !rootFolderAvailable) {
      return;
    }
    const itemIds = readDraggedMediaIds(event);
    if (itemIds.length === 0) {
      return;
    }
    event.preventDefault();
    markMediaDragHandled();
    moveItemsToFolder(itemIds, rootFolderId);
  }

  async function demuxSelectedVideo() {
    if (isReadOnly) {
      return;
    }
    const video = selectedDemuxVideo;
    const videoProject = video ? mediaItemProject(video, projects, mediaItems) : undefined;
    if (!video || !videoProject || isMediaVideoDetached(video, detachedVideoIds)) {
      return;
    }
    const taskId = createFfmpegTaskId("media-bin-demux");
    let cancelled = false;
    const task = await createTaskProgress({
      operation: "media_bin_demux",
      label: `分解 ${video.file_name}`,
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
        assetId: videoProject.asset.id,
        taskId,
      });
      mediaDemuxed(video.id, result);
      task.update({ current: 1 });
      task.remove();
      messagePublished(
        `已创建 ${result.audio_tracks.length} 条虚拟音轨和 ${result.subtitle_tracks.length} 条虚拟字幕`,
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
    if (isReadOnly || selectedIds.size === 0) {
      return;
    }
    if (isTauriRuntime()) {
      const removedIds = new Set(selectedItems.map((item) => item.id));
      const remainingItems = mediaItems.filter((item) => !removedIds.has(item.id));
      const projectIdsToClose = new Set(
        selectedItems
          .filter((item) => item.origin === "imported" && item.kind !== "subtitle")
          .map((item) => mediaItemProject(item, projects, mediaItems)?.asset.id)
          .filter((projectId): projectId is string => Boolean(projectId))
          .filter(
            (projectId) =>
              !remainingItems.some(
                (item) => item.id === projectId || item.source_video_id === projectId,
              ),
          ),
      );
      await Promise.all(
        Array.from(projectIdsToClose).map((assetId) =>
          invoke("close_project", { assetId }).catch(() => false),
        ),
      );
    }
    mediaBinEntriesRemoved(
      selectedFolders.map((folder) => folder.id),
      directlySelectedItems.map((item) => item.id),
    );
    clearSelection();
    messagePublished(`已从项目移除 ${selectedIds.size} 个项目条目`);
  }

  function previewVideo(videoId: string) {
    const video = mediaItems.find(
      (item) => item.id === videoId && item.kind === "video" && isMediaItemEnabled(item),
    );
    if (!video) {
      messagePublished("已禁用的媒体无法拖到源播放器预览");
      return;
    }
    activeVideoChanged(videoId);
    messagePublished(`源预览已切换到 ${video.file_name}`);
  }

  function clipboardFromSelection(): MediaBinClipboard {
    if (selectedIds.size === 0) {
      return { folders: [], items: [] };
    }
    return {
      folders: mediaFolders.filter((folder) => selectedFolderTreeIds.has(folder.id)),
      items: selectedItems.map((item) => {
        const projectId = mediaItemProject(item, projects, mediaItems)?.asset.id ?? null;
        return {
          ...item,
          source_video_id: item.source_video_id ?? projectId,
        };
      }),
    };
  }

  function copiedClipboardEntries(
    clipboard: MediaBinClipboard,
    destinationFolderId: string | null,
    duplicate: boolean,
    preserveSourceParents: boolean,
  ) {
    const folderIdMap = new Map(
      clipboard.folders.map((folder) => [folder.id, copiedMediaFolderId()]),
    );
    const itemIdMap = new Map(clipboard.items.map((item) => [item.id, copiedMediaItemId()]));
    const duplicateCounts = new Map<string, number>();
    const folders = clipboard.folders.map((folder) => ({
      ...folder,
      id: folderIdMap.get(folder.id)!,
      parent_id: folder.parent_id
        ? (folderIdMap.get(folder.parent_id) ??
          (preserveSourceParents ? folder.parent_id : destinationFolderId))
        : preserveSourceParents
          ? null
          : destinationFolderId,
      hidden: false,
    }));
    const items = clipboard.items.map((item) => ({
      ...item,
      id: itemIdMap.get(item.id)!,
      bin_id: item.bin_id
        ? (folderIdMap.get(item.bin_id) ??
          (preserveSourceParents ? item.bin_id : destinationFolderId))
        : preserveSourceParents
          ? null
          : destinationFolderId,
      file_name: duplicate ? duplicateFileName(item, mediaItems, duplicateCounts) : item.file_name,
      bound_to_video_id: item.bound_to_video_id
        ? (itemIdMap.get(item.bound_to_video_id) ??
          (preserveSourceParents ? item.bound_to_video_id : null))
        : null,
      hidden: false,
    }));
    const copiedSourceFolderIds = new Set(clipboard.folders.map((folder) => folder.id));
    const copiedSourceItemIds = new Set(clipboard.items.map((item) => item.id));
    const rootEntryIds = [
      ...clipboard.folders.flatMap((folder) =>
        !folder.parent_id || !copiedSourceFolderIds.has(folder.parent_id)
          ? [folderIdMap.get(folder.id)!]
          : [],
      ),
      ...clipboard.items.flatMap((item) =>
        (!item.bin_id || !copiedSourceFolderIds.has(item.bin_id)) &&
        (!item.bound_to_video_id || !copiedSourceItemIds.has(item.bound_to_video_id))
          ? [itemIdMap.get(item.id)!]
          : [],
      ),
    ];
    return { folders, items, rootEntryIds };
  }

  function copySelection() {
    const clipboard = clipboardFromSelection();
    const count = clipboard.folders.length + clipboard.items.length;
    if (count === 0) {
      return;
    }
    mediaBinClipboard = clipboard;
    setMediaBinClipboardItemCount(count);
    messagePublished(`已复制 ${count} 个项目条目`);
  }

  function pasteClipboard() {
    const clipboardCount = mediaBinClipboard.folders.length + mediaBinClipboard.items.length;
    if (isReadOnly || !rootFolderAvailable || clipboardCount === 0) {
      return;
    }
    const copies = copiedClipboardEntries(mediaBinClipboard, currentFolderId, false, false);
    mediaBinEntriesAdded(copies.folders, copies.items, `粘贴 ${clipboardCount} 个项目条目`);
    selectItems(copies.rootEntryIds);
    messagePublished(`已粘贴 ${clipboardCount} 个项目条目`);
  }

  function duplicateSelection() {
    if (isReadOnly) {
      return;
    }
    const clipboard = clipboardFromSelection();
    const count = clipboard.folders.length + clipboard.items.length;
    if (count === 0) {
      return;
    }
    const copies = copiedClipboardEntries(clipboard, currentFolderId, true, true);
    mediaBinEntriesAdded(copies.folders, copies.items, `重复 ${count} 个项目条目`);
    selectItems(copies.rootEntryIds);
    messagePublished(`已重复 ${count} 个项目条目`);
  }

  function createFolderFromSelection() {
    if (isReadOnly || isBusy || !rootFolderAvailable || selectedIds.size === 0) {
      return;
    }
    const clipboard = clipboardFromSelection();
    const copiedCount = clipboard.folders.length + clipboard.items.length;
    if (copiedCount === 0) {
      return;
    }
    const folder = newMediaFolder(currentFolderId);
    const copies = copiedClipboardEntries(clipboard, folder.id, false, false);
    mediaBinEntriesAdded(
      [folder, ...copies.folders],
      copies.items,
      `通过选择项新建媒体箱：${folder.name}`,
    );
    if (currentFolderId && currentFolderId !== rootFolderId) {
      setExpandedFolderIds((current) => new Set(current).add(currentFolderId));
    }
    setExpandedFolderIds((current) => new Set(current).add(folder.id));
    selectOnly(folder.id);
    setRenamingFolderId(folder.id);
    messagePublished(`已复制所选内容并创建媒体箱“${folder.name}”`);
  }

  useAppEvent("media:copy", ({ instanceId }) => {
    if (instanceId === panelInstanceId) {
      copySelection();
    }
  });
  useAppEvent("media:paste", ({ instanceId }) => {
    if (instanceId === panelInstanceId) {
      pasteClipboard();
    }
  });
  useAppEvent("media:clear", ({ instanceId }) => {
    if (instanceId === panelInstanceId) {
      void removeSelection();
    }
  });
  useAppEvent("media:duplicate", ({ instanceId }) => {
    if (instanceId === panelInstanceId) {
      duplicateSelection();
    }
  });
  useAppEvent("media:select-all", ({ instanceId }) => {
    if (instanceId === panelInstanceId) {
      selectItems(rows.map((row) => (row.type === "item" ? row.item.id : row.folder.id)));
    }
  });
  useAppEvent("media:clear-selection", ({ instanceId }) => {
    if (instanceId === panelInstanceId) {
      clearSelection();
    }
  });

  function setSelectionEnabled(enabled: boolean) {
    if (isReadOnly || selectedItems.length === 0) {
      return;
    }
    mediaItemsEnabledChanged(
      selectedItems.map((item) => item.id),
      enabled,
    );
  }

  function setItemsHidden(itemIds: string[], hidden: boolean) {
    if (isReadOnly || itemIds.length === 0) {
      return;
    }
    mediaItemsHiddenChanged(itemIds, hidden);
    if (hidden && !showHidden) {
      const hiddenIds = new Set(itemIds);
      selectItems(Array.from(selectedIds).filter((itemId) => !hiddenIds.has(itemId)));
    }
  }

  function setSelectionHidden(hidden: boolean) {
    if (isReadOnly || selectedIds.size === 0) {
      return;
    }
    mediaItemsHiddenChanged(
      directlySelectedItems.map((item) => item.id),
      hidden,
    );
    mediaFoldersHiddenChanged(
      selectedFolders.map((folder) => folder.id),
      hidden,
    );
    if (hidden && !showHidden) {
      clearSelection();
    }
  }

  async function restoreBackendWorkspace() {
    if (!isTauriRuntime()) {
      return;
    }
    await invoke("sync_project_workspace", { workspace: getProjectWorkspaceSnapshot() }).catch(
      () => undefined,
    );
  }

  async function relinkMediaItem(item: MediaBinItem, path: string, historyLabel: string) {
    const currentProject = mediaItemProject(item, projects, mediaItems);
    if (!currentProject) {
      mediaItemRelinked(item.id, path, null, historyLabel);
      messagePublished(`已重新链接 ${item.file_name}`);
      return true;
    }
    if (!isTauriRuntime()) {
      messagePublished("浏览器预览不能重新链接本地媒体，请运行 Tauri 桌面应用。");
      return false;
    }

    const outcome = await runMediaImportTask({
      path,
      operation: "media_relink",
      taskIdPrefix: "media-relink",
      assetId: currentProject.asset.id,
      label: `重新链接 ${item.file_name}`,
    });
    if (outcome.status !== "success") {
      if (outcome.status === "failed") {
        messagePublished(outcome.error);
      }
      return false;
    }

    const linkedKind = outcome.result.project.asset.video_stream_index !== null ? "video" : "audio";
    if (linkedKind !== item.kind) {
      await restoreBackendWorkspace();
      messagePublished(
        `${item.file_name} 需要${item.kind === "video" ? "视频" : "音频"}文件，所选文件类型不匹配。`,
      );
      return false;
    }

    mediaItemRelinked(item.id, path, outcome.result.project, historyLabel);
    warningsAppended(outcome.result.warnings);
    messagePublished(`已重新链接 ${item.file_name}`);
    return true;
  }

  async function attachLinkedFile(candidate: MediaLinkCandidate, path: string) {
    const item = mediaItems.find((current) => current.id === candidate.id);
    if (!item || !linkDialog) {
      return false;
    }
    if (linkDialog.mode === "proxy") {
      mediaProxyPathChanged(item.id, path);
      messagePublished(`已为 ${item.file_name} 连接代理`);
      return true;
    }
    return relinkMediaItem(
      item,
      path,
      linkDialog.mode === "full-resolution" ? "重新连接完整分辨率媒体" : "链接媒体",
    );
  }

  function openLinkDialog(mode: MediaLinkMode, items: MediaBinItem[]) {
    if (items.length === 0) {
      return;
    }
    setContextMenu(null);
    setLinkDialog({ mode, itemIds: items.map((item) => item.id) });
  }

  async function replaceSelectedMedia() {
    const item = selectedFileItems.length === 1 ? selectedFileItems[0] : null;
    setContextMenu(null);
    if (!item || isMediaItemOffline(item) || !isTauriRuntime()) {
      if (!isTauriRuntime()) {
        messagePublished("请在 Tauri 桌面窗口中替换本地素材。");
      }
      return;
    }
    try {
      const picked = await openDialog({ multiple: false, title: `替换素材：${item.file_name}` });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) {
        await relinkMediaItem(item, path, "替换素材");
      }
    } catch (error) {
      messagePublished(error instanceof Error ? error.message : String(error));
    }
  }

  function makeSelectedMediaOffline() {
    if (selectedOnlineItems.length === 0) {
      return;
    }
    mediaItemsOfflineChanged(
      selectedOnlineItems.map((item) => item.id),
      true,
    );
    messagePublished(`已将 ${selectedOnlineItems.length} 个媒体设为脱机`);
    setContextMenu(null);
  }

  function createProxyForSelection() {
    const video = selectedProjectVideos.length === 1 ? selectedProjectVideos[0] : null;
    if (!video || selectedItems.length !== 1 || isMediaItemOffline(video)) {
      return;
    }
    activeVideoChanged(video.id);
    proxyDialogOpened();
    setContextMenu(null);
  }

  function detachSelectedProxies() {
    for (const video of selectedVideosWithProxy) {
      mediaProxyPathChanged(video.id, null);
    }
    if (selectedVideosWithProxy.length > 0) {
      messagePublished(`已分离 ${selectedVideosWithProxy.length} 个代理`);
    }
    setContextMenu(null);
  }

  async function revealSelectedProxy() {
    const proxyPath = selectedVideosWithProxy
      .map((video) => mediaItemProject(video, projects, mediaItems)?.proxy_path)
      .find((path): path is string => Boolean(path));
    setContextMenu(null);
    if (!proxyPath) {
      return;
    }
    try {
      await invoke("reveal_in_file_manager", { path: proxyPath });
    } catch (error) {
      messagePublished(error instanceof Error ? error.message : String(error));
    }
  }

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const itemElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-media-item-id]",
    );
    const folderElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-media-folder-id]",
    );
    const itemId = itemElement?.dataset.mediaItemId ?? null;
    const folderId = itemId ? null : (folderElement?.dataset.mediaFolderId ?? null);
    const entryId = itemId ?? folderId;
    if (entryId && !selectedIds.has(entryId)) {
      selectOnly(entryId);
    }
    if (entryId) {
      focusMediaBinEntry(entryId);
    }
    panelRef.current?.focus({ preventScroll: true });
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      itemId,
      folderId,
      bindingSubmenuOpen: false,
      proxySubmenuOpen: false,
      moveSubmenuOpen: false,
    });
  }

  return (
    <>
      <section ref={panelRef} className="media-bin-panel" tabIndex={-1}>
        <div className="media-bin-project-row">
          <PanelTopOpen aria-hidden="true" />
          <span>{rootFolder ? `媒体箱：${rootFolder.name}` : "项目媒体"}</span>
        </div>

        <div className="media-bin-search-row">
          <label className="media-bin-search">
            <Search aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索媒体"
              aria-label="搜索媒体"
            />
          </label>
          <span>
            {selectedIds.size} 项已选择，共 {scopedItems.length + scopedFolders.length} 项
          </span>
        </div>

        <div
          className={`media-bin-content ${viewMode}-view ${isBinding ? "is-binding" : ""}`}
          style={contentStyle}
          onContextMenu={openContextMenu}
          onPointerDown={(event) => {
            if (!isEditableTarget(event.target)) {
              panelRef.current?.focus({ preventScroll: true });
            }
          }}
          onDragOver={handleContentDragOver}
          onDrop={handleContentDrop}
        >
          <MediaBinTable
            rows={rows}
            hasItems={scopedItems.length > 0 || scopedFolders.length > 0}
            mediaItems={mediaItems}
            projects={projects}
            detachedVideoIds={detachedVideoIds}
            gridCardWidth={gridCardWidth}
            listIconScale={listIconScale}
            selectedIds={selectedIds}
            expandedFolderIds={expandedFolderIds}
            defaultFolderId={rootFolderId}
            renamingFolderId={renamingFolderId}
            viewMode={viewMode}
            isReadOnly={isReadOnly}
            canImport={!isReadOnly && !isBusy && rootFolderAvailable && panelActive}
            onSelectOnly={selectOnly}
            onToggleSelected={toggleSelected}
            onSelectItems={selectItems}
            onEntryFocused={focusMediaBinEntry}
            onToggleFolder={toggleFolder}
            onOpenFolder={(folderId) => onOpenFolder?.(folderId)}
            onRenameFolder={mediaFolderRenamed}
            onFinishRenameFolder={() => setRenamingFolderId(null)}
            onMoveEntriesToFolder={moveEntriesToFolder}
            onRenameItem={mediaItemRenamed}
            onSetItemsEnabled={(itemIds, enabled) => mediaItemsEnabledChanged(itemIds, enabled)}
            onSetItemsHidden={setItemsHidden}
            onSetFoldersHidden={(folderIds, hidden) => {
              mediaFoldersHiddenChanged(folderIds, hidden);
              if (hidden && !showHidden) {
                const hiddenIds = new Set(folderIds);
                selectItems(Array.from(selectedIds).filter((entryId) => !hiddenIds.has(entryId)));
              }
            }}
            onPreviewVideo={previewVideo}
            onBindItems={bindItemsToVideo}
            onImportPaths={(paths) =>
              emitAppEvent("media:import", {
                paths,
                folderId: currentFolderId ?? undefined,
              })
            }
          />
        </div>

        <footer className="media-bin-footer">
          <div className="media-bin-view-tools">
            <button
              type="button"
              className={isReadOnly ? "media-bin-lock" : "media-bin-pen"}
              title={isReadOnly ? "解除项目只读" : "将项目设为只读"}
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
            <div className="media-bin-bind-wrap">
              <button
                type="button"
                className={!bindingActionIsUnbind && bindingPopoverOpen ? "active" : ""}
                onClick={() => {
                  if (bindingActionIsUnbind) {
                    setBindingPopoverOpen(false);
                    unbindItems(selectedAuxiliary.map((item) => item.id));
                    return;
                  }
                  setBindingPopoverOpen(true);
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
            </div>
            <button
              type="button"
              onClick={() => void demuxSelectedVideo()}
              disabled={isReadOnly || !canDemuxSelectedVideo || isBusy}
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
              onClick={() => createFolder()}
              disabled={isReadOnly || isBusy || !rootFolderAvailable}
              title="新建媒体箱"
            >
              <FolderPlus aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                emitAppEvent("media:import", {
                  folderId: currentFolderId ?? undefined,
                })
              }
              disabled={isReadOnly || isBusy || !rootFolderAvailable}
              title="导入媒体（视频、音频或字幕）"
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
              disabled={isReadOnly || selectedIds.size === 0 || isBusy}
              title="移除所选项目条目"
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        </footer>

        {!bindingActionIsUnbind &&
          bindingPopoverOpen &&
          createPortal(
            <ModalDialog
              title="绑定媒体"
              bodyClassName="media-bin-bind-dialog-body"
              confirmLabel={isBinding ? "绑定中..." : "绑定"}
              confirmDisabled={isReadOnly || !canBind || isBusy}
              onCancel={() => setBindingPopoverOpen(false)}
              onConfirm={() => void bindSelectedItems()}
            >
              <div className="media-bin-bind-dialog-intro">
                <Link2 aria-hidden="true" />
                <div>
                  <strong>关联所选媒体与目标视频</strong>
                  <span>绑定后，音频和字幕会归入目标视频，方便集中预览和导出。</span>
                </div>
              </div>
              <div className="media-bin-bind-dialog-field">
                <span className="media-bin-bind-dialog-label">已选媒体：</span>
                <div className="media-bin-bind-dialog-value">
                  <strong>
                    {selectedAuxiliary.length} 个媒体（{selectedAuxiliaryTypeSummary}）
                  </strong>
                  <span title={selectedAuxiliaryNames}>{selectedAuxiliaryNames}</span>
                </div>
              </div>
              <label className="media-bin-bind-dialog-field">
                <span className="media-bin-bind-dialog-label">目标视频：</span>
                <div className="media-bin-bind-dialog-target">
                  <SelectDropdown
                    className="media-bin-bind-dialog-select"
                    menuClassName="media-bin-bind-dialog-select-menu"
                    ariaLabel="目标视频"
                    value={selectedBindingVideoId}
                    items={bindingVideoItems}
                    disabled={selectedVideos.length === 1}
                    onChange={setBindingVideoId}
                  />
                  <small>
                    {selectedVideos.length === 1
                      ? "已选视频将自动作为绑定目标"
                      : `可从项目中的 ${videos.length} 个视频里选择目标`}
                  </small>
                </div>
              </label>
            </ModalDialog>,
            document.querySelector(".app-shell") ?? document.body,
          )}
      </section>
      {linkDialog &&
        linkDialogCandidates.length > 0 &&
        createPortal(
          <MediaLinkDialog
            candidates={linkDialogCandidates}
            mode={linkDialog.mode}
            onAttach={attachLinkedFile}
            onCancel={() => setLinkDialog(null)}
            onError={messagePublished}
          />,
          document.querySelector(".app-shell") ?? document.body,
        )}
      {contextMenu &&
        createPortal(
          <PopupMenu
            className="media-bin-context-menu"
            contextMenuAnchor={contextMenu}
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {contextMenu.folderId || contextMenu.itemId ? (
              <>
                <PopupMenuItem
                  onSelect={() => {
                    copySelection();
                    setContextMenu(null);
                  }}
                  disabled={selectedIds.size === 0}
                >
                  复制
                </PopupMenuItem>
                <PopupMenuItem
                  onSelect={() => {
                    pasteClipboard();
                    setContextMenu(null);
                  }}
                  disabled={
                    isReadOnly ||
                    mediaBinClipboard.folders.length + mediaBinClipboard.items.length === 0
                  }
                >
                  粘贴
                </PopupMenuItem>
                <PopupMenuItem
                  onSelect={() => {
                    void removeSelection();
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || selectedIds.size === 0 || isBusy}
                >
                  清除
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  onSelect={() => {
                    duplicateSelection();
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || selectedIds.size === 0}
                >
                  复制
                </PopupMenuItem>
                {contextMenu.folderId && selectedIds.size === 1 && (
                  <PopupMenuItem
                    onSelect={() => {
                      setRenamingFolderId(contextMenu.folderId);
                      setContextMenu(null);
                    }}
                    disabled={isReadOnly}
                  >
                    重命名
                  </PopupMenuItem>
                )}
                <PopupMenuSeparator />
                <PopupMenuSubmenu
                  label="移动到素材箱"
                  open={contextMenu.moveSubmenuOpen}
                  menuClassName="media-bin-context-menu"
                  onOpenChange={(open) =>
                    setContextMenu((current) =>
                      current
                        ? {
                            ...current,
                            moveSubmenuOpen: open,
                            bindingSubmenuOpen: false,
                            proxySubmenuOpen: false,
                          }
                        : current,
                    )
                  }
                  disabled={isReadOnly || selectedIds.size === 0 || isBusy}
                >
                  <PopupMenuItem
                    onSelect={() => {
                      moveEntriesToFolder(
                        directlySelectedItems.map((item) => item.id),
                        selectedFolders.map((folder) => folder.id),
                        null,
                      );
                      setContextMenu(null);
                    }}
                    disabled={
                      directlySelectedItems.every((item) => item.bin_id === null) &&
                      selectedFolders.every((folder) => folder.parent_id === null)
                    }
                  >
                    项目媒体（根目录）
                  </PopupMenuItem>
                  {mediaFolders
                    .filter((folder) => !selectedFolderTreeIds.has(folder.id))
                    .map((folder) => (
                      <PopupMenuItem
                        key={folder.id}
                        onSelect={() => {
                          moveEntriesToFolder(
                            directlySelectedItems.map((item) => item.id),
                            selectedFolders.map((item) => item.id),
                            folder.id,
                          );
                          setContextMenu(null);
                        }}
                        disabled={
                          directlySelectedItems.every((item) => item.bin_id === folder.id) &&
                          selectedFolders.every((item) => item.parent_id === folder.id)
                        }
                      >
                        {folder.name}
                      </PopupMenuItem>
                    ))}
                </PopupMenuSubmenu>
                <PopupMenuSeparator />
                {bindingActionIsUnbind ? (
                  <PopupMenuItem
                    onSelect={() => {
                      setBindingPopoverOpen(false);
                      unbindItems(selectedAuxiliary.map((item) => item.id));
                      setContextMenu(null);
                    }}
                    disabled={isReadOnly || !canManageBinding || isBusy}
                  >
                    解除绑定
                  </PopupMenuItem>
                ) : (
                  <PopupMenuSubmenu
                    label="绑定媒体"
                    open={contextMenu.bindingSubmenuOpen}
                    menuClassName="media-bin-context-menu"
                    onOpenChange={(open) =>
                      setContextMenu((current) =>
                        current
                          ? {
                              ...current,
                              bindingSubmenuOpen: open,
                              proxySubmenuOpen: open ? false : current.proxySubmenuOpen,
                              moveSubmenuOpen: open ? false : current.moveSubmenuOpen,
                            }
                          : current,
                      )
                    }
                    disabled={isReadOnly || !canManageBinding || isBusy}
                  >
                    {(selectedVideos.length === 1 ? selectedVideos : videos).map((video) => (
                      <PopupMenuItem
                        key={video.id}
                        onSelect={() => {
                          setBindingVideoId(video.id);
                          void bindItemsToVideo(
                            selectedAuxiliary.map((item) => item.id),
                            video.id,
                          );
                          setContextMenu(null);
                        }}
                        disabled={isReadOnly || isBusy}
                      >
                        {video.file_name}
                      </PopupMenuItem>
                    ))}
                  </PopupMenuSubmenu>
                )}
                <PopupMenuItem
                  onSelect={() => {
                    void demuxSelectedVideo();
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || !canDemuxSelectedVideo || isBusy}
                >
                  分解音轨和字幕
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  checked={selectedItems.every(isMediaItemEnabled)}
                  onSelect={() => {
                    setSelectionEnabled(!selectedItems.every(isMediaItemEnabled));
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || selectedItems.length === 0}
                >
                  启用
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  onSelect={() => {
                    setSelectionHidden(true);
                    setContextMenu(null);
                  }}
                  disabled={
                    isReadOnly ||
                    selectedIds.size === 0 ||
                    (directlySelectedItems.every(isMediaItemHidden) &&
                      selectedFolders.every((folder) => folder.hidden === true))
                  }
                >
                  隐藏
                </PopupMenuItem>
                <PopupMenuItem
                  checked={showHidden}
                  onSelect={() => {
                    setShowHidden(!showHidden);
                    setContextMenu(null);
                  }}
                >
                  查看隐藏内容
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  onSelect={() => {
                    createFolder();
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || isBusy || !rootFolderAvailable}
                >
                  新建素材箱
                </PopupMenuItem>
                <PopupMenuItem
                  onSelect={() => {
                    createFolderFromSelection();
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || isBusy || !rootFolderAvailable || selectedIds.size === 0}
                >
                  通过选择项新建素材箱
                </PopupMenuItem>
                <PopupMenuItem
                  onSelect={() => {
                    emitAppEvent("media:import", {
                      folderId: contextMenu.folderId ?? currentFolderId ?? undefined,
                    });
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || isBusy || !rootFolderAvailable}
                >
                  导入...
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  onSelect={() => void replaceSelectedMedia()}
                  disabled={
                    isReadOnly ||
                    isBusy ||
                    selectedFileItems.length !== 1 ||
                    isMediaItemOffline(selectedFileItems[0])
                  }
                >
                  替换素材...
                </PopupMenuItem>
                <PopupMenuItem
                  onSelect={() => openLinkDialog("media", selectedOfflineItems)}
                  disabled={isReadOnly || isBusy || selectedOfflineItems.length === 0}
                >
                  链接媒体...
                </PopupMenuItem>
                <PopupMenuItem
                  onSelect={makeSelectedMediaOffline}
                  disabled={isReadOnly || isBusy || selectedOnlineItems.length === 0}
                >
                  设为脱机...
                </PopupMenuItem>
                <PopupMenuItem mnemonic="O" disabled>
                  脱机编辑(O)...
                </PopupMenuItem>
                <PopupMenuSubmenu
                  label="代理"
                  open={contextMenu.proxySubmenuOpen}
                  menuClassName="media-bin-context-menu media-bin-proxy-context-menu"
                  onOpenChange={(open) =>
                    setContextMenu((current) =>
                      current
                        ? {
                            ...current,
                            proxySubmenuOpen: open,
                            bindingSubmenuOpen: open ? false : current.bindingSubmenuOpen,
                            moveSubmenuOpen: open ? false : current.moveSubmenuOpen,
                          }
                        : current,
                    )
                  }
                  disabled={selectedProjectVideos.length === 0}
                >
                  <PopupMenuItem
                    onSelect={createProxyForSelection}
                    disabled={
                      isReadOnly ||
                      isBusy ||
                      isGeneratingProxy ||
                      selectedItems.length !== 1 ||
                      selectedProjectVideos.length !== 1 ||
                      isMediaItemOffline(selectedProjectVideos[0])
                    }
                  >
                    创建代理...
                  </PopupMenuItem>
                  <PopupMenuItem
                    onSelect={() => openLinkDialog("proxy", selectedProjectVideos)}
                    disabled={isReadOnly || isBusy || selectedProjectVideos.length === 0}
                  >
                    连接代理...
                  </PopupMenuItem>
                  <PopupMenuItem
                    onSelect={detachSelectedProxies}
                    disabled={isReadOnly || isBusy || selectedVideosWithProxy.length === 0}
                  >
                    分离代理
                  </PopupMenuItem>
                  <PopupMenuItem
                    onSelect={() => void revealSelectedProxy()}
                    disabled={selectedVideosWithProxy.length === 0}
                  >
                    在资源管理器中显示
                  </PopupMenuItem>
                  <PopupMenuItem
                    onSelect={() => openLinkDialog("full-resolution", selectedOfflineProjectVideos)}
                    disabled={isReadOnly || isBusy || selectedOfflineProjectVideos.length === 0}
                  >
                    重新连接完整分辨率媒体...
                  </PopupMenuItem>
                </PopupMenuSubmenu>
              </>
            ) : (
              <>
                <PopupMenuItem
                  onSelect={() => {
                    createFolder();
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || isBusy || !rootFolderAvailable}
                >
                  新建素材箱
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  onSelect={() => {
                    pasteClipboard();
                    setContextMenu(null);
                  }}
                  disabled={
                    isReadOnly ||
                    !rootFolderAvailable ||
                    mediaBinClipboard.folders.length + mediaBinClipboard.items.length === 0
                  }
                >
                  粘贴
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  onSelect={() => {
                    emitAppEvent("media:import", { folderId: currentFolderId ?? undefined });
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || isBusy || !rootFolderAvailable}
                >
                  导入
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  checked={showHidden}
                  onSelect={() => {
                    setShowHidden(!showHidden);
                    setContextMenu(null);
                  }}
                >
                  查看隐藏内容
                </PopupMenuItem>
                <PopupMenuSeparator />
                <PopupMenuItem
                  checked={allItemsEnabled}
                  onSelect={() => {
                    mediaItemsEnabledChanged(
                      scopedItems.map((item) => item.id),
                      !allItemsEnabled,
                    );
                    setContextMenu(null);
                  }}
                  disabled={isReadOnly || scopedItems.length === 0}
                >
                  全部启用
                </PopupMenuItem>
              </>
            )}
          </PopupMenu>,
          document.body,
        )}
    </>
  );
}
