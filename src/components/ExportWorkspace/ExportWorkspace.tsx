import { useEffect, useRef } from "react";
import { useProjectPort } from "../../systems/ProjectSystem";
import {
  readRememberedExportDir,
  useExportWorkspaceState,
  type ExportSource,
} from "../../systems/ExportSystem";
import { ExportActionBar } from "./ExportActionBar";
import { ExportSettingsSection } from "./ExportSettingsSection";
import { ExportSourceList } from "./ExportSourceList";
import "./ExportWorkspace.css";

function suggestedStem(projectFilePath: string | null, source: ExportSource | null) {
  if (projectFilePath) {
    const stem = projectFilePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.lcp$/i, "");
    if (stem) {
      return stem;
    }
  }
  const firstPath = source?.clips[0]?.sourcePath;
  if (firstPath) {
    const stem = firstPath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "");
    if (stem) {
      return stem;
    }
  }
  return "导出";
}

export function ExportWorkspace() {
  const source = useExportWorkspaceState((state) => state.source);
  const selectedClipIds = useExportWorkspaceState((state) => state.selectedClipIds);
  const settings = useExportWorkspaceState((state) => state.settings);
  const toggleClip = useExportWorkspaceState((state) => state.toggleClip);
  const setAllSelected = useExportWorkspaceState((state) => state.setAllSelected);
  const updateSettings = useExportWorkspaceState((state) => state.updateSettings);
  const { projectFilePath } = useProjectPort(["projectFilePath"], []);

  const sourceKey = source ? `${source.kind}:${source.clips.length}:${source.assetId ?? ""}` : null;
  const lastSourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!source || sourceKey === lastSourceKeyRef.current) {
      return;
    }
    lastSourceKeyRef.current = sourceKey;
    const updates: Partial<typeof settings> = {};
    if (!settings.outputStem.trim()) {
      updates.outputStem = suggestedStem(projectFilePath, source);
    }
    if (!settings.outputDir.trim()) {
      const remembered = readRememberedExportDir();
      if (remembered) {
        updates.outputDir = remembered;
      }
    }
    if (Object.keys(updates).length > 0) {
      updateSettings(updates);
    }
  }, [projectFilePath, settings.outputDir, settings.outputStem, source, sourceKey, updateSettings]);

  if (!source) {
    return (
      <section className="export-workspace" aria-label="导出工作区">
        <header className="export-workspace-heading">
          <div>
            <span className="export-workspace-eyebrow">输出</span>
            <h1>导出</h1>
            <p>
              在「编辑」工作区的分镜、字幕或媒体库中选中片段，右键选择「导出选中片段」即可在此设置并导出。
            </p>
          </div>
        </header>
        <div className="export-workspace-empty">
          <p>尚未选择要导出的片段。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="export-workspace" aria-label="导出工作区">
      <header className="export-workspace-heading">
        <div>
          <span className="export-workspace-eyebrow">输出</span>
          <h1>导出</h1>
          <p>{source.title}——在左侧勾选要导出的片段，设置输出参数后开始导出。</p>
        </div>
        <span className="export-workspace-limit">
          已选 {selectedClipIds.size} / {source.clips.length} 个片段
        </span>
      </header>

      <div className="export-workspace-main">
        <ExportSourceList
          source={source}
          selectedClipIds={selectedClipIds}
          onToggleClip={toggleClip}
          onSetAllSelected={setAllSelected}
        />
        <ExportSettingsSection settings={settings} onUpdateSettings={updateSettings} />
      </div>

      <ExportActionBar />
    </section>
  );
}
