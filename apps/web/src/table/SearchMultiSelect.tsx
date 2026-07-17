import { Check, ChevronDown, Search } from "lucide-react";
import { useId, useRef, useState } from "react";

import { PopoverShell } from "./PopoverShell";

export type SearchMultiSelectOption = {
  value: string;
  label: string;
  hint?: string;
  badge?: string;
  badgeAccent?: boolean;
};

type SearchMultiSelectProps = {
  value: string[];
  options: SearchMultiSelectOption[];
  ariaLabel: string;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
  onChange: (value: string[]) => void;
};

export function SearchMultiSelect({
  value,
  options,
  ariaLabel,
  placeholder = "Search…",
  emptyLabel = "No matches.",
  className = "",
  onChange
}: SearchMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = `${useId()}-listbox`;
  const selected = new Set(value);
  const selectedOptions = options.filter((option) => selected.has(option.value));
  const filtered = filterSearchMultiSelectOptions(options, query);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const toggle = () => {
    setQuery("");
    setActiveIndex(0);
    setOpen(!open);
  };
  const toggleOption = (option: SearchMultiSelectOption) => {
    onChange(toggleSearchMultiSelectValue(value, option.value));
  };

  return (
    <div
      className={`menu-select search-multi-select ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        close(true);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${ariaLabel}, ${selectedOptions.length} selected`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <SelectionSummary options={selectedOptions} />
        <ChevronDown />
      </button>
      {open ? (
        <PopoverShell onDismiss={() => close()}>
          <div className="menu-select-popover search-multi-select-popover">
            <div className="search-select-input">
              <Search />
              <input
                autoFocus
                value={query}
                placeholder={placeholder}
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-label={`${ariaLabel} search`}
                aria-activedescendant={filtered[activeIndex] ? optionDomId(listboxId, activeIndex) : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    setActiveIndex((index) => Math.max(0, Math.min(filtered.length - 1, index + delta)));
                    return;
                  }
                  if (event.key === "Enter" && filtered[activeIndex]) {
                    event.preventDefault();
                    toggleOption(filtered[activeIndex]);
                  }
                }}
              />
            </div>
            <div
              id={listboxId}
              className="search-multi-select-list"
              role="listbox"
              aria-label={ariaLabel}
              aria-multiselectable="true"
            >
              {filtered.map((option, index) => {
                const checked = selected.has(option.value);
                return (
                  <button
                    key={option.value}
                    id={optionDomId(listboxId, index)}
                    type="button"
                    tabIndex={-1}
                    role="option"
                    aria-selected={checked}
                    className={index === activeIndex ? "active" : ""}
                    ref={index === activeIndex ? scrollNearestRef : undefined}
                    onClick={() => toggleOption(option)}
                  >
                    <span className={`search-multi-select-check${checked ? " checked" : ""}`}>
                      {checked ? <Check /> : null}
                    </span>
                    <OptionText option={option} />
                  </button>
                );
              })}
              {filtered.length === 0 ? <div className="search-select-empty">{emptyLabel}</div> : null}
            </div>
            <div className="search-multi-select-footer">
              <span>{value.length} selected</span>
              <div>
                {value.length > 0 ? (
                  <button type="button" onClick={() => onChange([])}>Clear</button>
                ) : null}
                <button type="button" className="search-multi-select-done" onClick={() => close(true)}>Done</button>
              </div>
            </div>
          </div>
        </PopoverShell>
      ) : null}
    </div>
  );
}

function SelectionSummary({ options }: { options: SearchMultiSelectOption[] }) {
  if (options.length === 0) return <span className="faint">Select…</span>;
  if (options.length === 1) return <span className="mono">{options[0]?.label}</span>;
  return (
    <span className="search-multi-select-summary">
      <span>{options.length} selected</span>
      <span className="faint">{options.map((option) => option.label).join(", ")}</span>
    </span>
  );
}

function OptionText({ option }: { option: SearchMultiSelectOption }) {
  return (
    <span className="search-multi-select-option">
      <span>
        <span className="mono">{option.label}</span>
        {option.badge ? (
          <span className={`badge${option.badgeAccent ? " badge-accent" : ""}`}>{option.badge}</span>
        ) : null}
      </span>
      {option.hint ? <span className="faint">{option.hint}</span> : null}
    </span>
  );
}

export function filterSearchMultiSelectOptions(options: SearchMultiSelectOption[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => (
    `${option.label} ${option.hint ?? ""} ${option.badge ?? ""}`.toLowerCase().includes(needle)
  ));
}

export function toggleSearchMultiSelectValue(value: string[], option: string) {
  return value.includes(option) ? value.filter((item) => item !== option) : [...value, option];
}

function optionDomId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}

function scrollNearestRef(node: HTMLButtonElement | null) {
  node?.scrollIntoView({ block: "nearest" });
}
