import * as fs from 'node:fs/promises';
import path from 'node:path';
import log from 'electron-log';

const AGENTS_MD_MAX_BYTES = 100 * 1024;
const AGENTS_CACHE_TTL_MS = 30_000;
const AGENTS_CACHE_MAX_ENTRIES = 200;
let lastAgentsMdCwd: string | undefined;

type AgentsCacheEntry = {
  expiresAt: number;
  content: string | undefined;
};

const agentsMdCache = new Map<string, AgentsCacheEntry>();

function pruneAgentsMdCache(now: number): void {
  for (const [cachePath, entry] of agentsMdCache.entries()) {
    if (entry.expiresAt <= now) {
      agentsMdCache.delete(cachePath);
    }
  }

  while (agentsMdCache.size > AGENTS_CACHE_MAX_ENTRIES) {
    const oldestKey = agentsMdCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    agentsMdCache.delete(oldestKey);
  }
}

/**
 * Reads AGENTS.md from the current workspace with a short TTL cache to avoid
 * repeated per-request disk I/O on hot chat paths.
 */
export async function readAgentsMd(cwd: string): Promise<string | undefined> {
  if (lastAgentsMdCwd && lastAgentsMdCwd !== cwd) {
    clearAgentsMdCache();
  }
  lastAgentsMdCwd = cwd;

  const agentsMdPath = path.join(cwd, 'AGENTS.md');
  const now = Date.now();
  pruneAgentsMdCache(now);
  const cached = agentsMdCache.get(agentsMdPath);

  if (cached && cached.expiresAt > now) {
    return cached.content;
  }

  let content: string | undefined;

  try {
    const stat = await fs.stat(agentsMdPath);
    if (stat.size > AGENTS_MD_MAX_BYTES) {
      log.warn(
        `[claude] Skipping AGENTS.md at ${agentsMdPath}: file too large (${stat.size} bytes)`,
      );
      content = undefined;
    } else {
      const raw = await fs.readFile(agentsMdPath, 'utf-8');
      content = raw.trim().length > 0 ? raw : undefined;
    }
  } catch {
    content = undefined;
  }

  agentsMdCache.set(agentsMdPath, {
    expiresAt: now + AGENTS_CACHE_TTL_MS,
    content,
  });
  pruneAgentsMdCache(now);

  return content;
}

export function clearAgentsMdCache(): void {
  agentsMdCache.clear();
  lastAgentsMdCwd = undefined;
}
