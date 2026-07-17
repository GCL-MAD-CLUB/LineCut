import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import "./DockLayout.css";
import { PopupMenu, PopupMenuItem, PopupMenuSeparator } from "../PopupMenu";
import { dockAreaOrder, normalizeArea, usePanelManagerState } from "./PanelManager";
import { PanelActions, PanelHost, PanelMenuItems, PanelTitle } from "./PanelRegistry";
import type { DockAreaId } from "./types";

const DOCK_DRAG_LONG_PRESS_MS = 220;
const RESIZER_SIZE_CSS_VAR = "--resizer-size";

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

function dockAreaFromPoint(clientX: number, clientY: number): DockAreaId | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element instanceof HTMLElement && element.dataset.dockArea) {
      return element.dataset.dockArea as DockAreaId;
    }
  }
  return null;
}

export function DockLayout() {
  const instances = usePanelManagerState((state) => state.instances);
  const layout = usePanelManagerState((state) => state.layout);
  const activatePanel = usePanelManagerState((state) => state.activatePanel);
  const focusPanel = usePanelManagerState((state) => state.focusPanel);
  const movePanel = usePanelManagerState((state) => state.movePanel);
  const closePanel = usePanelManagerState((state) => state.closePanel);
  const closePanels = usePanelManagerState((state) => state.closePanels);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const leftPaneRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DockDragState | null>(null);
  const dropTargetAreaRef = useRef<DockAreaId | null>(null);
  const tabViewportRefs = useRef<Record<DockAreaId, HTMLDivElement | null>>({
    leftTop: null,
    leftBottom: null,
    right: null,
  });
  const tabElementRefs = useRef<Record<DockAreaId, Map<string, HTMLDivElement>>>({
    leftTop: new Map(),
    leftBottom: new Map(),
    right: new Map(),
  });
  const [leftPaneWidth, setLeftPaneWidth] = useState(100 / 2.8);
  const [previewPaneHeight, setPreviewPaneHeight] = useState(48);
  const [resizerSize] = useState(() => readCssPixelVariable(RESIZER_SIZE_CSS_VAR, 6));
  const [dragPreview, setDragPreview] = useState<DockDragPreview | null>(null);
  const [dropTargetAreaId, setDropTargetAreaId] = useState<DockAreaId | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState<Record<DockAreaId, boolean>>({
    leftTop: false,
    leftBottom: false,
    right: false,
  });
  const [overflowMenu, setOverflowMenu] = useState<DockOverflowMenu | null>(null);
  const [panelMenu, setPanelMenu] = useState<DockPanelMenu | null>(null);

  function revealTabNow(areaId: DockAreaId, panelId: string) {
    const viewport = tabViewportRefs.current[areaId];
    const tab = tabElementRefs.current[areaId].get(panelId);
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
      for (const areaId of dockAreaOrder) {
        const activePanelId = normalizeArea(layout.areas[areaId]).activePanelId;
        if (activePanelId) {
          revealTabNow(areaId, activePanelId);
        }
      }
    });
  }

  useEffect(() => {
    function measureOverflow() {
      const nextOverflow = dockAreaOrder.reduce(
        (result, areaId) => {
          const viewport = tabViewportRefs.current[areaId];
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
        { leftTop: false, leftBottom: false, right: false } as Record<DockAreaId, boolean>,
      );

      revealActiveTabs();
      setTabsOverflow((current) => {
        if (dockAreaOrder.every((areaId) => current[areaId] === nextOverflow[areaId])) {
          return current;
        }
        return nextOverflow;
      });
    }

    const animationFrame = requestAnimationFrame(measureOverflow);
    const resizeObserver = new ResizeObserver(measureOverflow);
    const mutationObserver = new MutationObserver(measureOverflow);
    for (const areaId of dockAreaOrder) {
      const viewport = tabViewportRefs.current[areaId];
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
  }, [layout, instances, leftPaneWidth, previewPaneHeight, tabsOverflow]);

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
    const refs = tabElementRefs.current[areaId];
    if (element) {
      refs.set(panelId, element);
    } else {
      refs.delete(panelId);
    }
  }

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

  function startHorizontalResize(event: PointerEvent<HTMLDivElement>) {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const minLeft = 320;
    const minRight = 420 + resizerSize;
    const minPercent = (minLeft / rect.width) * 100;
    const maxPercent = 100 - (minRight / rect.width) * 100;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const next = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLeftPaneWidth(clamp(next, minPercent, maxPercent));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-x");
    };

    document.body.classList.add("is-resizing-x");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startVerticalResize(event: PointerEvent<HTMLDivElement>) {
    const rect = leftPaneRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const minTop = 220;
    const minBottom = 240 + resizerSize;
    const minPercent = (minTop / rect.height) * 100;
    const maxPercent = 100 - (minBottom / rect.height) * 100;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const next = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setPreviewPaneHeight(clamp(next, minPercent, maxPercent));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-y");
    };

    document.body.classList.add("is-resizing-y");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
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
    const targetAreaId = dropTargetAreaRef.current;
    if (state?.dragging && targetAreaId) {
      movePanel(state.panelId, targetAreaId);
    }
    dragRef.current = null;
    setDragPreview(null);
    setDropTargetAreaId(null);
    dropTargetAreaRef.current = null;
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
    const nextDropTarget = dockAreaFromPoint(event.clientX, event.clientY);
    dropTargetAreaRef.current = nextDropTarget;
    setDropTargetAreaId(nextDropTarget);
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
      const nextDropTarget = dockAreaFromPoint(event.clientX, event.clientY) ?? state.sourceAreaId;
      dropTargetAreaRef.current = nextDropTarget;
      setDropTargetAreaId(nextDropTarget);
    }, DOCK_DRAG_LONG_PRESS_MS);

    window.addEventListener("pointermove", updateDockDrag);
    window.addEventListener("pointerup", finishDockDrag, { once: true });
    window.addEventListener("pointercancel", finishDockDrag, { once: true });
  }

  function handleTabbarWheel(event: WheelEvent<HTMLDivElement>, areaId: DockAreaId) {
    const area = layout.areas[areaId];
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

    return (
      <section
        className={`dock-window ${area.tabs.length > 1 ? "has-multiple-tabs" : "has-single-tab"} ${
          dropTargetAreaId === areaId ? "drop-target" : ""
        }`}
        data-dock-area={areaId}
      >
        <div className="dock-tabbar" onWheel={(event) => handleTabbarWheel(event, areaId)}>
          <div
            ref={(node) => {
              tabViewportRefs.current[areaId] = node;
            }}
            className="dock-tabs-viewport"
          >
            <div className="dock-tabs">
              {area.tabs.length === 0 ? (
                <div className="dock-empty-tab">拖入面板</div>
              ) : (
                area.tabs.map((panelId) => {
                  if (!instances[panelId]) {
                    return null;
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
        </div>
      </section>
    );
  }

  return (
    <>
      <main
        ref={workspaceRef}
        className="workspace dock-workspace"
        style={{
          gridTemplateColumns: `minmax(320px, ${leftPaneWidth}%) ${resizerSize}px minmax(420px, 1fr)`,
        }}
      >
        <section
          ref={leftPaneRef}
          className="left-pane dock-left-pane"
          style={{
            gridTemplateRows: `minmax(220px, ${previewPaneHeight}%) ${resizerSize}px minmax(240px, 1fr)`,
          }}
        >
          {renderDockWindow("leftTop")}

          <div
            className="pane-resizer pane-resizer-horizontal"
            role="separator"
            aria-orientation="horizontal"
            title="调整上下窗口高度"
            onPointerDown={startVerticalResize}
          />

          {renderDockWindow("leftBottom")}
        </section>

        <div
          className="pane-resizer pane-resizer-vertical"
          role="separator"
          aria-orientation="vertical"
          title="调整左右窗口宽度"
          onPointerDown={startHorizontalResize}
        />

        {renderDockWindow("right")}
      </main>

      {dragPreview && (
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
