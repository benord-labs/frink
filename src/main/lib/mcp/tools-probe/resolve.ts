/**
 * Tool-resolution helpers for the aggregated MCP UI path (`getAggregatedMcpInfo`):
 * a cold probe and a deduped stale-while-revalidate refresh over the shared cache.
 * Kept out of the (large) mcp router so the router stays a thin composition layer.
 */
import { refreshClaudeToolsCache } from '../claude-tools-cache';
import type { FrinkMcpCredentials, FrinkMcpServerConfig } from '../types';
import { fetchMcpToolDescriptors, fetchMcpToolDescriptorsStdio, toolNames } from '.';
import { callMcpTool, callMcpToolStdio, type McpToolCallResult } from './call';

/**
 * Cold probe of a server's tool list (spawn stdio / HTTP fetch). Returns [] on any
 * failure — the caller's negative cache absorbs a dead server. Shared by the cold
 * path and the stale-while-revalidate refresh so both use one probe.
 */
export async function probeServerTools(
  config: FrinkMcpServerConfig,
  credentials?: FrinkMcpCredentials | null,
): Promise<string[]> {
  try {
    if (config.url) {
      return toolNames(
        await fetchMcpToolDescriptors(config.url, credentials?.headers, config.name),
      );
    }
    if (config.command) {
      return toolNames(
        await fetchMcpToolDescriptorsStdio(
          {
            command: config.command,
            args: config.args,
            env: credentials?.env,
          },
          config.name,
        ),
      );
    }
  } catch {
    // Probe failed — treat as no tools; the negative cache keeps it cheap.
  }
  return [];
}

/**
 * One-shot tool call against a server's config + credentials, mirroring
 * `probeServerTools`' transport selection. Unlike the probe, failures stay
 * typed — the caller must be able to tell a dead server from a tool error.
 */
export async function callServerTool(
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
  /** Registry key, when the caller holds one that identifies the server better than its display name. */
  serverName?: string,
): Promise<McpToolCallResult> {
  const identity = serverName ?? config.name;
  if (config.url) return callMcpTool(config.url, toolName, args, credentials?.headers, identity);
  if (config.command) {
    return callMcpToolStdio(
      { command: config.command, args: config.args, env: credentials?.env },
      toolName,
      args,
      identity,
    );
  }
  return {
    ok: false,
    reason: 'transport',
    message: 'MCP server config has neither url nor command',
  };
}

/**
 * In-flight background revalidations keyed by cache key, so a burst of stale reads
 * (the boot prefetch racing a user opening Settings) triggers ONE re-probe, not N.
 */
const revalidatingTools = new Map<string, Promise<void>>();

/**
 * Re-probe a stale entry in the background and write it back; deduped per cache key.
 * `fingerprint` + `revision` identify the exact entry being refreshed, so a result that
 * arrives after any newer write is discarded rather than clobbering it.
 */
export function revalidateServerTools(
  cacheKey: string,
  config: FrinkMcpServerConfig,
  credentials: FrinkMcpCredentials | null | undefined,
  fingerprint: string,
  revision: number,
): void {
  if (revalidatingTools.has(cacheKey)) return;
  const task = probeServerTools(config, credentials)
    .then((tools) => {
      refreshClaudeToolsCache(cacheKey, tools, fingerprint, revision);
    })
    .catch(() => {
      // Leave the stale entry in place; the next real miss re-probes.
    })
    .finally(() => {
      revalidatingTools.delete(cacheKey);
    });
  revalidatingTools.set(cacheKey, task);
}
