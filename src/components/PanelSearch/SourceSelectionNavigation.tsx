import { ChevronLeft, ChevronRight } from "lucide-react";
import "./PanelSearch.css";

export function SourceSelectionNavigation({
  canGoBack,
  canGoForward,
  onNavigate,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (direction: -1 | 1) => void;
}) {
  return (
    <div className="panel-source-navigation" aria-label="切换工作区来源历史">
      <button
        type="button"
        disabled={!canGoBack}
        title="上一个来源选择"
        aria-label="上一个来源选择"
        onClick={() => onNavigate(-1)}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={!canGoForward}
        title="下一个来源选择"
        aria-label="下一个来源选择"
        onClick={() => onNavigate(1)}
      >
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );
}
