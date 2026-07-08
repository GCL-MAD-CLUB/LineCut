import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { useAppStore } from "../../store";
import { isTauriRuntime } from "../../tauriRuntime";
import type { ProxyResult } from "../../types";
import type { ProxyCreationOptions } from "../ProxyCreationDialog";
import { removeTaskProgress, showTaskProgress } from "../TaskProgress";

export function useProxyController() {
  const isProxyDialogOpen = useAppStore((state) => state.proxyDialogOpen);
  const setProxyDialogOpen = useAppStore((state) => state.setProxyDialogOpen);
  const setProxyPath = useAppStore((state) => state.setProxyPath);
  const setUseProxy = useAppStore((state) => state.setUseProxy);
  const setIsGeneratingProxy = useAppStore((state) => state.setIsGeneratingProxy);
  const setBusyLabel = useAppStore((state) => state.setBusyLabel);
  const setMessage = useAppStore((state) => state.setMessage);

  const openProxyDialog = useCallback(() => setProxyDialogOpen(true), [setProxyDialogOpen]);
  const closeProxyDialog = useCallback(() => setProxyDialogOpen(false), [setProxyDialogOpen]);
  const enableProxy = useCallback(() => setUseProxy(true), [setUseProxy]);
  const disableProxy = useCallback(() => setUseProxy(false), [setUseProxy]);

  const generatePreview = useCallback(
    async (options: ProxyCreationOptions) => {
      const { project } = useAppStore.getState();
      if (!project) {
        return;
      }
      if (!isTauriRuntime()) {
        setMessage("浏览器预览不能生成代理，请运行 Tauri 桌面应用。");
        return;
      }

      const taskId = `proxy:${project.asset.id}`;
      setIsGeneratingProxy(true);
      setBusyLabel("正在生成预览代理");
      showTaskProgress({
        task_id: taskId,
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
          options,
        });
        setProxyPath(result.proxy_path);
        setUseProxy(true);
        setMessage("预览代理已生成");
      } catch (error) {
        removeTaskProgress(taskId);
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel("");
        setIsGeneratingProxy(false);
      }
    },
    [setBusyLabel, setIsGeneratingProxy, setMessage, setProxyPath, setUseProxy],
  );

  return {
    isProxyDialogOpen,
    openProxyDialog,
    closeProxyDialog,
    enableProxy,
    disableProxy,
    generatePreview,
  };
}
