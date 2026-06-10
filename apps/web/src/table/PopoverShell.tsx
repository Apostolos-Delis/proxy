import type { ReactNode } from "react";

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
