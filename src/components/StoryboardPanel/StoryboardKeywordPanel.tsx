import { ChevronsUpDown, ChevronDown, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StoryboardKeywordNode } from "../../types";
import {
  normalizeStoryboardKeywordIds,
  parseStoryboardKeywordInput,
  renderStoryboardKeywordLabel,
  sanitizeStoryboardKeywordInput,
  storyboardEffectiveKeywordIds,
  storyboardKeywordLabel,
  storyboardKeywordUsageCounts,
  suggestedStoryboardKeywordIds,
  visibleStoryboardKeywordIds,
} from "./storyboardKeywords";
import { useStoryboardPanelState } from "./storyboardPanelState";

interface StoryboardKeywordPanelProps {
  shotIds: readonly string[];
  resetKey: string;
}

interface KeywordPanelSectionProps {
  title: ReactNode;
  control?: ReactNode;
  open: boolean;
  className?: string;
  onToggle: () => void;
  children: ReactNode;
}

function KeywordPanelSection({
  title,
  control,
  open,
  className = "",
  onToggle,
  children,
}: KeywordPanelSectionProps) {
  return (
    <section className={`storyboard-keyword-section ${className}`.trim()}>
      <header
        className={`storyboard-keyword-section-header ${control ? "has-control" : ""}`.trim()}
      >
        <button
          type="button"
          className="storyboard-keyword-section-title"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span>{title}</span>
        </button>
        {control}
        <button
          type="button"
          className="storyboard-keyword-section-toggle"
          onClick={onToggle}
          aria-label={open ? `折叠${String(title)}` : `展开${String(title)}`}
          aria-expanded={open}
        >
          <ChevronDown className={open ? "" : "is-collapsed"} aria-hidden="true" />
        </button>
      </header>
      {open && <div className="storyboard-keyword-section-body">{children}</div>}
    </section>
  );
}

function keywordNodeOrder(left: StoryboardKeywordNode, right: StoryboardKeywordNode) {
  return left.name.localeCompare(right.name, "zh-CN");
}

export function StoryboardKeywordPanel({ shotIds, resetKey }: StoryboardKeywordPanelProps) {
  const {
    keywordNodes,
    recentKeywordIds,
    shots,
    shotAnnotations,
    appendShotKeywords,
    setShotKeywords,
    setShotKeywordActivation,
  } = useStoryboardPanelState((state) => state);
  const [keywordInput, setKeywordInput] = useState("");
  const [keywordEditValue, setKeywordEditValue] = useState("");
  const [keywordEditError, setKeywordEditError] = useState<string | null>(null);
  const [keywordEditorFocused, setKeywordEditorFocused] = useState(false);
  const [filter, setFilter] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [assignmentOpen, setAssignmentOpen] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(true);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedTreeNodeId, setSelectedTreeNodeId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keywordEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelKeywordEditRef = useRef(false);
  const targetShotIds = useMemo(() => Array.from(new Set(shotIds)), [shotIds]);
  const keywordParseResult = parseStoryboardKeywordInput(keywordInput);
  const mediaShotIds = useMemo(() => shots.map((shot) => shot.id), [shots]);

  useEffect(() => {
    setKeywordInput("");
    setKeywordEditValue("");
    setKeywordEditError(null);
    setFilter("");
    setCollapsedNodeIds(new Set());
    setSelectedTreeNodeId(null);
  }, [resetKey]);

  const usageCounts = useMemo(
    () => storyboardKeywordUsageCounts(keywordNodes, shotAnnotations, mediaShotIds),
    [keywordNodes, mediaShotIds, shotAnnotations],
  );
  const suggestedIds = useMemo(
    () =>
      suggestedStoryboardKeywordIds(recentKeywordIds, keywordNodes, shotAnnotations, mediaShotIds),
    [keywordNodes, mediaShotIds, recentKeywordIds, shotAnnotations],
  );
  const visibleRecentIds = useMemo(() => {
    const validIds = new Set(keywordNodes.map((node) => node.id));
    return Array.from(new Set(recentKeywordIds))
      .filter((keywordId) => validIds.has(keywordId))
      .slice(0, 18);
  }, [keywordNodes, recentKeywordIds]);

  const effectiveCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const shotId of targetShotIds) {
      for (const keywordId of storyboardEffectiveKeywordIds(
        shotAnnotations[shotId]?.keywordIds,
        keywordNodes,
      )) {
        counts.set(keywordId, (counts.get(keywordId) ?? 0) + 1);
      }
    }
    return counts;
  }, [keywordNodes, shotAnnotations, targetShotIds]);

  const directCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const shotId of targetShotIds) {
      for (const keywordId of normalizeStoryboardKeywordIds(
        shotAnnotations[shotId]?.keywordIds ?? [],
      )) {
        counts.set(keywordId, (counts.get(keywordId) ?? 0) + 1);
      }
    }
    return counts;
  }, [shotAnnotations, targetShotIds]);

  const selectedKeywordIds = useMemo(() => {
    const ids = new Set<string>();
    for (const shotId of targetShotIds) {
      for (const keywordId of visibleStoryboardKeywordIds(
        shotAnnotations[shotId]?.keywordIds,
        keywordNodes,
      )) {
        ids.add(keywordId);
      }
    }
    return Array.from(ids).sort((left, right) =>
      storyboardKeywordLabel(left, keywordNodes).localeCompare(
        storyboardKeywordLabel(right, keywordNodes),
        "zh-CN",
      ),
    );
  }, [keywordNodes, shotAnnotations, targetShotIds]);
  const selectedKeywordText = useMemo(
    () =>
      selectedKeywordIds
        .map((keywordId) => storyboardKeywordLabel(keywordId, keywordNodes))
        .filter(Boolean)
        .join(", "),
    [keywordNodes, selectedKeywordIds],
  );

  useEffect(() => {
    if (document.activeElement !== keywordEditorRef.current) {
      setKeywordEditValue(selectedKeywordText);
      setKeywordEditError(null);
    }
  }, [selectedKeywordText]);

  useEffect(() => {
    if (keywordEditorFocused) {
      keywordEditorRef.current?.focus();
    }
  }, [keywordEditorFocused]);

  const childrenByParent = useMemo(() => {
    const result = new Map<string | null, StoryboardKeywordNode[]>();
    for (const node of keywordNodes) {
      const parentId = node.parentId ?? null;
      const children = result.get(parentId) ?? [];
      children.push(node);
      result.set(parentId, children);
    }
    for (const children of result.values()) {
      children.sort(keywordNodeOrder);
    }
    return result;
  }, [keywordNodes]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const matchingTreeNodeIds = useMemo(() => {
    if (!normalizedFilter) {
      return new Set(keywordNodes.map((node) => node.id));
    }
    const matchingIds = new Set<string>();
    const visit = (node: StoryboardKeywordNode): boolean => {
      const childMatches = (childrenByParent.get(node.id) ?? []).some(visit);
      const selfMatches =
        node.name.toLocaleLowerCase().includes(normalizedFilter) ||
        storyboardKeywordLabel(node.id, keywordNodes)
          .toLocaleLowerCase()
          .includes(normalizedFilter);
      if (selfMatches || childMatches) {
        matchingIds.add(node.id);
        return true;
      }
      return false;
    };
    for (const rootNode of childrenByParent.get(null) ?? []) {
      visit(rootNode);
    }
    return matchingIds;
  }, [childrenByParent, keywordNodes, normalizedFilter]);

  function keywordActivationState(keywordId: string) {
    const activeCount = effectiveCountById.get(keywordId) ?? 0;
    return {
      active: targetShotIds.length > 0 && activeCount === targetShotIds.length,
      mixed: activeCount > 0 && activeCount < targetShotIds.length,
    };
  }

  function keywordCheckState(keywordId: string) {
    const directCount = directCountById.get(keywordId) ?? 0;
    const effectiveCount = effectiveCountById.get(keywordId) ?? 0;
    return {
      checked: targetShotIds.length > 0 && directCount === targetShotIds.length,
      mixed: directCount < targetShotIds.length && effectiveCount > 0,
    };
  }

  function toggleKeyword(keywordId: string) {
    if (targetShotIds.length === 0) {
      return;
    }
    const { active } = keywordActivationState(keywordId);
    setShotKeywordActivation(targetShotIds, keywordId, !active);
  }

  function toggleKeywordCheck(keywordId: string) {
    if (targetShotIds.length === 0) {
      return;
    }
    const { checked } = keywordCheckState(keywordId);
    setShotKeywordActivation(targetShotIds, keywordId, !checked, undefined, false);
  }

  function submitKeywordInput() {
    if (targetShotIds.length === 0) {
      return;
    }
    const sanitized = sanitizeStoryboardKeywordInput(keywordInput);
    if (!sanitized) {
      return;
    }
    appendShotKeywords(targetShotIds, sanitized);
    setKeywordInput("");
  }

  function commitKeywordEdit() {
    const parsed = parseStoryboardKeywordInput(keywordEditValue);
    if (parsed.error) {
      setKeywordEditError(parsed.error);
      return;
    }
    setKeywordEditError(null);
    if (keywordEditValue.trim() !== selectedKeywordText) {
      setShotKeywords(targetShotIds, keywordEditValue);
    }
  }

  function renderKeywordGrid(keywordIds: readonly string[]) {
    const cells = Array.from({ length: 9 }, (_, index) => keywordIds[index] ?? null);
    return (
      <div className="storyboard-keyword-grid">
        {cells.map((keywordId, index) => {
          if (!keywordId) {
            return <span key={`empty-${index}`} aria-hidden="true" />;
          }
          const label = storyboardKeywordLabel(keywordId, keywordNodes);
          const { active, mixed } = keywordActivationState(keywordId);
          return (
            <button
              key={keywordId}
              type="button"
              className={`${active ? "is-active" : ""} ${mixed ? "is-mixed" : ""}`.trim()}
              onClick={() => toggleKeyword(keywordId)}
              disabled={targetShotIds.length === 0}
              title={`${label} · 已用于 ${usageCounts.get(keywordId) ?? 0} 个分镜`}
              aria-pressed={active ? true : mixed ? "mixed" : false}
            >
              {renderStoryboardKeywordLabel(label)}
            </button>
          );
        })}
      </div>
    );
  }

  function renderTreeNodes(parentId: string | null, depth: number): ReactNode {
    return (childrenByParent.get(parentId) ?? []).map((node) => {
      if (!matchingTreeNodeIds.has(node.id)) {
        return null;
      }
      const childNodes = childrenByParent.get(node.id) ?? [];
      const hasChildren = childNodes.length > 0;
      const expanded = normalizedFilter ? true : !collapsedNodeIds.has(node.id);
      const { checked, mixed } = keywordCheckState(node.id);
      return (
        <div key={node.id} className="storyboard-keyword-tree-branch">
          <div
            className={`storyboard-keyword-tree-row ${
              selectedTreeNodeId === node.id ? "is-active" : ""
            }`.trim()}
            onClick={() => setSelectedTreeNodeId(node.id)}
          >
            <button
              type="button"
              className="storyboard-keyword-tree-check"
              onClick={(event) => {
                event.stopPropagation();
                toggleKeywordCheck(node.id);
              }}
              disabled={targetShotIds.length === 0}
              title={storyboardKeywordLabel(node.id, keywordNodes)}
              aria-pressed={checked ? true : mixed ? "mixed" : false}
              aria-label={`勾选${node.name}`}
            >
              <span className="storyboard-keyword-tree-check-box" aria-hidden="true">
                <span className="storyboard-keyword-tree-check-mark">
                  {checked ? "✓" : mixed ? "−" : ""}
                </span>
              </span>
            </button>
            <div
              className="storyboard-keyword-tree-label"
              style={{ paddingLeft: `${depth * 14}px` }}
            >
              <button
                type="button"
                className="storyboard-keyword-tree-toggle"
                disabled={!hasChildren}
                onClick={(event) => {
                  event.stopPropagation();
                  setCollapsedNodeIds((current) => {
                    const next = new Set(current);
                    if (next.has(node.id)) {
                      next.delete(node.id);
                    } else {
                      next.add(node.id);
                    }
                    return next;
                  });
                }}
                aria-label={expanded ? `折叠${node.name}` : `展开${node.name}`}
                aria-expanded={hasChildren ? expanded : undefined}
              >
                <span
                  className={`storyboard-keyword-tree-arrow ${
                    hasChildren && expanded ? "is-expanded" : ""
                  } ${hasChildren ? "" : "is-leaf"}`.trim()}
                  aria-hidden="true"
                />
              </button>
              <span
                className="storyboard-keyword-tree-name"
                title={storyboardKeywordLabel(node.id, keywordNodes)}
              >
                {node.name}
              </span>
            </div>
            <span className="storyboard-keyword-tree-count">{usageCounts.get(node.id) ?? 0}</span>
          </div>
          {hasChildren && expanded && renderTreeNodes(node.id, depth + 1)}
        </div>
      );
    });
  }

  return (
    <aside className="storyboard-keyword-panel">
      <header
        className={`storyboard-keyword-panel-heading ${panelOpen ? "" : "is-collapsed"}`.trim()}
      >
        <button
          type="button"
          className="storyboard-keyword-panel-heading-title"
          onClick={() => setPanelOpen((current) => !current)}
          aria-expanded={panelOpen}
        >
          <span>关键字</span>
          <ChevronDown className={panelOpen ? "" : "is-collapsed"} aria-hidden="true" />
        </button>
      </header>

      {panelOpen && (
        <>
          <section
            className={`storyboard-keyword-section storyboard-keyword-assignment ${
              assignmentOpen ? "" : "is-collapsed"
            }`.trim()}
          >
            <header className="storyboard-keyword-assignment-header">
              <span>关键字标记</span>
              <span className="storyboard-keyword-dropdown-shell">
                <span className="storyboard-keyword-dropdown-value">键入关键字</span>
                <span className="storyboard-keyword-dropdown-arrows" aria-hidden="true">
                  <ChevronsUpDown aria-hidden="true" />
                </span>
              </span>
              <button
                type="button"
                className="storyboard-keyword-assignment-toggle"
                onClick={() => setAssignmentOpen((current) => !current)}
                aria-label={assignmentOpen ? "折叠关键字标记" : "展开关键字标记"}
                aria-expanded={assignmentOpen}
              >
                <ChevronDown className={assignmentOpen ? "" : "is-collapsed"} aria-hidden="true" />
              </button>
            </header>
            {assignmentOpen && (
              <div className="storyboard-keyword-section-body">
                <div className="storyboard-keyword-plain-editor">
                  {!keywordEditorFocused && (
                    <div
                      className="storyboard-keyword-plain-editor-display"
                      onClick={() => {
                        if (targetShotIds.length > 0) {
                          setKeywordEditorFocused(true);
                        }
                      }}
                    >
                      {renderStoryboardKeywordLabel(keywordEditValue)}
                    </div>
                  )}
                  <textarea
                    ref={keywordEditorRef}
                    className={keywordEditorFocused ? "" : "is-hidden"}
                    value={keywordEditValue}
                    disabled={targetShotIds.length === 0}
                    placeholder=""
                    aria-label="编辑当前分镜关键字"
                    aria-invalid={Boolean(keywordEditError)}
                    title={keywordEditError ?? "直接编辑当前关键字，回车或失焦后保存"}
                    onFocus={() => {
                      cancelKeywordEditRef.current = false;
                    }}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setKeywordEditValue(value);
                      setKeywordEditError(parseStoryboardKeywordInput(value).error);
                    }}
                    onBlur={() => {
                      setKeywordEditorFocused(false);
                      if (cancelKeywordEditRef.current) {
                        cancelKeywordEditRef.current = false;
                        setKeywordEditValue(selectedKeywordText);
                        setKeywordEditError(null);
                        return;
                      }
                      commitKeywordEdit();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelKeywordEditRef.current = true;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                <form
                  className="storyboard-keyword-inline-entry"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitKeywordInput();
                  }}
                >
                  <input
                    ref={inputRef}
                    value={keywordInput}
                    onChange={(event) => setKeywordInput(event.currentTarget.value)}
                    placeholder="单击此处添加关键字"
                    disabled={targetShotIds.length === 0}
                    aria-label="添加分镜关键字"
                    title={
                      keywordParseResult.error ?? "支持 父>子、子<父、父|子；多个关键字用逗号分隔"
                    }
                  />
                </form>
              </div>
            )}
          </section>

          <KeywordPanelSection
            title="建议关键字"
            open={suggestionsOpen}
            onToggle={() => setSuggestionsOpen((current) => !current)}
          >
            {renderKeywordGrid(suggestedIds)}
          </KeywordPanelSection>

          <KeywordPanelSection
            title="关键字集"
            control={
              <span className="storyboard-keyword-dropdown-shell">
                <span className="storyboard-keyword-dropdown-value">最近使用过的关键字</span>
                <span className="storyboard-keyword-dropdown-arrows" aria-hidden="true">
                  <ChevronsUpDown />
                </span>
              </span>
            }
            open={recentOpen}
            onToggle={() => setRecentOpen((current) => !current)}
          >
            {renderKeywordGrid(visibleRecentIds)}
          </KeywordPanelSection>
        </>
      )}

      <section className="storyboard-keyword-tree-section">
        <header
          className={`storyboard-keyword-tree-heading ${treeOpen ? "" : "is-collapsed"}`.trim()}
        >
          <button
            type="button"
            className="storyboard-keyword-add-button"
            onClick={() => inputRef.current?.focus()}
            title="添加关键字"
            aria-label="添加关键字"
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="storyboard-keyword-tree-title"
            onClick={() => setTreeOpen((current) => !current)}
            aria-expanded={treeOpen}
          >
            <span>关键字列表</span>
            <ChevronDown className={treeOpen ? "" : "is-collapsed"} aria-hidden="true" />
          </button>
        </header>
        {treeOpen && (
          <div className="storyboard-keyword-tree-body">
            <label className="storyboard-keyword-filter">
              <Search aria-hidden="true" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
                placeholder="过滤关键字"
                aria-label="过滤关键字"
              />
            </label>
            <div className="storyboard-keyword-tree" role="tree">
              {renderTreeNodes(null, 0)}
              {keywordNodes.length === 0 && (
                <p className="storyboard-keyword-empty">尚未创建关键字</p>
              )}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}
