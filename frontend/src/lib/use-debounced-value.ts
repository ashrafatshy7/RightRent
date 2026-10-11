import { useEffect, useState } from "react";

// The value once it has stopped changing for `delayMs`, so a dragged slider sends one request.
export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
