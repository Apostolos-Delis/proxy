import { BarChart3, Check, CircleDollarSign, FileJson, GitBranch, Logs, RotateCw, Save, Search, Shield, Zap } from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";

import { CompressionPreviewPanel } from "./compressionPreviewPanel";
import { SettingRow, SettingsSectionCard } from "./settingsFields";
import { changedRowIds, filterSections, restartPending, sectionsFor, validate, type EditableSettings } from "./settingsPageData";
import { Badge } from "./ui";

const sectionIcons: Record<string, ComponentType> = {
  system: Shield,
  optimization: Zap,
  baseline: CircleDollarSign,
  classifier: GitBranch,
  capture: Logs,
  quality: BarChart3
};

export function SettingsForm({
  initial,
  databaseEnabled,
  storagePath,
  storageReason,
  restartRequiredFor,
  saving,
  justSaved,
  justSavedRestart,
  saveError,
  onSave
}: {
  initial: EditableSettings;
  databaseEnabled: boolean;
  storagePath: string;
  storageReason: string;
  restartRequiredFor: string[];
  saving: boolean;
  justSaved: boolean;
  justSavedRestart: boolean;
  saveError?: string;
  onSave: (settings: EditableSettings, needsRestart: boolean) => void;
}) {
  const sections = useMemo(() => sectionsFor(databaseEnabled), [databaseEnabled]);
  const [settings, setSettings] = useState(initial);
  const [search, setSearch] = useState("");
  const [activeSection, setActiveSection] = useState(sections[0]?.id ?? "classifier");

  const visible = useMemo(() => filterSections(sections, search), [sections, search]);
  const dirtyCount = changedRowIds(sections, settings, initial).length;
  const needsRestart = restartPending(sections, restartRequiredFor, settings, initial);
  const validation = validate(settings);
  // Compare trimmed: the save path trims, so a whitespace-only change is a
  // no-op that does not actually shift the cached prefix.
  const systemPromptEdited = (settings.systemPrompt ?? "").trim() !== (initial.systemPrompt ?? "").trim();
  const filtering = search.trim().length > 0;
  const moreErrors = validation.length > 1 ? ` (+${validation.length - 1} more)` : "";
  const barError = validation.length > 0 ? `${validation[0]}${moreErrors}` : saveError;

  function jump(id: string) {
    setActiveSection(id);
    document.getElementById(`settings-sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <form className="settings-layout" onSubmit={(event) => {
      event.preventDefault();
      if (dirtyCount > 0 && validation.length === 0) onSave(settings, needsRestart);
    }}>
      <nav className="settings-rail" aria-label="Settings sections">
        <div className="input settings-rail-filter">
          <Search />
          <input
            value={search}
            placeholder="Filter settings..."
            aria-label="Filter settings"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </div>
        {sections.map((section) => {
          const Icon = sectionIcons[section.id] ?? Shield;
          const active = activeSection === section.id && !filtering;
          return (
            <button
              key={section.id}
              type="button"
              className={`nav-item${active ? " active" : ""}`}
              aria-current={active ? "true" : undefined}
              onClick={() => jump(section.id)}
            >
              <Icon />
              <span>{section.title}</span>
            </button>
          );
        })}
      </nav>

      <div className="settings-content">
        {visible.map((section) => (
          <SettingsSectionCard
            key={section.id}
            section={section}
            icon={sectionIcons[section.id] ?? Shield}
            restartRequired={section.restartKey !== undefined && restartRequiredFor.includes(section.restartKey)}
          >
            {section.rows.map((row) => (
              <SettingRow key={row.id} row={row} settings={settings} initial={initial} onChange={setSettings} />
            ))}
            {section.id === "optimization" ? (
              <CompressionPreviewPanel policy={settings.toolResultCompressionPolicy} />
            ) : null}
            {section.id === "system" && systemPromptEdited ? (
              <div className="settings-warning">
                Active harness sessions keep their pinned organization prompt. This change applies to new sessions and sessionless requests.
              </div>
            ) : null}
          </SettingsSectionCard>
        ))}

        {visible.length === 0 ? (
          <div className="settings-empty">No settings match &ldquo;{search.trim()}&rdquo;.</div>
        ) : null}

        <div className="settings-storage">
          <Badge variant={databaseEnabled ? "success" : "warn"} dot>{databaseEnabled ? "Database on" : "File only"}</Badge>
          <FileJson />
          <span className="mono">{storagePath}</span>
          <span className="settings-storage-note">{storageReason}</span>
        </div>

        {dirtyCount > 0 ? (
          <div className="settings-savebar" role="status">
            <span className="settings-savebar-count">{dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}</span>
            {needsRestart ? <Badge variant="warn"><RotateCw />restart required</Badge> : null}
            {barError ? <span className="settings-savebar-error">{barError}</span> : null}
            <button className="btn btn-sm" type="button" onClick={() => setSettings(initial)}><RotateCw />Reset</button>
            <button className="btn btn-sm btn-primary" type="submit" disabled={saving || validation.length > 0}>
              <Save />{saving ? "Saving" : "Save changes"}
            </button>
          </div>
        ) : null}
        {dirtyCount === 0 && justSaved ? (
          <div className="settings-savebar saved" role="status">
            <Check />
            Saved{justSavedRestart ? " — applies after proxy restart" : ""}
          </div>
        ) : null}
      </div>
    </form>
  );
}
