import type { AgentRuntime } from '../../../../../shared/lib/ai-providers';

export type ScenarioId = 'simple-turn' | 'write-file-changed' | 'write-in-wake-burst';
export type RowId = `${ScenarioId} x ${AgentRuntime}`;

/** Rows that fail today, with the cause. Shrink-only: a listed row that passes fails the grid. */
export const EXPECTED_FAILURES: Partial<Record<RowId, string>> = {
  'write-file-changed x codex':
    'Its Edit card names the file only in `changes`, so no `file_path` reaches the shared tool effect.',
};
