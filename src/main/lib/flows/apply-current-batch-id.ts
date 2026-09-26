import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GraphWithSettings = { settings?: Record<string, unknown> };

export function isBriefingPopulated(briefing: unknown): boolean {
  return typeof briefing === 'string' && briefing.trim().length > 0;
}

/**
 * Server-managed `graph.settings.currentBatchId` from briefing lifecycle.
 * Strips any client-sent value first — never trust the client for this field.
 *
 * Concurrency: `prevBriefing` / `prevBatchId` must reflect the latest saved version,
 * read inside the same write lock as the subsequent INSERT. The caller
 * (`createFlowVersion`) reads `latestRow` and runs this inside `BEGIN IMMEDIATE`,
 * so the briefing/batch transition never observes a stale predecessor.
 *
 * `prevBriefing` / `prevBatchId` are `unknown` so callers can pass raw graph settings
 * directly — both are type-guarded here (briefing via isBriefingPopulated, batchId via UUID_RE).
 */
export function applyCurrentBatchIdForBriefingTransition(
  graph: GraphWithSettings,
  prevBriefing: unknown,
  prevBatchId: unknown,
): void {
  const s = graph.settings;
  if (s) delete s.currentBatchId;

  const incoming = s?.briefing;
  const prevPop = isBriefingPopulated(prevBriefing);
  const incomingPop = isBriefingPopulated(incoming);

  if (!prevPop && incomingPop) {
    if (!graph.settings) return;
    graph.settings.currentBatchId = randomUUID();
  } else if (prevPop && incomingPop) {
    if (!graph.settings) return;
    graph.settings.currentBatchId =
      typeof prevBatchId === 'string' && UUID_RE.test(prevBatchId.trim())
        ? prevBatchId.trim()
        : randomUUID();
  }
  // prevPop && !incomingPop → briefing cleared, no batchId written
}
