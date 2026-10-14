import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  runStillExportTask,
  stillFormats,
  type StillExportRequest,
  type StillFormat,
} from "../../../application/media/stillExportTask";
import { invokeCommand, runBackgroundOperation, runOperation } from "../../../errors";
import { ModalDialog } from "../ModalDialog";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import "./StillExportDialog.css";

interface StillExportDefaults {
  name: string;
  directory: string;
}

export function StillExportDialog({
  request,
  onClose,
}: {
  request: StillExportRequest;
  onClose: () => void;
}) {
  const [defaults, setDefaults] = useState<StillExportDefaults | null>(null);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [format, setFormat] = useState<StillFormat>("png");
  const [importIntoProject, setImportIntoProject] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      const outcome = await runOperation("export.run", () =>
        invokeCommand<StillExportDefaults>("still_export_defaults", {
          mediaName: request.mediaName,
          timecode: request.timecode,
          directory: null,
        }),
      );
      if (!aliveRef.current || outcome.status !== "success") return;
      setDefaults(outcome.value);
      setName(outcome.value.name);
      setDirectory(outcome.value.directory);
    })();
    return () => {
      aliveRef.current = false;
    };
  }, [request]);

  useEffect(() => {
    if (defaults) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [defaults]);

  async function browse() {
    setChoosingDirectory(true);
    const outcome = await runOperation("export.run", () =>
      openDialog({
        directory: true,
        multiple: false,
        defaultPath: directory,
        title: "选择导出位置",
      }),
    );
    if (!aliveRef.current) return;
    const selected = outcome.status === "success" ? outcome.value : null;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (path) {
      setDirectory(path);
      const automaticName = name === defaults?.name;
      const next = await runOperation("export.run", () =>
        invokeCommand<StillExportDefaults>("still_export_defaults", {
          mediaName: request.mediaName,
          timecode: request.timecode,
          directory: path,
        }),
      );
      if (!aliveRef.current) return;
      if (next.status === "success") {
        setDefaults(next.value);
        if (automaticName) setName(next.value.name);
      }
    }
    setChoosingDirectory(false);
  }

  const validName = Boolean(
    name.trim() &&
    name === name.trim() &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
  );
  const canConfirm = Boolean(defaults && validName && directory && !choosingDirectory);

  function confirm() {
    if (!canConfirm) return;
    onClose();
    runBackgroundOperation("export.run", () =>
      runStillExportTask(request, {
        name,
        automaticName: name === defaults?.name,
        directory,
        format,
        importIntoProject,
      }),
    );
  }

  return createPortal(
    <ModalDialog
      title="导出帧"
      className="still-export-dialog"
      bodyClassName="still-export-dialog-body"
      confirmLabel="确定"
      cancelLabel="取消"
      closeTitle="关闭"
      confirmDisabled={!canConfirm}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="still-export-field">
        <label htmlFor="still-export-name">名称：</label>
        <input
          ref={nameRef}
          id="still-export-name"
          value={name}
          disabled={!defaults || choosingDirectory}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirm();
            }
          }}
        />
      </div>
      <div className="still-export-field">
        <span>格式：</span>
        <SelectDropdown
          ariaLabel="格式"
          className="still-export-format"
          menuClassName="still-export-format-menu"
          placement="bottom"
          value={format}
          items={selectDropdownItems([...stillFormats])}
          onChange={setFormat}
        />
      </div>
      <div className="still-export-path">
        <span>路径：</span>
        <span title={directory}>{directory}</span>
      </div>
      <div className="still-export-destination">
        <label>
          <input
            type="checkbox"
            checked={importIntoProject}
            onChange={(event) => setImportIntoProject(event.currentTarget.checked)}
          />
          导入到项目中
        </label>
        <button
          type="button"
          onClick={() => void browse()}
          disabled={!defaults || choosingDirectory}
        >
          浏览...
        </button>
      </div>
    </ModalDialog>,
    document.body,
  );
}
