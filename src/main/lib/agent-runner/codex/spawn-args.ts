import os from 'node:os';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { getChannelToken, withChannelQuery } from '../../mcp/execution-identity';

/** Disable Codex execution surfaces that do not implement Frink host permission v1. */
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
    ...(configArgs ?? []),
  ];
}

type CodexMcpConfigParams = {
  /** The dynamic-chat MCP base URL, or null when this turn injects no frink MCP. */
  baseUrl: string | null;
  subChatId: string;
  projectPath: string;
  mode: ChatMode;
  /** Whether a live task expects a lifecycle signal — part of the tool-list discriminator. */
  hasSignalTask: boolean;
};

/** Build the channel-scoped dynamic-chat URL included in Codex's canonical MCP table. */
export function buildCodexDynamicChatMcpUrl(params: CodexMcpConfigParams): string | null {
  const { baseUrl, subChatId, projectPath, mode, hasSignalTask } = params;
  const eligible = baseUrl && projectPath && projectPath !== os.homedir();
  if (!eligible) return null;
  return withChannelQuery(baseUrl, getChannelToken(subChatId, 'codex'), mode, hasSignalTask);
}
