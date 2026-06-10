import { Info, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { MenuSelect } from "./table/MenuSelect";
import { GlassCard } from "./ui";

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={text}>
      <Info />
      <span role="tooltip">{text}</span>
    </span>
  );
}

export function SettingsSection({ title, description, restartRequired = false, children }: {
  title: string;
  description: string;
  restartRequired?: boolean;
  children: ReactNode;
}) {
  return (
    <GlassCard className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {restartRequired ? (
          <span className="settings-restart info-tip" tabIndex={0}>
            <RotateCw />
            Restart required
            <span role="tooltip">Edits here are saved immediately but only take effect after the proxy restarts.</span>
          </span>
        ) : null}
      </div>
      <div className="settings-fields">{children}</div>
    </GlassCard>
  );
}

function FieldCaption({ label, info }: { label: string; info: string }) {
  return (
    <span className="settings-field-label">
      {label}
      <InfoTip text={info} />
    </span>
  );
}

export function TextField({ label, info, value, onChange }: {
  label: string;
  info: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-field">
      <FieldCaption label={label} info={info} />
      <input value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

export function TextAreaField({ label, info, value, placeholder, onChange }: {
  label: string;
  info: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-field settings-field-wide">
      <FieldCaption label={label} info={info} />
      <textarea
        value={value}
        rows={4}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function NumberField({ label, info, value, min, max, step = 1, suffix, placeholder, onChange }: {
  label: string;
  info: string;
  value: number | null;
  min: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="settings-field">
      <FieldCaption label={label} info={info} />
      <div className="settings-number">
        <input
          type="number"
          value={value ?? ""}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => onChange(numberOrNull(event.target.value))}
        />
        {suffix ? <em>{suffix}</em> : null}
      </div>
    </div>
  );
}

export function SelectField({ label, info, value, options, onChange }: {
  label: string;
  info: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-field">
      <FieldCaption label={label} info={info} />
      <MenuSelect value={value} options={[...options]} ariaLabel={label} onChange={onChange} />
    </div>
  );
}

export function ToggleField({ label, info, checked, onChange }: {
  label: string;
  info: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="settings-toggle">
      <FieldCaption label={label} info={info} />
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
