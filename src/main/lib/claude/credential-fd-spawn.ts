import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** The fd the CLI reads its credential from. 0-2 are the SDK's stdio pipes. */
const CREDENTIAL_FD = 3;

export const CLAUDE_API_KEY_FD_ENV = 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR';
export const CLAUDE_OAUTH_TOKEN_FD_ENV = 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR';

/** Every env key a Claude credential can occupy: the raw vars (Windows, or a user's own shell
 * export) and the fd pointers. A retry or a Frink-built child env clears all of them. */
export const CLAUDE_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  CLAUDE_API_KEY_FD_ENV,
  CLAUDE_OAUTH_TOKEN_FD_ENV,
] as const;

type ClaudeCredential = { token: string | null; isApiKey: boolean };

/** The SDK spawn hook, carrying a non-reversible identity of the credential it pipes. */
type CredentialSpawn = ((options: SpawnOptions) => SpawnedProcess) & {
  readonly credentialFingerprint: string;
};

export type ClaudeCredentialLaunch = {
  /** Merged into the CLI env: the fd pointer, or on Windows the raw credential var. */
  envPatch: Record<string, string>;
  /** Set when the credential travels through a pipe; pass to the SDK's `query()` options. */
  spawnClaudeCodeProcess?: CredentialSpawn;
};

/** Hands a stored credential to the CLI on fd 3 instead of its env, which its Bash and MCP servers
 * inherit; Windows keeps env. Why: docs/decisions/child-process-env-secrets.md */
export function buildClaudeCredentialLaunch(
  credential: ClaudeCredential,
  options?: { platform?: NodeJS.Platform; onStderr?: (data: string) => void },
): ClaudeCredentialLaunch {
  const token = credential.token?.trim();
  if (!token) return { envPatch: {} };

  if ((options?.platform ?? process.platform) === 'win32') {
    return {
      envPatch: credential.isApiKey
        ? { ANTHROPIC_API_KEY: token }
        : { CLAUDE_CODE_OAUTH_TOKEN: token },
    };
  }

  const fdVar = credential.isApiKey ? CLAUDE_API_KEY_FD_ENV : CLAUDE_OAUTH_TOKEN_FD_ENV;
  const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions) =>
    spawnWithCredentialPipe(spawnOptions, token, options?.onStderr);
  return {
    envPatch: { [fdVar]: String(CREDENTIAL_FD) },
    spawnClaudeCodeProcess: Object.assign(spawnClaudeCodeProcess, {
      credentialFingerprint: fingerprint(token),
    }),
  };
}

/** The credential identity a spawn hook carries, so a warm CLI is never reused across accounts
 * once the token no longer keys through `env`. Undefined for the SDK's default spawn. */
export function spawnCredentialFingerprint(spawn: unknown): string | undefined {
  return typeof spawn === 'function'
    ? (spawn as Partial<CredentialSpawn>).credentialFingerprint
    : undefined;
}

/** `env` re-pointed at `credential`: every credential key cleared, then the fresh launch applied.
 * For a retry, whose previous spawn closure still carries the rejected token. */
export function relaunchWithCredential(
  env: Record<string, string>,
  credential: ClaudeCredential,
): {
  env: Record<string, string>;
  spawnClaudeCodeProcess: ClaudeCredentialLaunch['spawnClaudeCodeProcess'];
} {
  const cleared = { ...env };
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) delete cleared[key];
  const { envPatch, spawnClaudeCodeProcess } = buildClaudeCredentialLaunch(credential);
  return { env: { ...cleared, ...envPatch }, spawnClaudeCodeProcess };
}

/** Mirrors the SDK's own local spawn (stdio, windowsHide, stderr forwarding) plus the credential
 * pipe. A fresh pipe per call, so a respawn or 401 retry always delivers its own credential. */
function spawnWithCredentialPipe(
  { command, args, cwd, env, signal }: SpawnOptions,
  token: string,
  onStderr: ((data: string) => void) | undefined,
): SpawnedProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    signal,
    // An undrained stderr pipe fills and blocks the CLI, so pipe it only when someone reads it.
    stdio: ['pipe', 'pipe', onStderr ? 'pipe' : 'ignore', 'pipe'],
    windowsHide: true,
  });
  if (onStderr) child.stderr?.on('data', (chunk: Buffer) => onStderr(chunk.toString()));

  const credentialPipe = child.stdio[CREDENTIAL_FD] as Writable | null;
  if (credentialPipe) {
    // A child that exits (or never starts) before reading raises EPIPE here. The spawn outcome
    // reaches the SDK through the child's own 'error'/'exit'; this must not crash the main process.
    credentialPipe.on('error', () => {});
    credentialPipe.end(token);
  }
  // Same shape the SDK's spawnLocalProcess returns; stdin/stdout are non-null with piped stdio.
  return {
    stdin: child.stdin as Writable,
    stdout: child.stdout as Readable,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

/** Non-reversible identity for a credential. Never the token itself. */
function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}
