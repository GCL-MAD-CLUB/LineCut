import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  PopupMenu,
  PopupMenuItem,
  PopupMenuSeparator,
  useCloseOnOutsidePointer,
} from "../../../common/PopupMenu";
import { ModalDialog } from "../../../common/ModalDialog";
import {
  customKeywordSet,
  defaultKeywordPresetId,
  keywordPresetNameError,
  keywordSlots,
  recentKeywordSet,
} from "../../../../core/editor/keywordPresets";
import { parseStoryboardKeywordInput } from "./storyboardKeywords";
import { useKeywordSet } from "./keywordPresetState";
import "./KeywordPresetControl.css";

type PresetMenuItem = { type: "option"; value: string; label: string } | { type: "separator" };

function KeywordPresetMenu({
  items,
  value,
  onChange,
  variant = "sidebar",
  ariaLabel,
}: {
  items: PresetMenuItem[];
  value: string;
  onChange: (value: string) => void;
  variant?: "sidebar" | "spray" | "editor";
  ariaLabel: string;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number } | null>(null);
  useCloseOnOutsidePointer(Boolean(anchor), () => setAnchor(null));
  const label = items.find((item) => item.type === "option" && item.value === value);
  const spray = variant === "spray";
  return (
    <>
      <button
        type="button"
        className={`${spray ? "storyboard-spray-keyword-picker-dropdown" : "storyboard-keyword-dropdown-shell"} storyboard-keyword-mode-trigger ${variant === "editor" ? "keyword-preset-editor-trigger" : ""} ${anchor ? "is-open" : ""}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        title={label?.type === "option" ? label.label : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          setAnchor(anchor ? null : { x: bounds.left, y: bounds.bottom, width: bounds.width });
        }}
      >
        <span className={spray ? undefined : "storyboard-keyword-dropdown-value"}>
          {label?.type === "option" ? label.label : ""}
        </span>
        {spray ? (
          <ChevronsUpDown aria-hidden="true" />
        ) : (
          <span className="storyboard-keyword-dropdown-arrows" aria-hidden="true">
            <ChevronsUpDown aria-hidden="true" />
          </span>
        )}
      </button>
      {anchor &&
        createPortal(
          <PopupMenu
            ariaLabel={ariaLabel}
            className={spray ? "storyboard-spray-keyword-preset-menu" : undefined}
            contextMenuAnchor={anchor}
            style={{
              position: "fixed",
              left: anchor.x,
              top: anchor.y,
              width: "max-content",
              minWidth: anchor.width,
              maxWidth: "calc(100vw - 16px)",
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {items.map((item, index) =>
              item.type === "separator" ? (
                <PopupMenuSeparator key={`separator-${index}`} />
              ) : (
                <PopupMenuItem
                  key={item.value}
                  checked={item.value.startsWith("action:") ? undefined : item.value === value}
                  onSelect={() => {
                    setAnchor(null);
                    onChange(item.value);
                  }}
                >
                  {item.label}
                </PopupMenuItem>
              ),
            )}
          </PopupMenu>,
          document.body,
        )}
    </>
  );
}

export function KeywordPresetControl({
  recent,
  selectionOnly = false,
  onDialogChange,
}: {
  recent: readonly string[];
  selectionOnly?: boolean;
  onDialogChange?: (open: boolean) => void;
}) {
  const state = useKeywordSet(recent);
  const [editing, setEditing] = useState(false);
  const [editorId, setEditorId] = useState(state.selected);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [nameDialog, setNameDialog] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const id = editing ? editorId : state.selected;
  const preset = state.presets.find((preset) => preset.id === id);
  const keywords =
    drafts[id] ??
    (id === recentKeywordSet
      ? keywordSlots(recent)
      : id === customKeywordSet
        ? (state.custom ?? keywordSlots([]))
        : (preset?.keywords ?? keywordSlots([])));
  const canManage = Boolean(preset && preset.id !== defaultKeywordPresetId);
  const nameError = keywordPresetNameError(
    name,
    state.presets,
    nameDialog === "rename" ? id : undefined,
  );
  const keywordError = Object.values(drafts)
    .flat()
    .map((keyword) => {
      const result = parseStoryboardKeywordInput(keyword);
      return (
        result.error ?? (result.paths.length > 1 ? "每个格子只能填写一个关键字或层级路径。" : null)
      );
    })
    .find(Boolean);

  function closeEditor() {
    setEditing(false);
    setDrafts({});
    onDialogChange?.(false);
  }
  function items(value: string, management: boolean): PresetMenuItem[] {
    return [
      { type: "option", value: recentKeywordSet, label: "最近使用过的关键字" },
      { type: "separator" },
      ...(state.custom && value === customKeywordSet
        ? [
            { type: "option" as const, value: customKeywordSet, label: "自定" },
            { type: "separator" as const },
          ]
        : []),
      ...state.presets.map((preset) => ({
        type: "option" as const,
        value: preset.id,
        label: preset.name,
      })),
      ...(management
        ? [
            { type: "separator" as const },
            { type: "option" as const, value: "action:create", label: "将当前设置存储为新预设..." },
            { type: "option" as const, value: "action:restore", label: "还原默认预设" },
            ...(canManage
              ? [
                  {
                    type: "option" as const,
                    value: "action:delete",
                    label: `删除预设“${preset!.name}”...`,
                  },
                  {
                    type: "option" as const,
                    value: "action:rename",
                    label: `重命名预设“${preset!.name}”...`,
                  },
                ]
              : []),
            ...(!editing
              ? [
                  { type: "separator" as const },
                  { type: "option" as const, value: "action:edit", label: "编辑集..." },
                ]
              : []),
          ]
        : []),
    ];
  }
  function choose(value: string) {
    if (value === "action:edit") {
      setEditorId(state.selected);
      setDrafts({});
      setEditing(true);
      onDialogChange?.(true);
    } else if (value === "action:create" || value === "action:rename") {
      setName(value === "action:create" ? "未命名预设" : (preset?.name ?? ""));
      setNameDialog(value === "action:create" ? "create" : "rename");
      onDialogChange?.(true);
    } else if (value === "action:delete") {
      setDeleting(true);
      onDialogChange?.(true);
    } else if (value === "action:restore") {
      state.restore();
      setDrafts((current) => {
        const next = { ...current };
        delete next[defaultKeywordPresetId];
        return next;
      });
    } else if (editing) {
      setEditorId(value);
    } else state.select(value);
  }
  function closeName() {
    setNameDialog(null);
    onDialogChange?.(editing);
  }
  function closeDelete() {
    setDeleting(false);
    onDialogChange?.(editing);
  }
  const modal = nameDialog ? (
    <ModalDialog
      title={nameDialog === "create" ? "新建预设" : "重命名预设"}
      className="keyword-preset-dialog"
      confirmLabel={nameDialog === "create" ? "创建" : "重命名"}
      confirmDisabled={Boolean(nameError || (nameDialog === "create" && keywordError))}
      onCancel={closeName}
      onConfirm={() => {
        if (nameError) return;
        if (nameDialog === "create") {
          const created = state.createPreset(name, keywords);
          if (created && editing) setEditorId(created);
        } else state.rename(id, name);
        closeName();
      }}
    >
      <form onSubmit={(event) => event.preventDefault()}>
        <label className="keyword-preset-field">
          预设名称：
          <input
            autoFocus
            value={name}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                !nameError &&
                !(nameDialog === "create" && keywordError)
              ) {
                event.preventDefault();
                if (nameDialog === "create") {
                  const created = state.createPreset(name, keywords);
                  if (created && editing) setEditorId(created);
                } else state.rename(id, name);
                closeName();
              }
            }}
          />
        </label>
        <p className="keyword-preset-error" role="status">
          {nameError ?? (nameDialog === "create" ? keywordError : null)}
        </p>
      </form>
    </ModalDialog>
  ) : deleting ? (
    <ModalDialog
      title="删除预设"
      className="keyword-preset-dialog"
      confirmLabel="删除"
      onCancel={closeDelete}
      onConfirm={() => {
        // Deleting the open preset retains its currently displayed contents as 自定.
        state.select(id);
        state.remove(id);
        if (editing) {
          state.save(customKeywordSet, keywords);
          setEditorId(customKeywordSet);
          setDrafts((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
        }
        closeDelete();
      }}
    >
      <p>是否要删除名为“{preset?.name}”的预设？</p>
      <p>无法还原此操作。</p>
    </ModalDialog>
  ) : editing ? (
    <ModalDialog
      title="编辑关键字集"
      className="keyword-preset-dialog keyword-preset-editor"
      confirmLabel="更改"
      confirmDisabled={Boolean(keywordError)}
      onCancel={closeEditor}
      onConfirm={() => {
        if (keywordError) return;
        for (const [draftId, slots] of Object.entries(drafts)) {
          if (draftId !== recentKeywordSet && draftId !== customKeywordSet)
            state.save(draftId, slots);
        }
        if (id !== recentKeywordSet && id !== customKeywordSet) state.select(id);
        else if (id === customKeywordSet || drafts[recentKeywordSet]) state.save(id, keywords);
        else state.select(id);
        closeEditor();
      }}
    >
      <label className="keyword-preset-field">
        预设：
        <KeywordPresetMenu
          variant="editor"
          ariaLabel="编辑的关键字预设"
          items={items(id, true)}
          value={id}
          onChange={choose}
        />
      </label>
      <fieldset>
        <legend>关键字</legend>
        <div className="keyword-preset-inputs">
          {keywords.map((keyword, index) => (
            <input
              key={index}
              autoFocus={index === 0}
              aria-label={`关键字 ${index + 1}`}
              value={keyword}
              onChange={(event) => {
                const next = [...keywords];
                next[index] = event.target.value;
                setDrafts((current) => ({ ...current, [id]: next }));
              }}
            />
          ))}
        </div>
      </fieldset>
      <p className="keyword-preset-error" role="status">
        {keywordError}
      </p>
    </ModalDialog>
  ) : null;
  return (
    <>
      <KeywordPresetMenu
        variant={selectionOnly ? "spray" : "sidebar"}
        ariaLabel="关键字集预设"
        items={items(state.selected, !selectionOnly).filter(
          (item) => !selectionOnly || item.type !== "separator",
        )}
        value={state.selected}
        onChange={choose}
      />
      {modal && createPortal(modal, document.querySelector(".app-shell") ?? document.body)}
    </>
  );
}
