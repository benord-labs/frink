import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ClaudeMcpConfigTransport = {
  configPath: string;
  extraArgs: { 'mcp-config': string };
  stage: () => Promise<void>;
  clear: () => Promise<void>;
};

/**
 * Projects secret-bearing MCP startup config through a protected file so the Claude SDK receives
 * only a path in argv. A fresh CLI retry can re-stage the same path after the prior attempt clears
 * it on its first frame.
 */
export function createClaudeMcpConfigTransport(
  mcpServers: Record<string, unknown> | undefined,
  configDir: string,
  onCleanupError: (error: unknown) => void,
): ClaudeMcpConfigTransport | null {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return null;

  // One execution must never clear or overwrite another execution's config. Duplicate executes
  // for the same chat can overlap before the session registry elects a winner.
  const configPath = path.join(configDir, `mcp-config-${randomUUID()}.json`);
  const serializedConfig = JSON.stringify({ mcpServers });
  let staged = false;

  return {
    configPath,
    extraArgs: { 'mcp-config': configPath },
    stage: async () => {
      staged = true;
      await fs.promises.writeFile(configPath, serializedConfig, { mode: 0o600 });
      await fs.promises.chmod(configPath, 0o600);
    },
    clear: async () => {
      if (!staged) return;
      try {
        await fs.promises.rm(configPath, { force: true });
        staged = false;
      } catch (error) {
        onCleanupError(error);
      }
    },
  };
}
