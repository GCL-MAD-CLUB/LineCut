import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import "./DockLayout.css";
import { PopupMenu, PopupMenuItem, PopupMenuSeparator } from "../PopupMenu";
import { dockAreaIds, normalizeArea, usePanelManagerState } from "./PanelManager";
import { PanelActions, PanelHost, PanelMenuItems, PanelTitle } from "./PanelRegistry";
import type { DockAreaId, DockDropPosition, DockLayoutNode, DockSplitNode } from "./types";

const DOCK_DRAG_LONG_PRESS_MS = 220;
const RESIZER_SIZE_CSS_VAR = "--resizer-size";
const DOCK_DROP_INSET_PX = 25;

function readCssPixelVariable(name: string, fallback: number): number {
  if (typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  const parsed = parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface DockDragState {
  panelId: string;
  sourceAreaId: DockAreaId;
  timer: number | null;
  dragging: boolean;
}

interface DockDragPreview {
  panelId: string;
  x: number;
  y: number;
}

interface DockDropTarget {
  areaId: DockAreaId;
  surface: "title" | "panel";
  position: DockDropPosition;
  insertionIndex: number;
  showDraggedTitle: boolean;
  width: number;
  height: number;
}

interface DockOverflowMenu {
  areaId: DockAreaId;
  activePanelId: string | null;
  x: number;
  y: number;
  width: number;
}

interface DockPanelMenu {
  areaId: DockAreaId;
  panelId: string;
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function dockWindowFromPoint(clientX: number, clientY: number): HTMLElement | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element instanceof HTMLElement && element.dataset.dockArea) {
      return element;
    }
  }
  return null;
}

function dropPositionFromRect(rect: DOMRect, clientX: number, clientY: number): DockDropPosition {
  const insetLeft = Math.min(rect.left + DOCK_DROP_INSET_PX, rect.left + rect.width / 2);
  const insetRight = Math.max(rect.right - DOCK_DROP_INSET_PX, rect.left + rect.width / 2);
  const insetTop = Math.min(rect.top + DOCK_DROP_INSET_PX, rect.top + rect.height / 2);
  const insetBottom = Math.max(rect.bottom - DOCK_DROP_INSET_PX, rect.top + rect.height / 2);

  if (
    clientX >= insetLeft &&
    clientX <= insetRight &&
    clientY >= insetTop &&
    clientY <= insetBottom
  ) {
    return "self";
  }

  const edgeDistances: Array<[DockDropPosition, number]> = [
    ["left", Math.max(0, insetLeft - clientX)],
    ["right", Math.max(0, clientX - insetRight)],
    ["up", Math.max(0, insetTop - clientY)],
    ["down", Math.max(0, clientY - insetBottom)],
  ];
  return edgeDistances.reduce((best, current) => (current[1] > best[1] ? current : best))[0];
}

function DockDropZones({
  className,
  position,
  width,
  height,
}: {
  className: string;
  position: DockDropPosition;
  width: number;
  height: number;
}) {
  const leftInset = Math.min(DOCK_DROP_INSET_PX, width / 2);
  const rightInset = Math.max(width - DOCK_DROP_INSET_PX, width / 2);
  const topInset = Math.min(DOCK_DROP_INSET_PX, height / 2);
  const bottomInset = Math.max(height - DOCK_DROP_INSET_PX, height / 2);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon
        className={position === "left" ? "active" : undefined}
        points={`0,0 ${leftInset},${topInset} ${leftInset},${bottomInset} 0,${height}`}
      />
      <polygon
        className={position === "right" ? "active" : undefined}
        points={`${width},0 ${rightInset},${topInset} ${rightInset},${bottomInset} ${width},${height}`}
      />
      <polygon
        className={position === "up" ? "active" : undefined}
        points={`0,0 ${width},0 ${rightInset},${topInset} ${leftInset},${topInset}`}
      />
      <polygon
        className={position === "down" ? "active" : undefined}
        points={`0,${height} ${leftInset},${bottomInset} ${rightInset},${bottomInset} ${width},${height}`}
      />
      <polygon
        className={position === "self" ? "active" : undefined}
        points={`${leftInset},${topInset} ${rightInset},${topInset} ${rightInset},${bottomInset} ${leftInset},${bottomInset}`}
      />
    </svg>
  );
}

function DockSelfDropZone({ className, active = true }: { className: string; active?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon className={active ? "active" : undefined} points="0,0 100,0 100,100 0,100" />
    </svg>
  );
}

export function DockLayout() {
  const instances = usePanelManagerState((state) => state.instances);
  const layout = usePanelManagerState((state) => state.layout);
  const activatePanel = usePanelManagerState((state) => state.activatePanel);
  const focusPanel = usePanelManagerState((state) => state.focusPanel);
  const movePanel = usePanelManagerState((state) => state.movePanel);
  const resizeSplit = usePanelManagerState((state) => state.resizeSplit);
  const closePanel = usePanelManagerState((state) => state.closePanel);
  const closePanels = usePanelManagerState((state) => state.closePanels);
  const areaIds = dockAreaIds(layout.root);
  const dragRef = useRef<DockDragState | null>(null);
  const dropTargetRef = useRef<DockDropTarget | null>(null);
  const draggedTabWidthRef = useRef(0);
  const pendingTabPositionsRef = useRef<Map<string, DOMRect> | null>(null);
  const tabAnimationFrameRef = useRef<number | null>(null);
  const tabViewportRefs = useRef(new Map<DockAreaId, HTMLDivElement>());
  const tabElementRefs = useRef(new Map<DockAreaId, Map<string, HTMLDivElement>>());
  const splitElementRefs = useRef(new Map<string, HTMLDivElement>());
  const [resizerSize] = useState(() => readCssPixelVariable(RESIZER_SIZE_CSS_VAR, 6));
  const [dragPreview, setDragPreview] = useState<DockDragPreview | null>(null);
  const [dropTarget, setDropTarget] = useState<DockDropTarget | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState<Record<string, boolean>>({});
  const [overflowMenu, setOverflowMenu] = useState<DockOverflowMenu | null>(null);
  const [panelMenu, setPanelMenu] = useState<DockPanelMenu | null>(null);

  function revealTabNow(areaId: DockAreaId, panelId: string) {
    const viewport = tabViewportRefs.current.get(areaId);
    const tab = tabElementRefs.current.get(areaId)?.get(panelId);
    if (!viewport || !tab) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const leftOverflow = tabRect.left - viewportRect.left;
    const rightOverflow = tabRect.right - viewportRect.right;

    if (tabRect.width > viewportRect.width && rightOverflow > 0) {
      viewport.scrollLeft += leftOverflow;
    } else if (leftOverflow < 0) {
      viewport.scrollLeft += leftOverflow;
    } else if (rightOverflow > 0) {
      viewport.scrollLeft += rightOverflow;
    }
  }

  function revealTab(areaId: DockAreaId, panelId: string) {
    requestAnimationFrame(() => revealTabNow(areaId, panelId));
  }

  function revealActiveTabs() {
    requestAnimationFrame(() => {
      for (const areaId of areaIds) {
        const activePanelId = normalizeArea(layout.areas[areaId]).activePanelId;
        if (activePanelId) {
          revealTabNow(areaId, activePanelId);
        }
      }
    });
  }

  useEffect(() => {
    function measureOverflow() {
      const nextOverflow = areaIds.reduce(
        (result, areaId) => {
          const viewport = tabViewportRefs.current.get(areaId);
          if (!viewport) {
            result[areaId] = false;
            return result;
          }
          const overflowButton =
            viewport.parentElement?.querySelector<HTMLButtonElement>(".dock-overflow-button");
          const overflowButtonWidth = overflowButton?.getBoundingClientRect().width ?? 0;
          const availableWidth = viewport.clientWidth + overflowButtonWidth;
          result[areaId] = viewport.scrollWidth > availableWidth + 1;
          return result;
        },
        {} as Record<string, boolean>,
      );

      revealActiveTabs();
      setTabsOverflow((current) => {
        if (areaIds.every((areaId) => current[areaId] === nextOverflow[areaId])) {
          return current;
        }
        return nextOverflow;
      });
    }

    const animationFrame = requestAnimationFrame(measureOverflow);
    const resizeObserver = new ResizeObserver(measureOverflow);
    const mutationObserver = new MutationObserver(measureOverflow);
    for (const areaId of areaIds) {
      const viewport = tabViewportRefs.current.get(areaId);
      if (viewport) {
        resizeObserver.observe(viewport);
        mutationObserver.observe(viewport, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    window.addEventListener("resize", measureOverflow);
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [layout, instances]);

  useEffect(() => {
    revealActiveTabs();
  }, [layout, instances, tabsOverflow]);

  useEffect(() => {
    if (!overflowMenu && !panelMenu) {
      return;
    }

    const closeMenus = () => {
      setOverflowMenu(null);
      setPanelMenu(null);
    };
    window.addEventListener("pointerdown", closeMenus);
    window.addEventListener("keydown", closeMenus);
    window.addEventListener("resize", closeMenus);
    return () => {
      window.removeEventListener("pointerdown", closeMenus);
      window.removeEventListener("keydown", closeMenus);
      window.removeEventListener("resize", closeMenus);
    };
  }, [overflowMenu, panelMenu]);

  function setTabElementRef(areaId: DockAreaId, panelId: string, element: HTMLDivElement | null) {
    let refs = tabElementRefs.current.get(areaId);
    if (!refs) {
      refs = new Map();
      tabElementRefs.current.set(areaId, refs);
    }
    if (element) {
      refs.set(panelId, element);
    } else {
      refs.delete(panelId);
      if (refs.size === 0) {
        tabElementRefs.current.delete(areaId);
      }
    }
  }

  function captureTabPositions() {
    const positions = new Map<string, DOMRect>();
    for (const refs of tabElementRefs.current.values()) {
      for (const [panelId, element] of refs) {
        positions.set(panelId, element.getBoundingClientRect());
      }
    }
    pendingTabPositionsRef.current = positions;
  }

  function clearTabAnimations() {
    if (tabAnimationFrameRef.current !== null) {
      cancelAnimationFrame(tabAnimationFrameRef.current);
      tabAnimationFrameRef.current = null;
    }
    const tabs = Array.from(tabElementRefs.current.values()).flatMap((refs) =>
      Array.from(refs.values()),
    );
    for (const tab of tabs) {
      tab.style.transition = "none";
      tab.style.transform = "";
    }
    document.body.getBoundingClientRect();
    for (const tab of tabs) {
      tab.style.transition = "";
    }
  }

  function setDockDropTarget(nextTarget: DockDropTarget | null) {
    const currentTarget = dropTargetRef.current;
    if (
      currentTarget?.areaId === nextTarget?.areaId &&
      currentTarget?.surface === nextTarget?.surface &&
      currentTarget?.position === nextTarget?.position &&
      currentTarget?.insertionIndex === nextTarget?.insertionIndex &&
      currentTarget?.showDraggedTitle === nextTarget?.showDraggedTitle
    ) {
      return;
    }
    captureTabPositions();
    clearTabAnimations();
    dropTargetRef.current = nextTarget;
    setDropTarget(nextTarget);
  }

  useLayoutEffect(() => {
    const previousPositions = pendingTabPositionsRef.current;
    pendingTabPositionsRef.current = null;
    if (!previousPositions || !dragRef.current?.dragging) {
      return;
    }

    const movedTabs: HTMLDivElement[] = [];
    for (const refs of tabElementRefs.current.values()) {
      for (const [panelId, element] of refs) {
        const previousPosition = previousPositions.get(panelId);
        if (!previousPosition) {
          continue;
        }
        const nextPosition = element.getBoundingClientRect();
        const offsetX = previousPosition.left - nextPosition.left;
        const offsetY = previousPosition.top - nextPosition.top;
        if (Math.abs(offsetX) < 1 && Math.abs(offsetY) < 1) {
          continue;
        }
        element.style.transition = "none";
        element.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
        movedTabs.push(element);
      }
    }
    if (movedTabs.length === 0) {
      return;
    }

    document.body.getBoundingClientRect();
    tabAnimationFrameRef.current = requestAnimationFrame(() => {
      for (const element of movedTabs) {
        element.style.transition = "";
        element.style.transform = "";
      }
      tabAnimationFrameRef.current = null;
    });
  }, [dropTarget]);

  useEffect(
    () => () => {
      clearTabAnimations();
    },
    [],
  );

  function setActivePanel(areaId: DockAreaId, panelId: string) {
    activatePanel(areaId, panelId);
    setOverflowMenu(null);
    revealTab(areaId, panelId);
  }

  function cycleAreaPanel(areaId: DockAreaId, direction: -1 | 1) {
    const area = normalizeArea(layout.areas[areaId]);
    if (area.tabs.length <= 1 || !area.activePanelId) {
      return;
    }
    const index = area.tabs.indexOf(area.activePanelId);
    const nextIndex = (index + direction + area.tabs.length) % area.tabs.length;
    const nextPanelId = area.tabs[nextIndex];
    activatePanel(areaId, nextPanelId);
    revealTab(areaId, nextPanelId);
  }

  function startSplitResize(event: PointerEvent<HTMLDivElement>, split: DockSplitNode) {
    const rect = splitElementRefs.current.get(split.id)?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const size = split.axis === "x" ? rect.width : rect.height;
    const minimumRatio = Math.min(0.45, 160 / Math.max(size - resizerSize, 1));

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const offset =
        split.axis === "x" ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
      resizeSplit(split.id, clamp(offset / size, minimumRatio, 1 - minimumRatio));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove(`is-resizing-${split.axis}`);
    };

    document.body.classList.add(`is-resizing-${split.axis}`);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }

  function clearDockDragTimer(state = dragRef.current) {
    if (!state?.timer) {
      return;
    }
    window.clearTimeout(state.timer);
    state.timer = null;
  }

  function finishDockDrag() {
    const state = dragRef.current;
    clearDockDragTimer(state);
    const target = dropTargetRef.current;
    if (state?.dragging && target) {
      movePanel(state.panelId, target.areaId, target.insertionIndex, target.position);
    }
    dragRef.current = null;
    setDragPreview(null);
    setDockDropTarget(null);
    document.body.classList.remove("is-docking-panel");
    window.removeEventListener("pointermove", updateDockDrag);
    window.removeEventListener("pointerup", finishDockDrag);
    window.removeEventListener("pointercancel", finishDockDrag);
  }

  function updateDockDrag(event: globalThis.PointerEvent) {
    const state = dragRef.current;
    if (!state) {
      return;
    }
    if (!state.dragging) {
      return;
    }
    event.preventDefault();
    setDragPreview({ panelId: state.panelId, x: event.clientX, y: event.clientY });
    setDockDropTarget(dockDropTargetFromPoint(state.panelId, event.clientX, event.clientY));
  }

  function isOverDockTabbar(areaId: DockAreaId, clientY: number) {
    const viewportRect = tabViewportRefs.current.get(areaId)?.getBoundingClientRect();
    return Boolean(viewportRect && clientY >= viewportRect.top && clientY <= viewportRect.bottom);
  }

  function dockDropTargetFromPoint(
    draggedPanelId: string,
    clientX: number,
    clientY: number,
  ): DockDropTarget | null {
    const dockWindow = dockWindowFromPoint(clientX, clientY);
    const areaId = dockWindow?.dataset.dockArea;
    if (!dockWindow || !areaId || !layout.areas[areaId]) {
      return null;
    }

    const tabbar = dockWindow.querySelector<HTMLElement>(":scope > .dock-tabbar");
    const panelContent = dockWindow.querySelector<HTMLElement>(":scope > .dock-panel-content");
    const tabbarRect = tabbar?.getBoundingClientRect();
    const contentRect = panelContent?.getBoundingClientRect();
    const overTitle = Boolean(
      tabbarRect &&
      clientX >= tabbarRect.left &&
      clientX <= tabbarRect.right &&
      clientY >= tabbarRect.top &&
      clientY <= tabbarRect.bottom,
    );
    const surface = overTitle ? "title" : "panel";
    const position =
      surface === "title" || !contentRect
        ? "self"
        : dropPositionFromRect(contentRect, clientX, clientY);
    const targetTabs = normalizeArea(layout.areas[areaId]).tabs;
    const tabsWithoutDragged = targetTabs.filter((panelId) => panelId !== draggedPanelId);
    const preserveCurrentIndex =
      surface === "panel" && position === "self" && dragRef.current?.sourceAreaId === areaId;
    return {
      areaId,
      surface,
      position,
      insertionIndex: overTitle
        ? dockInsertionIndex(areaId, draggedPanelId, clientX, clientY)
        : preserveCurrentIndex
          ? Math.max(targetTabs.indexOf(draggedPanelId), 0)
          : tabsWithoutDragged.length,
      showDraggedTitle: surface === "title",
      width: contentRect?.width ?? 0,
      height: contentRect?.height ?? 0,
    };
  }

  function dockInsertionIndex(
    areaId: DockAreaId,
    draggedPanelId: string,
    clientX: number,
    clientY: number,
  ) {
    const tabs = normalizeArea(layout.areas[areaId]).tabs.filter(
      (panelId) => panelId !== draggedPanelId,
    );
    if (!isOverDockTabbar(areaId, clientY)) {
      return tabs.length;
    }
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabElementRefs.current.get(areaId)?.get(tabs[index]);
      if (tab) {
        const rect = tab.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          return index;
        }
      }
    }
    return tabs.length;
  }

  function startDockDrag(event: PointerEvent<HTMLDivElement>, areaId: DockAreaId, panelId: string) {
    if (event.button !== 0) {
      return;
    }
    focusPanel(panelId);
    event.preventDefault();
    event.stopPropagation();
    clearDockDragTimer();

    const state: DockDragState = {
      panelId,
      sourceAreaId: areaId,
      timer: null,
      dragging: false,
    };
    dragRef.current = state;

    state.timer = window.setTimeout(() => {
      if (dragRef.current !== state) {
        return;
      }
      state.dragging = true;
      document.body.classList.add("is-docking-panel");
      setActivePanel(areaId, panelId);
      setDragPreview({ panelId, x: event.clientX, y: event.clientY });
      draggedTabWidthRef.current =
        tabElementRefs.current.get(areaId)?.get(panelId)?.getBoundingClientRect().width ?? 0;
      const sourceTabs = normalizeArea(layout.areas[areaId]).tabs;
      setDockDropTarget({
        areaId: state.sourceAreaId,
        surface: "title",
        position: "self",
        insertionIndex: sourceTabs.indexOf(panelId),
        showDraggedTitle: true,
        width: 0,
        height: 0,
      });
    }, DOCK_DRAG_LONG_PRESS_MS);

    window.addEventListener("pointermove", updateDockDrag);
    window.addEventListener("pointerup", finishDockDrag, { once: true });
    window.addEventListener("pointercancel", finishDockDrag, { once: true });
  }

  function handleTabbarWheel(event: WheelEvent<HTMLDivElement>, areaId: DockAreaId) {
    const area = normalizeArea(layout.areas[areaId]);
    if (area.tabs.length <= 1) {
      return;
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) {
      return;
    }
    event.stopPropagation();
    cycleAreaPanel(areaId, delta > 0 ? 1 : -1);
  }

  function toggleOverflowMenu(
    event: PointerEvent<HTMLButtonElement>,
    areaId: DockAreaId,
    activePanelId: string | null,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 252;
    const viewportPadding = 6;
    const leftAlignedX = rect.left;
    const rightAlignedX = rect.right - menuWidth;
    const x =
      leftAlignedX + menuWidth <= window.innerWidth - viewportPadding
        ? leftAlignedX
        : Math.max(viewportPadding, rightAlignedX);
    setOverflowMenu((current) =>
      current?.areaId === areaId
        ? null
        : {
            areaId,
            activePanelId,
            x,
            y: rect.bottom,
            width: menuWidth,
          },
    );
  }

  function openPanelMenu(
    event: PointerEvent<HTMLButtonElement>,
    areaId: DockAreaId,
    panelId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showPanelMenu(areaId, panelId, rect.left, rect.bottom);
  }

  function showPanelMenu(areaId: DockAreaId, panelId: string, x: number, y: number) {
    setActivePanel(areaId, panelId);
    setOverflowMenu(null);
    setPanelMenu({ areaId, panelId, x, y });
  }

  function openPanelMenuFromTitleContext(
    event: ReactMouseEvent<HTMLDivElement>,
    areaId: DockAreaId,
    panelId: string,
  ) {
    event.preventDefault();
    event.stopPropagation();
    showPanelMenu(areaId, panelId, event.clientX, event.clientY);
  }

  function renderDockWindow(areaId: DockAreaId) {
    const area = normalizeArea(layout.areas[areaId]);
    const activePanel = area.activePanelId ? instances[area.activePanelId] : null;
    const draggedPanelId = dragPreview?.panelId;
    const areaTabs = area.tabs.filter((panelId) => Boolean(instances[panelId]));
    const tabsWithoutDragged = draggedPanelId
      ? areaTabs.filter((panelId) => panelId !== draggedPanelId)
      : areaTabs;
    const displayedTabs =
      draggedPanelId && dropTarget?.areaId === areaId && dropTarget.showDraggedTitle
        ? [
            ...tabsWithoutDragged.slice(0, dropTarget.insertionIndex),
            draggedPanelId,
            ...tabsWithoutDragged.slice(dropTarget.insertionIndex),
          ]
        : tabsWithoutDragged;
    const isIntraAreaDrag =
      Boolean(draggedPanelId) &&
      dropTarget?.areaId === areaId &&
      dragRef.current?.sourceAreaId === areaId;
    const showIntraAreaControls = isIntraAreaDrag && Boolean(dropTarget?.showDraggedTitle);

    return (
      <section
        key={areaId}
        className={`dock-window ${displayedTabs.length > 1 ? "has-multiple-tabs" : "has-single-tab"}`}
        data-dock-area={areaId}
      >
        <div className="dock-tabbar" onWheel={(event) => handleTabbarWheel(event, areaId)}>
          <div
            ref={(node) => {
              if (node) {
                tabViewportRefs.current.set(areaId, node);
              } else {
                tabViewportRefs.current.delete(areaId);
              }
            }}
            className="dock-tabs-viewport"
          >
            <div className="dock-tabs">
              {displayedTabs.length === 0 ? (
                <div className="dock-empty-tab">拖入面板</div>
              ) : (
                displayedTabs.map((panelId) => {
                  if (panelId === draggedPanelId) {
                    return (
                      <PanelTitle key={panelId} instanceId={panelId}>
                        {(title) => (
                          <div
                            ref={(node) => setTabElementRef(areaId, panelId, node)}
                            className={`dock-tab dock-tab-placeholder ${
                              showIntraAreaControls ? "active" : ""
                            }`}
                            style={{ width: draggedTabWidthRef.current }}
                            aria-hidden="true"
                          >
                            {dropTarget?.showDraggedTitle && (
                              <span
                                className={`dock-tab-label ${
                                  showIntraAreaControls ? "" : "dock-tab-drag-label"
                                }`}
                              >
                                {title}
                              </span>
                            )}
                            {showIntraAreaControls && (
                              <span className="dock-tab-grip">
                                <span />
                              </span>
                            )}
                          </div>
                        )}
                      </PanelTitle>
                    );
                  }
                  const isActive = panelId === area.activePanelId;
                  return (
                    <PanelTitle key={panelId} instanceId={panelId}>
                      {(title) => (
                        <div
                          ref={(node) => setTabElementRef(areaId, panelId, node)}
                          className={`dock-tab ${isActive ? "active" : ""}`}
                          onClick={() => setActivePanel(areaId, panelId)}
                          onPointerDown={(event) => startDockDrag(event, areaId, panelId)}
                          onContextMenu={(event) =>
                            openPanelMenuFromTitleContext(event, areaId, panelId)
                          }
                        >
                          <button type="button" className="dock-tab-label" title={title}>
                            {title}
                          </button>
                          <button
                            type="button"
                            className="dock-tab-grip"
                            title="面板菜单"
                            aria-label={`${title} 面板菜单`}
                            onPointerDown={(event) => openPanelMenu(event, areaId, panelId)}
                          >
                            <span />
                          </button>
                        </div>
                      )}
                    </PanelTitle>
                  );
                })
              )}
            </div>
          </div>
          <div className="dock-tabbar-controls">
            {activePanel && (
              <div className="dock-tab-actions">
                <PanelActions instanceId={activePanel.id} />
              </div>
            )}
            {tabsOverflow[areaId] && (
              <button
                type="button"
                className={`dock-overflow-button ${overflowMenu?.areaId === areaId ? "active" : ""}`}
                title="显示全部标题"
                aria-label="显示全部标题"
                aria-expanded={overflowMenu?.areaId === areaId}
                onPointerDown={(event) => toggleOverflowMenu(event, areaId, area.activePanelId)}
              />
            )}
          </div>
          {dragPreview && dropTarget?.areaId === areaId && (
            <DockSelfDropZone
              className="dock-title-drop-zones"
              active={dropTarget.surface === "title"}
            />
          )}
        </div>

        <div className="dock-panel-content">
          {area.tabs.map((panelId) => {
            if (!instances[panelId]) {
              return null;
            }
            return (
              <div
                key={panelId}
                className={`dock-panel-surface ${panelId === area.activePanelId ? "active" : ""}`}
                onPointerDownCapture={() => focusPanel(panelId)}
                onFocusCapture={() => focusPanel(panelId)}
              >
                <PanelHost instanceId={panelId} active={panelId === area.activePanelId} />
              </div>
            );
          })}
          {area.tabs.length === 0 && (
            <div className="dock-empty-content">
              <span>将面板拖到这里</span>
            </div>
          )}
          {dragPreview &&
            dropTarget?.areaId === areaId &&
            (dropTarget.surface === "title" ? (
              <DockSelfDropZone className="dock-drop-zones" active={false} />
            ) : (
              <DockDropZones
                className="dock-drop-zones"
                position={dropTarget.position}
                width={dropTarget.width}
                height={dropTarget.height}
              />
            ))}
        </div>
      </section>
    );
  }

  function renderDockNode(node: DockLayoutNode) {
    if (node.type === "area") {
      return renderDockWindow(node.areaId);
    }
    const gridStyle =
      node.axis === "x"
        ? {
            gridTemplateColumns: `minmax(0, ${node.ratio}fr) ${resizerSize}px minmax(0, ${1 - node.ratio}fr)`,
          }
        : {
            gridTemplateRows: `minmax(0, ${node.ratio}fr) ${resizerSize}px minmax(0, ${1 - node.ratio}fr)`,
          };
    return (
      <div
        key={node.id}
        ref={(element) => {
          if (element) {
            splitElementRefs.current.set(node.id, element);
          } else {
            splitElementRefs.current.delete(node.id);
          }
        }}
        className={`dock-split dock-split-${node.axis}`}
        data-split-id={node.id}
        style={gridStyle}
      >
        {renderDockNode(node.first)}
        <div
          className={`pane-resizer ${
            node.axis === "x" ? "pane-resizer-vertical" : "pane-resizer-horizontal"
          }`}
          role="separator"
          aria-orientation={node.axis === "x" ? "vertical" : "horizontal"}
          title={node.axis === "x" ? "调整左右窗口宽度" : "调整上下窗口高度"}
          onPointerDown={(event) => startSplitResize(event, node)}
        />
        {renderDockNode(node.second)}
      </div>
    );
  }

  return (
    <>
      <main className="workspace dock-workspace">{renderDockNode(layout.root)}</main>

      {dragPreview && !dropTarget?.showDraggedTitle && (
        <div
          className="dock-drag-preview"
          style={{
            transform: `translate(${dragPreview.x + 12}px, ${dragPreview.y + 10}px)`,
          }}
        >
          <PanelTitle instanceId={dragPreview.panelId}>{(title) => title}</PanelTitle>
        </div>
      )}

      {panelMenu && (
        <PopupMenu
          className="dock-panel-menu"
          contextMenuAnchor={panelMenu}
          style={{ position: "fixed", left: panelMenu.x, top: panelMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <PopupMenuItem
            onSelect={() => {
              closePanel(panelMenu.panelId);
              setPanelMenu(null);
            }}
          >
            关闭面板
          </PopupMenuItem>
          <PopupMenuItem disabled>浮动面板</PopupMenuItem>
          <PopupMenuItem
            onSelect={() => {
              closePanels(
                panelMenu.areaId,
                normalizeArea(layout.areas[panelMenu.areaId]).tabs.filter(
                  (panelId) => panelId !== panelMenu.panelId,
                ),
              );
              setPanelMenu(null);
            }}
            disabled={normalizeArea(layout.areas[panelMenu.areaId]).tabs.length <= 1}
          >
            关闭组中的其他面板
          </PopupMenuItem>
          <PopupMenuItem disabled submenu>
            面板组设置
          </PopupMenuItem>
          <PanelMenuItems instanceId={panelMenu.panelId} closeMenu={() => setPanelMenu(null)} />
        </PopupMenu>
      )}

      {overflowMenu && (
        <div
          className="dock-overflow-menu"
          style={{
            left: `${overflowMenu.x}px`,
            top: `${overflowMenu.y}px`,
            width: `${overflowMenu.width}px`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {normalizeArea(layout.areas[overflowMenu.areaId]).tabs.map((panelId) => {
            if (!instances[panelId]) {
              return null;
            }
            const isActive = panelId === overflowMenu.activePanelId;
            return (
              <PanelTitle key={panelId} instanceId={panelId}>
                {(title) => (
                  <button
                    type="button"
                    className={`dock-overflow-menu-item ${isActive ? "active" : ""}`}
                    title={title}
                    onClick={() => setActivePanel(overflowMenu.areaId, panelId)}
                  >
                    <span className="dock-overflow-check">{isActive ? "✓" : ""}</span>
                    <span>{title}</span>
                  </button>
                )}
              </PanelTitle>
            );
          })}
        </div>
      )}
    </>
  );
}
