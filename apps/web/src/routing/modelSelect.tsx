import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { PopoverShell } from "../table/PopoverShell";

export type ModelOption = {
  id: string;
  description: string;
};

export function ModelSelect({ value, providerLabel, options, onChange }: {
  value: string;
  providerLabel: string;
  options: ModelOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isCatalogModel = options.some((option) => option.id === value);
  return (
    <div
      className="model-select"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="model-select-trigger"
        aria-label={`${providerLabel} model`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {value ? <span className="mono">{value}</span> : <span className="faint">choose model</span>}
        <ChevronDown />
      </button>
      {open ? (
        <PopoverShell onDismiss={() => setOpen(false)}>
          <div className="model-select-popover">
            {value && !isCatalogModel ? (
              <ModelRow
                option={{ id: value, description: "Current config value not found in the catalog" }}
                active
                onSelect={() => setOpen(false)}
              />
            ) : null}
            {options.length === 0 ? <div className="model-select-empty">No catalog models</div> : null}
            {options.map((option) => (
              <ModelRow
                key={option.id}
                option={option}
                active={option.id === value}
                onSelect={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </PopoverShell>
      ) : null}
    </div>
  );
}

function ModelRow({ option, active, onSelect }: {
  option: ModelOption;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={active ? "active" : ""} onClick={onSelect}>
      <strong className="mono">{option.id}{active ? <Check /> : null}</strong>
      <span>{option.description}</span>
    </button>
  );
}
