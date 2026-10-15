import log from 'electron-log';

/** Every kind of live work that should keep the Mac awake. Each owning registry reports its own. */
export type WorkSource = 'agent-turns' | 'background-waits' | 'flow-nodes';

const busySources = new Set<WorkSource>();
const listeners = new Set<() => void>();

/** Called by a registry after it mutates; listeners hear only when a source flips busy ↔ idle. */
export function reportWork(source: WorkSource, active: boolean): void {
  if (busySources.has(source) === active) return;
  if (active) busySources.add(source);
  else busySources.delete(source);
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      log.warn('[WorkActivity] listener failed', { source, error });
    }
  }
}

export function isWorkActive(): boolean {
  return busySources.size > 0;
}

export function onWorkChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: forget reported sources and listeners. */
export function _resetWorkActivityForTests(): void {
  busySources.clear();
  listeners.clear();
}
