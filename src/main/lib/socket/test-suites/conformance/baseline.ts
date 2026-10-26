import type { AgentRuntime } from '../../../../../shared/lib/ai-providers';
import type { Feature } from '../../../../../shared/lib/ai-providers/capabilities';

export type ScenarioId =
  | 'simple-turn'
  | 'write-file-changed'
  | 'write-in-wake-burst'
  | 'resumed-mode-kept'
  | 'plan-exit-reminder'
  | 'stopped-plan-exit-reminder'
  | 'stop-mid-turn'
  | 'stop-keeps-partial'
  | 'resume-after-stop'
  | 'concurrent-approvals'
  | 'stop-while-asking'
  | 'debug-session';
export type RowId = `${ScenarioId} x ${AgentRuntime}`;

const NO_DEBUG_SESSION =
  "Only Claude's session sets up Frink's debug session; the other runners refuse a Debug turn.";

/** Rows that fail today, with the cause. Shrink-only: a listed row that passes fails the grid. */
export const EXPECTED_FAILURES: Partial<Record<RowId, string>> = {
  'write-file-changed x codex':
    'Its Edit card names the file only in `changes`, so no `file_path` reaches the shared tool effect.',
  'debug-session x codex': NO_DEBUG_SESSION,
  'debug-session x acp': NO_DEBUG_SESSION,
  'debug-session x copilot': NO_DEBUG_SESSION,
  'debug-session x cursor': NO_DEBUG_SESSION,
};

/** The scenarios whose rows decide each feature flag: a provider holds it only where they pass. */
export const FEATURE_ROWS: Record<Feature, readonly [ScenarioId, ...ScenarioId[]]> = {
  debug: ['debug-session'],
};

/** The parts of the user's setup the canary plants. Every row but the project tier is a capability
 * category, so its expected outcome is that provider's cell. */
export const CANARY_ROWS = [
  'instructions (project)',
  'instructions',
  'skills',
  'agentBrain',
  'memory',
  'hooks',
  'mcp',
] as const;
export type CanaryRow = (typeof CANARY_ROWS)[number];
export const CANARY_PROVIDERS = ['claude-code', 'opencode', 'copilot'] as const;
export type CanaryProvider = (typeof CANARY_PROVIDERS)[number];
export type CanaryRowId = `${CanaryRow} x ${CanaryProvider}`;

const OPENCODE_PRIVATE =
  "OpenCode's private launch takes no Frink MCP servers, agents, memory or hooks.";
const COPILOT_PRIVATE =
  "GitHub Copilot runs in a Frink-owned config folder that Frink hands none of the user's setup.";

/** Canary rows whose setup does not reach the model today, with the cause. Shrink-only. */
export const CANARY_GAPS: Partial<Record<CanaryRowId, string>> = {
  'agentBrain x opencode': OPENCODE_PRIVATE,
  'memory x opencode': OPENCODE_PRIVATE,
  'hooks x opencode': OPENCODE_PRIVATE,
  'mcp x opencode': OPENCODE_PRIVATE,
  'instructions x copilot': COPILOT_PRIVATE,
  'skills x copilot': COPILOT_PRIVATE,
  'agentBrain x copilot': COPILOT_PRIVATE,
  'memory x copilot': COPILOT_PRIVATE,
  'hooks x copilot': COPILOT_PRIVATE,
  'mcp x copilot': COPILOT_PRIVATE,
};
