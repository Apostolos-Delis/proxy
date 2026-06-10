import { Check, ChevronDown, PenLine } from "lucide-react";
import { useState } from "react";

import { PopoverShell } from "../table/PopoverShell";

export type ModelProvider = "openai" | "anthropic";

type ModelOption = {
  id: string;
  description: string;
};

const PROVIDER_MODEL_OPTIONS: Record<ModelProvider, ModelOption[]> = {
  openai: [
    { id: "gpt-5.5", description: "Frontier model for complex coding and research" },
    { id: "gpt-5.4", description: "Strong model for everyday coding" },
    { id: "gpt-5.4-mini", description: "Small, fast, and cost-efficient for simpler tasks" },
    { id: "gpt-5.3-codex", description: "Coding-optimized model" },
    { id: "gpt-5.2", description: "Optimized for professional work and long-running agents" }
  ],
  anthropic: [
    { id: "claude-fable-5", description: "Most capable for the hardest, longest-running tasks" },
    { id: "claude-opus-4-8", description: "Best for everyday, complex tasks" },
    { id: "claude-opus-4-7", description: "Previous-generation Opus" },
    { id: "claude-sonnet-4-6", description: "Efficient for routine tasks" },
    { id: "claude-haiku-4-5", description: "Fastest for quick answers" }
  ]
};

export function ModelSelect({ provider, value, onChange }: {
  provider: ModelProvider;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);

  if (customMode) {
    return (
      <div className="model-select-custom">
        <input
          value={value}
          placeholder={`${provider} model id`}
          spellCheck={false}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            setCustomMode(false);
          }}
        />
        <button
          className="btn btn-ghost btn-icon"
          type="button"
          aria-label={`Choose ${provider} model from list`}
          title="Back to model list"
          onClick={() => setCustomMode(false)}
        >
          <ChevronDown />
        </button>
      </div>
    );
  }

  const options = PROVIDER_MODEL_OPTIONS[provider];
  const isCurated = options.some((option) => option.id === value);
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
        aria-label={`${provider} model`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {value ? <span className="mono">{value}</span> : <span className="faint">none</span>}
        <ChevronDown />
      </button>
      {open ? (
        <PopoverShell onDismiss={() => setOpen(false)}>
          <div className="model-select-popover">
            {value && !isCurated ? (
              <ModelRow
                option={{ id: value, description: "Custom model id" }}
                active
                onSelect={() => setOpen(false)}
              />
            ) : null}
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
            <div className="model-select-footer">
              <button type="button" onClick={() => {
                setOpen(false);
                setCustomMode(true);
              }}>
                <strong><PenLine />Custom model…</strong>
                <span>Type any {provider} model id</span>
              </button>
              <button type="button" onClick={() => {
                onChange("");
                setOpen(false);
              }}>
                <strong>None</strong>
                <span>Skip this provider for the tier</span>
              </button>
            </div>
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
