import { ChevronsUpDown, ChevronDown, Minus, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "../ModalDialog";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  useCloseOnOutsidePointer,
} from "../PopupMenu";
import type { StoryboardKeywordNode } from "../../types";
import {
  expandedStoryboardKeywordText,
  formatStoryboardKeywordPath,
  normalizeStoryboardKeywordIds,
  parseStoryboardKeywordInput,
  renderStoryboardKeywordLabel,
  sanitizeStoryboardKeywordInput,
  sanitizeStoryboardKeywordName,
  storyboardEffectiveKeywordIds,
  storyboardKeywordDescendantIds,
  storyboardKeywordLabel,
  storyboardKeywordUsageCounts,
  suggestedStoryboardKeywordIds,
  visibleStoryboardKeywordIds,
  type StoryboardKeywordPath,
} from "./storyboardKeywords";
import { useStoryboardPanelState } from "./storyboardPanelState";
import { usePanelInstanceId } from "../../runtime/systems/PanelState";

interface StoryboardKeywordPanelProps {
  shotIds: readonly string[];
  resetKey: string;
  onSetQuickKeyword?: (keywordLabel: string) => void;
  quickKeywordLabel?: string;
}

const keywordModeMenuWidth = 176;

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

export function StoryboardKeywordPanel({
  shotIds,
  resetKey,
  onSetQuickKeyword,
  quickKeywordLabel = "",
}: StoryboardKeywordPanelProps) {
  const {
    keywordNodes,
    keywordUsageCounters,
    recentKeywordIds,
    shots,
    shotAnnotations,
    appendShotKeywords,
    setShotKeywordActivation,
    reconcileShotKeywords,
    removeStoryboardKeyword,
    updateStoryboardKeyword,
    createStoryboardKeyword,
    keywordEditorMode,
    setKeywordEditorMode,
    quickFilterKeywordIds,
    toggleQuickFilterKeyword,
  } = useStoryboardPanelState((state) => state);
  const panelInstanceId = usePanelInstanceId();
  const [keywordInput, setKeywordInput] = useState("");
  const [keywordEditValue, setKeywordEditValue] = useState("");
  const [keywordEditError, setKeywordEditError] = useState<string | null>(null);
  const [keywordEditorFocused, setKeywordEditorFocused] = useState(false);
  const [keywordModeMenu, setKeywordModeMenu] = useState<{ x: number; y: number } | null>(null);
  const [treeContextMenu, setTreeContextMenu] = useState<{
    x: number;
    y: number;
    keywordId: string;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [assignmentOpen, setAssignmentOpen] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(true);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedTreeNodeIds, setSelectedTreeNodeIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [keywordBatchDeleteRequest, setKeywordBatchDeleteRequest] = useState(false);
  const [keywordDeleteRequest, setKeywordDeleteRequest] = useState<{
    keywordId: string;
    label: string;
    count: number;
  } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSynonyms, setCreateSynonyms] = useState("");
  const [createNestIntoParent, setCreateNestIntoParent] = useState(false);
  const [createAddToShots, setCreateAddToShots] = useState(false);
  const [createParentOverrideId, setCreateParentOverrideId] = useState<string | null>(null);
  const [newKeywordContainerId, setNewKeywordContainerId] = useState<string | null>(null);
  const [editKeywordDialog, setEditKeywordDialog] = useState<{ keywordId: string } | null>(null);
  const [editName, setEditName] = useState("");
  const [editSynonyms, setEditSynonyms] = useState("");
  const [duplicateNameRequest, setDuplicateNameRequest] = useState<{
    name: string;
    keywordId: string | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keywordEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelKeywordEditRef = useRef(false);
  const portalContainerRef = useRef<Element | null>(null);
  const targetShotIds = useMemo(() => Array.from(new Set(shotIds)), [shotIds]);
  const keywordParseResult = parseStoryboardKeywordInput(keywordInput);
  const mediaShotIds = useMemo(() => shots.map((shot) => shot.id), [shots]);

  useEffect(() => {
    setKeywordInput("");
    setKeywordEditValue("");
    setKeywordEditError(null);
    setFilter("");
    setCollapsedNodeIds(new Set());
    setSelectedTreeNodeIds(new Set());
    setSelectionAnchorId(null);
    setKeywordDeleteRequest(null);
    setKeywordBatchDeleteRequest(false);
    setCreateDialogOpen(false);
    setCreateParentOverrideId(null);
    setNewKeywordContainerId(null);
    setEditKeywordDialog(null);
    setDuplicateNameRequest(null);
    setKeywordModeMenu(null);
    setTreeContextMenu(null);
  }, [resetKey]);

  useCloseOnOutsidePointer(Boolean(treeContextMenu), () => setTreeContextMenu(null));
  useCloseOnOutsidePointer(Boolean(keywordModeMenu), () => setKeywordModeMenu(null));

  useEffect(() => {
    portalContainerRef.current = document.querySelector(".app-shell");
  }, []);

  const usageCounts = useMemo(
    () => storyboardKeywordUsageCounts(keywordNodes, shotAnnotations, mediaShotIds),
    [keywordNodes, mediaShotIds, shotAnnotations],
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

  const suggestedIds = useMemo(() => {
    const appliedIds = new Set(effectiveCountById.keys());
    return suggestedStoryboardKeywordIds(
      keywordUsageCounters,
      keywordNodes,
      shotAnnotations,
      mediaShotIds,
      appliedIds,
    );
  }, [effectiveCountById, keywordNodes, keywordUsageCounters, mediaShotIds, shotAnnotations]);
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
  const selectedKeywordText = useMemo(() => {
    const textParts: string[] = [];
    for (const keywordId of selectedKeywordIds) {
      const label = storyboardKeywordLabel(keywordId, keywordNodes);
      if (!label) {
        continue;
      }
      const activeCount = effectiveCountById.get(keywordId) ?? 0;
      const partial =
        targetShotIds.length > 1 && activeCount > 0 && activeCount < targetShotIds.length;
      textParts.push(partial ? `${label}*` : label);
    }
    return textParts.join(", ");
  }, [effectiveCountById, keywordNodes, selectedKeywordIds, targetShotIds.length]);
  const partialKeywordIds = useMemo(() => {
    const ids = new Set<string>();
    for (const keywordId of selectedKeywordIds) {
      const activeCount = effectiveCountById.get(keywordId) ?? 0;
      if (targetShotIds.length > 1 && activeCount > 0 && activeCount < targetShotIds.length) {
        ids.add(keywordId);
      }
    }
    return ids;
  }, [effectiveCountById, selectedKeywordIds, targetShotIds.length]);
  const partialKeywordLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const keywordId of partialKeywordIds) {
      const label = storyboardKeywordLabel(keywordId, keywordNodes);
      if (label) {
        labels.add(label);
      }
    }
    return labels;
  }, [keywordNodes, partialKeywordIds]);
  const expandedKeywordText = useMemo(
    () => expandedStoryboardKeywordText(selectedKeywordIds, keywordNodes),
    [keywordNodes, selectedKeywordIds],
  );
  const keywordEditorKeywordCount = useMemo(
    () =>
      keywordEditValue
        .split(/[,，]/)
        .map((value) => value.trim())
        .filter(Boolean).length,
    [keywordEditValue],
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
    const nodeById = new Map(keywordNodes.map((node) => [node.id, node]));
    const matchingIds = new Set<string>();
    for (const node of keywordNodes) {
      if (
        !node.name.toLocaleLowerCase().includes(normalizedFilter) &&
        !storyboardKeywordLabel(node.id, keywordNodes)
          .toLocaleLowerCase()
          .includes(normalizedFilter)
      ) {
        continue;
      }
      let currentId: string | null = node.id;
      while (currentId && !matchingIds.has(currentId)) {
        matchingIds.add(currentId);
        currentId = nodeById.get(currentId)?.parentId ?? null;
      }
    }
    return matchingIds;
  }, [keywordNodes, normalizedFilter]);

  const visibleOrderedTreeNodeIds = useMemo(() => {
    const orderedIds: string[] = [];
    const visit = (parentId: string | null) => {
      for (const node of childrenByParent.get(parentId) ?? []) {
        if (!matchingTreeNodeIds.has(node.id)) {
          continue;
        }
        orderedIds.push(node.id);
        const childNodes = childrenByParent.get(node.id) ?? [];
        const expanded = normalizedFilter ? true : !collapsedNodeIds.has(node.id);
        if (childNodes.length > 0 && expanded) {
          visit(node.id);
        }
      }
    };
    visit(null);
    return orderedIds;
  }, [childrenByParent, collapsedNodeIds, matchingTreeNodeIds, normalizedFilter]);

  const primarySelectedId = useMemo(() => {
    if (selectedTreeNodeIds.size === 1) {
      return selectedTreeNodeIds.values().next().value ?? null;
    }
    if (selectionAnchorId && selectedTreeNodeIds.has(selectionAnchorId)) {
      return selectionAnchorId;
    }
    return selectedTreeNodeIds.values().next().value ?? null;
  }, [selectedTreeNodeIds, selectionAnchorId]);

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
    setShotKeywordActivation(targetShotIds, keywordId, !checked);
  }

  function selectTreeRow(
    nodeId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) {
    if (event.shiftKey) {
      const effectiveAnchorId =
        selectionAnchorId && visibleOrderedTreeNodeIds.includes(selectionAnchorId)
          ? selectionAnchorId
          : (visibleOrderedTreeNodeIds.find((candidateId) =>
              selectedTreeNodeIds.has(candidateId),
            ) ?? null);
      const anchorIndex = effectiveAnchorId
        ? visibleOrderedTreeNodeIds.indexOf(effectiveAnchorId)
        : -1;
      const nodeIndex = visibleOrderedTreeNodeIds.indexOf(nodeId);
      if (effectiveAnchorId && anchorIndex >= 0 && nodeIndex >= 0) {
        const start = Math.min(anchorIndex, nodeIndex);
        const end = Math.max(anchorIndex, nodeIndex);
        setSelectedTreeNodeIds(new Set(visibleOrderedTreeNodeIds.slice(start, end + 1)));
        return;
      }
      setSelectedTreeNodeIds(new Set([nodeId]));
      setSelectionAnchorId(nodeId);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedTreeNodeIds);
      if (next.has(nodeId)) {
        next.delete(nodeId);
        if (selectionAnchorId === nodeId) {
          setSelectionAnchorId(
            visibleOrderedTreeNodeIds.find((candidateId) => next.has(candidateId)) ?? null,
          );
        }
      } else {
        next.add(nodeId);
        setSelectionAnchorId(nodeId);
      }
      setSelectedTreeNodeIds(next);
      return;
    }
    setSelectedTreeNodeIds(new Set([nodeId]));
    setSelectionAnchorId(nodeId);
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
    const tokens = keywordEditValue
      .split(/[,，]/)
      .map((token) => token.trim())
      .filter(Boolean);
    const pathsByLabel = new Map<string, StoryboardKeywordPath>();
    const preservedLabels = new Set<string>();
    const forcedFullLabels = new Set<string>();
    let parseError: string | null = null;
    for (const token of tokens) {
      const isStarred = token.endsWith("*");
      const value = isStarred ? token.slice(0, -1).trim() : token;
      if (!value) {
        parseError = `关键字路径“${token}”包含空的关键字名称`;
        break;
      }
      const parsed = parseStoryboardKeywordInput(value);
      if (parsed.error) {
        parseError = parsed.error;
        break;
      }
      for (const path of parsed.paths) {
        const label = formatStoryboardKeywordPath(path);
        pathsByLabel.set(label, path);
        const preserve = isStarred && partialKeywordLabels.has(label);
        if (preserve && !forcedFullLabels.has(label)) {
          preservedLabels.add(label);
        } else {
          preservedLabels.delete(label);
          forcedFullLabels.add(label);
        }
      }
    }
    if (parseError) {
      setKeywordEditError(parseError);
      return;
    }
    setKeywordEditError(null);
    if (keywordEditValue.trim() !== selectedKeywordText) {
      const allPaths = Array.from(pathsByLabel.values());
      const preservedPaths = Array.from(preservedLabels)
        .map((label) => pathsByLabel.get(label))
        .filter((path): path is StoryboardKeywordPath => path !== undefined);
      reconcileShotKeywords(targetShotIds, allPaths, preservedPaths);
    }
  }

  function performKeywordDelete(keywordId: string, historyGroupId?: string) {
    const removableIds = storyboardKeywordDescendantIds(keywordId, keywordNodes);
    removeStoryboardKeyword(keywordId, historyGroupId);
    setSelectedTreeNodeIds((current) => {
      const next = new Set(current);
      for (const deletedId of removableIds) {
        next.delete(deletedId);
      }
      return next;
    });
    setSelectionAnchorId((current) => (current && removableIds.has(current) ? null : current));
    if (newKeywordContainerId && removableIds.has(newKeywordContainerId)) {
      setNewKeywordContainerId(null);
    }
    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      for (const deletedId of removableIds) {
        next.delete(deletedId);
      }
      return next;
    });
  }

  function requestKeywordDelete(keywordId: string) {
    const node = keywordNodes.find((candidate) => candidate.id === keywordId);
    if (!node) {
      return;
    }
    const count = usageCounts.get(keywordId) ?? 0;
    if (count > 0) {
      setKeywordDeleteRequest({
        keywordId,
        label: node.name,
        count,
      });
      return;
    }
    performKeywordDelete(keywordId);
  }

  function requestRemoveSelectedKeyword() {
    const selectedIds = Array.from(selectedTreeNodeIds);
    if (selectedIds.length === 1) {
      requestKeywordDelete(selectedIds[0]);
    } else if (selectedIds.length > 1) {
      setKeywordBatchDeleteRequest(true);
    }
  }

  function requestContextMenuDelete(keywordId: string) {
    if (selectedTreeNodeIds.size > 1 && selectedTreeNodeIds.has(keywordId)) {
      setKeywordBatchDeleteRequest(true);
      return;
    }
    requestKeywordDelete(keywordId);
  }

  function confirmKeywordDelete() {
    if (!keywordDeleteRequest) {
      return;
    }
    const { keywordId } = keywordDeleteRequest;
    setKeywordDeleteRequest(null);
    performKeywordDelete(keywordId);
  }

  function confirmKeywordBatchDelete() {
    const selectedIds = Array.from(selectedTreeNodeIds);
    setKeywordBatchDeleteRequest(false);
    const historyGroupId = `storyboard-keyword-batch-delete-${Date.now()}`;
    for (const keywordId of selectedIds) {
      performKeywordDelete(keywordId, historyGroupId);
    }
  }

  const handleCancelDelete = useCallback(() => setKeywordDeleteRequest(null), []);
  const handleCancelBatchDelete = useCallback(() => setKeywordBatchDeleteRequest(false), []);

  const createParentCandidate = useMemo(() => {
    if (createParentOverrideId) {
      const override = keywordNodes.find((node) => node.id === createParentOverrideId);
      if (override) {
        return override;
      }
    }
    if (newKeywordContainerId) {
      const container = keywordNodes.find((node) => node.id === newKeywordContainerId);
      if (container) {
        return container;
      }
    }
    if (primarySelectedId) {
      const selected = keywordNodes.find((node) => node.id === primarySelectedId);
      if (selected) {
        return selected;
      }
    }
    return childrenByParent.get(null)?.[0] ?? null;
  }, [
    childrenByParent,
    createParentOverrideId,
    keywordNodes,
    newKeywordContainerId,
    primarySelectedId,
  ]);

  const createKeywordName = sanitizeStoryboardKeywordName(createName);

  function openCreateDialog(preserveFields = false, parentOverrideId: string | null = null) {
    if (!preserveFields) {
      setCreateName("");
      setCreateSynonyms("");
      setCreateAddToShots(false);
      setCreateNestIntoParent(
        Boolean(parentOverrideId) ||
          Boolean(
            newKeywordContainerId && keywordNodes.some((node) => node.id === newKeywordContainerId),
          ),
      );
      setCreateParentOverrideId(parentOverrideId);
    }
    setCreateDialogOpen(true);
  }

  function confirmKeywordCreate() {
    if (!createKeywordName) {
      return;
    }
    const parentId =
      createNestIntoParent && createParentCandidate ? createParentCandidate.id : null;
    const duplicate = keywordNodes.some(
      (node) => (node.parentId ?? null) === parentId && node.name === createKeywordName,
    );
    if (duplicate) {
      setCreateDialogOpen(false);
      setDuplicateNameRequest({ name: createKeywordName, keywordId: null });
      return;
    }
    const synonyms = createSynonyms
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    createStoryboardKeyword(createKeywordName, {
      parentId,
      synonyms,
      shotIds: createAddToShots ? targetShotIds : undefined,
    });
    setCreateDialogOpen(false);
  }

  const handleCancelCreate = useCallback(() => setCreateDialogOpen(false), []);

  function acknowledgeDuplicateName() {
    if (!duplicateNameRequest) {
      return;
    }
    const { keywordId } = duplicateNameRequest;
    setDuplicateNameRequest(null);
    if (keywordId) {
      setEditKeywordDialog({ keywordId });
    } else {
      openCreateDialog(true);
    }
  }

  const editKeywordDialogNode = editKeywordDialog
    ? (keywordNodes.find((node) => node.id === editKeywordDialog.keywordId) ?? null)
    : null;
  const editKeywordName = sanitizeStoryboardKeywordName(editName);

  function openKeywordTagEditDialog(keywordId: string) {
    const node = keywordNodes.find((candidate) => candidate.id === keywordId);
    if (!node) {
      return;
    }
    setEditName(node.name);
    setEditSynonyms((node.synonyms ?? []).join(", "));
    setEditKeywordDialog({ keywordId });
  }

  function confirmKeywordTagEdit() {
    if (!editKeywordDialogNode || !editKeywordName) {
      return;
    }
    const duplicate = keywordNodes.some(
      (node) =>
        node.id !== editKeywordDialogNode.id &&
        (node.parentId ?? null) === (editKeywordDialogNode.parentId ?? null) &&
        node.name === editKeywordName,
    );
    if (duplicate) {
      setEditKeywordDialog(null);
      setDuplicateNameRequest({ name: editKeywordName, keywordId: editKeywordDialogNode.id });
      return;
    }
    const synonyms = editSynonyms
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    updateStoryboardKeyword(editKeywordDialogNode.id, { name: editKeywordName, synonyms });
    setEditKeywordDialog(null);
  }

  const handleCancelKeywordTagEdit = useCallback(() => setEditKeywordDialog(null), []);

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
      const nodeLabel = storyboardKeywordLabel(node.id, keywordNodes);
      return (
        <div key={node.id} className="storyboard-keyword-tree-branch">
          <div
            className={`storyboard-keyword-tree-row ${
              selectedTreeNodeIds.has(node.id) ? "is-active" : ""
            }`.trim()}
            onClick={(event) => selectTreeRow(node.id, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!selectedTreeNodeIds.has(node.id)) {
                setSelectedTreeNodeIds(new Set([node.id]));
                setSelectionAnchorId(node.id);
              }
              setTreeContextMenu({ x: event.clientX, y: event.clientY, keywordId: node.id });
            }}
          >
            <button
              type="button"
              className="storyboard-keyword-tree-check"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedTreeNodeIds(new Set([node.id]));
                setSelectionAnchorId(node.id);
                toggleKeywordCheck(node.id);
              }}
              disabled={targetShotIds.length === 0}
              title={nodeLabel}
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
              <span className="storyboard-keyword-tree-name" title={nodeLabel}>
                {node.name}
              </span>
              {newKeywordContainerId === node.id && (
                <span
                  className="storyboard-keyword-tree-dot"
                  title="将新关键字置入到该关键字中"
                  aria-label="将新关键字置入到该关键字中"
                />
              )}
              {quickKeywordLabel === nodeLabel && (
                <span
                  className="storyboard-keyword-tree-quick"
                  title="快捷关键字"
                  aria-label="快捷关键字"
                >
                  <Plus aria-hidden="true" />
                </span>
              )}
            </div>
            <span className="storyboard-keyword-tree-count">{usageCounts.get(node.id) ?? 0}</span>
            <button
              type="button"
              className={`storyboard-keyword-tree-quick-filter ${
                quickFilterKeywordIds.includes(node.id) ? "is-active" : ""
              }`.trim()}
              title={
                quickFilterKeywordIds.includes(node.id)
                  ? `取消快捷过滤 ${nodeLabel}`
                  : `快捷过滤 ${nodeLabel}`
              }
              aria-pressed={quickFilterKeywordIds.includes(node.id)}
              aria-label={
                quickFilterKeywordIds.includes(node.id)
                  ? `取消快捷过滤${nodeLabel}`
                  : `快捷过滤${nodeLabel}`
              }
              onClick={(event) => {
                event.stopPropagation();
                toggleQuickFilterKeyword(node.id);
              }}
            >
              <svg
                className="storyboard-keyword-tree-quick-filter-arrow"
                viewBox="-1 -1 12 14"
                width="11"
                height="12"
                aria-hidden="true"
              >
                <g filter={`url(#quick-filter-arrow-inset-${panelInstanceId})`}>
                  <path d="M0 4h4v4H0z" fill="currentColor" />
                  <path d="M4 0 10 6 4 12z" fill="currentColor" />
                </g>
              </svg>
            </button>
          </div>
          {hasChildren && expanded && renderTreeNodes(node.id, depth + 1)}
        </div>
      );
    });
  }

  const treeContextMenuNode = treeContextMenu
    ? (keywordNodes.find((node) => node.id === treeContextMenu.keywordId) ?? null)
    : null;
  const treeContextMenuLabel = treeContextMenuNode
    ? storyboardKeywordLabel(treeContextMenuNode.id, keywordNodes)
    : "";

  return (
    <>
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          <filter id={`quick-filter-arrow-inset-${panelInstanceId}`}>
            <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="dilated" />
            <feFlood floodColor="#000" floodOpacity="1" result="black" />
            <feComposite in="black" in2="dilated" operator="in" result="outline" />
            <feMerge>
              <feMergeNode in="outline" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
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
                <button
                  type="button"
                  className={`storyboard-keyword-dropdown-shell storyboard-keyword-mode-trigger ${
                    keywordModeMenu ? "is-open" : ""
                  }`.trim()}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(keywordModeMenu)}
                  aria-label="关键字编辑方式"
                  title="选择关键字编辑方式"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (keywordModeMenu) {
                      setKeywordModeMenu(null);
                      return;
                    }
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setKeywordModeMenu({
                      x: bounds.right - keywordModeMenuWidth,
                      y: bounds.bottom,
                    });
                  }}
                >
                  <span className="storyboard-keyword-dropdown-value">
                    {keywordEditorMode === "withParents" ? "关键字与父关键字" : "键入关键字"}
                  </span>
                  <span className="storyboard-keyword-dropdown-arrows" aria-hidden="true">
                    <ChevronsUpDown aria-hidden="true" />
                  </span>
                </button>
                <button
                  type="button"
                  className="storyboard-keyword-assignment-toggle"
                  onClick={() => setAssignmentOpen((current) => !current)}
                  aria-label={assignmentOpen ? "折叠关键字标记" : "展开关键字标记"}
                  aria-expanded={assignmentOpen}
                >
                  <ChevronDown
                    className={assignmentOpen ? "" : "is-collapsed"}
                    aria-hidden="true"
                  />
                </button>
              </header>
              {assignmentOpen && (
                <div className="storyboard-keyword-section-body">
                  {keywordEditorMode === "withParents" ? (
                    <div className="storyboard-keyword-plain-editor storyboard-keyword-with-parents">
                      <div className="storyboard-keyword-plain-editor-display">
                        {renderStoryboardKeywordLabel(expandedKeywordText)}
                      </div>
                    </div>
                  ) : (
                    <div
                      className="storyboard-keyword-plain-editor"
                      title={
                        keywordEditError ??
                        `星号（*）表示标记仅应用于某些选定的分镜。\n\n关键词数量：${keywordEditorKeywordCount}`
                      }
                    >
                      {!keywordEditorFocused && (
                        <div
                          className={`storyboard-keyword-plain-editor-display ${
                            keywordEditError ? "is-error" : ""
                          }`.trim()}
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
                  )}
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
            <span className="storyboard-keyword-tree-actions">
              <button
                type="button"
                className="storyboard-keyword-add-button"
                onClick={() => openCreateDialog()}
                title="创建关键字标记"
                aria-label="创建关键字标记"
              >
                <Plus aria-hidden="true" />
              </button>
              {selectedTreeNodeIds.size > 0 && (
                <button
                  type="button"
                  className="storyboard-keyword-remove-button"
                  onClick={requestRemoveSelectedKeyword}
                  title="删除选中关键字"
                  aria-label="删除选中关键字"
                >
                  <Minus aria-hidden="true" />
                </button>
              )}
            </span>
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
              </div>
            </div>
          )}
        </section>
      </aside>
      {keywordModeMenu &&
        createPortal(
          <PopupMenu
            className="storyboard-keyword-mode-menu"
            contextMenuAnchor={keywordModeMenu}
            ariaLabel="关键字编辑方式"
            style={{ position: "fixed", left: keywordModeMenu.x, top: keywordModeMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuItem
              checked={keywordEditorMode === "plain"}
              indicator="check"
              onSelect={() => {
                setKeywordEditorMode("plain");
                setKeywordModeMenu(null);
              }}
            >
              键入关键字
            </PopupMenuItem>
            <PopupMenuItem
              checked={keywordEditorMode === "withParents"}
              indicator="check"
              onSelect={() => {
                setKeywordEditorMode("withParents");
                setKeywordModeMenu(null);
              }}
            >
              关键字与父关键字
            </PopupMenuItem>
          </PopupMenu>,
          document.body,
        )}
      {treeContextMenu &&
        treeContextMenuNode &&
        createPortal(
          <PopupMenu
            className="storyboard-keyword-tree-menu"
            contextMenuAnchor={{ x: treeContextMenu.x, y: treeContextMenu.y }}
            ariaLabel="关键字操作"
            style={{ position: "fixed", left: treeContextMenu.x, top: treeContextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PopupMenuItem
              disabled={
                targetShotIds.length === 0 || keywordCheckState(treeContextMenuNode.id).checked
              }
              onSelect={() => {
                setShotKeywordActivation(targetShotIds, treeContextMenuNode.id, true);
                setTreeContextMenu(null);
              }}
            >
              将此关键字添加到选定分镜
            </PopupMenuItem>
            <PopupMenuItem
              disabled={
                targetShotIds.length === 0 ||
                (directCountById.get(treeContextMenuNode.id) ?? 0) === 0
              }
              onSelect={() => {
                setShotKeywordActivation(targetShotIds, treeContextMenuNode.id, false);
                setTreeContextMenu(null);
              }}
            >
              从选定的分镜中移去此关键字
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              onSelect={() => {
                openKeywordTagEditDialog(treeContextMenuNode.id);
                setTreeContextMenu(null);
              }}
            >
              编辑关键字标记...
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              onSelect={() => {
                openCreateDialog();
                setTreeContextMenu(null);
              }}
            >
              创建关键字标记...
            </PopupMenuItem>
            <PopupMenuItem
              onSelect={() => {
                openCreateDialog(false, treeContextMenuNode.id);
                setTreeContextMenu(null);
              }}
            >
              在“{treeContextMenuNode.name}”中创建关键字标记...
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              onSelect={() => {
                requestContextMenuDelete(treeContextMenuNode.id);
                setTreeContextMenu(null);
              }}
            >
              删除...
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              checked={newKeywordContainerId === treeContextMenuNode.id}
              indicator="check"
              onSelect={() => {
                setNewKeywordContainerId((current) =>
                  current === treeContextMenuNode.id ? null : treeContextMenuNode.id,
                );
                setTreeContextMenu(null);
              }}
            >
              将新关键字置入到该关键字中
            </PopupMenuItem>
            <PopupMenuItem
              disabled={!onSetQuickKeyword}
              checked={quickKeywordLabel === treeContextMenuLabel}
              indicator="check"
              onSelect={() => {
                onSetQuickKeyword?.(treeContextMenuLabel);
                setTreeContextMenu(null);
              }}
            >
              设为快捷关键字
            </PopupMenuItem>
          </PopupMenu>,
          document.body,
        )}
      {createDialogOpen &&
        createPortal(
          <ModalDialog
            title="创建关键字标记"
            className="storyboard-keyword-create-dialog"
            bodyClassName="storyboard-keyword-create-dialog-body"
            confirmLabel="创建"
            confirmDisabled={!createKeywordName}
            onCancel={handleCancelCreate}
            onConfirm={confirmKeywordCreate}
          >
            <label className="storyboard-keyword-create-field storyboard-keyword-create-field-name">
              <span>关键字名称:</span>
              <input
                autoFocus
                value={createName}
                onChange={(event) => setCreateName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    confirmKeywordCreate();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    handleCancelCreate();
                  }
                }}
                aria-label="关键字名称"
              />
            </label>
            <label className="storyboard-keyword-create-field">
              <span>同义词:</span>
              <textarea
                value={createSynonyms}
                rows={4}
                onChange={(event) => setCreateSynonyms(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    handleCancelCreate();
                  }
                }}
                aria-label="同义词"
                title="多个同义词用逗号或换行分隔"
              />
            </label>
            {(createParentCandidate || targetShotIds.length > 0) && (
              <div className="storyboard-keyword-create-options">
                <span className="storyboard-keyword-create-options-title">创建选项</span>
                {createParentCandidate && (
                  <label>
                    <input
                      type="checkbox"
                      checked={createNestIntoParent}
                      onChange={(event) => setCreateNestIntoParent(event.currentTarget.checked)}
                    />
                    置入“{createParentCandidate.name}”中
                  </label>
                )}
                {targetShotIds.length > 0 && (
                  <label>
                    <input
                      type="checkbox"
                      checked={createAddToShots}
                      onChange={(event) => setCreateAddToShots(event.currentTarget.checked)}
                    />
                    添加到选定的分镜
                  </label>
                )}
              </div>
            )}
          </ModalDialog>,
          portalContainerRef.current ?? document.body,
        )}
      {editKeywordDialog &&
        editKeywordDialogNode &&
        createPortal(
          <ModalDialog
            title="编辑关键字标记"
            className="storyboard-keyword-create-dialog"
            bodyClassName="storyboard-keyword-create-dialog-body"
            confirmLabel="存储"
            confirmDisabled={!editKeywordName}
            onCancel={handleCancelKeywordTagEdit}
            onConfirm={confirmKeywordTagEdit}
          >
            <label className="storyboard-keyword-create-field storyboard-keyword-create-field-name">
              <span>关键字名称:</span>
              <input
                autoFocus
                value={editName}
                onChange={(event) => setEditName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    confirmKeywordTagEdit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    handleCancelKeywordTagEdit();
                  }
                }}
                aria-label="关键字名称"
              />
            </label>
            <label className="storyboard-keyword-create-field">
              <span>同义词:</span>
              <textarea
                value={editSynonyms}
                rows={4}
                onChange={(event) => setEditSynonyms(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    handleCancelKeywordTagEdit();
                  }
                }}
                aria-label="同义词"
                title="多个同义词用逗号或换行分隔"
              />
            </label>
          </ModalDialog>,
          portalContainerRef.current ?? document.body,
        )}
      {duplicateNameRequest &&
        createPortal(
          <ModalDialog
            title="创建关键字标记"
            className="storyboard-keyword-duplicate-dialog"
            actions={
              <button
                type="button"
                className="modal-dialog-confirm"
                autoFocus
                onClick={acknowledgeDuplicateName}
              >
                确定
              </button>
            }
            onCancel={acknowledgeDuplicateName}
            onConfirm={acknowledgeDuplicateName}
          >
            <div className="storyboard-keyword-duplicate-dialog-message">
              名称“{duplicateNameRequest.name}”已被使用，请选择其它名称。
            </div>
          </ModalDialog>,
          portalContainerRef.current ?? document.body,
        )}
      {keywordDeleteRequest &&
        createPortal(
          <ModalDialog
            title="删除关键字"
            className="storyboard-keyword-delete-dialog"
            bodyClassName="storyboard-keyword-delete-dialog-body"
            confirmLabel="删除"
            onCancel={handleCancelDelete}
            onConfirm={confirmKeywordDelete}
          >
            <div className="storyboard-keyword-delete-dialog-message">
              <Trash2 aria-hidden="true" />
              <div>
                <strong>是否要删除关键字“{keywordDeleteRequest.label}”？</strong>
                <span>此关键字用于 {keywordDeleteRequest.count} 个分镜，并将从中移去。</span>
              </div>
            </div>
          </ModalDialog>,
          portalContainerRef.current ?? document.body,
        )}
      {keywordBatchDeleteRequest &&
        createPortal(
          <ModalDialog
            title="删除关键字"
            className="storyboard-keyword-delete-dialog"
            bodyClassName="storyboard-keyword-delete-dialog-body"
            confirmLabel="删除"
            onCancel={handleCancelBatchDelete}
            onConfirm={confirmKeywordBatchDelete}
          >
            <div className="storyboard-keyword-delete-dialog-message">
              <Trash2 aria-hidden="true" />
              <div>
                <strong>是否要删除所有选定的关键字？</strong>
                <span>
                  某些选定的关键字可能会用于将移去这些关键字的照片，或可能包含其它将被一同删除的关键字。
                </span>
              </div>
            </div>
          </ModalDialog>,
          portalContainerRef.current ?? document.body,
        )}
    </>
  );
}
