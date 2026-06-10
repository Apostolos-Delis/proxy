import { useEffect, useRef } from "react";

export function useMountEffect(effect: () => void | (() => void)) {
  const effectRef = useRef(effect);
  useEffect(() => effectRef.current(), []);
}
