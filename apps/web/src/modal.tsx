import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Tabbing out of the dialog would reach controls behind the scrim (e.g. the
// wizard's Back button), which can unmount the modal mid-mutation.
function trapTab(event: KeyboardEvent<HTMLDivElement>) {
  const focusable = event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// Portals out of the page so fixed positioning isn't trapped while the
// .page-enter transform animation runs, but into .app rather than body so
// the data-theme variables still apply.
export function Modal({ label, title, subtitle, className = "", onClose, children }: {
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            trapTab(event);
            return;
          }
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="modal-head">
          {title !== undefined ? (
            <div className="modal-title">
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
    </>,
    document.querySelector(".app") ?? document.body
  );
}
