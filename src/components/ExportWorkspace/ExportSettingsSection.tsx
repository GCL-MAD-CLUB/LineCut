import { FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import type { ExportContainer, ExportSettings } from "../../systems/ExportSystem";
import {
  exportContainerOptions,
  exportEncoderSpeedOptions,
  exportModeOptions,
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

const audioBitrateOptions: Array<readonly [string, string]> = [
  ["128", "128 kbps"],
  ["192", "192 kbps"],
  ["256", "256 kbps"],
  ["320", "320 kbps"],
];

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

interface ExportFieldProps {
  label: string;
  children: ReactNode;
}

function ExportField({ label, children }: ExportFieldProps) {
  return (
    <div className="export-settings-field">
      <span className="export-settings-field-label">{label}</span>
      <div className="export-settings-field-control">{children}</div>
    </div>
  );
}

interface ExportSettingsSectionProps {
  settings: ExportSettings;
  onUpdateSettings: (updates: Partial<ExportSettings>) => void;
}

export function ExportSettingsSection({ settings, onUpdateSettings }: ExportSettingsSectionProps) {
  const frameRateValue = settings.frameRate === null ? "source" : String(settings.frameRate);
  const outputDir = settings.outputDir.trim() ? settings.outputDir : readRememberedExportDir();

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
    <section className="export-settings-pane">
      <header className="export-pane-header">
        <div>
          <div className="export-pane-eyebrow">输出</div>
          <h2 className="export-pane-title">导出设置</h2>
        </div>
      </header>

      <div className="export-settings-body">
        <ExportField label="格式">
          <SelectDropdown
            className="export-select"
            ariaLabel="导出格式"
            value={settings.container}
            items={selectDropdownItems(exportContainerOptions)}
            onChange={(value) => onUpdateSettings({ container: value })}
          />
        </ExportField>

        <ExportField label="导出模式">
          <SelectDropdown
            className="export-select"
            ariaLabel="导出模式"
            value={settings.mode}
            items={selectDropdownItems(exportModeOptions)}
            onChange={(value) => onUpdateSettings({ mode: value })}
          />
        </ExportField>

        <ExportField label="分辨率">
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

        <ExportField label="包含音频">
          <label className="export-check-label">
            <input
              type="checkbox"
              checked={settings.includeAudio}
              onChange={(event) => onUpdateSettings({ includeAudio: event.target.checked })}
            />
            <span>输出片段内包含的音轨</span>
          </label>
        </ExportField>

        <ExportField label="音频码率">
          <SelectDropdown
            className="export-select"
            ariaLabel="音频码率"
            disabled={!settings.includeAudio}
            value={String(settings.audioBitrateKbps)}
            items={selectDropdownItems(audioBitrateOptions)}
            onChange={(value) => onUpdateSettings({ audioBitrateKbps: Number(value) })}
          />
        </ExportField>

        <ExportField label="文件名">
          <input
            type="text"
            className="export-text-input"
            value={settings.outputStem}
            placeholder="导出文件名"
            onChange={(event) => onUpdateSettings({ outputStem: event.target.value })}
          />
        </ExportField>

        <ExportField label="输出位置">
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

        <p className="export-path-preview">
          输出：{outputDir.trim() ? outputDir : "…"}
          {settings.mode === "merge"
            ? `\\${settings.outputStem.trim() || "导出"}.${containerExtension(settings.container)}`
            : `\\${settings.outputStem.trim() || "导出"}_001_…`}
        </p>
      </div>
    </section>
  );
}
