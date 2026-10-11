import { useSyncExternalStore } from "react";

function mediaList(query: string) {
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaList(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => mediaList(query)?.matches ?? false,
    () => false,
  );
}
