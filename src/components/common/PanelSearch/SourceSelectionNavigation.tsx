import { ChevronLeft, ChevronRight } from "lucide-react";
import "./PanelSearch.css";

export function SourceSelectionNavigation({
  canGoBack,
  canGoForward,
  locked,
  onLockChange,
  onNavigate,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  locked: boolean;
  onLockChange: (locked: boolean) => void;
  onNavigate: (direction: -1 | 1) => void;
}) {
  return (
    <div className="panel-source-navigation" aria-label="作用域锁定与来源历史">
      <button
        type="button"
        disabled={locked || !canGoBack}
        title="上一个来源选择"
        aria-label="上一个来源选择"
        onClick={() => onNavigate(-1)}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`panel-source-lock ${locked ? "active" : ""}`}
        title={locked ? "解锁作用域" : "锁定作用域"}
        aria-label={locked ? "解锁作用域" : "锁定作用域"}
        aria-pressed={locked}
        onClick={() => onLockChange(!locked)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            fillRule="evenodd"
            stroke="none"
            d={
              locked
                ? "M7 10V7a5 5 0 0 1 10 0v3h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2Zm3 0h4V7a2 2 0 1 0-4 0v3Zm1 4h2v4h-2v-4Z"
                : "M7 10V7a5 5 0 0 1 10 0h-3a2 2 0 1 0-4 0v3H7ZM5 10h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm6 4h2v4h-2v-4Z"
            }
          />
        </svg>
      </button>
      <button
        type="button"
        disabled={locked || !canGoForward}
        title="下一个来源选择"
        aria-label="下一个来源选择"
        onClick={() => onNavigate(1)}
      >
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );
}
