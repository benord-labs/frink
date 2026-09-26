import { useEffect, useState } from 'react';

/** Returns `Date.now()` updated every `intervalMs` while `isActive`; initial tick when becoming active. */
export function usePeriodicNow(isActive: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [isActive, intervalMs]);
  return now;
}
