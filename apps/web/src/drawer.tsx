import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

// Portals out of the page so fixed positioning isn't trapped while the
// .page-enter transform animation runs, but into .app rather than body so
// the data-theme variables still apply.
export function Drawer({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="drawer-head">
          <button className="btn btn-ghost btn-icon" type="button" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </aside>
    </>,
    document.querySelector(".app") ?? document.body
  );
}
