import { AlertCircle } from "lucide-react";
import { ImportFolderIcon } from "./ImportFolderIcon";

/** The folder silhouette leaves its centre clear for the progressive media count. */
export function ImportFolderBadge({
  count,
  scanning,
  hasErrors,
}: {
  count: number;
  scanning: boolean;
  hasErrors: boolean;
}) {
  return (
    <span
      className={`import-folder-badge ${scanning ? "is-scanning" : ""}`}
      aria-label={`${count} 个可导入媒体${scanning ? "，正在扫描" : ""}${hasErrors ? "，部分文件夹无法读取" : ""}`}
      aria-busy={scanning}
    >
      <ImportFolderIcon />
      <span className="import-folder-count">{count.toLocaleString()}</span>
      {hasErrors && <AlertCircle className="import-folder-warning" aria-hidden="true" />}
    </span>
  );
}
