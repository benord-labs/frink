type HydrationListener = () => void;

let hydrationComplete = true;
const listeners = new Set<HydrationListener>();

/**
 * A reloaded renderer must not dispatch a queued turn over a surviving execution it has not yet
 * reconciled. This is the single gate for that: closed the instant boot starts, reopened once the
 * live-run header pull resolves (or fails its single retry and gives up).
 */
export function beginLiveRunHydration(): void {
  if (!hydrationComplete) return;
  hydrationComplete = false;
  for (const listener of listeners) listener();
}

export function completeLiveRunHydration(): void {
  if (hydrationComplete) return;
  hydrationComplete = true;
  for (const listener of listeners) listener();
}

export function isLiveRunHydrationComplete(): boolean {
  return hydrationComplete;
}

export function onLiveRunHydrationChange(listener: HydrationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetLiveRunHydrationForTests(): void {
  hydrationComplete = true;
  listeners.clear();
}
