import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import "./DockLayout.css";
import { PanelInstanceProvider } from "../../panelState";
import type { DockAreaId, DockLayoutState, DockPanelDefinition } from "./types";

const dockAreaOrder: DockAreaId[] = ["leftTop", "leftBottom", "right"];
const DOCK_DRAG_LONG_PRESS_MS = 220;

interface DockDragState<PanelId extends string> {
  panelId: PanelId;
  sourceAreaId: DockAreaId;
  timer: number | null;
  dragging: boolean;
}

interface DockDragPreview<PanelId extends string> {
  panelId: PanelId;
  x: number;
  y: number;
}

interface DockOverflowMenu<PanelId extends string> {
  areaId: DockAreaId;
  activePanelId: PanelId | null;
  x: number;
  y: number;
  width: number;
}

interface DockLayoutProps<PanelId extends string> {
  panels: Array<DockPanelDefinition<PanelId>>;
  initialLayout: DockLayoutState<PanelId>;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeArea<PanelId extends string>(
  area: DockLayoutState<PanelId>["areas"][DockAreaId],
) {
  if (area.tabs.length === 0) {
    return { tabs: area.tabs, activePanelId: null };
  }
  return {
    tabs: area.tabs,
    activePanelId:
      area.activePanelId && area.tabs.includes(area.activePanelId)
        ? area.activePanelId
        : area.tabs[0],
  };
}

function dockAreaFromPoint(clientX: number, clientY: number): DockAreaId | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element instanceof HTMLElement && element.dataset.dockArea) {
      return element.dataset.dockArea as DockAreaId;
    }
  }
  return null;
}

export function DockLayout<PanelId extends string>({
  panels,
  initialLayout,
}: DockLayoutProps<PanelId>) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const leftPaneRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DockDragState<PanelId> | null>(null);
  const dropTargetAreaRef = useRef<DockAreaId | null>(null);
  const tabViewportRefs = useRef<Record<DockAreaId, HTMLDivElement | null>>({
    leftTop: null,
    leftBottom: null,
    right: null,
  });
  const tabElementRefs = useRef<Record<DockAreaId, Map<PanelId, HTMLDivElement>>>({
    leftTop: new Map(),
    leftBottom: new Map(),
    right: new Map(),
  });
  const [layout, setLayout] = useState(initialLayout);
  const [leftPaneWidth, setLeftPaneWidth] = useState(100 / 2.8);
  const [previewPaneHeight, setPreviewPaneHeight] = useState(48);
  const [dragPreview, setDragPreview] = useState<DockDragPreview<PanelId> | null>(null);
  const [dropTargetAreaId, setDropTargetAreaId] = useState<DockAreaId | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState<Record<DockAreaId, boolean>>({
    leftTop: false,
    leftBottom: false,
    right: false,
  });
  const [overflowMenu, setOverflowMenu] = useState<DockOverflowMenu<PanelId> | null>(null);

  const panelMap = useMemo(() => {
    return new Map(panels.map((panel) => [panel.id, panel]));
  }, [panels]);

  function revealTabNow(areaId: DockAreaId, panelId: PanelId) {
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

  function revealTab(areaId: DockAreaId, panelId: PanelId) {
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
    for (const areaId of dockAreaOrder) {
      const viewport = tabViewportRefs.current[areaId];
      if (viewport) {
        resizeObserver.observe(viewport);
      }
    }
    window.addEventListener("resize", measureOverflow);
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [layout, panels]);

  useEffect(() => {
    revealActiveTabs();
  }, [layout, panels, leftPaneWidth, previewPaneHeight, tabsOverflow]);

  useEffect(() => {
    if (!overflowMenu) {
      return;
    }

    const closeOverflowMenu = () => setOverflowMenu(null);
    window.addEventListener("pointerdown", closeOverflowMenu);
    window.addEventListener("keydown", closeOverflowMenu);
    window.addEventListener("resize", closeOverflowMenu);
    return () => {
      window.removeEventListener("pointerdown", closeOverflowMenu);
      window.removeEventListener("keydown", closeOverflowMenu);
      window.removeEventListener("resize", closeOverflowMenu);
    };
  }, [overflowMenu]);

  function setTabElementRef(areaId: DockAreaId, panelId: PanelId, element: HTMLDivElement | null) {
    const refs = tabElementRefs.current[areaId];
    if (element) {
      refs.set(panelId, element);
    } else {
      refs.delete(panelId);
    }
  }

  function setActivePanel(areaId: DockAreaId, panelId: PanelId) {
    setLayout((current) => ({
      areas: {
        ...current.areas,
        [areaId]: {
          ...current.areas[areaId],
          activePanelId: panelId,
        },
      },
    }));
    setOverflowMenu(null);
    revealTab(areaId, panelId);
  }

  function cycleAreaPanel(areaId: DockAreaId, direction: -1 | 1) {
    setLayout((current) => {
      const area = normalizeArea(current.areas[areaId]);
      if (area.tabs.length <= 1 || !area.activePanelId) {
        return current;
      }
      const index = area.tabs.indexOf(area.activePanelId);
      const nextIndex = (index + direction + area.tabs.length) % area.tabs.length;
      const nextPanelId = area.tabs[nextIndex];
      revealTab(areaId, nextPanelId);
      return {
        areas: {
          ...current.areas,
          [areaId]: {
            ...area,
            activePanelId: nextPanelId,
          },
        },
      };
    });
  }

  function movePanel(panelId: PanelId, targetAreaId: DockAreaId) {
    setLayout((current) => {
      const nextAreas = { ...current.areas };
      for (const areaId of dockAreaOrder) {
        const area = current.areas[areaId];
        const tabs = area.tabs.filter((tabPanelId) => tabPanelId !== panelId);
        nextAreas[areaId] = normalizeArea({
          tabs,
          activePanelId: area.activePanelId === panelId ? (tabs[0] ?? null) : area.activePanelId,
        });
      }

      const targetTabs = nextAreas[targetAreaId].tabs.includes(panelId)
        ? nextAreas[targetAreaId].tabs
        : [...nextAreas[targetAreaId].tabs, panelId];

      nextAreas[targetAreaId] = {
        tabs: targetTabs,
        activePanelId: panelId,
      };

      return { areas: nextAreas };
    });
  }

  function startHorizontalResize(event: PointerEvent<HTMLDivElement>) {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const splitterWidth = 6;
    const minLeft = 320;
    const minRight = 420 + splitterWidth;
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

    const splitterHeight = 6;
    const minTop = 220;
    const minBottom = 240 + splitterHeight;
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

  function startDockDrag(
    event: PointerEvent<HTMLDivElement>,
    areaId: DockAreaId,
    panelId: PanelId,
  ) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearDockDragTimer();

    const state: DockDragState<PanelId> = {
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
    activePanelId: PanelId | null,
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

  function renderDockWindow(areaId: DockAreaId) {
    const area = normalizeArea(layout.areas[areaId]);
    const activePanel = area.activePanelId ? panelMap.get(area.activePanelId) : null;

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
                  const panel = panelMap.get(panelId);
                  if (!panel) {
                    return null;
                  }
                  const isActive = panelId === area.activePanelId;
                  return (
                    <div
                      key={panelId}
                      ref={(node) => setTabElementRef(areaId, panelId, node)}
                      className={`dock-tab ${isActive ? "active" : ""}`}
                      onClick={() => setActivePanel(areaId, panelId)}
                      onPointerDown={(event) => startDockDrag(event, areaId, panelId)}
                    >
                      <button type="button" className="dock-tab-label" title={panel.title}>
                        {panel.title}
                      </button>
                      <button
                        type="button"
                        className="dock-tab-grip"
                        title="长按拖动面板"
                        aria-label={`拖动 ${panel.title}`}
                      >
                        <span />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="dock-tabbar-controls">
            {activePanel?.actions && <div className="dock-tab-actions">{activePanel.actions}</div>}
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
            const panel = panelMap.get(panelId);
            if (!panel) {
              return null;
            }
            return (
              <div
                key={panelId}
                className={`dock-panel-surface ${panelId === area.activePanelId ? "active" : ""}`}
              >
                <PanelInstanceProvider instanceId={panelId}>{panel.render()}</PanelInstanceProvider>
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
          gridTemplateColumns: `minmax(320px, ${leftPaneWidth}%) 6px minmax(420px, 1fr)`,
        }}
      >
        <section
          ref={leftPaneRef}
          className="left-pane dock-left-pane"
          style={{
            gridTemplateRows: `minmax(220px, ${previewPaneHeight}%) 6px minmax(240px, 1fr)`,
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
          {panelMap.get(dragPreview.panelId)?.title ?? "面板"}
        </div>
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
            const panel = panelMap.get(panelId);
            if (!panel) {
              return null;
            }
            const isActive = panelId === overflowMenu.activePanelId;
            return (
              <button
                key={panelId}
                type="button"
                className={`dock-overflow-menu-item ${isActive ? "active" : ""}`}
                title={panel.title}
                onClick={() => setActivePanel(overflowMenu.areaId, panelId)}
              >
                <span className="dock-overflow-check">{isActive ? "✓" : ""}</span>
                <span>{panel.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
