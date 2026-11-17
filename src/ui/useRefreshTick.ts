import { useEffect, useState } from "react";

/**
 * A counter that goes up every `intervalMs`. A page puts it in the deps of a
 * read effect to read its data again; `tick > 0` marks a quiet re-read.
 */
export function useRefreshTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs]);
  return tick;
}
