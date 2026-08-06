import { ChevronDown, FolderOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import type {
  ExportAudioFormat,
  ExportContainer,
  ExportSettings,
} from "../../systems/ExportSystem";
import {
  audioFormatOfCodec,
  defaultAudioCodecForFormat,
  exportAudioBitrateOptions,
  exportAudioChannelOptions,
  exportAudioFormatOptions,
  exportAudioLayerOptions,
  exportAudioSampleRateOptions,
  exportContainerOptions,
  exportEncoderSpeedOptions,
  exportQualityOptions,
  exportResolutionOptions,
  readRememberedExportDir,
  rememberExportDir,
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

export function containerExtension(container: ExportContainer) {
  switch (container) {
    case "mp4_h264":
    case "mp4_hevc":
      return "mp4";
    case "mov_prores":
      return "mov";
    case "webm_vp9":
      return "webm";
  }
}

function dirname(path: string) {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}

function fileStem(path: string) {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "") || "导出";
}

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

type ExportSettingsGroupId = "video" | "audio" | "general";

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
}

export function ExportSettingsSection({
  settings,
  onUpdateSettings,
  sourceChannels,
}: ExportSettingsSectionProps) {
  // Only one settings group stays expanded at a time; 视频 is open by default.
  const [openGroup, setOpenGroup] = useState<ExportSettingsGroupId | null>("video");

  function toggleGroup(group: ExportSettingsGroupId) {
    setOpenGroup((current) => (current === group ? null : group));
  }

  const frameRateValue = settings.frameRate === null ? "source" : String(settings.frameRate);
  const audioFormat = audioFormatOfCodec(settings.audioCodec);
  const audioSampleRateValue =
    settings.audioSampleRateHz === null ? "source" : String(settings.audioSampleRateHz);
  const outputDir = settings.outputDir.trim() ? settings.outputDir : readRememberedExportDir();
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

  async function chooseOutputLocation() {
    if (settings.mode === "merge") {
      const picked = await save({
        title: "选择导出位置",
        defaultPath: `${settings.outputStem.trim() || "导出"}.${containerExtension(settings.container)}`,
        filters: [
          {
            name: "视频文件",
            extensions: [containerExtension(settings.container)],
          },
        ],
      });
      if (!picked) {
        return;
      }
      const dir = dirname(picked);
      const stem = fileStem(picked);
      onUpdateSettings({ outputDir: dir, outputStem: stem });
      rememberExportDir(dir);
      return;
    }
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

  return (
    <section className="export-settings-panel">
      <div className="export-settings-fixed">
        <ExportField label="文件名">
          <input
            type="text"
            className="export-text-input"
            value={settings.outputStem}
            placeholder="导出文件名"
            onChange={(event) => onUpdateSettings({ outputStem: event.target.value })}
          />
        </ExportField>

        <ExportField label="位置">
          <div className="export-output-location">
            <span className="export-output-path" title={outputDir}>
              {outputDir.trim() ? outputDir : "未选择输出位置"}
            </span>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => void chooseOutputLocation()}
              title={settings.mode === "merge" ? "选择导出文件" : "选择导出目录"}
            >
              <FolderOpen size={14} />
              <span>选择</span>
            </button>
          </div>
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
