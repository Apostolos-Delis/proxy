import { Check, ChevronDown, Search } from "lucide-react";
import { useId, useState } from "react";

import { PopoverShell } from "./PopoverShell";

export type SearchSelectOption = {
  value: string;
  label: string;
  // Secondary text shown faint after the label, also matched when filtering
  // (e.g. a secret hint, a slug, an owner).
  hint?: string;
};

type SearchSelectProps = {
  value: string;
  options: SearchSelectOption[];
  ariaLabel: string;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
  onChange: (value: string) => void;
};

// Drop-in MenuSelect variant with a filter input on top, for option lists
// long enough that searching beats scrolling. Fully data-driven: callers
// supply {value, label, hint?} options and get the same trigger/popover
// styling as MenuSelect, plus arrow-key navigation and Enter-to-pick.
export function SearchSelect({
  value,
  options,
  ariaLabel,
  placeholder = "Search…",
  emptyLabel = "No matches.",
  className = "",
  onChange
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = `${useId()}-listbox`;
  const selected = options.find((option) => option.value === value) ?? options[0];
  const filtered = filterSearchOptions(options, query);

  const toggle = () => {
    setQuery("");
    setActiveIndex(0);
    setOpen(!open);
  };
  const pick = (option: SearchSelectOption) => {
    onChange(option.value);
    setOpen(false);
  };

  return (
    <div
      className={`menu-select search-select ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button type="button" aria-label={ariaLabel} aria-expanded={open} onClick={toggle}>
        <OptionText option={selected} />
        <ChevronDown />
      </button>
      {open ? (
        <PopoverShell onDismiss={() => setOpen(false)}>
          <div className="menu-select-popover search-select-popover">
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
                    pick(filtered[activeIndex]);
                  }
                }}
              />
            </div>
            <div id={listboxId} className="search-select-list" role="listbox" aria-label={ariaLabel}>
              {filtered.map((option, index) => (
                <button
                  key={option.value}
                  id={optionDomId(listboxId, index)}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={index === activeIndex ? "active" : ""}
                  ref={index === activeIndex ? scrollNearestRef : undefined}
                  onClick={() => pick(option)}
                >
                  <OptionText option={option} />
                  {option.value === value ? <Check /> : null}
                </button>
              ))}
              {filtered.length === 0 ? <div className="search-select-empty">{emptyLabel}</div> : null}
            </div>
          </div>
        </PopoverShell>
      ) : null}
    </div>
  );
}

function OptionText({ option }: { option: SearchSelectOption | undefined }) {
  if (!option) return <span>Select</span>;
  return (
    <span className="search-select-text">
      {option.label}
      {option.hint ? <span className="faint">{option.hint}</span> : null}
    </span>
  );
}

export function filterSearchOptions(options: SearchSelectOption[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle));
}

function optionDomId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}

function scrollNearestRef(node: HTMLButtonElement | null) {
  node?.scrollIntoView({ block: "nearest" });
}
