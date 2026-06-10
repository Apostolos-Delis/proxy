import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { PopoverShell } from "./PopoverShell";

export type MenuSelectOption = {
  value: string;
  label: string;
};

type MenuSelectProps = {
  value: string;
  options: MenuSelectOption[];
  ariaLabel: string;
  className?: string;
  onChange: (value: string) => void;
};

export function MenuSelect({ value, options, ariaLabel, className = "", onChange }: MenuSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div
      className={`menu-select ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button type="button" aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{selected?.label ?? "Select"}</span>
        <ChevronDown />
      </button>
      {open ? (
        <PopoverShell onDismiss={() => setOpen(false)}>
          <div className="menu-select-popover">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === value ? "active" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.value === value ? <Check /> : null}
              </button>
            ))}
          </div>
        </PopoverShell>
      ) : null}
    </div>
  );
}
