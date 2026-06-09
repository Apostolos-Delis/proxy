import { Plus, Trash2, X } from "lucide-react";

import { MenuSelect } from "./MenuSelect";
import type { ConsoleTableAdvancedField, ConsoleTableAdvancedOperator, ConsoleTableAdvancedRule } from "./types";

type AdvancedFilterPanelProps<TData> = {
  fields: ConsoleTableAdvancedField<TData>[];
  rules: ConsoleTableAdvancedRule[];
  onRulesChange: (rules: ConsoleTableAdvancedRule[]) => void;
  onClose: () => void;
};

const operatorOptions: { value: ConsoleTableAdvancedOperator; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "startsWith", label: "starts with" },
  { value: "endsWith", label: "ends with" },
  { value: "isEmpty", label: "is empty" },
  { value: "isNotEmpty", label: "is not empty" }
];

const joinOptions = [{ value: "and", label: "and" }, { value: "or", label: "or" }];

export function AdvancedFilterPanel<TData>({ fields, rules, onRulesChange, onClose }: AdvancedFilterPanelProps<TData>) {
  const fieldOptions = fields.map((field) => ({ value: field.id, label: field.label }));
  const visibleRules = rules.length > 0 ? rules : [newRule(fields)];
  const updateRule = (id: string, patch: Partial<ConsoleTableAdvancedRule>) => {
    onRulesChange(visibleRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
  };
  const removeRule = (id: string) => {
    onRulesChange(visibleRules.filter((rule) => rule.id !== id));
  };

  return (
    <div className="advanced-filter-panel">
      <div className="advanced-filter-head">
        <div>
          <strong>Advanced filters</strong>
          <span>Build precise rule sets across table fields.</span>
        </div>
        <button type="button" className="btn btn-icon" aria-label="Close advanced filters" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="advanced-filter-rules">
        {visibleRules.map((rule, index) => (
          <div key={rule.id} className="advanced-filter-row">
            <div className="advanced-filter-join">
              {index === 0 ? "Where" : (
                <MenuSelect value={rule.join} options={joinOptions} ariaLabel="Filter join" onChange={(value) => updateRule(rule.id, { join: value as "and" | "or" })} />
              )}
            </div>
            <MenuSelect value={rule.fieldId} options={fieldOptions} ariaLabel="Filter field" onChange={(fieldId) => updateRule(rule.id, { fieldId })} />
            <MenuSelect value={rule.operator} options={operatorOptions} ariaLabel="Filter operator" onChange={(operator) => updateRule(rule.id, { operator: operator as ConsoleTableAdvancedOperator })} />
            <input
              value={rule.value}
              disabled={rule.operator === "isEmpty" || rule.operator === "isNotEmpty"}
              onChange={(event) => updateRule(rule.id, { value: event.target.value })}
              placeholder={`${fieldOptions.find((field) => field.value === rule.fieldId)?.label ?? "Field"} text`}
            />
            <button type="button" className="btn btn-icon" aria-label="Remove filter rule" onClick={() => removeRule(rule.id)}>
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-primary" onClick={() => onRulesChange([...visibleRules, newRule(fields)])}>
        <Plus />Add filter
      </button>
    </div>
  );
}

function newRule<TData>(fields: ConsoleTableAdvancedField<TData>[]): ConsoleTableAdvancedRule {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fieldId: fields[0]?.id ?? "",
    operator: "contains",
    value: "",
    join: "and"
  };
}
