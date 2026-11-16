import type { AgentRuntime } from '../../../../../shared/lib/ai-providers';

export type ScenarioId = 'simple-turn' | 'write-file-changed';
export type RowId = `${ScenarioId} x ${AgentRuntime}`;

const CLAUDE_ONLY_REFRESH = 'Only the Claude turn loop tells open editor tabs a file changed.';

/** Rows that fail today, with the cause. Shrink-only: a listed row that passes fails the grid. */
export const EXPECTED_FAILURES: Partial<Record<RowId, string>> = {
  'write-file-changed x codex': `${CLAUDE_ONLY_REFRESH} Its Edit card also has no file_path.`,
  'write-file-changed x acp': CLAUDE_ONLY_REFRESH,
  'write-file-changed x copilot': CLAUDE_ONLY_REFRESH,
  'write-file-changed x cursor': CLAUDE_ONLY_REFRESH,
};
