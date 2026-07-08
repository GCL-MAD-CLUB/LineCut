import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { listenToFfmpegTaskProgress } from "../../ffmpegProgress";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { ProxyResult } from "../../types";
import { ModalDialog } from "../ModalDialog";
import { SelectDropdown, selectDropdownItems, type SelectDropdownItem } from "../SelectDropdown";
import { createTaskProgress, getTaskProgressStatus } from "../TaskProgress";
import "./ProxyCreationDialog.css";

export type ProxyFrameSize = "full" | "half" | "quarter" | "custom";
export type ProxyPreset =
  | "prores_quicktime"
  | "h264_quicktime"
  | "h264_mp4"
  | "cineform_quicktime"
  | "dnxhr_vr_mono_quicktime"
  | "dnxhr_vr_stereo_quicktime";
export type ProxyWatermark = "none";
export type ProxyLocation = "source_proxy_folder" | "custom" | "preferences_cache";

export interface ProxyCreationOptions {
  frameSize: ProxyFrameSize;
  customWidth: number;
  customHeight: number;
  preset: ProxyPreset;
  watermark: ProxyWatermark;
  location: ProxyLocation;
  customLocation: string;
}

const frameSizeOptions: Array<[ProxyFrameSize, string]> = [
  ["full", "完整"],
  ["half", "二分之一"],
  ["quarter", "四分之一"],
  ["custom", "自定义"],
];

const presetOptions: Array<[ProxyPreset, string]> = [
  ["prores_quicktime", "ProRes QuickTime 代理"],
  ["h264_quicktime", "H.264 QuickTime 代理"],
  ["h264_mp4", "H.264 MP4 代理"],
  ["cineform_quicktime", "CineForm QuickTime 代理"],
  ["dnxhr_vr_mono_quicktime", "DNxHR VR Monoscopic QuickTime 代理"],
  ["dnxhr_vr_stereo_quicktime", "DNxHR VR Stereoscopic QuickTime 代理"],
];

function labelForLocation(location: ProxyLocation, customLocation: string, cacheDir: string) {
  if (location === "source_proxy_folder") {
    return "在原始媒体旁边，代理文件夹中";
  }
  if (location === "custom") {
    return customLocation || "选择位置...";
  }
  return cacheDir || "首选项缓存路径";
}

export function ProxyCreationDialog() {
  const cacheDir = useAppStore((state) => state.preferences.cache_dir);
  const project = useAppStore((state) => state.project);
  const isProxyDialogOpen = useAppStore((state) => state.proxyDialogOpen);
  const setProxyDialogOpen = useAppStore((state) => state.setProxyDialogOpen);
  const setProxyPath = useAppStore((state) => state.setProxyPath);
  const setUseProxy = useAppStore((state) => state.setUseProxy);
  const setMessage = useAppStore((state) => state.setMessage);
  const { isRunning: isGeneratingProxy } = getTaskProgressStatus("proxy");
  const [frameSize, setFrameSize] = useState<ProxyFrameSize>("full");
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(720);
  const [preset, setPreset] = useState<ProxyPreset>("prores_quicktime");
  const [watermark, setWatermark] = useState<ProxyWatermark>("none");
  const [location, setLocation] = useState<ProxyLocation>("source_proxy_folder");
  const [customLocation, setCustomLocation] = useState("");

  async function chooseCustomLocation(previousLocation: ProxyLocation) {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) {
        setCustomLocation(path);
        setLocation("custom");
      } else {
        setLocation(previousLocation);
      }
    } catch {
      setLocation(previousLocation);
    }
  }

  function changeLocation(value: string) {
    if (value === "choose") {
      void chooseCustomLocation(location);
      return;
    }
    setLocation(value as ProxyLocation);
  }

  const locationOptions: Array<SelectDropdownItem<string>> = [
    {
      type: "option",
      value: "source_proxy_folder",
      label: "在原始媒体旁边，代理文件夹中",
    },
    ...(customLocation
      ? [
          {
            type: "option" as const,
            value: "custom",
            label: customLocation,
          },
        ]
      : []),
    {
      type: "option",
      value: "choose",
      label: "选择位置...",
    },
    {
      type: "separator",
    },
    {
      type: "option",
      value: "preferences_cache",
      label: cacheDir || "首选项缓存路径",
    },
  ];

  async function generatePreview(options: ProxyCreationOptions) {
    if (!project) {
      return;
    }
    if (!isTauriRuntime()) {
      setMessage("浏览器预览不能生成代理，请运行 Tauri 桌面应用。");
      return;
    }

    const proxyTaskId = `proxy:${project.asset.id}`;
    let proxyCancelled = false;
    const proxyTask = createTaskProgress({
      operation: "proxy",
      label: "生成代理",
      current: 0,
      total: 1,
      on_cancel: async () => {
        proxyCancelled = true;
        await invoke<boolean>("cancel_current_task");
      },
    });
    const stopProgressListener = await listenToFfmpegTaskProgress(proxyTaskId, proxyTask);
    try {
      const result = await invoke<ProxyResult>("generate_proxy", {
        assetId: project.asset.id,
        options,
      });
      setProxyPath(result.proxy_path);
      setUseProxy(true);
      setMessage("预览代理已生成");
      proxyTask.update({ current: 1 });
      proxyTask.remove();
    } catch (error) {
      if (proxyCancelled) {
        setMessage("代理生成已取消");
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      proxyTask.fail("生成代理失败", errorMessage);
      setMessage(errorMessage);
    } finally {
      stopProgressListener();
    }
  }

  function closeProxyDialog() {
    setProxyDialogOpen(false);
  }

  function confirm() {
    closeProxyDialog();
    void generatePreview({
      frameSize,
      customWidth,
      customHeight,
      preset,
      watermark,
      location,
      customLocation,
    });
  }

  if (!isProxyDialogOpen) {
    return null;
  }

  return (
    <ModalDialog
      title="创建代理"
      bodyClassName="proxy-dialog-body"
      confirmDisabled={isGeneratingProxy}
      onCancel={closeProxyDialog}
      onConfirm={confirm}
    >
      <div className="proxy-dialog-field proxy-dialog-frame-size">
        <span>帧大小：</span>
        <div className="proxy-dialog-frame-size-controls">
          <ProxySelectControl
            value={frameSize}
            items={selectDropdownItems(frameSizeOptions)}
            onChange={(value) => setFrameSize(value as ProxyFrameSize)}
          />
          <div className="proxy-dialog-size-inputs">
            <label>
              宽
              <input
                type="number"
                min={2}
                step={2}
                value={customWidth}
                onChange={(event) => setCustomWidth(Number(event.currentTarget.value))}
                disabled={frameSize !== "custom"}
              />
            </label>
            <label>
              高
              <input
                type="number"
                min={2}
                step={2}
                value={customHeight}
                onChange={(event) => setCustomHeight(Number(event.currentTarget.value))}
                disabled={frameSize !== "custom"}
              />
            </label>
          </div>
        </div>
      </div>
      <ProxySelect
        label="预设"
        value={preset}
        options={presetOptions}
        onChange={(value) => setPreset(value as ProxyPreset)}
      />
      <ProxySelect
        label="水印"
        value={watermark}
        options={[["none", "无"]]}
        onChange={(value) => setWatermark(value as ProxyWatermark)}
      />
      <div className="proxy-dialog-field">
        <span>位置：</span>
        <ProxySelectControl
          value={location}
          selectedLabel={labelForLocation(location, customLocation, cacheDir)}
          items={locationOptions}
          onChange={changeLocation}
        />
      </div>
    </ModalDialog>
  );
}

interface ProxySelectProps {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}

function ProxySelect({ label, value, options, onChange }: ProxySelectProps) {
  return (
    <div className="proxy-dialog-field">
      <span>{label}：</span>
      <ProxySelectControl value={value} items={selectDropdownItems(options)} onChange={onChange} />
    </div>
  );
}

interface ProxySelectControlProps<T extends string = string> {
  value: string;
  selectedLabel?: string;
  items: Array<SelectDropdownItem<T>>;
  onChange: (value: T) => void;
}

function ProxySelectControl<T extends string>({
  value,
  selectedLabel,
  items,
  onChange,
}: ProxySelectControlProps<T>) {
  return (
    <SelectDropdown
      className="proxy-dialog-select"
      menuClassName="proxy-dialog-select-menu"
      value={value as T}
      selectedLabel={selectedLabel}
      items={items}
      onChange={onChange}
    />
  );
}
