import { useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useMountEffect } from "./useMountEffect";

type PopoverShellProps = {
  onDismiss: () => void;
  children: ReactNode;
};

export function PopoverShell({ onDismiss, children }: PopoverShellProps) {
  return (
    <>
      <div className="popover-backdrop" onClick={onDismiss} />
      {children}
    </>
  );
}

// Fallbacks for placement before the popover has rendered content;
// place() prefers the measured size so narrow variants clamp correctly.
const popoverWidth = 280;
const popoverMaxHeight = 320;
const popoverGap = 6;
const viewportPadding = 8;

// Popovers anchored inside scroll containers get clipped by their
// overflow, so this portals them to an unclipped fixed layer.
export function AnchoredPopover({ anchorRef, matchAnchorWidth = false, onDismiss, children }: PopoverShellProps & {
  anchorRef: RefObject<HTMLElement | null>;
  matchAnchorWidth?: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useMountEffect(() => {
    const onScroll = (event: Event) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onDismiss);
    };
  });
  // Positioning happens in a callback ref: it runs at commit time, after the
  // anchor's ref is attached even when the whole cell remounts in one commit.
  const place = (node: HTMLDivElement | null) => {
    popoverRef.current = node;
    const anchor = anchorRef.current;
    if (!node || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    if (matchAnchorWidth) node.style.width = `${rect.width}px`;
    const width = node.offsetWidth || popoverWidth;
    const height = node.offsetHeight || popoverMaxHeight;
    const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
    node.style.left = `${left}px`;
    const spaceBelow = window.innerHeight - rect.bottom - popoverGap;
    const spaceAbove = rect.top - popoverGap;
    if (spaceBelow < height && spaceAbove > spaceBelow) {
      node.style.top = "auto";
      node.style.bottom = `${window.innerHeight - rect.top + popoverGap}px`;
    } else {
      node.style.top = `${rect.bottom + popoverGap}px`;
      node.style.bottom = "auto";
    }
  };
  return createPortal(
    <>
      <div className="popover-backdrop" onClick={onDismiss} />
      <div ref={place} className="cell-popover">{children}</div>
    </>,
    anchorRef.current?.closest(".modal") ?? document.querySelector(".app") ?? document.body
  );
}
