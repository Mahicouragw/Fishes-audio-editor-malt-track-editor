import { useEffect, useRef, useState } from 'react';

/**
 * Seconds since `active` became true.
 *
 * A progress bar that has not moved yet is indistinguishable from a frozen
 * page — especially on a phone or tablet where the first stage of a render can
 * take many seconds. A counter that visibly ticks proves the app is alive, so
 * the user knows to wait instead of giving up. It is deliberately not a live
 * region: announcing every second would make a screen reader talk over
 * everything else.
 */
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return undefined;
    }
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(timer);
  }, [active]);
  return elapsed;
}
