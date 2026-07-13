import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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

interface MenuItemProps {
  children: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  submenu?: boolean;
  title?: string;
  onSelect?: () => void | Promise<void>;
}

function MenuItem({ children, shortcut, disabled, submenu, title, onSelect }: MenuItemProps) {
  return (
    <button
      type="button"
      className="application-menu-item"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={() => void onSelect?.()}
    >
      <span>{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
      {submenu && <ChevronRight aria-hidden="true" />}
    </button>
  );
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
          <div className="application-menu-popover" role="menu">
            <MenuItem shortcut="Ctrl+N" disabled={isBusy} onSelect={select(onNewProject)}>
              新建项目(N)...
            </MenuItem>
            <MenuItem shortcut="Ctrl+O" disabled={isBusy} onSelect={select(onOpenProject)}>
              打开项目(O)...
            </MenuItem>
            <div className="application-menu-submenu">
              <MenuItem
                disabled={recentProjectPaths.length === 0 || isBusy}
                submenu
                onSelect={() => {
                  setRecentProjectMenuOpen((open) => !open);
                  setRecentImportMenuOpen(false);
                }}
              >
                打开最近使用的内容(E)
              </MenuItem>
              {recentProjectMenuOpen && (
                <div
                  className="application-menu-popover application-menu-submenu-popover"
                  role="menu"
                >
                  {recentProjectPaths.map((path) => (
                    <MenuItem
                      key={path}
                      title={path}
                      disabled={isBusy}
                      onSelect={select(() => onOpenRecentProject(path))}
                    >
                      {fileName(path)}
                    </MenuItem>
                  ))}
                </div>
              )}
            </div>
            <div className="application-menu-separator" role="separator" />
            <MenuItem
              shortcut="Ctrl+Shift+W"
              disabled={!hasProject || isBusy}
              onSelect={select(onCloseProject)}
            >
              关闭项目(P)
            </MenuItem>
            <MenuItem
              shortcut="Ctrl+S"
              disabled={!hasProject || !isDirty || isBusy}
              onSelect={select(onSaveProject)}
            >
              保存(S)
            </MenuItem>
            <MenuItem
              shortcut="Ctrl+Shift+S"
              disabled={!hasProject || isBusy}
              onSelect={select(onSaveProjectAs)}
            >
              另存为(A)...
            </MenuItem>
            <MenuItem
              shortcut="Ctrl+Alt+S"
              disabled={!hasProject || isBusy}
              onSelect={select(onSaveProjectCopy)}
            >
              保存副本(Y)...
            </MenuItem>
            <div className="application-menu-separator" role="separator" />
            <MenuItem
              shortcut="Ctrl+I"
              disabled={isMediaBinReadOnly || isBusy}
              onSelect={select(onImportMedia)}
            >
              导入(I)...
            </MenuItem>
            <div className="application-menu-submenu">
              <MenuItem
                disabled={recentMediaPaths.length === 0 || isMediaBinReadOnly || isBusy}
                submenu
                onSelect={() => {
                  setRecentImportMenuOpen((open) => !open);
                  setRecentProjectMenuOpen(false);
                }}
              >
                导入最近使用的文件(F)
              </MenuItem>
              {recentImportMenuOpen && (
                <div
                  className="application-menu-popover application-menu-submenu-popover"
                  role="menu"
                >
                  {recentMediaPaths.map((path) => (
                    <MenuItem
                      key={path}
                      title={path}
                      disabled={isMediaBinReadOnly || isBusy}
                      onSelect={select(() => onImportRecentMedia(path))}
                    >
                      {fileName(path)}
                    </MenuItem>
                  ))}
                </div>
              )}
            </div>
            <div className="application-menu-separator" role="separator" />
            <MenuItem shortcut="Ctrl+Q" onSelect={select(onExit)}>
              退出(X)
            </MenuItem>
          </div>
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
          <div className="application-menu-popover" role="menu">
            <MenuItem
              shortcut="Ctrl+A"
              disabled={!canSelectAllSubtitleCues || isBusy}
              onSelect={select(onSelectAllSubtitleCues)}
            >
              全选(A)
            </MenuItem>
            <MenuItem
              shortcut="Ctrl+Shift+A"
              disabled={!canClearSubtitleCueSelection || isBusy}
              onSelect={select(onClearSubtitleCueSelection)}
            >
              取消全选(D)
            </MenuItem>
            <div className="application-menu-separator" role="separator" />
            <MenuItem disabled={isBusy} onSelect={select(onOpenPreferences)}>
              首选项...
            </MenuItem>
          </div>
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
