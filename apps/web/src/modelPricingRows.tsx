import { useState } from "react";

import { formatDateTime, formatMoney } from "./format";
import type { ModelPricingCardQuery } from "./gql/graphql";
import { MenuSelect } from "./table/MenuSelect";
import { Badge } from "./ui";

export type PricingRow = ModelPricingCardQuery["modelPricing"][number];

export type PricingInput = {
  provider: string;
  model: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  cacheReadCostPerMtok?: number;
  cacheWriteCostPerMtok?: number;
};

export function pricingRowKey(row: PricingRow) {
  return `${row.provider ?? ""}:${row.model}`;
}

export function PricingViewRow({ row, reverting, onEdit, onRevert }: {
  row: PricingRow;
  reverting: boolean;
  onEdit: () => void;
  onRevert?: () => void;
}) {
  return (
    <tr>
      <td>
        <div className="pricing-model">
          <span className="mono">{row.model}</span>
          <span className="faint">{row.provider ?? "unknown provider"}{row.seenInTraffic ? " · in traffic" : ""}</span>
        </div>
      </td>
      <td>{formatRate(row.inputCostPerMtok)}</td>
      <td>{formatRate(row.cacheReadCostPerMtok)}</td>
      <td>{formatRate(row.cacheWriteCostPerMtok)}</td>
      <td>{formatRate(row.outputCostPerMtok)}</td>
      <td><SourceBadge row={row} /></td>
      <td className="pricing-actions">
        <button className="btn btn-ghost" type="button" onClick={onEdit}>Edit</button>
        {onRevert
          ? <button className="btn btn-ghost" type="button" disabled={reverting} onClick={onRevert}>Revert</button>
          : null}
      </td>
    </tr>
  );
}

function SourceBadge({ row }: { row: PricingRow }) {
  if (row.source === "custom") {
    return (
      <Badge variant="accent" dot>
        {row.updatedAt ? `custom · ${formatDateTime(row.updatedAt)}` : "custom"}
      </Badge>
    );
  }
  if (row.source === "unpriced") return <Badge variant="warn" dot>unpriced</Badge>;
  if (row.source === "env") return <Badge>env</Badge>;
  return <Badge>default</Badge>;
}

export function PricingEditRow({ row, saving, onSave, onCancel }: {
  row?: PricingRow;
  saving: boolean;
  onSave: (input: PricingInput) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState(row?.provider ?? "anthropic");
  const [model, setModel] = useState(row?.model ?? "");
  const [input, setInput] = useState(rateDraft(row?.inputCostPerMtok));
  const [cacheRead, setCacheRead] = useState(rateDraft(row?.cacheReadCostPerMtok));
  const [cacheWrite, setCacheWrite] = useState(rateDraft(row?.cacheWriteCostPerMtok));
  const [output, setOutput] = useState(rateDraft(row?.outputCostPerMtok));

  const inputRate = parseRate(input);
  const outputRate = parseRate(output);
  const cacheReadRate = parseOptionalRate(cacheRead);
  const cacheWriteRate = parseOptionalRate(cacheWrite);
  const valid =
    model.trim().length > 0 &&
    inputRate !== undefined &&
    outputRate !== undefined &&
    cacheReadRate !== "invalid" &&
    cacheWriteRate !== "invalid";

  const save = () => {
    if (inputRate === undefined || outputRate === undefined || !valid) return;
    onSave({
      provider,
      model: model.trim(),
      inputCostPerMtok: inputRate,
      outputCostPerMtok: outputRate,
      ...(typeof cacheReadRate === "number" ? { cacheReadCostPerMtok: cacheReadRate } : {}),
      ...(typeof cacheWriteRate === "number" ? { cacheWriteCostPerMtok: cacheWriteRate } : {})
    });
  };

  return (
    <tr className="pricing-edit-row">
      <td>
        {row ? (
          <div className="pricing-model">
            <span className="mono">{row.model}</span>
            <span className="faint">{row.provider ?? "unknown provider"}</span>
          </div>
        ) : (
          <div className="pricing-model pricing-model-fields">
            <MenuSelect
              ariaLabel="Provider"
              value={provider}
              options={[
                { value: "anthropic", label: "anthropic" },
                { value: "openai", label: "openai" }
              ]}
              onChange={setProvider}
            />
            <div className="input pricing-model-input">
              <input
                value={model}
                placeholder="model identifier"
                aria-label="Model identifier"
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
          </div>
        )}
      </td>
      <td><RateInput label="Input cost" value={input} onChange={setInput} /></td>
      <td><RateInput label="Cache read cost" value={cacheRead} placeholder="10% of input" onChange={setCacheRead} /></td>
      <td><RateInput label="Cache write cost" value={cacheWrite} placeholder="1.25x input" onChange={setCacheWrite} /></td>
      <td><RateInput label="Output cost" value={output} onChange={setOutput} /></td>
      <td><span className="faint">per MTok</span></td>
      <td className="pricing-actions">
        <button className="btn btn-primary" type="button" disabled={!valid || saving} onClick={save}>
          {saving ? "Saving" : "Save"}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </td>
    </tr>
  );
}

function RateInput({ label, value, placeholder, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="input pricing-rate-input">
      <input
        value={value}
        inputMode="decimal"
        placeholder={placeholder ?? "0.00"}
        aria-label={`${label} per million tokens`}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function formatRate(value: number | null | undefined) {
  if (value === null || value === undefined) return <span className="faint">—</span>;
  return <span className="mono">{formatMoney(value)}</span>;
}

function rateDraft(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function parseRate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalRate(value: string): number | undefined | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : "invalid";
}
