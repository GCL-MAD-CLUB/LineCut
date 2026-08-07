import { ChevronDown, FolderOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { SelectDropdown, selectDropdownItems, type SelectDropdownItem } from "../SelectDropdown";
import type {
  ExportAudioFormat,
  ExportClip,
  ExportDestination,
  ExportContainer,
  ExportExistingFileMode,
  ExportRenameRule,
  ExportSettings,
  ExportSource,
} from "../../systems/ExportSystem";
import {
  audioFormatOfCodec,
  computeExportFileNames,
  defaultAudioCodecForFormat,
  exportAudioBitrateOptions,
  exportAudioChannelOptions,
  exportAudioFormatOptions,
  exportAudioLayerOptions,
  exportAudioSampleRateOptions,
  exportContainerOptions,
  exportDestinationOptions,
  exportEncoderSpeedOptions,
  exportExtensionCaseOptions,
  exportQualityOptions,
  exportRenameRuleOptions,
  exportResolutionOptions,
  readRememberedExportDir,
  rememberExportDir,
  renameRuleUsesCustom,
  resolveExportDestinationDir,
} from "../../systems/ExportSystem";

const frameRateOptions: Array<readonly [string, string]> = [
  ["source", "匹配源"],
  ["23.976", "23.976 fps"],
  ["24", "24 fps"],
  ["25", "25 fps"],
  ["29.97", "29.97 fps"],
  ["30", "30 fps"],
  ["50", "50 fps"],
  ["59.94", "59.94 fps"],
  ["60", "60 fps"],
];

/** Presets are not implemented yet; the dropdown is a disabled placeholder. */
const exportPresetOptions: Array<readonly [string, string]> = [["custom", "自定义"]];

/**
 * Destination dropdown items: the three source/file categories first, then a
 * separator, then the well-known Windows folders (they are OS paths, not the
 * user's own project, so they are visually grouped below the divider).
 */
const destinationItems: Array<SelectDropdownItem<ExportDestination>> = [
  ...selectDropdownItems(exportDestinationOptions.slice(0, 3)),
  { type: "separator" },
  ...selectDropdownItems(exportDestinationOptions.slice(3)),
];

/**
 * Existing-file handling dropdown. "询问要执行的操作" sits above the divider:
 * it prompts on export, while the other modes act automatically.
 */
const existingFileModeItems: Array<SelectDropdownItem<ExportExistingFileMode>> = [
  ...selectDropdownItems([["ask", "询问要执行的操作"]]),
  { type: "separator" },
  ...selectDropdownItems([
    ["uniqueName", "为导出的文件选择一个新名称"],
    ["overwrite", "无提示覆盖"],
    ["skip", "跳过"],
  ]),
];

/** Snaps `target` to the closest value in a sorted list (used for format-switch resets). */
function nearestValue(values: number[], target: number) {
  return values.reduce(
    (best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best),
    values[0],
  );
}

interface ExportFieldProps {
  label: string;
  /** The control stacks multiple rows; keeps the label aligned to the first one. */
  stacked?: boolean;
  children: ReactNode;
}

function ExportField({ label, stacked = false, children }: ExportFieldProps) {
  return (
    <div className={`export-settings-field ${stacked ? "export-settings-field-stacked" : ""}`}>
      <span className="export-settings-field-label">{label}</span>
      <div className="export-settings-field-control">{children}</div>
    </div>
  );
}

type ExportSettingsGroupId = "rename" | "video" | "audio" | "general";

interface ExportSettingsGroupProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** When provided, the header shows an enable switch bound to these props. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  switchAriaLabel?: string;
  children: ReactNode;
}

function ExportSettingsGroup({
  title,
  open,
  onToggle,
  enabled,
  onEnabledChange,
  switchAriaLabel,
  children,
}: ExportSettingsGroupProps) {
  return (
    <section className="export-settings-group">
      <div className="export-settings-group-header">
        <button
          type="button"
          className="export-settings-group-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronDown
            size={14}
            className={`export-settings-group-chevron ${open ? "" : "is-collapsed"}`}
          />
          <span>{title}</span>
        </button>
        {onEnabledChange && (
          <label className="export-switch">
            <input
              type="checkbox"
              checked={enabled ?? false}
              aria-label={switchAriaLabel ?? `${title}开关`}
              onChange={(event) => onEnabledChange(event.target.checked)}
            />
            <span className="export-switch-track" />
          </label>
        )}
      </div>
      {open && <div className="export-settings-group-body">{children}</div>}
    </section>
  );
}

interface ExportSettingsSectionProps {
  settings: ExportSettings;
  onUpdateSettings: (updates: Partial<ExportSettings>) => void;
  /** Channel count of the source being previewed; drives the 声道 options. */
  sourceChannels: number | null;
  /** Export source; its clips resolve the "原始照片所在的文件夹" destination. */
  source: ExportSource | null;
  /** Currently selected clip ids; the export set for rename disambiguation. */
  selectedClipIds: Set<string>;
  /** The focused (blue-bar) clip on the left; the 示例 previews its filename. */
  previewClip: ExportClip | null;
}

export function ExportSettingsSection({
  settings,
  onUpdateSettings,
  sourceChannels,
  source,
  selectedClipIds,
  previewClip,
}: ExportSettingsSectionProps) {
  // Only one settings group stays expanded at a time; 重命名规则 is open by default.
  const [openGroup, setOpenGroup] = useState<ExportSettingsGroupId | null>("rename");

  function toggleGroup(group: ExportSettingsGroupId) {
    setOpenGroup((current) => (current === group ? null : group));
  }

  const frameRateValue = settings.frameRate === null ? "source" : String(settings.frameRate);
  const audioFormat = audioFormatOfCodec(settings.audioCodec);
  const audioSampleRateValue =
    settings.audioSampleRateHz === null ? "source" : String(settings.audioSampleRateHz);
  // The 文件夹 row shows the actual resolved target folder. `choose_later` is a
  // preset-only placeholder with no path, so it gets a hint instead.
  const folderLabel =
    settings.destination === "choose_later"
      ? "将在导出时选择文件夹"
      : settings.outputDir.trim() || "未选择输出位置";
  // 重命名规则 options depend on the export mode + source kind; when switching
  // between them the current rule may leave the option set, so snap it back.
  const renameRuleOptions = exportRenameRuleOptions(settings.mode, source?.kind ?? "media-bin");
  const renameRuleValid = renameRuleOptions.some(([value]) => value === settings.renameRule);
  const selectedClips = source?.clips.filter((clip) => selectedClipIds.has(clip.id)) ?? [];
  // The 示例 previews the currently focused (blue-bar) clip's filename, not the
  // first checked one. When it isn't checked itself, its name is shown standalone.
  const previewFileName = previewClip
    ? (computeExportFileNames(
        selectedClips.some((clip) => clip.id === previewClip.id) ? selectedClips : [previewClip],
        settings,
      ).find((entry) => entry.clipId === previewClip.id)?.fileName ?? "")
    : "";

  useEffect(() => {
    if (!renameRuleValid) {
      onUpdateSettings({ renameRule: "filename" });
    }
  }, [renameRuleValid, onUpdateSettings]);
  // Surround output is only offered when the source actually carries surround
  // audio, and MPEG (MP2/MP3) cannot encode more than two channels.
  const channelOptions = exportAudioChannelOptions(sourceChannels).filter(
    ([value]) => audioFormat !== "mpeg" || value !== "5.1",
  );
  const channelsValid = channelOptions.some(([value]) => value === settings.audioChannels);

  useEffect(() => {
    if (!channelsValid) {
      onUpdateSettings({ audioChannels: "stereo" });
    }
  }, [channelsValid, onUpdateSettings]);

  // Bitrate and sample-rate choices are format-specific; snap the selection back
  // to the nearest valid value when the current one falls outside the new
  // format's options.
  const bitrateOptions = exportAudioBitrateOptions(audioFormat);
  const bitrateValues = bitrateOptions.map(([value]) => Number(value));
  const bitrateValid = bitrateValues.includes(settings.audioBitrateKbps);

  useEffect(() => {
    if (!bitrateValid) {
      onUpdateSettings({
        audioBitrateKbps: nearestValue(bitrateValues, settings.audioBitrateKbps),
      });
    }
  }, [bitrateValid, settings.audioBitrateKbps, onUpdateSettings]);

  const sampleRateOptions = exportAudioSampleRateOptions(audioFormat);
  const sampleRateValues = sampleRateOptions
    .filter(([value]) => value !== "source")
    .map(([value]) => Number(value));
  const sampleRateValid =
    settings.audioSampleRateHz === null || sampleRateValues.includes(settings.audioSampleRateHz);

  useEffect(() => {
    if (!sampleRateValid) {
      onUpdateSettings({
        audioSampleRateHz: nearestValue(sampleRateValues, settings.audioSampleRateHz ?? 0),
      });
    }
  }, [sampleRateValid, settings.audioSampleRateHz, onUpdateSettings]);

  function changeContainer(container: ExportContainer) {
    const formats = exportAudioFormatOptions(container);
    const audioCodec = formats.some(([format]) => format === audioFormat)
      ? settings.audioCodec
      : defaultAudioCodecForFormat(formats[0][0]);
    onUpdateSettings({ container, audioCodec });
  }

  function changeAudioFormat(format: ExportAudioFormat) {
    // Picking MPEG keeps the current layer when one is already selected.
    const audioCodec =
      format === "mpeg" && (settings.audioCodec === "mp2" || settings.audioCodec === "mp3")
        ? settings.audioCodec
        : defaultAudioCodecForFormat(format);
    const updates: Partial<ExportSettings> = { audioCodec };
    // MP2/MP3 encoders are limited to two channels, so 5.1 is not viable for MPEG.
    if (format === "mpeg" && settings.audioChannels === "5.1") {
      updates.audioChannels = "stereo";
    }
    onUpdateSettings(updates);
  }

  /**
   * Picks the target folder for the 指定文件夹 destination. Merge mode also
   * writes into a folder now (the file name comes from the auto-derived output
   * stem), so the button is always a directory picker.
   */
  async function chooseOutputLocation() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择导出目录",
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (dir) {
      onUpdateSettings({ outputDir: dir });
      rememberExportDir(dir);
    }
  }

  /** Resolves the destination's target folder and records it as the base output dir. */
  async function handleDestinationChange(destination: ExportDestination) {
    if (destination === "specified") {
      // Restore the last folder the user explicitly picked; the button stays
      // enabled so they can choose a new one.
      onUpdateSettings({ destination, outputDir: readRememberedExportDir() });
      return;
    }
    onUpdateSettings({
      destination,
      outputDir: await resolveExportDestinationDir(destination, source),
    });
  }

  return (
    <section className="export-settings-panel">
      <div className="export-settings-fixed">
        <ExportField label="导出到">
          <SelectDropdown
            className="export-select"
            ariaLabel="导出到"
            value={settings.destination}
            items={destinationItems}
            onChange={(value) => void handleDestinationChange(value)}
          />
        </ExportField>

        <ExportField label="文件夹">
          <div className="export-output-location">
            <span className="export-output-path" title={folderLabel}>
              {folderLabel}
            </span>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void chooseOutputLocation()}
              disabled={settings.destination !== "specified"}
              title={
                settings.destination === "specified"
                  ? "选择导出目录"
                  : "仅“指定文件夹”时可手动选择目录"
              }
            >
              <FolderOpen size={14} />
              <span>选择</span>
            </button>
          </div>
        </ExportField>

        <div className="export-settings-subfolder">
          <label className="export-check-label">
            <input
              type="checkbox"
              checked={settings.useSubfolder}
              onChange={(event) => onUpdateSettings({ useSubfolder: event.target.checked })}
            />
            <span>存储到子文件夹：</span>
          </label>
          <input
            type="text"
            className="export-subfolder-input"
            value={settings.subfolderName}
            onChange={(event) => onUpdateSettings({ subfolderName: event.target.value })}
          />
        </div>

        <ExportField label="现有文件">
          <SelectDropdown
            className="export-select"
            ariaLabel="现有文件"
            value={settings.existingFileMode}
            items={existingFileModeItems}
            onChange={(value) => onUpdateSettings({ existingFileMode: value })}
          />
        </ExportField>

        <ExportField label="预设">
          <SelectDropdown
            className="export-select"
            ariaLabel="导出预设"
            disabled
            title="预设保存功能尚未开放"
            value="custom"
            items={selectDropdownItems(exportPresetOptions)}
            onChange={() => {}}
          />
        </ExportField>

        <ExportField label="格式">
          <SelectDropdown
            className="export-select"
            ariaLabel="导出格式"
            value={settings.container}
            items={selectDropdownItems(exportContainerOptions)}
            onChange={(value) => changeContainer(value)}
          />
        </ExportField>
      </div>

      <div className="export-settings-groups">
        <ExportSettingsGroup
          title="重命名规则"
          open={openGroup === "rename"}
          onToggle={() => toggleGroup("rename")}
        >
          <ExportField label="重命名为">
            <SelectDropdown
              className="export-select"
              ariaLabel="重命名为"
              value={settings.renameRule}
              items={selectDropdownItems(renameRuleOptions)}
              onChange={(value) => onUpdateSettings({ renameRule: value })}
            />
          </ExportField>

          <ExportField label="自定文本">
            <input
              type="text"
              className="export-subfolder-input export-rename-custom-input"
              value={settings.customName}
              disabled={!renameRuleUsesCustom(settings.renameRule)}
              onChange={(event) => onUpdateSettings({ customName: event.target.value })}
            />
          </ExportField>

          <div className="export-rename-inline">
            <ExportField label="起始编号">
              <input
                type="number"
                min={0}
                className="export-subfolder-input"
                value={settings.startNumber}
                aria-label="起始编号"
                onChange={(event) =>
                  onUpdateSettings({
                    startNumber: Math.max(0, Math.round(Number(event.target.value) || 0)),
                  })
                }
              />
            </ExportField>
            <ExportField label="扩展名">
              <SelectDropdown
                className="export-select"
                ariaLabel="扩展名大小写"
                value={settings.extensionCase}
                items={selectDropdownItems(exportExtensionCaseOptions)}
                onChange={(value) => onUpdateSettings({ extensionCase: value })}
              />
            </ExportField>
          </div>

          <ExportField label="示例">
            <span className="export-rename-preview" title={previewFileName}>
              {previewFileName || "—"}
            </span>
          </ExportField>
        </ExportSettingsGroup>

        <ExportSettingsGroup
          title="视频"
          open={openGroup === "video"}
          onToggle={() => toggleGroup("video")}
        >
          <ExportField label="分辨率" stacked={settings.resolution === "custom"}>
            <div className="export-resolution-control">
              <SelectDropdown
                className="export-select"
                ariaLabel="导出分辨率"
                value={settings.resolution}
                items={selectDropdownItems(exportResolutionOptions)}
                onChange={(value) => onUpdateSettings({ resolution: value })}
              />
              {settings.resolution === "custom" && (
                <div className="export-custom-resolution">
                  <input
                    type="number"
                    min={2}
                    value={settings.customWidth}
                    onChange={(event) =>
                      onUpdateSettings({
                        customWidth: Math.max(2, Math.round(Number(event.target.value) || 2)),
                      })
                    }
                    aria-label="自定义宽度"
                  />
                  <span>×</span>
                  <input
                    type="number"
                    min={2}
                    value={settings.customHeight}
                    onChange={(event) =>
                      onUpdateSettings({
                        customHeight: Math.max(2, Math.round(Number(event.target.value) || 2)),
                      })
                    }
                    aria-label="自定义高度"
                  />
                </div>
              )}
            </div>
          </ExportField>

          <ExportField label="帧率">
            <SelectDropdown
              className="export-select"
              ariaLabel="导出帧率"
              value={frameRateValue}
              items={selectDropdownItems(frameRateOptions)}
              onChange={(value) =>
                onUpdateSettings({ frameRate: value === "source" ? null : Number(value) })
              }
            />
          </ExportField>

          <ExportField label="质量">
            <SelectDropdown
              className="export-select"
              ariaLabel="导出质量"
              value={settings.quality}
              items={selectDropdownItems(exportQualityOptions)}
              onChange={(value) => onUpdateSettings({ quality: value })}
            />
          </ExportField>

          <ExportField label="编码速度">
            <SelectDropdown
              className="export-select"
              ariaLabel="编码速度"
              value={settings.encoderSpeed}
              items={selectDropdownItems(exportEncoderSpeedOptions)}
              onChange={(value) => onUpdateSettings({ encoderSpeed: value })}
            />
          </ExportField>
        </ExportSettingsGroup>

        <ExportSettingsGroup
          title="音频"
          open={openGroup === "audio"}
          onToggle={() => toggleGroup("audio")}
          enabled={settings.includeAudio}
          onEnabledChange={(includeAudio) => onUpdateSettings({ includeAudio })}
          switchAriaLabel="包含音频"
        >
          <h3 className="export-settings-subheading">音频格式设置</h3>
          <ExportField label="音频格式">
            <SelectDropdown
              className="export-select"
              ariaLabel="音频格式"
              disabled={!settings.includeAudio}
              title="可选范围由导出格式决定"
              value={audioFormat}
              items={selectDropdownItems(exportAudioFormatOptions(settings.container))}
              onChange={(value) => changeAudioFormat(value)}
            />
          </ExportField>

          <h3 className="export-settings-subheading">基本音频设置</h3>
          <ExportField label="采样率">
            <SelectDropdown
              className="export-select"
              ariaLabel="采样率"
              disabled={!settings.includeAudio}
              title="可选范围由音频格式决定"
              value={audioSampleRateValue}
              items={selectDropdownItems(sampleRateOptions)}
              onChange={(value) =>
                onUpdateSettings({ audioSampleRateHz: value === "source" ? null : Number(value) })
              }
            />
          </ExportField>

          <ExportField label="声道">
            <SelectDropdown
              className="export-select"
              ariaLabel="声道"
              disabled={!settings.includeAudio}
              title="可选范围取决于源视频的声道数"
              value={settings.audioChannels}
              items={selectDropdownItems(channelOptions)}
              onChange={(value) => onUpdateSettings({ audioChannels: value })}
            />
          </ExportField>

          {audioFormat === "mpeg" && (
            <ExportField label="音频层">
              <SelectDropdown
                className="export-select"
                ariaLabel="音频层"
                disabled={!settings.includeAudio}
                value={settings.audioCodec}
                items={selectDropdownItems(exportAudioLayerOptions)}
                onChange={(value) => onUpdateSettings({ audioCodec: value })}
              />
            </ExportField>
          )}

          <h3 className="export-settings-subheading">比特率设置</h3>
          <ExportField label="比特率[kbps]">
            <SelectDropdown
              className="export-select"
              ariaLabel="音频比特率"
              disabled={!settings.includeAudio}
              title="可选范围由音频格式决定"
              value={String(settings.audioBitrateKbps)}
              items={selectDropdownItems(bitrateOptions)}
              onChange={(value) => onUpdateSettings({ audioBitrateKbps: Number(value) })}
            />
          </ExportField>
        </ExportSettingsGroup>

        <ExportSettingsGroup
          title="常规"
          open={openGroup === "general"}
          onToggle={() => toggleGroup("general")}
        >
          <div className="export-settings-checks">
            <label className="export-check-label">
              <input
                type="checkbox"
                checked={settings.mode === "merge"}
                onChange={(event) =>
                  onUpdateSettings({ mode: event.target.checked ? "merge" : "individual" })
                }
              />
              <span>合并为一个视频</span>
            </label>
            <label className="export-check-label" title="导出成功后把产物自动导入媒体箱">
              <input
                type="checkbox"
                checked={settings.importIntoProject}
                onChange={(event) => onUpdateSettings({ importIntoProject: event.target.checked })}
              />
              <span>导入项目中</span>
            </label>
            <label className="export-check-label" title="有代理文件时用代理代替原始素材导出">
              <input
                type="checkbox"
                checked={settings.useProxy}
                onChange={(event) => onUpdateSettings({ useProxy: event.target.checked })}
              />
              <span>使用代理</span>
            </label>
          </div>
        </ExportSettingsGroup>
      </div>
    </section>
  );
}
