import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { app } from 'electron';
import log from 'electron-log';
import type { CredentialResult } from '../../credentials';
import { buildOneShotClaudeEnv, getBundledClaudeBinaryPath } from '../env';
import type { UsageResponseInput } from './rate-limit-store';

const PROBE_TIMEOUT_MS = 30_000;

/** A fresh empty config dir per probe, so overlapping probes never share CLI state. The usage call
 * scans `<config>/projects` (~20s on ~/.claude, ~2s here); the keychain login resolves via the pin. */
function probeConfigDir(): string {
  const root = join(app.getPath('userData'), 'claude-usage-probe');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'run-'));
}

/** A session that never sends a turn (nothing billed), isolated from the user's hooks, MCP servers,
 * claude.ai connectors and IDE, and writing no transcript. */
export function buildUsageProbeOptions(
  credential: Pick<CredentialResult, 'token' | 'isApiKey'>,
  configDir: string,
  abortController: AbortController,
): Options {
  return {
    abortController,
    cwd: configDir,
    env: {
      ...buildOneShotClaudeEnv(credential),
      CLAUDE_CONFIG_DIR: configDir,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    },
    persistSession: false,
    settingSources: [],
    settings: { disableAllHooks: true },
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    stderr: () => {},
  };
}

async function* waitForAbort(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}

/** Read plan usage from a throwaway CLI session. Always aborts (kills) the session when done. */
export async function probeClaudeUsage(
  credential: Pick<CredentialResult, 'token' | 'isApiKey'>,
): Promise<UsageResponseInput> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
  const configDir = probeConfigDir();
  const q = query({
    prompt: waitForAbort(abortController.signal),
    options: {
      ...buildUsageProbeOptions(credential, configDir, abortController),
      // The binary download-claude-binary.mjs asserts CLAUDE_SECURESTORAGE_CONFIG_DIR support on.
      pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
    },
  });
  try {
    await q.initializationResult();
    return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  } finally {
    clearTimeout(timer);
    abortController.abort();
    // Cleanup never decides the result: a read that already succeeded stays a success.
    void rm(configDir, { recursive: true, force: true, maxRetries: 3 }).catch((err) =>
      log.warn('[usage-probe] could not remove probe config dir', err),
    );
  }
}
