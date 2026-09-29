import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeCredentialLaunch,
  CLAUDE_API_KEY_FD_ENV,
  CLAUDE_OAUTH_TOKEN_FD_ENV,
  relaunchWithCredential,
  spawnCredentialFingerprint,
} from './credential-fd-spawn';

const API_KEY = 'sk-ant-api03-test-key';
const OAUTH = 'sk-ant-oat01-test-token';
const posixOnly = process.platform === 'win32' ? it.skip : it;

function collect(proc: SpawnedProcess): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.on('exit', (code) => resolve({ stdout, code }));
  });
}

/** Spawn a real node child through the closure, the way the SDK would. */
function spawnNode(launch: ReturnType<typeof buildClaudeCredentialLaunch>, script: string) {
  if (!launch.spawnClaudeCodeProcess) throw new Error('expected a custom spawn');
  return launch.spawnClaudeCodeProcess({
    command: process.execPath,
    args: ['-e', script],
    env: { ...process.env, ...launch.envPatch, ELECTRON_RUN_AS_NODE: '1' },
    signal: new AbortController().signal,
  });
}

const READ_FD3 = "process.stdout.write(require('fs').readFileSync('/dev/fd/3','utf8'))";

describe('buildClaudeCredentialLaunch', () => {
  it('injects nothing for a passthrough (keychain) account', () => {
    expect(buildClaudeCredentialLaunch({ token: null, isApiKey: false })).toEqual({ envPatch: {} });
  });

  it('treats a blank token as no token instead of handing the CLI an empty credential', () => {
    expect(buildClaudeCredentialLaunch({ token: '   \n', isApiKey: true })).toEqual({
      envPatch: {},
    });
  });

  it('points an API key at the fd without putting the key in env', () => {
    const launch = buildClaudeCredentialLaunch(
      { token: API_KEY, isApiKey: true },
      { platform: 'darwin' },
    );
    expect(launch.envPatch).toEqual({ [CLAUDE_API_KEY_FD_ENV]: '3' });
    expect(JSON.stringify(launch.envPatch)).not.toContain(API_KEY);
    expect(launch.spawnClaudeCodeProcess).toBeTypeOf('function');
  });

  it('points a setup token at the OAuth fd var', () => {
    const launch = buildClaudeCredentialLaunch(
      { token: OAUTH, isApiKey: false },
      { platform: 'linux' },
    );
    expect(launch.envPatch).toEqual({ [CLAUDE_OAUTH_TOKEN_FD_ENV]: '3' });
  });

  it('keeps env delivery on Windows, which has no /dev/fd', () => {
    const apiKey = buildClaudeCredentialLaunch(
      { token: API_KEY, isApiKey: true },
      { platform: 'win32' },
    );
    const oauth = buildClaudeCredentialLaunch(
      { token: OAUTH, isApiKey: false },
      { platform: 'win32' },
    );
    expect(apiKey).toEqual({ envPatch: { ANTHROPIC_API_KEY: API_KEY } });
    expect(oauth).toEqual({ envPatch: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  });

  posixOnly('delivers the trimmed credential on fd 3 of the spawned child', async () => {
    const launch = buildClaudeCredentialLaunch({ token: `${OAUTH}\n`, isApiKey: false });
    const result = await collect(spawnNode(launch, READ_FD3));
    expect(result).toEqual({ stdout: OAUTH, code: 0 });
  });

  posixOnly('delivers the credential again on every spawn (respawn, 401 retry)', async () => {
    const launch = buildClaudeCredentialLaunch({ token: API_KEY, isApiKey: true });
    const first = await collect(spawnNode(launch, READ_FD3));
    const second = await collect(spawnNode(launch, READ_FD3));
    expect([first.stdout, second.stdout]).toEqual([API_KEY, API_KEY]);
  });

  posixOnly('never exposes the credential to the child env or its descendants', async () => {
    const launch = buildClaudeCredentialLaunch({ token: API_KEY, isApiKey: true });
    const script =
      "const {execSync}=require('child_process');" +
      "process.stdout.write(JSON.stringify(process.env)+execSync('env').toString())";
    const result = await collect(spawnNode(launch, script));
    expect(result.stdout).not.toContain(API_KEY);
  });

  posixOnly('survives a child that exits without reading the pipe', async () => {
    const launch = buildClaudeCredentialLaunch({ token: API_KEY, isApiKey: true });
    // An unhandled EPIPE on the credential pipe would fail the run as an uncaught error.
    const result = await collect(spawnNode(launch, 'process.exit(0)'));
    expect(result.code).toBe(0);
  });

  posixOnly('reports a signal-killed child as exited, not still running', async () => {
    const launch = buildClaudeCredentialLaunch({ token: API_KEY, isApiKey: true });
    const proc = spawnNode(launch, "process.kill(process.pid,'SIGTERM')");
    await collect(proc);
    expect(proc.signalCode).toBe('SIGTERM');
  });

  it('reports a missing binary through the process error event instead of throwing', async () => {
    const launch = buildClaudeCredentialLaunch(
      { token: API_KEY, isApiKey: true },
      { platform: 'darwin' },
    );
    const proc = launch.spawnClaudeCodeProcess!({
      command: '/nonexistent/claude-binary',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const error = await new Promise<Error>((resolve) => proc.on('error', resolve));
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  posixOnly(
    'drains stderr to the consumer so a chatty CLI never blocks on a full pipe',
    async () => {
      let received = 0;
      const launch = buildClaudeCredentialLaunch(
        { token: API_KEY, isApiKey: true },
        { onStderr: (data) => (received += data.length) },
      );
      // writeSync blocks until the parent drains, so exiting proves nothing was left stuck.
      const result = await collect(
        spawnNode(launch, "require('fs').writeSync(2,'x'.repeat(200000))"),
      );
      expect(result.code).toBe(0);
      // 'exit' can land before the last stderr chunk is delivered.
      await vi.waitFor(() => expect(received).toBe(200000));
    },
  );

  posixOnly('does not block a chatty CLI when nobody consumes stderr', async () => {
    const launch = buildClaudeCredentialLaunch({ token: API_KEY, isApiKey: true });
    const result = await collect(
      spawnNode(launch, "require('fs').writeSync(2,'x'.repeat(200000))"),
    );
    expect(result.code).toBe(0);
  });
});

describe('spawnCredentialFingerprint', () => {
  const fingerprintOf = (token: string) =>
    spawnCredentialFingerprint(
      buildClaudeCredentialLaunch({ token, isApiKey: true }, { platform: 'darwin' })
        .spawnClaudeCodeProcess,
    );

  it('is stable for a token and differs across tokens', () => {
    expect(fingerprintOf(API_KEY)).toBe(fingerprintOf(`${API_KEY}\n`));
    expect(fingerprintOf(API_KEY)).not.toBe(fingerprintOf(`${API_KEY}x`));
  });

  it('never contains the token, and is undefined for the SDK default spawn', () => {
    expect(fingerprintOf(API_KEY)).not.toContain('sk-ant');
    expect(spawnCredentialFingerprint(undefined)).toBeUndefined();
    expect(spawnCredentialFingerprint(() => ({}))).toBeUndefined();
  });
});

describe('relaunchWithCredential', () => {
  const staleEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-api-stale',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-stale',
    [CLAUDE_API_KEY_FD_ENV]: '3',
  };

  it('clears every stale credential key before pointing at the fresh one', () => {
    const next = relaunchWithCredential(staleEnv, { token: OAUTH, isApiKey: false });
    if (process.platform === 'win32') return;
    expect(next.env).toEqual({ PATH: '/usr/bin', [CLAUDE_OAUTH_TOKEN_FD_ENV]: '3' });
    expect(next.spawnClaudeCodeProcess).toBeTypeOf('function');
  });

  it('never mutates the env of the attempt it replaces', () => {
    const before = { ...staleEnv };
    relaunchWithCredential(staleEnv, { token: API_KEY, isApiKey: true });
    expect(staleEnv).toEqual(before);
  });
});
