import { open as openDialog, type DialogFilter } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { invokeCommand, runOperation } from "../../errors";
import { formatMonitorTime } from "../../time";
import type { MediaBinItemKind } from "../../types";
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

const videoExtensions = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "mts", "m2ts"];
const audioExtensions = ["wav", "mp3", "aac", "flac", "m4a", "ogg", "opus"];
const subtitleExtensions = ["srt", "ass", "ssa", "vtt"];

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function fileExtension(path: string) {
  const name = fileName(path);
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLocaleLowerCase();
}

function directoryName(path: string) {
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return separator < 0 ? "" : path.slice(0, separator);
}

function joinPath(directory: string, name: string) {
  if (!directory) {
    return name;
  }
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]$/, "")}${separator}${name}`;
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

function dialogFilters(candidate: MediaLinkCandidate, mode: MediaLinkMode): DialogFilter[] {
  if (mode === "proxy" || candidate.kind === "video") {
    return [{ name: mode === "proxy" ? "代理媒体" : "视频", extensions: videoExtensions }];
  }
  if (candidate.kind === "audio") {
    return [{ name: "音频", extensions: audioExtensions }];
  }
  return [{ name: "字幕", extensions: subtitleExtensions }];
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

  useEffect(() => {
    setCurrentId(candidates[0]?.id ?? "");
    setProcessedIds(new Set());
    setSkippedIds(new Set());
    setBusy(false);
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

  async function attachCurrent() {
    if (!current || busy) {
      return;
    }
    const selectedCandidate = current;
    await runOperation(
      "media.link",
      async () => {
        const picked = await openDialog({
          multiple: false,
          title: `${useMediaBrowser ? "附加" : "选择"}${fileName(selectedCandidate.filePath)}`,
          filters: dialogFilters(selectedCandidate, mode),
        });
        const path = Array.isArray(picked) ? picked[0] : picked;
        if (!path) {
          return false;
        }
        setBusy(true);
        const processed = new Set(processedIds);
        const skipped = new Set(skippedIds);
        if (await onAttach(selectedCandidate, path)) {
          processed.add(selectedCandidate.id);
        }

        if (autoRelink) {
          const directory = directoryName(path);
          for (const candidate of candidates) {
            if (
              candidate.id === selectedCandidate.id ||
              processed.has(candidate.id) ||
              skipped.has(candidate.id)
            ) {
              continue;
            }
            const automaticPath = joinPath(directory, fileName(candidate.filePath));
            const nameMatches =
              !matchFileName || fileName(automaticPath) === fileName(candidate.filePath);
            const extensionMatches =
              !matchExtension || fileExtension(automaticPath) === fileExtension(candidate.filePath);
            if (!nameMatches || !extensionMatches) {
              continue;
            }
            const exists = await invokeCommand<boolean>("path_is_file", { path: automaticPath });
            if (exists && (await onAttach(candidate, automaticPath))) {
              processed.add(candidate.id);
            }
          }
        }

        setProcessedIds(processed);
        const handled = new Set([...processed, ...skipped]);
        const next = nextCandidate(handled);
        if (next) {
          setCurrentId(next.id);
        } else {
          onCancel();
        }
        return true;
      },
      { displayName: fileName(selectedCandidate.filePath), resourceKind: "media" },
    );
    setBusy(false);
  }

  return (
    <ModalDialog
      title={titleForMode(mode)}
      className="media-link-dialog"
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
