import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileVideo, Folder, FolderOpen, HardDrive, Loader2, Save, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { defaultPreferences, useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { Preferences } from "../../types";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";

const executableFilters = [
  {
    name: "Executable",
    extensions: ["exe"],
  },
];

interface PreferencesDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PreferencesDialog({ open: isOpen, onClose }: PreferencesDialogProps) {
  const preferences = useAppStore((state) => state.preferences);
  const setPreferences = useAppStore((state) => state.setPreferences);
  const setMessage = useAppStore((state) => state.setMessage);
  const { isRunning: isSavingPreferences } = getTaskProgressStatus("preferences");
  const [draftPreferences, setDraftPreferences] = useState<Preferences>(preferences);

  useEffect(() => {
    if (isOpen) {
      setDraftPreferences(preferences);
    }
  }, [isOpen, preferences]);

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
    const preferencesTask = createTaskProgress({
      operation: "preferences",
      label: "保存首选项",
      current: 0,
      total: 1,
      on_cancel: () => undefined,
    });
    try {
      const saved = await invoke<Preferences>("update_preferences", {
        preferences: draftPreferences,
      });
      setPreferences(saved);
      setDraftPreferences(saved);
      onClose();
      setMessage("首选项已保存");
      preferencesTask.update({ current: 1 });
      preferencesTask.remove();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      preferencesTask.fail("保存首选项失败", errorMessage);
      setMessage(errorMessage);
    }
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="preferences-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">应用首选项</span>
            <h2>路径与媒体工具</h2>
          </div>
          <button className="tool-button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="preference-fields">
          <PathField
            label="缓存路径"
            value={draftPreferences.cache_dir}
            icon={<HardDrive size={15} />}
            onChange={(value) =>
              setDraftPreferences((current) => ({ ...current, cache_dir: value }))
            }
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
            onChange={(value) =>
              setDraftPreferences((current) => ({ ...current, ffmpeg_path: value }))
            }
            onBrowse={() => chooseExecutable("ffmpeg_path")}
          />
          <PathField
            label="ffprobe"
            value={draftPreferences.ffprobe_path}
            icon={<FileVideo size={15} />}
            onChange={(value) =>
              setDraftPreferences((current) => ({ ...current, ffprobe_path: value }))
            }
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
          <button
            className="accent-button"
            onClick={savePreferences}
            disabled={isSavingPreferences}
          >
            {isSavingPreferences ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            保存
          </button>
        </div>
      </section>
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
