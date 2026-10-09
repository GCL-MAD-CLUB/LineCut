import { ChevronLeft, ChevronRight, ChevronsUpDown, Search } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  canHighlightSearchRule,
  textSearchRanges,
  type SearchMode,
  type SearchRange,
  type SearchRule,
} from "../../../core/editor/textSearch";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  useCloseOnOutsidePointer,
} from "../PopupMenu";
import "./PanelSearch.css";

const ruleLabels: Record<SearchRule, string> = {
  contains: "包含",
  containsAll: "包含所有",
  containsWords: "包含单词",
  doesNotContain: "不含",
  startsWith: "开头为",
  endsWith: "结尾为",
  isEmpty: "为空",
  isNotEmpty: "不为空",
};
const scopeLabels = { any: "任何可搜索的字段", title: "标题", keywords: "关键字" };
type SearchScope = keyof typeof scopeLabels;

interface PanelSearchProps {
  label: string;
  query: string;
  mode: SearchMode;
  rule: SearchRule;
  scope?: SearchScope;
  disabled: boolean;
  canNavigate: boolean;
  matchCount?: number;
  activeMatchNumber?: number;
  summary: ReactNode;
  onQueryChange: (query: string) => void;
  onModeChange: (mode: SearchMode) => void;
  onRuleChange: (rule: SearchRule) => void;
  onScopeChange?: (scope: SearchScope) => void;
  onMatchNumberChange?: (matchNumber: number) => void;
  onNavigate: (direction: -1 | 1) => void;
}

export function PanelSearch({
  label,
  query,
  mode,
  rule,
  scope,
  disabled,
  canNavigate,
  matchCount = 0,
  activeMatchNumber = 0,
  summary,
  onQueryChange,
  onModeChange,
  onRuleChange,
  onScopeChange,
  onMatchNumberChange,
  onNavigate,
}: PanelSearchProps) {
  const [menu, setMenu] = useState<{
    kind: "mode" | "scope" | "rule";
    x: number;
    y: number;
  } | null>(null);
  const [matchDraft, setMatchDraft] = useState<string | null>(null);
  useCloseOnOutsidePointer(Boolean(menu), () => setMenu(null));
  useEffect(() => {
    setMenu(null);
    setMatchDraft(null);
  }, [disabled, mode, rule, scope]);

  const navigationDisabled = disabled || mode !== "highlight" || !query.trim() || !canNavigate;
  const showMatchCount = !disabled && mode === "highlight" && matchCount > 0;
  const matchDigits = Math.max(1, String(matchCount).length);

  function commitMatchNumber() {
    if (matchDraft === null) {
      return;
    }
    setMatchDraft(null);
    const target = Number.parseInt(matchDraft, 10);
    if (!Number.isFinite(target) || matchCount <= 0) {
      return;
    }
    const clamped = Math.min(Math.max(target, 1), matchCount);
    if (clamped === activeMatchNumber) {
      return;
    }
    onMatchNumberChange?.(clamped);
  }

  function dropdown(kind: "mode" | "scope" | "rule", name: string, value: string) {
    return (
      <button
        type="button"
        className={`panel-search-dropdown panel-search-${kind} ${menu?.kind === kind ? "active" : ""}`}
        disabled={disabled}
        aria-label={`${label}搜索${name}：${value}`}
        aria-haspopup="menu"
        aria-expanded={menu?.kind === kind}
        onPointerDown={(event) => {
          if (menu?.kind === kind) event.stopPropagation();
        }}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenu(menu?.kind === kind ? null : { kind, x: bounds.left, y: bounds.bottom });
        }}
      >
        <span className="panel-search-option-label">{name}：</span>
        <span className="panel-search-option-value">{value}</span>
        <ChevronsUpDown aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="panel-search-row">
      <label className="panel-search-input">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={`搜索${label}`}
          aria-label={`搜索${label}`}
          disabled={disabled}
        />
      </label>
      <span className="panel-search-separator" aria-hidden="true" />
      {dropdown("mode", "模式", mode === "filter" ? "过滤" : "高亮")}
      <div className="panel-search-navigation" aria-label="切换搜索结果">
        <button
          type="button"
          disabled={navigationDisabled}
          title="上一个搜索项（←）"
          aria-label="上一个搜索项"
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        {showMatchCount && (
          <span className="panel-search-count">
            <input
              className="panel-search-count-input"
              value={matchDraft ?? (activeMatchNumber > 0 ? String(activeMatchNumber) : "")}
              style={{ width: `calc(${matchDigits}ch + 4px)` }}
              inputMode="numeric"
              aria-label={`跳转到第几条${label}搜索结果，共 ${matchCount} 条`}
              onFocus={(event) => {
                setMatchDraft(activeMatchNumber > 0 ? String(activeMatchNumber) : "");
                event.currentTarget.select();
              }}
              onChange={(event) => setMatchDraft(event.currentTarget.value.replace(/\D+/g, ""))}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => commitMatchNumber()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitMatchNumber();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setMatchDraft(null);
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="panel-search-count-slash">/</span>
            <span className="panel-search-count-total">{matchCount}</span>
          </span>
        )}
        <button
          type="button"
          disabled={navigationDisabled}
          title="下一个搜索项（→）"
          aria-label="下一个搜索项"
          onClick={() => onNavigate(1)}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      {scope !== undefined && (
        <>
          <span className="panel-search-separator" aria-hidden="true" />
          {dropdown("scope", "范围", scopeLabels[scope])}
        </>
      )}
      <span className="panel-search-separator" aria-hidden="true" />
      {dropdown("rule", "规则", ruleLabels[rule])}
      <span className="panel-search-summary">{summary}</span>
      {menu &&
        createPortal(
          <PopupMenu
            className="panel-search-menu"
            contextMenuAnchor={menu}
            ariaLabel={`${label}搜索${menu.kind === "mode" ? "模式" : menu.kind === "scope" ? "范围" : "规则"}`}
            style={{ position: "fixed", left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {menu.kind === "mode"
              ? (["filter", "highlight"] as const).map((value) => (
                  <PopupMenuItem
                    key={value}
                    checked={mode === value}
                    onSelect={() => {
                      onModeChange(value);
                      setMenu(null);
                    }}
                  >
                    {value === "filter" ? "过滤" : "高亮"}
                  </PopupMenuItem>
                ))
              : menu.kind === "scope"
                ? (Object.keys(scopeLabels) as SearchScope[]).map((value) => (
                    <Fragment key={value}>
                      <PopupMenuItem
                        checked={scope === value}
                        onSelect={() => {
                          onScopeChange?.(value);
                          setMenu(null);
                        }}
                      >
                        {scopeLabels[value]}
                      </PopupMenuItem>
                      {value === "any" && <PopupMenuSeparator />}
                    </Fragment>
                  ))
                : (Object.keys(ruleLabels) as SearchRule[]).map((value) => (
                    <Fragment key={value}>
                      {(value === "startsWith" || value === "isEmpty") && <PopupMenuSeparator />}
                      <PopupMenuItem
                        checked={rule === value}
                        disabled={mode === "highlight" && !canHighlightSearchRule(value)}
                        onSelect={() => {
                          onRuleChange(value);
                          setMenu(null);
                        }}
                      >
                        {ruleLabels[value]}
                      </PopupMenuItem>
                    </Fragment>
                  ))}
          </PopupMenu>,
          document.body,
        )}
    </div>
  );
}

export interface SearchHighlightOptions {
  query: string;
  rule: SearchRule;
  matchingIds: ReadonlySet<string>;
  focusedId: string | null;
}

export function SearchHighlight({
  text,
  search,
  itemId,
  searchFields,
  renderText = (value) => value,
}: {
  text: string;
  search: SearchHighlightOptions | undefined;
  itemId: string;
  searchFields?: readonly SearchRange[];
  renderText?: (text: string) => ReactNode;
}) {
  const ranges = search?.matchingIds.has(itemId)
    ? textSearchRanges(text, search.query, search.rule, searchFields)
    : [];
  if (!ranges.length) return renderText(text);
  let offset = 0;
  const parts: ReactNode[] = [];
  for (const range of ranges) {
    parts.push(
      <Fragment key={`text-${offset}`}>{renderText(text.slice(offset, range.start))}</Fragment>,
    );
    parts.push(
      <mark
        key={`match-${range.start}`}
        className={`panel-search-highlight ${search?.focusedId === itemId ? "is-focused" : ""}`}
      >
        {renderText(text.slice(range.start, range.end))}
      </mark>,
    );
    offset = range.end;
  }
  parts.push(<Fragment key={`text-${offset}`}>{renderText(text.slice(offset))}</Fragment>);
  return parts;
}

export function useSearchNavigation(
  panelRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onNavigate: (direction: -1 | 1) => void,
) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      const target = event.target as HTMLElement | null;
      if (!target || target.closest(".popup-menu")) return;
      const searchInput = target.closest(".panel-search-input");
      if (!searchInput && target.closest("input, textarea, select, [contenteditable='true']"))
        return;
      if (
        target !== panel &&
        !target.closest(".panel-search-row, [data-subtitle-cue-id], [data-storyboard-shot-id]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(event.key === "ArrowLeft" ? -1 : 1);
    };
    panel.addEventListener("keydown", handleKeyDown, true);
    return () => panel.removeEventListener("keydown", handleKeyDown, true);
  }, [panelRef, enabled, onNavigate]);
}
