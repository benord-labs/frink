import os from 'node:os';
import { getChannelToken, withChannelQuery } from '../../mcp/execution-identity';

/** Codex shells drop `*KEY*`/`*SECRET*`/`*TOKEN*` vars; last in the args so no override undoes it.
 * Why: docs/decisions/child-process-env-secrets.md */
export const CODEX_SHELL_ENV_SCRUB_ARGS = [
  '--config',
  'shell_environment_policy.ignore_default_excludes=false',
] as const;

/** Disable Codex execution surfaces that do not implement Frink host permission v1, including
 * sub-agents, and scrub credentials from the shells Codex spawns. */
export function buildSpawnArgs(configArgs?: string[]): string[] {
  return [
    '--disable',
    'computer_use',
    '--disable',
    'code_mode',
    '--disable',
    'code_mode_host',
    '--disable',
    'code_mode_buffered_exec',
    '--disable',
    'code_mode_only',
    '--disable',
    'multi_agent',
    '--disable',
    'multi_agent_v2',
    // Codex's model catalog turns sub-agents on despite the feature flags; only
    // [agents].enabled=false removes them, and a sub-agent's calls skip Frink's gate.
    '--config',
    'agents.enabled=false',
    ...(configArgs ?? []),
    ...CODEX_SHELL_ENV_SCRUB_ARGS,
  ];
}

type CodexMcpConfigParams = {
  /** The dynamic-chat MCP base URL, or null when this turn injects no frink MCP. */
  baseUrl: string | null;
  subChatId: string;
  projectPath: string;
  /** Whether a live task expects a lifecycle signal — part of the tool-list discriminator. */
  hasSignalTask: boolean;
};

/** Build the channel-scoped dynamic-chat URL included in Codex's canonical MCP table. */
export function buildCodexDynamicChatMcpUrl(params: CodexMcpConfigParams): string | null {
  const { baseUrl, subChatId, projectPath, hasSignalTask } = params;
  const eligible = baseUrl && projectPath && projectPath !== os.homedir();
  if (!eligible) return null;
  return withChannelQuery(baseUrl, getChannelToken(subChatId, 'codex'), hasSignalTask);
}
