/**
 * Runs a custom node script locally with credentials injected as env vars.
 * Used for dynamic option fetching (--list-options <field>) from the config panel.
 */

import log from 'electron-log';
import { buildSafeEnv } from '../terminal/env';
import { resolveNodeCredentialEnvVars } from './credentials';
import type { CustomNodeManifest } from './discovery';
import { acquireCustomNodeReadLease } from './installation-coordinator';
import { type CustomNodeProcessResult, runCustomNodeProcess } from './process-runner';

const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;
export const MIN_SCRIPT_TIMEOUT_MS = 1_000;
export const MAX_SCRIPT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 512 * 1024;

export type ScriptRunResult = CustomNodeProcessResult;

export async function runCustomNodeScript(
  manifest: CustomNodeManifest,
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal; skipReadLease?: boolean },
): Promise<ScriptRunResult> {
  const releaseReadLease = options?.skipReadLease
    ? null
    : await acquireCustomNodeReadLease(manifest.name, options?.signal);
  if (!options?.skipReadLease && !releaseReadLease) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      cancelled: true,
      spawnMessage: `Custom node "${manifest.name}" was cancelled while waiting for an update to finish.`,
    };
  }

  try {
    const credResult = resolveNodeCredentialEnvVars(manifest);
    const credEnv = credResult.ok ? credResult.envVars : {};
    if (!credResult.ok) {
      log.warn(
        `[script-runner] missing credentials for "${manifest.name}": ${credResult.missing.join(', ')} — running without`,
      );
    }

    const rawTimeout = options?.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(rawTimeout, MIN_SCRIPT_TIMEOUT_MS), MAX_SCRIPT_TIMEOUT_MS);

    return await runCustomNodeProcess({
      manifest,
      args,
      cwd: manifest.nodePath,
      env: { ...buildSafeEnv(process.env), ...credEnv },
      timeoutMs,
      maxBuffer: MAX_BUFFER,
      signal: options?.signal,
    });
  } finally {
    releaseReadLease?.();
  }
}
