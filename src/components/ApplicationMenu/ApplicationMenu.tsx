import { useEffect, useRef, useState } from "react";
import { PopupMenu, PopupMenuItem, PopupMenuSeparator, PopupMenuSubmenu } from "../PopupMenu";
import "./ApplicationMenu.css";

interface ApplicationMenuProps {
  hasProject: boolean;
  isDirty: boolean;
  isBusy: boolean;
  isMediaBinReadOnly: boolean;
  onNewProject: () => void | Promise<void>;
  onOpenProject: () => void | Promise<void>;
  onCloseProject: () => void | Promise<void>;
  onSaveProject: () => void | Promise<void>;
  onSaveProjectAs: () => void | Promise<void>;
  onSaveProjectCopy: () => void | Promise<void>;
  recentProjectPaths: string[];
  onOpenRecentProject: (path: string) => void | Promise<void>;
  onImportMedia: () => void | Promise<void>;
  recentMediaPaths: string[];
  onImportRecentMedia: (path: string) => void | Promise<void>;
  canSelectAllSubtitleCues: boolean;
  canClearSubtitleCueSelection: boolean;
  onSelectAllSubtitleCues: () => void;
  onClearSubtitleCueSelection: () => void;
  onOpenPreferences: () => void;
  onExit: () => void | Promise<void>;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function ApplicationMenu({
  hasProject,
  isDirty,
  isBusy,
  isMediaBinReadOnly,
  onNewProject,
  onOpenProject,
  onCloseProject,
  onSaveProject,
  onSaveProjectAs,
  onSaveProjectCopy,
  recentProjectPaths,
  onOpenRecentProject,
  onImportMedia,
  recentMediaPaths,
  onImportRecentMedia,
  canSelectAllSubtitleCues,
  canClearSubtitleCueSelection,
  onSelectAllSubtitleCues,
  onClearSubtitleCueSelection,
  onOpenPreferences,
  onExit,
}: ApplicationMenuProps) {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const [recentProjectMenuOpen, setRecentProjectMenuOpen] = useState(false);
  const [recentImportMenuOpen, setRecentImportMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!fileMenuOpen && !editMenuOpen) {
      return;
    }

    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
        setEditMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFileMenuOpen(false);
        setEditMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [editMenuOpen, fileMenuOpen]);

  useEffect(() => {
    if (!fileMenuOpen) {
      setRecentProjectMenuOpen(false);
      setRecentImportMenuOpen(false);
    }
  }, [fileMenuOpen]);

  const select = (handler: () => void | Promise<void>) => async () => {
    setFileMenuOpen(false);
    setEditMenuOpen(false);
    await handler();
  };

  return (
    <nav className="application-menu" aria-label="应用菜单" ref={menuRef}>
      <div className="application-menu-root">
        <button
          type="button"
          className={`application-menu-trigger${fileMenuOpen ? " active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={fileMenuOpen}
          onClick={() => {
            setFileMenuOpen((open) => !open);
            setEditMenuOpen(false);
          }}
        >
          文件(F)
        </button>
        {fileMenuOpen && (
          <PopupMenu>
            <PopupMenuItem shortcut="Ctrl+N" disabled={isBusy} onSelect={select(onNewProject)}>
              新建项目(N)...
            </PopupMenuItem>
            <PopupMenuItem shortcut="Ctrl+O" disabled={isBusy} onSelect={select(onOpenProject)}>
              打开项目(O)...
            </PopupMenuItem>
            <PopupMenuSubmenu
              label="打开最近使用的内容(E)"
              open={recentProjectMenuOpen}
              disabled={recentProjectPaths.length === 0 || isBusy}
              onOpenChange={(open) => {
                setRecentProjectMenuOpen(open);
                if (open) {
                  setRecentImportMenuOpen(false);
                }
              }}
            >
              {recentProjectPaths.map((path) => (
                <PopupMenuItem
                  key={path}
                  title={path}
                  disabled={isBusy}
                  onSelect={select(() => onOpenRecentProject(path))}
                >
                  {fileName(path)}
                </PopupMenuItem>
              ))}
            </PopupMenuSubmenu>
            <PopupMenuSeparator />
            <PopupMenuItem
              shortcut="Ctrl+Shift+W"
              disabled={!hasProject || isBusy}
              onSelect={select(onCloseProject)}
            >
              关闭项目(P)
            </PopupMenuItem>
            <PopupMenuItem
              shortcut="Ctrl+S"
              disabled={!hasProject || !isDirty || isBusy}
              onSelect={select(onSaveProject)}
            >
              保存(S)
            </PopupMenuItem>
            <PopupMenuItem
              shortcut="Ctrl+Shift+S"
              disabled={!hasProject || isBusy}
              onSelect={select(onSaveProjectAs)}
            >
              另存为(A)...
            </PopupMenuItem>
            <PopupMenuItem
              shortcut="Ctrl+Alt+S"
              disabled={!hasProject || isBusy}
              onSelect={select(onSaveProjectCopy)}
            >
              保存副本(Y)...
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              shortcut="Ctrl+I"
              disabled={isMediaBinReadOnly || isBusy}
              onSelect={select(onImportMedia)}
            >
              导入(I)...
            </PopupMenuItem>
            <PopupMenuSubmenu
              label="导入最近使用的文件(F)"
              open={recentImportMenuOpen}
              disabled={recentMediaPaths.length === 0 || isMediaBinReadOnly || isBusy}
              onOpenChange={(open) => {
                setRecentImportMenuOpen(open);
                if (open) {
                  setRecentProjectMenuOpen(false);
                }
              }}
            >
              {recentMediaPaths.map((path) => (
                <PopupMenuItem
                  key={path}
                  title={path}
                  disabled={isMediaBinReadOnly || isBusy}
                  onSelect={select(() => onImportRecentMedia(path))}
                >
                  {fileName(path)}
                </PopupMenuItem>
              ))}
            </PopupMenuSubmenu>
            <PopupMenuSeparator />
            <PopupMenuItem shortcut="Ctrl+Q" onSelect={select(onExit)}>
              退出(X)
            </PopupMenuItem>
          </PopupMenu>
        )}
      </div>
      <div className="application-menu-root">
        <button
          type="button"
          className={`application-menu-trigger${editMenuOpen ? " active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={editMenuOpen}
          onClick={() => {
            setEditMenuOpen((open) => !open);
            setFileMenuOpen(false);
          }}
        >
          编辑(E)
        </button>
        {editMenuOpen && (
          <PopupMenu>
            <PopupMenuItem
              shortcut="Ctrl+A"
              disabled={!canSelectAllSubtitleCues || isBusy}
              onSelect={select(onSelectAllSubtitleCues)}
            >
              全选(A)
            </PopupMenuItem>
            <PopupMenuItem
              shortcut="Ctrl+Shift+A"
              disabled={!canClearSubtitleCueSelection || isBusy}
              onSelect={select(onClearSubtitleCueSelection)}
            >
              取消全选(D)
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem disabled={isBusy} onSelect={select(onOpenPreferences)}>
              首选项...
            </PopupMenuItem>
          </PopupMenu>
        )}
      </div>
      {[
        ["剪辑(C)", "剪辑菜单将在后续版本实现"],
        ["窗口(W)", "窗口菜单将在后续版本实现"],
        ["帮助(H)", "帮助菜单将在后续版本实现"],
      ].map(([label, title]) => (
        <button
          key={label}
          type="button"
          className="application-menu-trigger application-menu-placeholder"
          aria-disabled="true"
          title={title}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
