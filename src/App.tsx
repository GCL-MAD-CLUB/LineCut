import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Captions,
  ChevronDown,
  Download,
  FileVideo,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Play,
  Save,
  Scissors,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { SourceMonitor } from "./components/SourceMonitor";
import { TaskProgress, clearTaskProgress, removeTaskProgress, showTaskProgress } from "./components/TaskProgress";
import { useAppStore } from "./store";
import { formatDuration } from "./time";
import type {
  AddExternalSubtitlesResult,
  ExportLayout,
  ExportMode,
  ExportNameRule,
  ExportResult,
  ImportResult,
  Preferences,
  ProxyResult,
  SubtitleCue,
} from "./types";

const videoFilters = [
  {
    name: "Video",
    extensions: ["mkv", "mp4", "mov", "webm", "avi", "ts", "m2ts"],
  },
];

const subtitleFilters = [
  {
    name: "Subtitle",
    extensions: ["srt", "ass", "ssa", "vtt", "webvtt"],
  },
];

const executableFilters = [
  {
    name: "Executable",
    extensions: ["exe"],
  },
];

const appIconUrl = new URL("../src-tauri/icons/icon.ico", import.meta.url).href;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
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

function defaultPreferences(): Preferences {
  return {
    cache_dir: "",
    default_export_dir: "",
    ffmpeg_path: "ffmpeg",
    ffprobe_path: "ffprobe",
  };
}

function isDialogueNameRule(rule: ExportNameRule) {
  return rule === "source_dialogue" || rule === "dialogue";
}

function nonDialogueNameRule(rule: ExportNameRule): ExportNameRule {
  if (rule === "source_dialogue") {
    return "source_time_range";
  }
  if (rule === "dialogue") {
    return "time_range";
  }
  return rule;
}

const allExportNameRuleOptions: Array<[ExportNameRule, string]> = [
  ["source_time_range", "原视频名_时间范围"],
  ["source_dialogue", "原视频名_“台词”"],
  ["time_range", "时间范围"],
  ["dialogue", "“台词”"],
];

const mergedExportNameRuleOptions: Array<[ExportNameRule, string]> = [
  ["source_time_range", "原视频名_时间范围"],
  ["time_range", "时间范围"],
];

function exportNameRuleLabel(value: ExportNameRule) {
  return allExportNameRuleOptions.find(([optionValue]) => optionValue === value)?.[1] ?? value;
}

function subtitleLineLabel(index: number) {
  return `字幕 ${index + 1}`;
}

function splitCueTextLines(cue: SubtitleCue) {
  return cue.plain_text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cueLabelValue(cue: SubtitleCue) {
  return cue.style?.trim() || cue.speaker?.trim() || "";
}

function splitMergedLabel(value: string) {
  return value
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cueLineLabels(cue: SubtitleCue) {
  const lineCount = splitCueTextLines(cue).length;
  const label = cueLabelValue(cue);
  if (!label || lineCount === 0) {
    return [];
  }

  const parts = splitMergedLabel(label);
  if (parts.length >= lineCount) {
    return parts.slice(0, lineCount);
  }

  return lineCount === 1 && parts.length === 1 ? parts : [];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function App() {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const leftPaneRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [externalSubtitlePaths, setExternalSubtitlePaths] = useState<string[]>([]);
  const [busyLabel, setBusyLabel] = useState("");
  const [message, setMessage] = useState("就绪");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [draftPreferences, setDraftPreferences] = useState<Preferences>(defaultPreferences);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(100 / 2.8);
  const [previewPaneHeight, setPreviewPaneHeight] = useState(48);
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [useProxy, setUseProxy] = useState(false);
  const [isGeneratingProxy, setIsGeneratingProxy] = useState(false);

  const {
    project,
    activeTrackId,
    query,
    selectedCueIds,
    proxyPath,
    exportOptions,
    setProject,
    setActiveTrackId,
    setQuery,
    toggleCue,
    clearSelection,
    selectCueIds,
    setProxyPath,
    setExportOptions,
    addExternalSubtitles,
  } = useAppStore();

  useEffect(() => {
    const suppressBareAltKey = (event: KeyboardEvent) => {
      if (event.key !== "Alt") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", suppressBareAltKey, true);
    window.addEventListener("keyup", suppressBareAltKey, true);
    return () => {
      window.removeEventListener("keydown", suppressBareAltKey, true);
      window.removeEventListener("keyup", suppressBareAltKey, true);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void invoke<Preferences>("get_preferences")
      .then((loaded) => {
        setPreferences(loaded);
        setDraftPreferences(loaded);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const baseTitle = " LineCut";
    const title = project?.asset.file_name ? `${baseTitle} - ${project.asset.file_name}` : baseTitle;
    void getCurrentWindow().setTitle(title);
  }, [project]);

  const activeTrack = project?.tracks.find((track) => track.id === activeTrackId) ?? null;
  const cues = activeTrackId && project ? project.cues[activeTrackId] ?? [] : [];
  const filteredCues = useMemo(
    () =>
      cues.filter((cue) => cueMatches(cue, query) && (!showOnlySelected || selectedCueIds.has(cue.id))),
    [cues, query, selectedCueIds, showOnlySelected],
  );
  const dialogueLineCount = useMemo(() => {
    return cues.reduce((max, cue) => {
      return Math.max(max, splitCueTextLines(cue).length);
    }, 1);
  }, [cues]);
  const dialogueLineLabels = useMemo(() => {
    const labels = Array.from({ length: dialogueLineCount }, (_, index) => subtitleLineLabel(index));
    for (const cue of cues) {
      const cueLabels = cueLineLabels(cue);
      for (const [index, label] of cueLabels.entries()) {
        if (index < labels.length && labels[index] === subtitleLineLabel(index)) {
          labels[index] = label;
        }
      }
    }
    return labels;
  }, [cues, dialogueLineCount]);
  const selectedDialogueLineIndexes = useMemo(() => {
    if (exportOptions.dialogue_line_indexes.length === 0) {
      return Array.from({ length: dialogueLineCount }, (_, index) => index);
    }
    return exportOptions.dialogue_line_indexes.filter((index) => index < dialogueLineCount);
  }, [dialogueLineCount, exportOptions.dialogue_line_indexes]);
  useEffect(() => {
    if (exportOptions.layout === "merged" && isDialogueNameRule(exportOptions.export_name_rule)) {
      setExportOptions({
        export_name_rule: nonDialogueNameRule(exportOptions.export_name_rule),
        dialogue_line_indexes: [],
      });
    }
  }, [exportOptions.export_name_rule, exportOptions.layout, setExportOptions]);

  useEffect(() => {
    const validIndexes = exportOptions.dialogue_line_indexes.filter(
      (index) => index < dialogueLineCount,
    );
    if (validIndexes.length !== exportOptions.dialogue_line_indexes.length) {
      setExportOptions({ dialogue_line_indexes: validIndexes });
    }
  }, [dialogueLineCount, exportOptions.dialogue_line_indexes, setExportOptions]);

  const rowVirtualizer = useVirtualizer({
    count: filteredCues.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 88,
    overscan: 12,
  });

  function startHorizontalResize(event: PointerEvent<HTMLDivElement>) {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const splitterWidth = 6;
    const minLeft = 320;
    const minRight = 420 + splitterWidth;
    const minPercent = (minLeft / rect.width) * 100;
    const maxPercent = 100 - (minRight / rect.width) * 100;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const next = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLeftPaneWidth(clamp(next, minPercent, maxPercent));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-x");
    };

    document.body.classList.add("is-resizing-x");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startVerticalResize(event: PointerEvent<HTMLDivElement>) {
    const rect = leftPaneRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const splitterHeight = 6;
    const minTop = 220;
    const minBottom = 240 + splitterHeight;
    const minPercent = (minTop / rect.height) * 100;
    const maxPercent = 100 - (minBottom / rect.height) * 100;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const next = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setPreviewPaneHeight(clamp(next, minPercent, maxPercent));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-y");
    };

    document.body.classList.add("is-resizing-y");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  async function chooseExternalSubtitles() {
    if (!isTauriRuntime()) {
      setMessage("请在 Tauri 桌面窗口中选择本地外挂字幕。");
      return;
    }
    const picked = await open({
      multiple: true,
      filters: subtitleFilters,
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) {
      return;
    }

    if (project) {
      setBusyLabel("正在导入外挂字幕");
      try {
        const result = await invoke<AddExternalSubtitlesResult>("add_external_subtitles", {
          assetId: project.asset.id,
          paths,
        });
        addExternalSubtitles(result.tracks, result.cues);
        if (result.warnings.length > 0) {
          setWarnings((current) => [...current, ...result.warnings]);
        }
        setMessage("外挂字幕已导入");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel("");
      }
    } else {
      setExternalSubtitlePaths((current) => Array.from(new Set([...current, ...paths])));
    }
  }

  async function importVideo() {
    if (!isTauriRuntime()) {
      setMessage("浏览器预览不能导入本地 MKV，请运行 Tauri 桌面应用。");
      return;
    }
    const picked = await open({
      multiple: false,
      filters: videoFilters,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) {
      return;
    }

    setBusyLabel("正在探测媒体并抽取字幕");
    const importTaskId = `import:${path}`;
    showTaskProgress({
      task_id: importTaskId,
      operation: "import",
      label: "导入媒体",
      current: 0,
      total: 1,
      progress: 0,
      done: false,
    });
    setWarnings([]);
    setExportResult(null);
    try {
      const result = await invoke<ImportResult>("import_media", {
        path,
        externalSubtitles: externalSubtitlePaths,
      });
      setProject(result.project);
      setWarnings(result.warnings);
      setExternalSubtitlePaths([]);
      setMessage(`已导入 ${result.project.asset.file_name}`);
      removeTaskProgress(importTaskId);
    } catch (error) {
      removeTaskProgress(importTaskId);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel("");
    }
  }

  async function generatePreview() {
    if (!project) {
      return;
    }
    setIsGeneratingProxy(true);
    setBusyLabel("正在生成 720p 预览代理");
    showTaskProgress({
      task_id: `proxy:${project.asset.id}`,
      operation: "proxy",
      label: "生成代理",
      current: 1,
      total: 1,
      progress: 0,
      done: false,
    });
    try {
      const result = await invoke<ProxyResult>("generate_proxy", {
        assetId: project.asset.id,
      });
      setProxyPath(result.proxy_path);
      setUseProxy(true);
      setMessage("预览代理已生成");
    } catch (error) {
      removeTaskProgress(`proxy:${project.asset.id}`);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel("");
      setIsGeneratingProxy(false);
    }
  }

  function handleVideoError() {
    if (!useProxy && project) {
      setUseProxy(true);
      setMessage("原文件无法直接播放，已切换到代理模式，请生成预览代理。");
    }
  }

  async function cancelCurrentTask() {
    if (!isTauriRuntime()) {
      clearTaskProgress();
      return;
    }
    try {
      const cancelled = await invoke<boolean>("cancel_current_task");
      setMessage(cancelled ? "正在取消任务" : "当前没有可取消的 FFmpeg 任务");
      if (!cancelled) {
        clearTaskProgress();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function chooseOutputDir() {
    if (!isTauriRuntime()) {
      setMessage("请在 Tauri 桌面窗口中选择导出目录。");
      return;
    }
    const picked = await open({
      directory: true,
      multiple: false,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) {
      setExportOptions({ output_dir: path, output_dir_explicit: true });
    }
  }

  async function choosePreferenceDir(key: "cache_dir" | "default_export_dir") {
    if (!isTauriRuntime()) {
      setMessage("请在 Tauri 桌面窗口中选择目录。");
      return;
    }
    const picked = await open({
      directory: true,
      multiple: false,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) {
      setDraftPreferences((current) => ({ ...current, [key]: path }));
    }
  }

  async function chooseExecutable(key: "ffmpeg_path" | "ffprobe_path") {
    if (!isTauriRuntime()) {
      setMessage("请在 Tauri 桌面窗口中选择可执行文件。");
      return;
    }
    const picked = await open({
      multiple: false,
      filters: executableFilters,
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) {
      setDraftPreferences((current) => ({ ...current, [key]: path }));
    }
  }

  async function savePreferences() {
    if (!isTauriRuntime()) {
      setMessage("浏览器预览不能保存首选项。");
      return;
    }
    setBusyLabel("正在保存首选项");
    try {
      const saved = await invoke<Preferences>("update_preferences", {
        preferences: draftPreferences,
      });
      setPreferences(saved);
      setDraftPreferences(saved);
      setPreferencesOpen(false);
      setMessage("首选项已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel("");
    }
  }

  async function exportSelection() {
    if (!project || !activeTrackId) {
      return;
    }
    setBusyLabel("正在导出台词片段");
    showTaskProgress({
      task_id: `export:${project.asset.id}`,
      operation: "export",
      label: `导出 ${selectedCount} 条台词`,
      current: 0,
      total: 1,
      progress: 0,
      done: false,
    });
    setExportResult(null);
    try {
      const result = await invoke<ExportResult>("export_clips", {
        assetId: project.asset.id,
        trackId: activeTrackId,
        cueIds: Array.from(selectedCueIds),
        options: exportOptions,
      });
      setExportResult(result);
      setMessage(`导出完成：${result.files.length} 个文件`);
    } catch (error) {
      removeTaskProgress(`export:${project.asset.id}`);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel("");
    }
  }

  function toggleDialogueLineIndex(lineIndex: number) {
    const current =
      exportOptions.dialogue_line_indexes.length === 0
        ? Array.from({ length: dialogueLineCount }, (_, index) => index)
        : exportOptions.dialogue_line_indexes.filter((index) => index < dialogueLineCount);
    const next = current.includes(lineIndex)
      ? current.filter((index) => index !== lineIndex)
      : [...current, lineIndex].sort((a, b) => a - b);
    if (next.length === 0) {
      return;
    }
    setExportOptions({ dialogue_line_indexes: next });
  }

  function seekToCue(cue: SubtitleCue) {
    window.dispatchEvent(new CustomEvent("linecut-monitor-seek", { detail: { timeUs: cue.start_us } }));
  }

  const selectedCount = selectedCueIds.size;
  useEffect(() => {
    if (showOnlySelected && selectedCount === 0) {
      setShowOnlySelected(false);
    }
  }, [showOnlySelected, selectedCount]);

  useEffect(() => {
    setUseProxy(false);
  }, [project?.asset.id]);
  const canExport = Boolean(project && activeTrackId && selectedCount > 0 && !busyLabel);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <img src={appIconUrl} alt="" className="app-icon" />
            <TaskProgress onCancel={cancelCurrentTask}>
              <div className="brand-copy">
                <strong>LineCut</strong>
                <span>对白检索与片段导出</span>
              </div>
            </TaskProgress>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="toolbar-button" onClick={() => setPreferencesOpen(true)}>
            <Settings size={16} />
            首选项
          </button>
          <button className="toolbar-button" onClick={chooseExternalSubtitles} disabled={Boolean(busyLabel)}>
            <Captions size={16} />
            外挂字幕
          </button>
          <button className="accent-button" onClick={importVideo} disabled={Boolean(busyLabel)}>
            {busyLabel ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />}
            导入视频
          </button>
        </div>
      </header>

      {externalSubtitlePaths.length > 0 && (
        <div className="subtitle-strip">
          <span>外挂字幕</span>
          {externalSubtitlePaths.map((path) => (
            <button
              key={path}
              className="subtitle-chip"
              onClick={() =>
                setExternalSubtitlePaths((current) => current.filter((item) => item !== path))
              }
              title={path}
            >
              {fileName(path)}
              <X size={13} />
            </button>
          ))}
        </div>
      )}

      <main
        ref={workspaceRef}
        className="workspace"
        style={{
          gridTemplateColumns: `minmax(320px, ${leftPaneWidth}%) 6px minmax(420px, 1fr)`,
        }}
      >
        <section
          ref={leftPaneRef}
          className="left-pane"
          style={{
            gridTemplateRows: `minmax(220px, ${previewPaneHeight}%) 6px minmax(240px, 1fr)`,
          }}
        >
          <div className="panel preview-panel">
            <SourceMonitor
              project={project}
              proxyPath={proxyPath}
              useProxy={useProxy}
              isGeneratingProxy={isGeneratingProxy}
              onUseProxyChange={setUseProxy}
              onGenerateProxy={generatePreview}
              onVideoError={handleVideoError}
            />
          </div>

          <div
            className="pane-resizer pane-resizer-horizontal"
            role="separator"
            aria-orientation="horizontal"
            title="调整预览和导出设置高度"
            onPointerDown={startVerticalResize}
          />

          <div className="panel export-panel">
            <div className="panel-header compact">
              <div>
                <span className="eyebrow">导出设置</span>
                <h2>{selectedCount} 条台词已选择</h2>
              </div>
              <Scissors size={18} />
            </div>

            <div className="control-grid">
              <label>
                前留白 ms
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={exportOptions.head_padding_ms}
                  onChange={(event) =>
                    setExportOptions({ head_padding_ms: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                后留白 ms
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={exportOptions.tail_padding_ms}
                  onChange={(event) =>
                    setExportOptions({ tail_padding_ms: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                合并间隔 ms
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={exportOptions.merge_gap_ms}
                  onChange={(event) =>
                    setExportOptions({ merge_gap_ms: Number(event.currentTarget.value) })
                  }
                />
              </label>
            </div>

            <SegmentedControl<ExportMode>
              label="导出模式"
              value={exportOptions.mode}
              options={[
                ["precise_encode", "精确重编码"],
                ["fast_copy", "快速无损"],
              ]}
              onChange={(mode) => setExportOptions({ mode })}
            />
            <SegmentedControl<ExportLayout>
              label="输出方式"
              value={exportOptions.layout}
              options={[
                ["individual", "独立片段"],
                ["merged", "合并视频"],
              ]}
              onChange={(layout) => setExportOptions({ layout })}
            />
            <SelectMenu<ExportNameRule>
              label="重命名规则"
              value={exportOptions.export_name_rule}
              options={
                exportOptions.layout === "merged"
                  ? mergedExportNameRuleOptions
                  : allExportNameRuleOptions
              }
              onChange={(export_name_rule) => setExportOptions({ export_name_rule })}
            />
            {exportOptions.layout === "individual" &&
              isDialogueNameRule(exportOptions.export_name_rule) && (
                <div className="language-picker">
                  <span>文件名台词字幕</span>
                  <div className="language-options">
                    {Array.from({ length: dialogueLineCount }, (_, index) => (
                      <label key={index} className="language-option">
                        <input
                          type="checkbox"
                          checked={selectedDialogueLineIndexes.includes(index)}
                          onChange={() => toggleDialogueLineIndex(index)}
                        />
                        {dialogueLineLabels[index]}
                      </label>
                    ))}
                  </div>
                </div>
              )}

            <div className="output-row">
              <button className="toolbar-button" onClick={chooseOutputDir} disabled={Boolean(busyLabel)}>
                <Folder size={15} />
                导出目录
              </button>
              <span title={exportOptions.output_dir || preferences.default_export_dir}>
                {exportOptions.output_dir || preferences.default_export_dir || "默认目录"}
              </span>
            </div>

            <button className="accent-button wide" disabled={!canExport} onClick={exportSelection}>
              {busyLabel === "正在导出台词片段" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Download size={16} />
              )}
              开始导出
            </button>
          </div>
        </section>

        <div
          className="pane-resizer pane-resizer-vertical"
          role="separator"
          aria-orientation="vertical"
          title="调整左右面板宽度"
          onPointerDown={startHorizontalResize}
        />

        <section className="right-pane panel">
          <div className="list-toolbar">
            <div className="track-select">
              <label htmlFor="track">字幕轨</label>
              <select
                id="track"
                value={activeTrackId}
                onChange={(event) => setActiveTrackId(event.currentTarget.value)}
                disabled={!project}
              >
                {project?.tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.source_type === "embedded" ? `流 ${track.stream_index}` : "外挂"} ·{" "}
                    {track.title || track.language || track.codec} · {track.cue_count} 条
                  </option>
                ))}
              </select>
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
              onClick={() => selectCueIds(filteredCues.map((cue) => cue.id))}
              disabled={filteredCues.length === 0}
            >
              全选
            </button>
            <button className="toolbar-button" onClick={clearSelection} disabled={selectedCount === 0}>
              清空
            </button>
            <button
              className={`toolbar-button ${showOnlySelected ? "active" : ""}`}
              onClick={() => setShowOnlySelected((value) => !value)}
              disabled={selectedCount === 0}
            >
              仅展示选中
            </button>
            <span>{filteredCues.length} 条结果</span>
          </div>

          {activeTrack?.warning && <div className="warning-line">{activeTrack.warning}</div>}

          <div ref={listRef} className="cue-list">
            {filteredCues.length === 0 ? (
              <div className="empty-list">
                <Captions size={36} />
                <span>{project ? "当前字幕轨没有可显示台词" : "导入视频后会显示全部台词"}</span>
              </div>
            ) : (
              <div
                className="virtual-spacer"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
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
                          onChange={() => toggleCue(cue.id)}
                          aria-label="选择台词"
                        />
                      </label>
                      <button className="cue-play" onClick={() => seekToCue(cue)} title="跳转预览">
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
      </main>

      <footer className="statusbar">
        <span className={busyLabel ? "busy-status" : ""}>
          {busyLabel ? (
            <>
              <Loader2 className="spin" size={14} />
              {busyLabel}
            </>
          ) : (
            message
          )}
        </span>
        {warnings.length > 0 && <span>{warnings.length} 条导入提示</span>}
        {exportResult && <span title={exportResult.files.join("\n")}>{exportResult.output_dir}</span>}
      </footer>

      {(warnings.length > 0 || exportResult) && (
        <aside className="event-drawer">
          {warnings.map((warning) => (
            <div key={warning} className="event warning">
              {warning}
            </div>
          ))}
          {exportResult?.log.map((item) => (
            <div key={item} className="event">
              {item}
            </div>
          ))}
        </aside>
      )}

      {preferencesOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setPreferencesOpen(false)}>
          <section className="preferences-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className="eyebrow">应用首选项</span>
                <h2>路径与媒体工具</h2>
              </div>
              <button className="tool-button" onClick={() => setPreferencesOpen(false)} title="关闭">
                <X size={16} />
              </button>
            </div>

            <div className="preference-fields">
              <PathField
                label="缓存路径"
                value={draftPreferences.cache_dir}
                icon={<HardDrive size={15} />}
                onChange={(value) => setDraftPreferences((current) => ({ ...current, cache_dir: value }))}
                onBrowse={() => choosePreferenceDir("cache_dir")}
              />
              <PathField
                label="默认导出路径"
                value={draftPreferences.default_export_dir}
                icon={<Folder size={15} />}
                onChange={(value) =>
                  setDraftPreferences((current) => ({ ...current, default_export_dir: value }))
                }
                onBrowse={() => choosePreferenceDir("default_export_dir")}
              />
              <PathField
                label="FFmpeg"
                value={draftPreferences.ffmpeg_path}
                icon={<FileVideo size={15} />}
                onChange={(value) => setDraftPreferences((current) => ({ ...current, ffmpeg_path: value }))}
                onBrowse={() => chooseExecutable("ffmpeg_path")}
              />
              <PathField
                label="ffprobe"
                value={draftPreferences.ffprobe_path}
                icon={<FileVideo size={15} />}
                onChange={(value) => setDraftPreferences((current) => ({ ...current, ffprobe_path: value }))}
                onBrowse={() => chooseExecutable("ffprobe_path")}
              />
            </div>

            <div className="modal-actions">
              <button
                className="toolbar-button"
                onClick={() => {
                  const defaults = defaultPreferences();
                  setDraftPreferences({
                    ...defaults,
                    cache_dir: preferences.cache_dir,
                    default_export_dir: preferences.default_export_dir,
                  });
                }}
              >
                重置工具路径
              </button>
              <button className="accent-button" onClick={savePreferences} disabled={Boolean(busyLabel)}>
                {busyLabel === "正在保存首选项" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                保存
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

interface PathFieldProps {
  label: string;
  value: string;
  icon: ReactNode;
  onChange: (value: string) => void;
  onBrowse: () => void;
}

function PathField({ label, value, icon, onChange, onBrowse }: PathFieldProps) {
  return (
    <label className="path-field">
      <span>{label}</span>
      <div className="path-input">
        {icon}
        <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
        <button type="button" className="tool-button" onClick={onBrowse} title="浏览">
          <FolderOpen size={15} />
        </button>
      </div>
    </label>
  );
}

interface SelectMenuProps<T extends string> {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}

function SelectMenu<T extends string>({ label, value, options, onChange }: SelectMenuProps<T>) {
  return (
    <label className="select-menu-field">
      <span>{label}</span>
      <div className="select-menu">
        <span>{exportNameRuleLabel(value as ExportNameRule)}</span>
        <span className="select-menu-divider" />
        <ChevronDown size={18} />
        <select value={value} onChange={(event) => onChange(event.currentTarget.value as T)}>
          {options.map(([optionValue, optionLabel]) => (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          ))}
        </select>
      </div>
    </label>
  );
}

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div className="segmented-field">
      <span>{label}</span>
      <div className="segmented-control">
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            className={value === optionValue ? "active" : ""}
            onClick={() => onChange(optionValue)}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
