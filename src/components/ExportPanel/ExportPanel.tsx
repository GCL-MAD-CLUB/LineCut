import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, Folder, Loader2, Scissors } from "lucide-react";
import { useEffect, useMemo } from "react";
import { listenToFfmpegTaskProgress } from "../../ffmpegProgress";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type {
  ExportLayout,
  ExportMode,
  ExportNameRule,
  ExportResult,
  SubtitleCue,
} from "../../types";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";
import "./ExportPanel.css";

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

function useActiveCues() {
  const project = useAppStore((state) => state.project);
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  return useMemo(
    () => (activeTrackId && project ? (project.cues[activeTrackId] ?? []) : []),
    [activeTrackId, project],
  );
}

function useCanExport(isExporting: boolean) {
  const project = useAppStore((state) => state.project);
  const activeTrackId = useAppStore((state) => state.activeTrackId);
  const selectedCount = useAppStore((state) => state.selectedCueIds.size);
  return Boolean(project && activeTrackId && selectedCount > 0 && !isExporting);
}

export function ExportPanel() {
  const exportOptions = useAppStore((state) => state.exportOptions);
  const setExportOptions = useAppStore((state) => state.setExportOptions);
  const defaultExportDir = useAppStore((state) => state.preferences.default_export_dir);
  const setMessage = useAppStore((state) => state.setMessage);
  const setExportResult = useAppStore((state) => state.setExportResult);
  const labelCues = useActiveCues();
  const selectedCount = useAppStore((state) => state.selectedCueIds.size);
  const { isRunning: isExporting } = getTaskProgressStatus("export");
  const canExport = useCanExport(isExporting);
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

  async function exportSelection() {
    const {
      project,
      activeTrackId,
      selectedCueIds,
      exportOptions: currentExportOptions,
    } = useAppStore.getState();
    if (!project || !activeTrackId) {
      return;
    }
    if (!isTauriRuntime()) {
      setMessage("浏览器预览不能导出视频，请运行 Tauri 桌面应用。");
      return;
    }
    const exportTaskId = `export:${project.asset.id}`;
    let exportCancelled = false;
    const exportTask = createTaskProgress({
      operation: "export",
      label: `导出 ${selectedCueIds.size} 条台词`,
      current: 0,
      total: 1,
      on_cancel: async () => {
        exportCancelled = true;
        await invoke<boolean>("cancel_current_task");
      },
    });
    setExportResult(null);
    const stopProgressListener = await listenToFfmpegTaskProgress(exportTaskId, exportTask);
    try {
      const result = await invoke<ExportResult>("export_clips", {
        assetId: project.asset.id,
        trackId: activeTrackId,
        cueIds: Array.from(selectedCueIds),
        options: currentExportOptions,
      });
      setExportResult(result);
      setMessage(`导出完成：${result.files.length} 个文件`);
      exportTask.update({ current: 1 });
      exportTask.remove();
    } catch (error) {
      if (exportCancelled) {
        setMessage("导出已取消");
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      exportTask.fail("导出失败", errorMessage);
      setMessage(errorMessage);
    } finally {
      stopProgressListener();
    }
  }

  return (
    <div className="export-panel">
      <div className="export-summary">
        <strong>{selectedCount} 条台词已选择</strong>
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
          exportOptions.layout === "merged" ? mergedExportNameRuleOptions : allExportNameRuleOptions
        }
        onChange={(export_name_rule) => setExportOptions({ export_name_rule })}
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
          <Folder size={15} />
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
