import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { runOperation } from "../../errors";
import { isTauriRuntime } from "../../tauriRuntime";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import type { ImportSettings } from "./importBrowserModel";

export function ImportSettingsPanel({
  settings,
  onChange,
  disabled,
  projectDirectory,
}: {
  settings: ImportSettings;
  onChange: (settings: ImportSettings) => void;
  disabled: boolean;
  projectDirectory: string;
}) {
  const [organizeOpen, setOrganizeOpen] = useState(true);
  const [copyOpen, setCopyOpen] = useState(true);
  function update(patch: Partial<ImportSettings>) {
    onChange({ ...settings, ...patch });
  }
  async function chooseDirectory() {
    if (!isTauriRuntime()) return;
    const outcome = await runOperation("media.import", () =>
      open({ directory: true, multiple: false, title: "复制媒体到" }),
    );
    if (outcome.status === "success" && typeof outcome.value === "string")
      update({ customDirectory: outcome.value, destination: "custom" });
  }
  return (
    <aside className="import-settings" aria-label="导入设置">
      <h2>导入设置</h2>
      <section>
        <button
          className="import-settings-heading"
          aria-expanded={organizeOpen}
          onClick={() => setOrganizeOpen(!organizeOpen)}
        >
          {organizeOpen ? <ChevronDown /> : <ChevronRight />}组织媒体
        </button>
        {organizeOpen && (
          <fieldset disabled={disabled} className="import-settings-body">
            <label className="import-checkbox-label">
              <input
                type="checkbox"
                checked={settings.newBin}
                onChange={(event) => update({ newBin: event.currentTarget.checked })}
              />
              添加到新媒体箱
            </label>
            <label className="import-field">
              名称
              <input
                value={settings.binName}
                placeholder="媒体箱"
                disabled={!settings.newBin}
                onChange={(event) => update({ binName: event.currentTarget.value })}
              />
            </label>
          </fieldset>
        )}
      </section>
      <section>
        <div className="import-settings-heading-row">
          <button
            className="import-settings-heading"
            aria-expanded={copyOpen}
            onClick={() => setCopyOpen(!copyOpen)}
          >
            {copyOpen ? <ChevronDown /> : <ChevronRight />}复制媒体
          </button>
          <button
            className="import-switch"
            role="switch"
            aria-label="复制媒体"
            aria-checked={settings.copy}
            disabled={disabled}
            onClick={() => update({ copy: !settings.copy })}
          >
            <span />
          </button>
        </div>
        {copyOpen && (
          <fieldset className="import-settings-body" disabled={disabled || !settings.copy}>
            <div className="import-field">
              预设
              <SelectDropdown
                ariaLabel="复制预设"
                disabled={disabled || !settings.copy}
                value={settings.verify ? "verify" : "copy"}
                items={selectDropdownItems([
                  ["verify", "复制并进行 MD5 校验"],
                  ["copy", "复制且不校验"],
                ])}
                onChange={(value) => update({ verify: value === "verify" })}
              />
            </div>
            <div className="import-field">
              复制文件的目标
              <SelectDropdown
                ariaLabel="复制文件的目标"
                disabled={disabled || !settings.copy}
                value={settings.destination}
                items={selectDropdownItems([
                  ["project", "与项目相同"],
                  ["custom", "选择文件夹…"],
                ])}
                onChange={(value) => {
                  update({ destination: value === "custom" ? "custom" : "project" });
                  if (value === "custom") void chooseDirectory();
                }}
              />
            </div>
            {settings.destination === "custom" ? (
              <button
                className="import-destination"
                title={settings.customDirectory}
                onClick={() => void chooseDirectory()}
              >
                {settings.customDirectory || "选择文件夹…"}
              </button>
            ) : (
              settings.copy && (
                <p className="import-setting-note">
                  {projectDirectory || "项目尚未保存，请选择复制目标文件夹。"}
                </p>
              )
            )}
          </fieldset>
        )}
      </section>
    </aside>
  );
}
