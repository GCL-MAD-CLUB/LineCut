import { open as openDialog, type DialogFilter } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { invokeCommand, runOperation } from "../../errors";
import { createFfmpegTaskId } from "../../platform/tauri/ffmpegProgress";
import { formatMonitorTime } from "../../core/editor/time";
import type { MediaBinItemKind } from "../../types";
import { MediaBrowserDialog } from "../MediaBrowserDialog";
import { ModalDialog } from "../ModalDialog";
import "./MediaLinkDialog.css";

export type MediaLinkMode = "media" | "proxy" | "full-resolution";

export interface MediaLinkCandidate {
  id: string;
  clipName: string;
  filePath: string;
  kind: MediaBinItemKind;
  mediaStartUs: number;
  tapeName?: string;
}

interface MediaLinkDialogProps {
  candidates: MediaLinkCandidate[];
  mode: MediaLinkMode;
  onAttach: (candidate: MediaLinkCandidate, path: string) => Promise<boolean>;
  onCancel: () => void;
}

interface MediaLinkFile {
  path: string;
  file_name: string;
}

interface MediaLinkFileMetadata {
  path: string;
  start_time_us: number;
  tape_name: string | null;
  has_video: boolean;
  has_audio: boolean;
}

interface MatchOptions {
  fileName: boolean;
  extension: boolean;
  mediaStart: boolean;
  tapeName: boolean;
}

const videoExtensions = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "mts", "m2ts"];
const audioExtensions = ["wav", "mp3", "aac", "flac", "m4a", "ogg", "opus"];
const subtitleExtensions = ["srt", "ass", "ssa", "vtt"];
const allMediaExtensions = Array.from(
  new Set([...videoExtensions, ...audioExtensions, ...subtitleExtensions]),
);
const MEDIA_START_TOLERANCE_US = 1_000;

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function fileExtension(path: string) {
  const name = fileName(path);
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLocaleLowerCase();
}

function fileStem(path: string) {
  const name = fileName(path);
  const separator = name.lastIndexOf(".");
  return separator < 0 ? name : name.slice(0, separator);
}

function normalizedText(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function pathKey(path: string) {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

function directoryName(path: string) {
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return separator < 0 ? "" : path.slice(0, separator);
}

function titleForMode(mode: MediaLinkMode) {
  if (mode === "proxy") return "连接代理";
  if (mode === "full-resolution") return "重新连接完整分辨率媒体";
  return "链接媒体";
}

function introForMode(mode: MediaLinkMode) {
  if (mode === "proxy") return "为以下剪辑连接代理：";
  if (mode === "full-resolution") return "为以下剪辑重新连接完整分辨率媒体：";
  return "为以下剪辑链接媒体：";
}

function browserTitleForMode(mode: MediaLinkMode, candidate: MediaLinkCandidate) {
  if (mode === "proxy") return `将代理连接到 ${candidate.clipName}`;
  if (mode === "full-resolution") return `将完整分辨率媒体连接到 ${candidate.clipName}`;
  return `将媒体链接到 ${candidate.clipName}`;
}

function dialogFilters(candidate: MediaLinkCandidate, mode: MediaLinkMode): DialogFilter[] {
  if (mode === "proxy" || candidate.kind === "video") {
    return [{ name: mode === "proxy" ? "代理媒体" : "视频", extensions: videoExtensions }];
  }
  if (candidate.kind === "audio") {
    return [{ name: "音频", extensions: audioExtensions }];
  }
  return [{ name: "字幕", extensions: subtitleExtensions }];
}

function extensionsForCandidate(candidate: MediaLinkCandidate, mode: MediaLinkMode) {
  if (mode === "proxy" || candidate.kind === "video") {
    return videoExtensions;
  }
  if (candidate.kind === "audio") {
    return audioExtensions;
  }
  return subtitleExtensions;
}

function fileMatchesCandidate(
  file: MediaLinkFile,
  metadata: MediaLinkFileMetadata | undefined,
  candidate: MediaLinkCandidate,
  mode: MediaLinkMode,
  options: MatchOptions,
) {
  if (!extensionsForCandidate(candidate, mode).includes(fileExtension(file.path))) {
    return false;
  }
  if (
    options.fileName &&
    normalizedText(fileStem(file.path)) !== normalizedText(fileStem(candidate.filePath))
  ) {
    return false;
  }
  if (
    options.extension &&
    normalizedText(fileExtension(file.path)) !== normalizedText(fileExtension(candidate.filePath))
  ) {
    return false;
  }

  if (candidate.kind === "subtitle" && mode !== "proxy") {
    return (
      (!options.mediaStart || Math.abs(candidate.mediaStartUs) <= MEDIA_START_TOLERANCE_US) &&
      (!options.tapeName || normalizedText(candidate.tapeName) === "")
    );
  }
  if ((options.mediaStart || options.tapeName) && !metadata) {
    return false;
  }
  if (
    metadata &&
    (mode === "proxy" || candidate.kind === "video" ? !metadata.has_video : !metadata.has_audio)
  ) {
    return false;
  }
  if (
    options.mediaStart &&
    Math.abs((metadata?.start_time_us ?? 0) - candidate.mediaStartUs) > MEDIA_START_TOLERANCE_US
  ) {
    return false;
  }
  return (
    !options.tapeName || normalizedText(metadata?.tape_name) === normalizedText(candidate.tapeName)
  );
}

export function MediaLinkDialog({ candidates, mode, onAttach, onCancel }: MediaLinkDialogProps) {
  const candidateKey = useMemo(
    () => `${mode}:${candidates.map((candidate) => candidate.id).join("\u0000")}`,
    [candidates, mode],
  );
  const [currentId, setCurrentId] = useState(candidates[0]?.id ?? "");
  const [processedIds, setProcessedIds] = useState<Set<string>>(() => new Set());
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [matchFileName, setMatchFileName] = useState(true);
  const [matchExtension, setMatchExtension] = useState(false);
  const [matchMediaStart, setMatchMediaStart] = useState(false);
  const [matchTapeName, setMatchTapeName] = useState(false);
  const [autoRelink, setAutoRelink] = useState(true);
  const [useMediaBrowser, setUseMediaBrowser] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mediaBrowserOpen, setMediaBrowserOpen] = useState(false);
  const [mediaBrowserDirectory, setMediaBrowserDirectory] = useState("");
  const [suggestedBrowserDirectory, setSuggestedBrowserDirectory] = useState("");
  const [suggestedBrowserPaths, setSuggestedBrowserPaths] = useState<string[]>([]);
  const suggestionRequestRef = useRef(0);

  useEffect(() => {
    setCurrentId(candidates[0]?.id ?? "");
    setProcessedIds(new Set());
    setSkippedIds(new Set());
    setBusy(false);
    setMediaBrowserOpen(false);
    setMediaBrowserDirectory("");
    setSuggestedBrowserDirectory("");
    setSuggestedBrowserPaths([]);
    suggestionRequestRef.current += 1;
  }, [candidateKey]);

  const current =
    candidates.find((candidate) => candidate.id === currentId) ??
    candidates.find(
      (candidate) => !processedIds.has(candidate.id) && !skippedIds.has(candidate.id),
    ) ??
    null;

  function nextCandidate(handledIds: Set<string>) {
    return candidates.find((candidate) => !handledIds.has(candidate.id)) ?? null;
  }

  function skipCurrent() {
    if (!current || busy) {
      return;
    }
    const skipped = new Set(skippedIds).add(current.id);
    const handled = new Set([...processedIds, ...skipped]);
    setSkippedIds(skipped);
    const next = nextCandidate(handled);
    if (next) {
      setCurrentId(next.id);
    } else {
      onCancel();
    }
  }

  async function filesInDirectory(directory: string, extensions = allMediaExtensions) {
    return invokeCommand<MediaLinkFile[]>("list_media_link_files", { directory, extensions });
  }

  function matchOptions(): MatchOptions {
    return {
      fileName: matchFileName,
      extension: matchExtension,
      mediaStart: matchMediaStart,
      tapeName: matchTapeName,
    };
  }

  async function matchingPathInDirectory(candidate: MediaLinkCandidate, directory: string) {
    const options = matchOptions();
    const files = await filesInDirectory(directory, extensionsForCandidate(candidate, mode));
    const structurallyMatchingFiles = files.filter((file) =>
      fileMatchesCandidate(file, undefined, candidate, mode, {
        ...options,
        mediaStart: false,
        tapeName: false,
      }),
    );
    if (!matchMediaStart && !matchTapeName) {
      return structurallyMatchingFiles.find((file) =>
        fileMatchesCandidate(file, undefined, candidate, mode, options),
      )?.path;
    }

    let metadataByPath = new Map<string, MediaLinkFileMetadata>();
    if (mode === "proxy" || candidate.kind !== "subtitle") {
      const metadata = await invokeCommand<MediaLinkFileMetadata[]>("probe_media_link_files", {
        paths: structurallyMatchingFiles.map((file) => file.path),
        taskId: createFfmpegTaskId("media-link-suggestion"),
      });
      metadataByPath = new Map(metadata.map((entry) => [pathKey(entry.path), entry]));
    }
    return structurallyMatchingFiles.find((file) =>
      fileMatchesCandidate(file, metadataByPath.get(pathKey(file.path)), candidate, mode, options),
    )?.path;
  }

  async function updateBrowserSuggestion(candidate: MediaLinkCandidate, directory: string) {
    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;
    setSuggestedBrowserDirectory(directory);
    setSuggestedBrowserPaths([]);
    if (
      !directory ||
      !(await invokeCommand<boolean>("path_is_directory", {
        path: directory,
      }))
    ) {
      return;
    }
    const outcome = await runOperation(
      "media.link",
      () => matchingPathInDirectory(candidate, directory),
      { displayName: directory, resourceKind: "media" },
    );
    if (suggestionRequestRef.current !== requestId) {
      return;
    }
    setSuggestedBrowserPaths(outcome.status === "success" && outcome.value ? [outcome.value] : []);
  }

  async function openMediaBrowser(candidate: MediaLinkCandidate) {
    const directory = mediaBrowserDirectory || directoryName(candidate.filePath);
    setBusy(true);
    await updateBrowserSuggestion(candidate, directory);
    setBusy(false);
    setMediaBrowserOpen(true);
  }

  async function automaticallyAttachOtherCandidates(
    selectedCandidate: MediaLinkCandidate,
    selectedPath: string,
    processed: Set<string>,
    skipped: Set<string>,
  ) {
    const directory = directoryName(selectedPath);
    const files = await filesInDirectory(directory);
    const remainingCandidates = candidates.filter(
      (candidate) =>
        candidate.id !== selectedCandidate.id &&
        !processed.has(candidate.id) &&
        !skipped.has(candidate.id),
    );
    const options = matchOptions();
    const structurallyMatchingFiles = files.filter((file) =>
      remainingCandidates.some((candidate) =>
        fileMatchesCandidate(file, undefined, candidate, mode, {
          ...options,
          mediaStart: false,
          tapeName: false,
        }),
      ),
    );
    let metadataByPath = new Map<string, MediaLinkFileMetadata>();
    if (matchMediaStart || matchTapeName) {
      const pathsToProbe = structurallyMatchingFiles
        .filter((file) =>
          remainingCandidates.some(
            (candidate) =>
              (mode === "proxy" || candidate.kind !== "subtitle") &&
              fileMatchesCandidate(file, undefined, candidate, mode, {
                ...options,
                mediaStart: false,
                tapeName: false,
              }),
          ),
        )
        .map((file) => file.path);
      const metadata = await invokeCommand<MediaLinkFileMetadata[]>("probe_media_link_files", {
        paths: pathsToProbe,
        taskId: createFfmpegTaskId("media-link-match"),
      });
      metadataByPath = new Map(metadata.map((entry) => [pathKey(entry.path), entry]));
    }

    const usedPaths = new Set([pathKey(selectedPath)]);
    for (const candidate of remainingCandidates) {
      const match = structurallyMatchingFiles.find(
        (file) =>
          !usedPaths.has(pathKey(file.path)) &&
          fileMatchesCandidate(
            file,
            metadataByPath.get(pathKey(file.path)),
            candidate,
            mode,
            options,
          ),
      );
      if (!match) {
        continue;
      }
      usedPaths.add(pathKey(match.path));
      if (await onAttach(candidate, match.path)) {
        processed.add(candidate.id);
      }
    }
  }

  async function attachPath(selectedCandidate: MediaLinkCandidate, path: string) {
    setMediaBrowserOpen(false);
    setBusy(true);
    const processed = new Set(processedIds);
    const skipped = new Set(skippedIds);
    const attachOutcome = await runOperation(
      "media.link",
      () => onAttach(selectedCandidate, path),
      { displayName: fileName(selectedCandidate.filePath), resourceKind: "media" },
    );
    if (attachOutcome.status !== "success" || !attachOutcome.value) {
      setBusy(false);
      return;
    }
    processed.add(selectedCandidate.id);

    if (autoRelink) {
      await runOperation(
        "media.link",
        () => automaticallyAttachOtherCandidates(selectedCandidate, path, processed, skipped),
        { displayName: directoryName(path), resourceKind: "media" },
      );
    }

    setProcessedIds(processed);
    const handled = new Set([...processed, ...skipped]);
    const next = nextCandidate(handled);
    if (next) {
      setCurrentId(next.id);
    } else {
      onCancel();
    }
    setBusy(false);
  }

  async function attachCurrent() {
    if (!current || busy) {
      return;
    }
    const selectedCandidate = current;
    if (useMediaBrowser) {
      await openMediaBrowser(selectedCandidate);
      return;
    }
    const outcome = await runOperation(
      "media.link",
      () =>
        openDialog({
          multiple: false,
          title: `选择 ${fileName(selectedCandidate.filePath)}`,
          filters: dialogFilters(selectedCandidate, mode),
        }),
      { displayName: fileName(selectedCandidate.filePath), resourceKind: "media" },
    );
    if (outcome.status !== "success") {
      return;
    }
    const path = Array.isArray(outcome.value) ? outcome.value[0] : outcome.value;
    if (path) {
      await attachPath(selectedCandidate, path);
    }
  }

  if (mediaBrowserOpen && current) {
    return (
      <MediaBrowserDialog
        title={browserTitleForMode(mode, current)}
        filters={dialogFilters(current, mode)}
        initialDirectory={mediaBrowserDirectory || directoryName(current.filePath)}
        selectionMode="single"
        suggestedPaths={suggestedBrowserPaths}
        onCancel={() => {
          suggestionRequestRef.current += 1;
          setMediaBrowserOpen(false);
        }}
        onDirectoryChange={(directory) => {
          setMediaBrowserDirectory(directory);
          if (pathKey(directory) !== pathKey(suggestedBrowserDirectory)) {
            void updateBrowserSuggestion(current, directory);
          }
        }}
        onConfirm={(paths) => {
          const path = paths[0];
          if (path) {
            void attachPath(current, path);
          }
        }}
      />
    );
  }

  return (
    <ModalDialog
      title={titleForMode(mode)}
      className="modal-dialog-large media-link-dialog"
      bodyClassName="media-link-dialog-body"
      onCancel={onCancel}
      onConfirm={() => void attachCurrent()}
      actions={
        <>
          <span className="media-link-dialog-status">
            已处理 {processedIds.size} 个剪辑，共 {candidates.length} 个
          </span>
          <button type="button" className="modal-dialog-cancel" onClick={onCancel} disabled={busy}>
            全部跳过
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={skipCurrent}
            disabled={!current || busy}
          >
            跳过
          </button>
          <button type="button" className="modal-dialog-cancel" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="modal-dialog-confirm"
            onClick={() => void attachCurrent()}
            disabled={!current || busy}
          >
            {busy ? "处理中..." : "附加"}
          </button>
        </>
      }
    >
      <p className="media-link-dialog-intro">{introForMode(mode)}</p>
      <div className="media-link-dialog-table-frame">
        <div className="media-link-dialog-table-scroll">
          <div className="media-link-dialog-table" role="table" aria-label="待链接媒体">
            <div className="media-link-dialog-row header" role="row">
              <span role="columnheader" aria-label="状态" />
              <span role="columnheader">剪辑名称</span>
              <span role="columnheader">文件名</span>
              <span role="columnheader">文件路径</span>
              <span role="columnheader">媒体开始</span>
              <span role="columnheader">磁带名称</span>
            </div>
            {candidates.map((candidate) => {
              const processed = processedIds.has(candidate.id);
              const skipped = skippedIds.has(candidate.id);
              const selected = current?.id === candidate.id;
              return (
                <button
                  type="button"
                  className={`media-link-dialog-row ${selected ? "selected" : ""} ${
                    processed ? "processed" : ""
                  }`}
                  role="row"
                  key={candidate.id}
                  onClick={() => !processed && !skipped && setCurrentId(candidate.id)}
                  disabled={busy}
                >
                  <span className="media-link-dialog-row-state" role="cell" aria-label="状态">
                    {processed ? "✓" : skipped ? "—" : selected ? "●" : ""}
                  </span>
                  <span role="cell" title={candidate.clipName}>
                    {candidate.clipName}
                  </span>
                  <span role="cell" title={fileName(candidate.filePath)}>
                    {fileName(candidate.filePath)}
                  </span>
                  <span role="cell" title={directoryName(candidate.filePath)}>
                    {directoryName(candidate.filePath)}
                  </span>
                  <span role="cell">{formatMonitorTime(candidate.mediaStartUs, 25)}</span>
                  <span role="cell">{candidate.tapeName ?? ""}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="media-link-dialog-options">
        <fieldset>
          <legend>匹配文件属性</legend>
          <label>
            <input
              type="checkbox"
              checked={matchFileName}
              onChange={(event) => setMatchFileName(event.currentTarget.checked)}
            />
            文件名
          </label>
          <label>
            <input
              type="checkbox"
              checked={matchExtension}
              onChange={(event) => setMatchExtension(event.currentTarget.checked)}
            />
            文件扩展名
          </label>
          <label>
            <input
              type="checkbox"
              checked={matchMediaStart}
              onChange={(event) => setMatchMediaStart(event.currentTarget.checked)}
            />
            媒体开始
          </label>
          <label>
            <input
              type="checkbox"
              checked={matchTapeName}
              onChange={(event) => setMatchTapeName(event.currentTarget.checked)}
            />
            磁带名称
          </label>
        </fieldset>
        <div className="media-link-dialog-toggles">
          <label>
            <input
              type="checkbox"
              checked={autoRelink}
              onChange={(event) => setAutoRelink(event.currentTarget.checked)}
            />
            自动重新链接其他媒体
          </label>
          <label>
            <input
              type="checkbox"
              checked={useMediaBrowser}
              onChange={(event) => setUseMediaBrowser(event.currentTarget.checked)}
            />
            使用媒体浏览器附加文件
          </label>
        </div>
      </div>
    </ModalDialog>
  );
}
