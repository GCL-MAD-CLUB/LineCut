import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { scheduleMediaAnalysis } from "../../mediaAnalysisTask";
import { defaultMediaBinFolderColor, useProjectPort } from "../../systems/ProjectSystem";
import { isTauriRuntime } from "../../tauriRuntime";
import { ImportSidebar } from "./ImportSidebar";
import { ImportToolbar } from "./ImportToolbar";
import { ImportFileView } from "./ImportFileView";
import { ImportSettingsPanel } from "./ImportSettingsPanel";
import { ImportSelectionBar } from "./ImportSelectionBar";
import { registerImportSelection } from "./importSelection";
import {
  parentDirectory,
  pathKey,
  type ImportEntry,
  type ImportSettings,
} from "./importBrowserModel";
import { useImportBrowser } from "./useImportBrowser";
import { useImportSelection } from "./useImportSelection";
import "./ImportWorkspace.css";

interface ImportWorkspaceProps {
  onImportCompleted?: () => void;
  onCancel?: () => void;
}

export function ImportWorkspace({ onImportCompleted, onCancel }: ImportWorkspaceProps) {
  const browser = useImportBrowser();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [zoom, setZoom] = useState(180);
  const [busy, setBusy] = useState(false);
  const importing = useRef(false);
  const anchor = useRef("");
  const [status, setStatus] = useState("");
  const [settings, setSettings] = useState<ImportSettings>({
    newBin: false,
    binName: "媒体箱",
    copy: false,
    verify: true,
    destination: "project",
    customDirectory: "",
  });
  const {
    mediaItems,
    mediaFolders,
    mediaBinReadOnly,
    projectFilePath,
    mediaProjectsAdded,
    mediaItemsAdded,
    mediaFolderAdded,
    mediaItemsMovedToFolder,
    messagePublished,
  } = useProjectPort(
    ["mediaItems", "mediaFolders", "mediaBinReadOnly", "projectFilePath"],
    [
      "mediaProjectsAdded",
      "mediaItemsAdded",
      "mediaFolderAdded",
      "mediaItemsMovedToFolder",
      "messagePublished",
    ],
  );
  const imported = useMemo(
    () =>
      new Set(
        mediaItems.filter((item) => item.origin === "imported").map((item) => pathKey(item.path)),
      ),
    [mediaItems],
  );
  const selection = useImportSelection(imported);
  const projectDirectory = projectFilePath ? parentDirectory(projectFilePath) : "";
  const destination =
    settings.destination === "project" ? projectDirectory : settings.customDirectory;
  const disabled = busy || mediaBinReadOnly;
  const canImport =
    !disabled &&
    selection.files.length > 0 &&
    !selection.scanning &&
    !selection.hasErrors &&
    (!settings.newBin || Boolean(settings.binName.trim())) &&
    (!settings.copy || Boolean(destination)) &&
    isTauriRuntime();
  function addEntries(entries: ImportEntry[]) {
    if (disabled) return;
    selection.add(entries);
  }
  function toggle(entry: ImportEntry, range: boolean) {
    if (disabled) return;
    const previous = browser.entries.findIndex((item) => item.path === anchor.current);
    const next = browser.entries.findIndex((item) => item.path === entry.path);
    if (range && previous >= 0 && next >= 0)
      addEntries(browser.entries.slice(Math.min(previous, next), Math.max(previous, next) + 1));
    else selection.toggle(entry);
    anchor.current = entry.path;
  }
  async function importSelected() {
    if (!canImport || importing.current) return;
    importing.current = true;
    setBusy(true);
    setStatus("");
    try {
      const { results, subtitles, completed } = await registerImportSelection(
        selection.files,
        settings.copy ? { directory: destination, verify: settings.verify } : null,
      );
      if (completed.size) {
        let folderId: string | null = null;
        if (settings.newBin) {
          const requestedName = settings.binName.trim();
          const names = new Set(
            mediaFolders
              .filter((folder) => !folder.parent_id)
              .map((folder) => folder.name.toLocaleLowerCase()),
          );
          let name = requestedName;
          for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix += 1)
            name = `${requestedName} ${suffix}`;
          folderId = `media-bin:${crypto.randomUUID()}`;
          mediaFolderAdded({
            id: folderId,
            name,
            parent_id: null,
            color: defaultMediaBinFolderColor,
            hidden: false,
          });
        }
        if (results.length) mediaProjectsAdded(results.map((result) => result.project));
        if (subtitles.length) mediaItemsAdded(subtitles);
        if (folderId)
          mediaItemsMovedToFolder(
            [
              ...results.map((result) => result.project.asset.id),
              ...subtitles.map((item) => item.id),
            ],
            folderId,
          );
        scheduleMediaAnalysis(results);
      }
      const remaining = selection.files.filter((entry) => !completed.has(entry.path));
      selection.retainFiles(remaining);
      const message = `已导入 ${completed.size} 个媒体${remaining.length ? `，${remaining.length} 个未完成，可重试` : ""}`;
      setStatus(message);
      messagePublished(message);
      if (completed.size && !remaining.length) onImportCompleted?.();
    } finally {
      importing.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="import-workspace" aria-label="导入工作区" aria-busy={busy}>
      <div className="import-workspace-content" inert={busy}>
        <ImportSidebar
          locations={browser.locations}
          directory={browser.listing?.directory ?? ""}
          onNavigate={(path) => void browser.navigate(path)}
        />
        <main className="import-browser-main">
          <ImportToolbar
            browser={browser}
            view={view}
            onView={setView}
            zoom={zoom}
            onZoom={setZoom}
          />
          <ImportFileView
            entries={browser.entries}
            selected={selection.selected}
            imported={imported}
            view={view}
            zoom={zoom}
            disabled={disabled}
            loading={browser.loading}
            error={browser.error}
            desktop={isTauriRuntime()}
            onToggle={toggle}
            onNavigate={(path) => void browser.navigate(path)}
            onSelectAll={() => addEntries(browser.entries)}
          />
        </main>
        <ImportSettingsPanel
          settings={settings}
          onChange={setSettings}
          disabled={disabled}
          projectDirectory={projectDirectory}
        />
      </div>
      <ImportSelectionBar
        items={selection.items}
        mediaCount={selection.files.length}
        scanning={selection.scanning}
        busy={busy}
        canImport={canImport}
        status={status}
        onRemoveMany={selection.removeMany}
        onClear={selection.clear}
        onRetry={selection.retry}
        onNavigate={(path) => void browser.navigate(path)}
        onCancel={() => {
          selection.clear();
          onCancel?.();
        }}
        onImport={() => void importSelected()}
      />
      {busy &&
        createPortal(
          <div
            className="import-freeze"
            role="dialog"
            aria-modal="true"
            aria-label="正在登记媒体"
            tabIndex={-1}
            ref={(element) => element?.focus()}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          />,
          document.body,
        )}
    </section>
  );
}
