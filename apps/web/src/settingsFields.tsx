import { RotateCw } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { MenuSelect } from "./table/MenuSelect";
import { rowChanged, type EditableSettings, type SettingRowDef, type SettingsSectionDef } from "./settingsPageData";

export function SettingsSectionCard({ section, icon: Icon, restartRequired, children }: {
  section: SettingsSectionDef;
  icon: ComponentType;
  restartRequired: boolean;
  children: ReactNode;
}) {
  return (
    <section className="glass card settings-section" id={`settings-sec-${section.id}`}>
      <div className="settings-section-head">
        <div className="settings-section-title">
          <Icon />
          <h3>{section.title}</h3>
          {restartRequired ? (
            <span className="settings-restart"><RotateCw />applies after restart</span>
          ) : null}
        </div>
        <p>{section.description}</p>
      </div>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

export function SettingRow({ row, settings, initial, onChange }: {
  row: SettingRowDef;
  settings: EditableSettings;
  initial: EditableSettings;
  onChange: (next: EditableSettings) => void;
}) {
  const changed = rowChanged(row, settings, initial);
  const block = row.type === "textarea";
  return (
    <div className={`settings-row${block ? " block" : ""}`}>
      <div className="settings-row-info">
        <div className="settings-row-label">
          <span>{row.label}</span>
          {changed ? <span className="settings-dirty-dot" title="Unsaved change" /> : null}
        </div>
        <p>{row.desc}</p>
      </div>
      <div className={`settings-row-control${row.type === "toggle" ? " toggle" : ""}`}>
        <SettingControl row={row} settings={settings} onChange={onChange} />
      </div>
    </div>
  );
}

function SettingControl({ row, settings, onChange }: {
  row: SettingRowDef;
  settings: EditableSettings;
  onChange: (next: EditableSettings) => void;
}) {
  if (row.type === "toggle") {
    return (
      <input
        type="checkbox"
        role="switch"
        checked={row.get(settings)}
        aria-checked={row.get(settings)}
        aria-label={row.label}
        onChange={(event) => onChange(row.set(settings, event.target.checked))}
      />
    );
  }
  if (row.type === "select") {
    return (
      <MenuSelect
        value={row.get(settings)}
        options={[...row.options]}
        ariaLabel={row.label}
        onChange={(value) => onChange(row.set(settings, value))}
      />
    );
  }
  if (row.type === "textarea") {
    return (
      <textarea
        className="settings-textarea"
        value={row.get(settings)}
        rows={4}
        placeholder={row.placeholder}
        spellCheck={false}
        aria-label={row.label}
        onChange={(event) => onChange(row.set(settings, event.target.value))}
      />
    );
  }
  if (row.type === "number") {
    return (
      <label className="input settings-input">
        <input
          type="number"
          value={row.get(settings) ?? ""}
          min={row.min}
          max={row.max}
          step={row.step ?? 1}
          placeholder={row.placeholder}
          aria-label={row.label}
          onChange={(event) => onChange(row.set(settings, numberOrNull(event.target.value)))}
        />
        {row.unit ? <em>{row.unit}</em> : null}
      </label>
    );
  }
  return (
    <label className="input settings-input">
      <input
        className={row.mono ? "mono" : undefined}
        value={row.get(settings)}
        aria-label={row.label}
        onChange={(event) => onChange(row.set(settings, event.target.value))}
      />
    </label>
  );
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
