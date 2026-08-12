import { open } from "@tauri-apps/plugin-dialog";
import { Captions, Download, Film, Folder, Link2, Loader2, Music2, Scissors } from "lucide-react";
import { useEffect, useMemo } from "react";
import { clientError, invokeCommand, runOperation } from "../../errors";
import {
  cancelFfmpegTask,
  createFfmpegTaskId,
  listenToFfmpegTaskProgress,
} from "../../ffmpegProgress";
import {
  isMediaItemEnabled,
  isMediaVideoDetached,
  isVirtualMediaItem,
  mediaItemProject,
  subtitleTrackCues,
  subtitleTrackContext,
  useProjectPort,
} from "../../systems/ProjectSystem";
import { isTauriRuntime } from "../../tauriRuntime";
import type {
  ExportLayout,
  ExportBoundMedia,
  ExportMode,
  ExportNameRule,
  ExportResult,
  SubtitleCue,
} from "../../types";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import { createTaskProgress, useTaskProgressStatus } from "../../systems/TaskSystem";
import "./ExportPanel.css";
import { useExportPanelState } from "./exportPanelState";

const allExportNameRuleOptions: Array<[ExportNameRule, string]> = [
  ["source_time_range", "原视频名_时间范围"],
  ["source_dialogue", "原视频名_台词"],
  ["time_range", "仅时间范围"],
  ["dialogue", "仅台词"],
];

const mergedExportNameRuleOptions: Array<[ExportNameRule, string]> = [
  ["source_time_range", "原视频名_时间范围"],
  ["time_range", "时间范围"],
];

export function isDialogueNameRule(rule: ExportNameRule) {
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

function subtitleLineLabel(index: number) {
  return `字幕 ${index + 1}`;
}

const maxDialogueLineOptions = 4;

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

function cueLineLabels(cue: SubtitleCue, lineCount: number) {
  const cueLineCount = splitCueTextLines(cue).length;
  const label = cueLabelValue(cue);
  if (!label || cueLineCount !== lineCount) {
    return [];
  }

  const parts = splitMergedLabel(label);
  if (parts.length >= lineCount) {
    return parts.slice(0, lineCount);
  }

  return lineCount === 1 && parts.length === 1 ? parts : [];
}

function dominantDialogueLineCount(cues: SubtitleCue[]) {
  const counts = new Map<number, number>();
  for (const cue of cues) {
    const lineCount = splitCueTextLines(cue).length;
    if (lineCount < 1 || lineCount > maxDialogueLineOptions) {
      continue;
    }
    counts.set(lineCount, (counts.get(lineCount) ?? 0) + 1);
  }

  let bestCount = 1;
  let bestFrequency = 0;
  for (const [lineCount, frequency] of counts) {
    if (frequency > bestFrequency || (frequency === bestFrequency && lineCount > bestCount)) {
      bestCount = lineCount;
      bestFrequency = frequency;
    }
  }

  return bestCount;
}

function buildDialogueLineLabels(cues: SubtitleCue[], lineCount: number) {
  const labels = Array.from({ length: lineCount }, (_, index) => subtitleLineLabel(index));
  for (const cue of cues) {
    const cueLabels = cueLineLabels(cue, lineCount);
    for (const [index, label] of cueLabels.entries()) {
      if (index < labels.length && labels[index] === subtitleLineLabel(index)) {
        labels[index] = label;
      }
    }
  }
  return labels;
}

export function ExportPanel() {
  const {
    project,
    projects,
    mediaItems,
    activeVideoId,
    detachedVideoIds,
    mediaBinReadOnly,
    activeVideoChanged,
    activeTrackId,
    selectedCueIds,
    preferences,
    messagePublished,
    exportResultChanged,
  } = useProjectPort(
    [
      "project",
      "projects",
      "mediaItems",
      "activeVideoId",
      "detachedVideoIds",
      "mediaBinReadOnly",
      "activeTrackId",
      "selectedCueIds",
      "preferences",
    ],
    ["activeVideoChanged", "messagePublished", "exportResultChanged"],
  );
  const {
    exportOptions,
    exportVideoId,
    selectedBoundMediaIds,
    updateExportOptions,
    setExportVideoId,
    setSelectedBoundMediaIds,
  } = useExportPanelState((state) => state);
  const labelCues = useMemo(
    () =>
      activeTrackId
        ? subtitleTrackCues(project, projects, mediaItems, activeVideoId, activeTrackId)
        : [],
    [activeTrackId, activeVideoId, mediaItems, project, projects],
  );
  const { isRunning: isExporting } = useTaskProgressStatus("export.clips");
  const selectedCount = selectedCueIds.size;
  const isMediaBinReadOnly = mediaBinReadOnly;
  const defaultExportDir = preferences.default_export_dir;
  const canExport =
    Boolean(project && activeTrackId && selectedCount > 0 && !isExporting) && !mediaBinReadOnly;
  const videoItems = useMemo(
    () => mediaItems.filter((item) => item.kind === "video" && isMediaItemEnabled(item)),
    [mediaItems],
  );
  const boundMediaItems = useMemo(
    () =>
      mediaItems.filter(
        (item) =>
          item.kind !== "video" &&
          isMediaItemEnabled(item) &&
          item.bound_to_video_id === exportVideoId,
      ),
    [exportVideoId, mediaItems],
  );
  const dialogueLineCount = useMemo(() => {
    return dominantDialogueLineCount(labelCues);
  }, [labelCues]);

  const dialogueLineLabels = useMemo(() => {
    return buildDialogueLineLabels(labelCues, dialogueLineCount);
  }, [labelCues, dialogueLineCount]);

  const selectedDialogueLineIndexes = useMemo(() => {
    if (exportOptions.dialogue_line_indexes.length === 0) {
      return Array.from({ length: dialogueLineCount }, (_, index) => index);
    }
    return exportOptions.dialogue_line_indexes.filter((index) => index < dialogueLineCount);
  }, [dialogueLineCount, exportOptions.dialogue_line_indexes]);

  useEffect(() => {
    if (activeVideoId && exportVideoId !== activeVideoId) {
      setExportVideoId(activeVideoId);
    }
  }, [activeVideoId, exportVideoId, setExportVideoId]);

  useEffect(() => {
    const availableIds = new Set(boundMediaItems.map((item) => item.id));
    const validIds = selectedBoundMediaIds.filter((itemId) => availableIds.has(itemId));
    if (validIds.length !== selectedBoundMediaIds.length) {
      setSelectedBoundMediaIds(validIds);
    }
  }, [boundMediaItems, selectedBoundMediaIds, setSelectedBoundMediaIds]);

  useEffect(() => {
    if (exportOptions.layout === "merged" && isDialogueNameRule(exportOptions.export_name_rule)) {
      updateExportOptions({
        export_name_rule: nonDialogueNameRule(exportOptions.export_name_rule),
        dialogue_line_indexes: [],
      });
    }
  }, [exportOptions.export_name_rule, exportOptions.layout, updateExportOptions]);

  useEffect(() => {
    const validIndexes = exportOptions.dialogue_line_indexes.filter(
      (index) => index < dialogueLineCount,
    );
    if (validIndexes.length !== exportOptions.dialogue_line_indexes.length) {
      updateExportOptions({ dialogue_line_indexes: validIndexes });
    }
  }, [dialogueLineCount, exportOptions.dialogue_line_indexes, updateExportOptions]);

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
    updateExportOptions({ dialogue_line_indexes: next });
  }

  function changeExportVideo(videoId: string) {
    setExportVideoId(videoId);
    activeVideoChanged(videoId);
  }

  function toggleBoundMedia(itemId: string) {
    setSelectedBoundMediaIds(
      selectedBoundMediaIds.includes(itemId)
        ? selectedBoundMediaIds.filter((current) => current !== itemId)
        : [...selectedBoundMediaIds, itemId],
    );
  }

  async function chooseOutputDir() {
    if (!isTauriRuntime()) {
      messagePublished("请在 Tauri 桌面窗口中选择导出目录。");
      return;
    }
    const outcome = await runOperation("export.clips", () =>
      open({
        directory: true,
        multiple: false,
      }),
    );
    if (outcome.status !== "success") {
      return;
    }
    const picked = outcome.value;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) {
      updateExportOptions({ output_dir: path, output_dir_explicit: true });
    }
  }

  async function exportSelection() {
    if (isMediaBinReadOnly) {
      return;
    }
    const exportVideo = mediaItems.find((item) => item.id === exportVideoId);
    const exportProject = exportVideo
      ? (mediaItemProject(exportVideo, projects, mediaItems) ?? project)
      : project;
    if (!exportProject || !activeTrackId) {
      return;
    }
    const trackContext = subtitleTrackContext(
      exportProject,
      projects,
      mediaItems,
      exportVideoId,
      activeTrackId,
    );
    if (!trackContext) {
      messagePublished("无法解析当前字幕轨的来源，请重新绑定字幕后再导出。");
      return;
    }
    if (!isTauriRuntime()) {
      messagePublished("浏览器预览不能导出视频，请运行 Tauri 桌面应用。");
      return;
    }
    const exportTaskId = createFfmpegTaskId("export");
    let exportCancelled = false;
    const exportTask = await createTaskProgress({
      operation: "export.clips",
      label: `导出 ${selectedCueIds.size} 个片段`,
      current: 0,
      total: 1,
      listener: listenToFfmpegTaskProgress(exportTaskId),
      on_cancel: async () => {
        await cancelFfmpegTask(exportTaskId);
        exportCancelled = true;
      },
    });
    exportResultChanged(null);
    try {
      const boundMedia: ExportBoundMedia[] = boundMediaItems
        .filter((item) => selectedBoundMediaIds.includes(item.id))
        .map((item): ExportBoundMedia => {
          const kind = item.kind === "audio" ? "audio" : "subtitle";
          if (isVirtualMediaItem(item)) {
            const sourceProject = mediaItemProject(item, projects, mediaItems);
            if (!sourceProject) {
              throw clientError(
                "EXPORT_VIRTUAL_MEDIA_SOURCE_MISSING",
                `Source video is missing for virtual export media: ${item.file_name}`,
              );
            }
            return {
              kind,
              source: "embedded_stream",
              path: sourceProject.asset.path,
              stream_index: item.stream_index,
            };
          }
          if (!item.path) {
            throw clientError(
              "EXPORT_BOUND_MEDIA_PATH_MISSING",
              `Source path is missing for bound export media: ${item.file_name}`,
            );
          }
          return { kind, source: "file", path: item.path, stream_index: null };
        });
      const result = await invokeCommand<ExportResult>("export_clips", {
        assetId: exportProject.asset.id,
        trackAssetId: trackContext.project.asset.id,
        trackId: activeTrackId,
        cueIds: Array.from(selectedCueIds),
        options: exportOptions,
        boundMedia,
        includeSourceAudio: exportVideo
          ? !isMediaVideoDetached(exportVideo, detachedVideoIds)
          : !detachedVideoIds.has(exportProject.asset.id),
        taskId: exportTaskId,
      });
      exportResultChanged(result);
      messagePublished(`导出完成：${result.files.length} 个文件`);
      exportTask.update({ current: 1 });
      exportTask.remove();
    } catch (error) {
      if (exportCancelled) {
        messagePublished("导出已取消");
        return;
      }
      exportTask.fail(error);
    }
  }

  return (
    <div className="export-panel">
      <section className="export-media-picker">
        <label>
          <span>
            <Film size={13} /> 导出视频
          </span>
          <SelectDropdown
            ariaLabel="导出视频"
            className="export-video-select"
            menuClassName="export-video-select-menu"
            disabled={videoItems.length === 0 || isExporting}
            value={exportVideoId}
            items={videoItems.map((item) => ({
              type: "option" as const,
              value: item.id,
              label: item.file_name,
            }))}
            onChange={changeExportVideo}
          />
        </label>

        <div className="export-bound-picker">
          <span>
            <Link2 size={13} /> 合成绑定媒体
          </span>
          {boundMediaItems.length === 0 ? (
            <small>当前视频没有绑定的音频或字幕</small>
          ) : (
            <div className="export-bound-options">
              {boundMediaItems.map((item) => (
                <label key={item.id} title={item.path}>
                  <input
                    type="checkbox"
                    checked={selectedBoundMediaIds.includes(item.id)}
                    onChange={() => toggleBoundMedia(item.id)}
                    disabled={isExporting}
                  />
                  {item.kind === "audio" ? <Music2 size={12} /> : <Captions size={12} />}
                  <span>{item.file_name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="export-summary">
        <strong>{selectedCount} 条台词已选择</strong>
        <Scissors size={12.5} />
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
              updateExportOptions({ head_padding_ms: Number(event.currentTarget.value) })
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
              updateExportOptions({ tail_padding_ms: Number(event.currentTarget.value) })
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
              updateExportOptions({ merge_gap_ms: Number(event.currentTarget.value) })
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
        onChange={(mode) => updateExportOptions({ mode })}
      />
      <SegmentedControl<ExportLayout>
        label="输出方式"
        value={exportOptions.layout}
        options={[
          ["individual", "独立片段"],
          ["merged", "合并视频"],
        ]}
        onChange={(layout) => updateExportOptions({ layout })}
      />
      <SelectMenu<ExportNameRule>
        label="重命名规则"
        value={exportOptions.export_name_rule}
        options={
          exportOptions.layout === "merged" ? mergedExportNameRuleOptions : allExportNameRuleOptions
        }
        onChange={(export_name_rule) => updateExportOptions({ export_name_rule })}
      />
      {exportOptions.layout === "individual" &&
        isDialogueNameRule(exportOptions.export_name_rule) && (
          <div className="language-picker">
            <span>字幕轨道</span>
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
        <button className="toolbar-button" onClick={chooseOutputDir} disabled={isExporting}>
          <Folder size={12} />
          导出目录
        </button>
        <span title={exportOptions.output_dir || defaultExportDir}>
          {exportOptions.output_dir || defaultExportDir || "默认目录"}
        </span>
      </div>

      <button className="accent-button wide" disabled={!canExport} onClick={exportSelection}>
        {isExporting ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
        开始导出
      </button>
    </div>
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
    <div className="select-menu-field">
      <span>{label}</span>
      <SelectDropdown
        className="select-menu"
        menuClassName="select-menu-dropdown"
        value={value}
        items={selectDropdownItems(options)}
        onChange={onChange}
      />
    </div>
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
