import { useEffect, useRef, useState } from "react";
import { PopupMenu, PopupMenuItem, PopupMenuSeparator, PopupMenuSubmenu } from "../PopupMenu";
import "./ApplicationMenu.css";

type ApplicationMenuHandler = () => void | Promise<void>;

interface ApplicationMenuCommand {
  enabled: boolean;
  execute: ApplicationMenuHandler;
}

interface ApplicationMenuRecentItem {
  id: string;
  label: string;
  title: string;
  execute: ApplicationMenuHandler;
}

interface ApplicationMenuRecentGroup {
  enabled: boolean;
  items: ApplicationMenuRecentItem[];
}

interface ApplicationMenuWindowItem {
  id: string;
  label: string;
  title?: string;
  checked: boolean;
  enabled: boolean;
  execute: ApplicationMenuHandler;
}

interface ApplicationMenuWindowGroup {
  enabled: boolean;
  items: ApplicationMenuWindowItem[];
}

export interface ApplicationMenuModel {
  file: {
    newProject: ApplicationMenuCommand;
    openProject: ApplicationMenuCommand;
    recentProjects: ApplicationMenuRecentGroup;
    closeProject: ApplicationMenuCommand;
    saveProject: ApplicationMenuCommand;
    saveProjectAs: ApplicationMenuCommand;
    saveProjectCopy: ApplicationMenuCommand;
    importMedia: ApplicationMenuCommand;
    recentMedia: ApplicationMenuRecentGroup;
    exit: ApplicationMenuCommand;
  };
  edit: {
    undo: ApplicationMenuCommand;
    redo: ApplicationMenuCommand;
    copy: ApplicationMenuCommand;
    paste: ApplicationMenuCommand;
    clear: ApplicationMenuCommand;
    duplicate: ApplicationMenuCommand;
    selectAll: ApplicationMenuCommand;
    clearSelection: ApplicationMenuCommand;
    preferences: ApplicationMenuCommand;
  };
  window: {
    source: ApplicationMenuWindowItem;
    project: ApplicationMenuWindowGroup;
    export: ApplicationMenuWindowItem;
    subtitles: ApplicationMenuWindowItem;
    storyboard: ApplicationMenuWindowItem;
    history: ApplicationMenuWindowItem;
  };
}

interface ApplicationMenuProps {
  model: ApplicationMenuModel;
}

export function ApplicationMenu({ model }: ApplicationMenuProps) {
  const { file, edit, window: windowMenu } = model;
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const [recentProjectMenuOpen, setRecentProjectMenuOpen] = useState(false);
  const [recentImportMenuOpen, setRecentImportMenuOpen] = useState(false);
  const [projectWindowMenuOpen, setProjectWindowMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!fileMenuOpen && !editMenuOpen && !windowMenuOpen) {
      return;
    }

    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
        setEditMenuOpen(false);
        setWindowMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFileMenuOpen(false);
        setEditMenuOpen(false);
        setWindowMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [editMenuOpen, fileMenuOpen, windowMenuOpen]);

  useEffect(() => {
    if (!fileMenuOpen) {
      setRecentProjectMenuOpen(false);
      setRecentImportMenuOpen(false);
    }
  }, [fileMenuOpen]);

  useEffect(() => {
    if (!windowMenuOpen) {
      setProjectWindowMenuOpen(false);
    }
  }, [windowMenuOpen]);

  const select = (handler: () => void | Promise<void>) => async () => {
    setFileMenuOpen(false);
    setEditMenuOpen(false);
    setWindowMenuOpen(false);
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
            setWindowMenuOpen(false);
          }}
        >
          文件(F)
        </button>
        {fileMenuOpen && (
          <PopupMenu enableMnemonics>
            <PopupMenuItem
              mnemonic="N"
              shortcut="Ctrl+N"
              disabled={!file.newProject.enabled}
              onSelect={select(file.newProject.execute)}
            >
              新建项目(N)...
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="O"
              shortcut="Ctrl+O"
              disabled={!file.openProject.enabled}
              onSelect={select(file.openProject.execute)}
            >
              打开项目(O)...
            </PopupMenuItem>
            <PopupMenuSubmenu
              label="打开最近使用的内容(E)"
              mnemonic="E"
              open={recentProjectMenuOpen}
              disabled={!file.recentProjects.enabled}
              onOpenChange={(open) => {
                setRecentProjectMenuOpen(open);
                if (open) {
                  setRecentImportMenuOpen(false);
                }
              }}
            >
              {file.recentProjects.items.map((item) => (
                <PopupMenuItem
                  key={item.id}
                  title={item.title}
                  disabled={!file.recentProjects.enabled}
                  onSelect={select(item.execute)}
                >
                  {item.label}
                </PopupMenuItem>
              ))}
            </PopupMenuSubmenu>
            <PopupMenuSeparator />
            <PopupMenuItem
              mnemonic="P"
              shortcut="Ctrl+Shift+W"
              disabled={!file.closeProject.enabled}
              onSelect={select(file.closeProject.execute)}
            >
              关闭项目(P)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="S"
              shortcut="Ctrl+S"
              disabled={!file.saveProject.enabled}
              onSelect={select(file.saveProject.execute)}
            >
              保存(S)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="A"
              shortcut="Ctrl+Shift+S"
              disabled={!file.saveProjectAs.enabled}
              onSelect={select(file.saveProjectAs.execute)}
            >
              另存为(A)...
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="Y"
              shortcut="Ctrl+Alt+S"
              disabled={!file.saveProjectCopy.enabled}
              onSelect={select(file.saveProjectCopy.execute)}
            >
              保存副本(Y)...
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              mnemonic="I"
              shortcut="Ctrl+I"
              disabled={!file.importMedia.enabled}
              onSelect={select(file.importMedia.execute)}
            >
              导入(I)...
            </PopupMenuItem>
            <PopupMenuSubmenu
              label="导入最近使用的文件(F)"
              mnemonic="F"
              open={recentImportMenuOpen}
              disabled={!file.recentMedia.enabled}
              onOpenChange={(open) => {
                setRecentImportMenuOpen(open);
                if (open) {
                  setRecentProjectMenuOpen(false);
                }
              }}
            >
              {file.recentMedia.items.map((item) => (
                <PopupMenuItem
                  key={item.id}
                  title={item.title}
                  disabled={!file.recentMedia.enabled}
                  onSelect={select(item.execute)}
                >
                  {item.label}
                </PopupMenuItem>
              ))}
            </PopupMenuSubmenu>
            <PopupMenuSeparator />
            <PopupMenuItem
              mnemonic="X"
              shortcut="Ctrl+Q"
              disabled={!file.exit.enabled}
              onSelect={select(file.exit.execute)}
            >
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
            setWindowMenuOpen(false);
          }}
        >
          编辑(E)
        </button>
        {editMenuOpen && (
          <PopupMenu enableMnemonics>
            <PopupMenuItem
              mnemonic="U"
              shortcut="Ctrl+Z"
              disabled={!edit.undo.enabled}
              onSelect={select(edit.undo.execute)}
            >
              撤销(U)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="R"
              shortcut="Ctrl+Shift+Z"
              disabled={!edit.redo.enabled}
              onSelect={select(edit.redo.execute)}
            >
              重做(R)
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              mnemonic="Y"
              shortcut="Ctrl+C"
              disabled={!edit.copy.enabled}
              onSelect={select(edit.copy.execute)}
            >
              复制(Y)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="P"
              shortcut="Ctrl+V"
              disabled={!edit.paste.enabled}
              onSelect={select(edit.paste.execute)}
            >
              粘贴(P)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="E"
              shortcut="Backspace / Del"
              disabled={!edit.clear.enabled}
              onSelect={select(edit.clear.execute)}
            >
              清除(E)
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              mnemonic="C"
              disabled={!edit.duplicate.enabled}
              onSelect={select(edit.duplicate.execute)}
            >
              重复(C)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="A"
              shortcut="Ctrl+A"
              disabled={!edit.selectAll.enabled}
              onSelect={select(edit.selectAll.execute)}
            >
              全选(A)
            </PopupMenuItem>
            <PopupMenuItem
              mnemonic="D"
              shortcut="Ctrl+Shift+A"
              disabled={!edit.clearSelection.enabled}
              onSelect={select(edit.clearSelection.execute)}
            >
              取消全选(D)
            </PopupMenuItem>
            <PopupMenuSeparator />
            <PopupMenuItem
              disabled={!edit.preferences.enabled}
              onSelect={select(edit.preferences.execute)}
            >
              首选项...
            </PopupMenuItem>
          </PopupMenu>
        )}
      </div>
      <button
        type="button"
        className="application-menu-trigger application-menu-placeholder"
        aria-disabled="true"
        title="剪辑菜单将在后续版本实现"
      >
        剪辑(C)
      </button>
      <div className="application-menu-root">
        <button
          type="button"
          className={`application-menu-trigger${windowMenuOpen ? " active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={windowMenuOpen}
          onClick={() => {
            setWindowMenuOpen((open) => !open);
            setFileMenuOpen(false);
            setEditMenuOpen(false);
          }}
        >
          窗口(W)
        </button>
        {windowMenuOpen && (
          <PopupMenu enableMnemonics>
            <PopupMenuItem
              checked={windowMenu.source.checked}
              disabled={!windowMenu.source.enabled}
              title={windowMenu.source.title}
              onSelect={select(windowMenu.source.execute)}
            >
              {windowMenu.source.label}
            </PopupMenuItem>
            <PopupMenuSubmenu
              label="项目"
              open={projectWindowMenuOpen}
              disabled={!windowMenu.project.enabled}
              onOpenChange={setProjectWindowMenuOpen}
            >
              {windowMenu.project.items.map((item) => (
                <PopupMenuItem
                  key={item.id}
                  checked={item.checked}
                  disabled={!item.enabled}
                  title={item.title}
                  onSelect={select(item.execute)}
                >
                  {item.label}
                </PopupMenuItem>
              ))}
            </PopupMenuSubmenu>
            <PopupMenuItem
              checked={windowMenu.export.checked}
              disabled={!windowMenu.export.enabled}
              title={windowMenu.export.title}
              onSelect={select(windowMenu.export.execute)}
            >
              {windowMenu.export.label}
            </PopupMenuItem>
            <PopupMenuItem
              checked={windowMenu.subtitles.checked}
              disabled={!windowMenu.subtitles.enabled}
              title={windowMenu.subtitles.title}
              onSelect={select(windowMenu.subtitles.execute)}
            >
              {windowMenu.subtitles.label}
            </PopupMenuItem>
            <PopupMenuItem
              checked={windowMenu.storyboard.checked}
              disabled={!windowMenu.storyboard.enabled}
              title={windowMenu.storyboard.title}
              onSelect={select(windowMenu.storyboard.execute)}
            >
              {windowMenu.storyboard.label}
            </PopupMenuItem>
            <PopupMenuItem
              checked={windowMenu.history.checked}
              disabled={!windowMenu.history.enabled}
              title={windowMenu.history.title}
              onSelect={select(windowMenu.history.execute)}
            >
              {windowMenu.history.label}
            </PopupMenuItem>
          </PopupMenu>
        )}
      </div>
      <button
        type="button"
        className="application-menu-trigger application-menu-placeholder"
        aria-disabled="true"
        title="帮助菜单将在后续版本实现"
      >
        帮助(H)
      </button>
    </nav>
  );
}
