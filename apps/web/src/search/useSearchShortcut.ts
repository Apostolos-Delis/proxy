import { useRef } from "react";

import { useMountEffect } from "../table/useMountEffect";

// Window-level cmd/ctrl-K handling is external synchronization, so this is one
// of the few places an effect (via useMountEffect) is unavoidable.
export function useSearchShortcut(onTrigger: () => void) {
  const handlerRef = useRef(onTrigger);
  handlerRef.current = onTrigger;
  useMountEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });
}
