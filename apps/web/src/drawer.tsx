import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useState } from "react";
import type { ReactNode } from "react";

const DEFAULT_WIDTH = 680;
const MIN_WIDTH = 480;
const MAX_WIDTH = 1100;

// Portals out of the page so fixed positioning isn't trapped while the
// .page-enter transform animation runs, but into .app rather than body so
// the data-theme variables still apply.
export function Drawer({ label, title, subtitle, storageKey, onClose, children }: {
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  storageKey?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(() => loadWidth(storageKey));
  const [dragStart, setDragStart] = useState<{ x: number; width: number } | null>(null);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="drawer"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
      >
        <button
          type="button"
          className="drawer-resize"
          aria-label="Resize panel"
          tabIndex={-1}
          data-resizing={dragStart ? "true" : undefined}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragStart({ x: event.clientX, width });
          }}
          onPointerMove={(event) => {
            if (!dragStart) return;
            setWidth(clampWidth(dragStart.width + dragStart.x - event.clientX));
          }}
          onPointerUp={() => {
            setDragStart(null);
            persistWidth(storageKey, width);
          }}
          onPointerCancel={() => setDragStart(null)}
        />
        <div className="drawer-body">
          <div className="drawer-head">
            {title !== undefined ? (
              <div className="drawer-title">
                <h3>{title}</h3>
                {subtitle ? <div className="muted">{subtitle}</div> : null}
              </div>
            ) : null}
            <button autoFocus className="btn btn-ghost btn-icon" type="button" aria-label="Close" onClick={onClose}>
              <X />
            </button>
          </div>
          {children}
        </div>
      </aside>
    </>,
    document.querySelector(".app") ?? document.body
  );
}

function loadWidth(storageKey: string | undefined) {
  if (!storageKey) return DEFAULT_WIDTH;
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function persistWidth(storageKey: string | undefined, width: number) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Private mode; the width just won't stick.
  }
}

function clampWidth(width: number) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
}
