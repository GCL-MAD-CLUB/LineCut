import { AlertCircle } from "lucide-react";

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
      <svg viewBox="0 0 100 88" fill="none" aria-hidden="true">
        <path d="M8 20V12a6 6 0 0 1 6-6h25l13 12H8Z" fill="currentColor" />
        <path
          d="M8 19h77a6 6 0 0 1 6 6v49a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6V19Z"
          fill="#535353"
          stroke="currentColor"
          strokeWidth="2.5"
        />
      </svg>
      <span className="import-folder-count">{count.toLocaleString()}</span>
      {hasErrors && <AlertCircle className="import-folder-warning" aria-hidden="true" />}
    </span>
  );
}
