import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCustomNodeProcessMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    stdout: '[]',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
  }),
);
const resolveNodeCredentialEnvVarsMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ ok: true as const, envVars: {} }),
);
const buildSafeEnvMock = vi.hoisted(() => vi.fn().mockReturnValue({ PATH: '/safe/bin' }));
const warnMock = vi.hoisted(() => vi.fn());

vi.mock('./process-runner', () => ({
  runCustomNodeProcess: (...args: unknown[]) => runCustomNodeProcessMock(...args),
}));
vi.mock('./credentials', () => ({
  resolveNodeCredentialEnvVars: (...args: unknown[]) => resolveNodeCredentialEnvVarsMock(...args),
}));
vi.mock('../terminal/env', () => ({
  buildSafeEnv: (...args: unknown[]) => buildSafeEnvMock(...args),
}));
vi.mock('electron-log', () => ({ default: { warn: warnMock } }));

const { makeManifest } = await import('./test-helpers');
const { MAX_SCRIPT_TIMEOUT_MS, MIN_SCRIPT_TIMEOUT_MS, runCustomNodeScript } =
  await import('./script-runner');

describe('runCustomNodeScript', () => {
  beforeEach(() => {
    runCustomNodeProcessMock.mockClear();
    resolveNodeCredentialEnvVarsMock.mockReset();
    resolveNodeCredentialEnvVarsMock.mockReturnValue({ ok: true, envVars: {} });
    buildSafeEnvMock.mockClear();
    buildSafeEnvMock.mockReturnValue({ PATH: '/safe/bin' });
    warnMock.mockClear();
  });

  it('delegates JavaScript to bundled Node.js with the node directory as cwd', async () => {
    const manifest = makeManifest({ entrypoint: 'index.js' });
    const args = ['--list-options', 'repo'];

    await runCustomNodeScript(manifest, args);

    expect(runCustomNodeProcessMock).toHaveBeenCalledWith({
      manifest,
      args,
      cwd: manifest.nodePath,
      env: { PATH: '/safe/bin' },
      timeoutMs: 10_000,
      maxBuffer: 512 * 1024,
      signal: undefined,
    });
  });

  it('filters the ambient process env before merging declared credentials', async () => {
    resolveNodeCredentialEnvVarsMock.mockReturnValue({
      ok: true,
      envVars: { GITHUB_TOKEN: 'declared-secret' },
    });
    buildSafeEnvMock.mockReturnValue({ PATH: '/safe/bin', LANG: 'en_GB.UTF-8' });

    await runCustomNodeScript(
      makeManifest({
        entrypoint: 'index.js',
        credentials: { github: { envVar: 'GITHUB_TOKEN' } },
      }),
      [],
    );

    const ambientEnv = buildSafeEnvMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(Object.values(ambientEnv).every((value) => typeof value === 'string')).toBe(true);
    expect(runCustomNodeProcessMock.mock.calls[0]?.[0].env).toEqual({
      PATH: '/safe/bin',
      LANG: 'en_GB.UTF-8',
      GITHUB_TOKEN: 'declared-secret',
    });
  });

  it('preserves lenient missing-credential behavior', async () => {
    resolveNodeCredentialEnvVarsMock.mockReturnValue({ ok: false, missing: ['github'] });

    const result = await runCustomNodeScript(makeManifest({ entrypoint: 'index.js' }), []);

    expect(result.exitCode).toBe(0);
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('missing credentials'));
    expect(runCustomNodeProcessMock.mock.calls[0]?.[0].env).toEqual({ PATH: '/safe/bin' });
  });

  it('clamps timeout to the supported 1–120 second range', async () => {
    const manifest = makeManifest({ entrypoint: 'index.js' });

    await runCustomNodeScript(manifest, [], { timeoutMs: 100 });
    expect(runCustomNodeProcessMock.mock.calls[0]?.[0].timeoutMs).toBe(MIN_SCRIPT_TIMEOUT_MS);

    await runCustomNodeScript(manifest, [], { timeoutMs: 999_999 });
    expect(runCustomNodeProcessMock.mock.calls[1]?.[0].timeoutMs).toBe(MAX_SCRIPT_TIMEOUT_MS);
  });

  it('passes cancellation through and returns actionable runner state', async () => {
    const controller = new AbortController();
    runCustomNodeProcessMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      cancelled: true,
      spawnMessage: 'Custom node was cancelled.',
    });

    const result = await runCustomNodeScript(makeManifest({ entrypoint: 'index.js' }), [], {
      signal: controller.signal,
    });

    expect(runCustomNodeProcessMock.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(result).toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: true,
      spawnMessage: 'Custom node was cancelled.',
    });
  });
});
