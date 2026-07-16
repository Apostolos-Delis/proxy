import { Fragment } from "react";

import { StatusIndicator } from "../ui";
import { matchSegments, type PaletteAction, type PaletteGroup } from "./searchData";

type PaletteResultsProps = {
  groups: PaletteGroup[];
  query: string;
  activeIndex: number;
  showSkeleton: boolean;
  emptyLabel: string | null;
  error: string | null;
  onOpen: (action: PaletteAction) => void;
  onHover: (index: number) => void;
};

export function paletteOptionId(index: number) {
  return `palette-option-${index}`;
}

export function PaletteResults({ groups, query, activeIndex, showSkeleton, emptyLabel, error, onOpen, onHover }: PaletteResultsProps) {
  if (showSkeleton) return <PaletteSkeleton />;

  const indexByKey = new Map(
    groups.flatMap((group) => group.actions).map((action, index) => [action.key, index])
  );
  return (
    <>
      {error ? <div className="palette-error">Search failed — {error}</div> : null}
      {groups.map((group) => (
        <div key={group.label} className="palette-group" role="group" aria-label={group.label}>
          <div className="palette-group-label">{group.label}</div>
          {group.actions.map((action) => (
            <PaletteRow
              key={action.key}
              action={action}
              query={query}
              index={indexByKey.get(action.key) ?? 0}
              active={indexByKey.get(action.key) === activeIndex}
              onOpen={onOpen}
              onHover={onHover}
            />
          ))}
        </div>
      ))}
      {emptyLabel ? (
        <div className="palette-empty">
          <strong>No matches for &ldquo;{emptyLabel}&rdquo;</strong>
          <span>Try a session id, prompt text, user, logical model, or API key name.</span>
        </div>
      ) : null}
    </>
  );
}

function PaletteRow({ action, query, index, active, onOpen, onHover }: {
  action: PaletteAction;
  query: string;
  index: number;
  active: boolean;
  onOpen: (action: PaletteAction) => void;
  onHover: (index: number) => void;
}) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      role="option"
      id={paletteOptionId(index)}
      aria-selected={active}
      className={`palette-row${active ? " active" : ""}`}
      data-kind={action.kind}
      ref={active ? scrollRowIntoView : undefined}
      onClick={() => onOpen(action)}
      onMouseMove={() => onHover(index)}
    >
      <span className="palette-row-icon"><Icon /></span>
      <span className="palette-row-main">
        <span className="palette-row-title">
          <Highlight text={action.title} query={query} />
          {action.status ? <StatusIndicator status={action.status} /> : null}
        </span>
        {action.subtitle ? (
          <span className="palette-row-sub">
            <Highlight text={action.subtitle} query={query} />
          </span>
        ) : null}
      </span>
      {action.meta ? <span className="palette-row-meta">{action.meta}</span> : null}
    </button>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const segments = matchSegments(text, query);
  return (
    <span className="palette-text">
      {segments.map((segment, index) => segment.match
        ? <mark key={index} className="palette-mark">{segment.text}</mark>
        : <Fragment key={index}>{segment.text}</Fragment>)}
    </span>
  );
}

function PaletteSkeleton() {
  return (
    <div className="palette-skeleton skeleton-pulse" aria-hidden="true">
      <i /><i /><i />
    </div>
  );
}

function scrollRowIntoView(element: HTMLButtonElement | null) {
  element?.scrollIntoView({ block: "nearest" });
}
