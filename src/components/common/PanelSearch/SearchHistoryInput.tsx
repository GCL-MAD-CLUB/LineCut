import { Search } from "lucide-react";
import { useId, useState } from "react";
import { SelectDropdown, selectDropdownItems } from "../SelectDropdown";
import {
  filterSearchHistory,
  readSearchHistory,
  rememberSearch,
  type SearchHistoryKind,
} from "./searchHistory";

export function SearchHistoryInput({
  label,
  kind,
  query,
  disabled,
  onQueryChange,
}: {
  label: string;
  kind: SearchHistoryKind;
  query: string;
  disabled: boolean;
  onQueryChange: (query: string) => void;
}) {
  const listId = useId();
  const [history, setHistory] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const suggestions = filterSearchHistory(history, query);
  const visible = open && !disabled && suggestions.length > 0;
  const activeIndex = suggestions.findIndex((entry) => entry === active);

  function select(value: string) {
    onQueryChange(value);
    setActive(null);
    setOpen(false);
  }

  return (
    <SelectDropdown
      className="panel-search-input"
      menuId={listId}
      ariaLabel={`${label}最近搜索`}
      open={visible}
      onOpenChange={setOpen}
      showCheck={false}
      disabled={disabled}
      placement="bottom"
      value={active ?? ""}
      items={selectDropdownItems(suggestions.map((entry) => [entry, entry] as const))}
      onChange={select}
      triggerElement={
        <>
          <Search aria-hidden="true" />
          <input
            value={query}
            placeholder={`搜索${label}`}
            aria-label={`搜索${label}`}
            disabled={disabled}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={visible}
            aria-controls={visible ? listId : undefined}
            aria-activedescendant={
              visible && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
            }
            onFocus={() => {
              setHistory(readSearchHistory(kind));
              setActive(null);
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onQueryChange(value);
              setActive(null);
              setOpen(true);
            }}
            onBlur={(event) => {
              setHistory(rememberSearch(kind, event.currentTarget.value));
              setOpen(false);
              setActive(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (!suggestions.length) return;
                event.preventDefault();
                event.stopPropagation();
                const next =
                  activeIndex < 0
                    ? event.key === "ArrowDown"
                      ? 0
                      : suggestions.length - 1
                    : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) %
                      suggestions.length;
                setActive(suggestions[next]);
                setOpen(true);
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (visible && activeIndex >= 0) select(suggestions[activeIndex]);
                else {
                  setOpen(false);
                  setActive(null);
                }
              } else if (event.key === "Escape" && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                setActive(null);
              }
            }}
          />
        </>
      }
    />
  );
}
