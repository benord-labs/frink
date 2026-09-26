import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const utilityForkMock = vi.hoisted(() => vi.fn());
const resolveEntrypointMock = vi.hoisted(() =>
  vi.fn(async (nodeRoot: string, entrypoint: string) => resolve(nodeRoot, entrypoint)),
);

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
  utilityProcess: { fork: (...args: unknown[]) => utilityForkMock(...args) },
}));

vi.mock('./runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime')>();
  return {
    ...actual,
    resolveCustomNodeEntrypoint: (nodeRoot: string, entrypoint: string) =>
      resolveEntrypointMock(nodeRoot, entrypoint),
  };
});

const { makeManifest } = await import('./test-helpers');
const { runCustomNodeProcess } = await import('./process-runner');

class FakeUtilityProcess extends EventEmitter {
  pid = 43_210;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);

  emitExit(code: number): void {
    try {
      this.emit('exit', code);
    } finally {
      // Electron removes these listeners immediately after emitting `exit`.
      this.stdout.removeAllListeners();
      this.stderr.removeAllListeners();
    }
  }
}

function run(overrides: Partial<Parameters<typeof runCustomNodeProcess>[0]> = {}) {
  return runCustomNodeProcess({
    manifest: makeManifest({ entrypoint: 'index.js' }),
    args: ['--list-options', 'repo'],
    cwd: '/work/node',
    env: { PATH: '/usr/bin', NODE_TOKEN: 'secret' },
    timeoutMs: 10_000,
    maxBuffer: 512 * 1024,
    ...overrides,
  });
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runCustomNodeProcess', () => {
  beforeEach(() => {
    vi.useRealTimers();
    utilityForkMock.mockReset();
    resolveEntrypointMock.mockClear();
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forks JavaScript with bundled Node.js and drains both output streams after exit', async () => {
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);

    const resultPromise = run();
    await nextTurn();

    expect(utilityForkMock).toHaveBeenCalledWith(
      resolve('/mock/app/resources/custom-nodes/managed-bootstrap.mjs'),
      [resolve('/mock/nodes/test-node', 'index.js'), '--list-options', 'repo'],
      {
        cwd: '/work/node',
        env: { PATH: '/usr/bin', NODE_TOKEN: 'secret' },
        stdio: 'pipe',
        serviceName: 'Frink custom node: test-node',
        allowLoadingUnsignedLibraries: false,
      },
    );

    const stdout = JSON.stringify({ items: ['x'.repeat(96 * 1024)] });
    const splitAt = 64 * 1024;
    child.stdout.write(stdout.slice(0, splitAt));
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    child.emitExit(0);
    await nextTurn();

    child.stdout.end(stdout.slice(splitAt));
    await nextTurn();
    expect(settled).toBe(false);
    child.stderr.end('debug');

    await expect(resultPromise).resolves.toEqual({
      stdout,
      stderr: 'debug',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
  });

  it('fails an ordinary managed exit when piped output never finishes draining', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);

    const resultPromise = run();
    await nextTurn();
    child.stdout.write('partial');
    child.emitExit(0);
    await nextTurn();

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: 'partial',
      exitCode: null,
      spawnMessage: expect.stringContaining('output did not finish draining'),
    });
  });

  it('ignores a late cancellation after managed exit while output drains', async () => {
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);
    const controller = new AbortController();

    const resultPromise = run({ signal: controller.signal });
    await nextTurn();
    child.stdout.write('{"done":');
    child.emitExit(0);
    controller.abort();
    await nextTurn();
    child.stdout.end('true}');
    child.stderr.end();

    await expect(resultPromise).resolves.toMatchObject({
      stdout: '{"done":true}',
      exitCode: 0,
      cancelled: false,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('counts managed stdout as UTF-8 bytes and kills on overflow', async () => {
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);

    const resultPromise = run({ maxBuffer: 3 });
    await nextTurn();
    child.stdout.write('éé');
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 0);

    const result = await resultPromise;
    expect(result.exitCode).toBeNull();
    expect(result.spawnMessage).toContain('3-byte stdout output limit');

    child.emit('exit', 0);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('caps stderr independently from stdout', async () => {
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);

    const resultPromise = run({ maxBuffer: 4 });
    await nextTurn();
    child.stdout.write('1234');
    child.stderr.write('12345');
    child.emit('exit', 0);

    const result = await resultPromise;
    expect(result.stdout).toBe('1234');
    expect(result.spawnMessage).toContain('stderr output limit');
  });

  it('waits for confirmed exit when cancellation races the timeout', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);
    const controller = new AbortController();

    const resultPromise = run({ timeoutMs: 50, signal: controller.signal });
    await nextTurn();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    child.emit('exit', 0);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: true,
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('marks a managed process timeout and ignores a later exit', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);

    const resultPromise = run({ timeoutMs: 50 });
    await nextTurn();
    await vi.advanceTimersByTimeAsync(50);
    child.emit('exit', 0);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      cancelled: false,
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('escalates an ignored graceful stop to SIGKILL before settling', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);
    const controller = new AbortController();

    const resultPromise = run({ signal: controller.signal });
    await nextTurn();
    controller.abort();
    child.emit('error', 'FatalError', 'index.js:1', 'report');
    await vi.advanceTimersByTimeAsync(500);

    expect(process.kill).toHaveBeenCalledWith(child.pid, 'SIGKILL');
    child.emit('exit', 0);
    await expect(resultPromise).resolves.toMatchObject({ cancelled: true, exitCode: null });
  });

  it('names bundled Node.js when its fork throws synchronously', async () => {
    utilityForkMock.mockImplementation(() => {
      throw new Error('app is not ready');
    });

    await expect(run()).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: false,
      spawnMessage: expect.stringMatching(/bundled Node\.js.*app is not ready/),
    });
  });

  it('handles a bundled Node.js fatal error without double settlement on exit', async () => {
    const child = new FakeUtilityProcess();
    utilityForkMock.mockReturnValue(child);

    const resultPromise = run();
    await nextTurn();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    child.emit('error', 'FatalError', 'index.js:1', 'report');
    await nextTurn();
    expect(settled).toBe(false);
    child.emit('exit', 1);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      spawnMessage: expect.stringMatching(/bundled Node\.js.*FatalError at index\.js:1/),
    });
  });

  it('rejects an unsupported entrypoint extension before spawning', async () => {
    await expect(run({ manifest: makeManifest({ entrypoint: 'index.ts' }) })).rejects.toThrow(
      /must use a "\.js" entrypoint/,
    );
    expect(utilityForkMock).not.toHaveBeenCalled();
  });

  it('rejects obsolete runtime selectors before spawning', async () => {
    const manifest = { ...makeManifest(), runtime: 'bun' } as never;
    await expect(run({ manifest })).rejects.toThrow(/"runtime" is no longer supported/);
    expect(utilityForkMock).not.toHaveBeenCalled();
  });

  it('requires every explicit environment value to be a string', async () => {
    await expect(
      run({ env: { PATH: undefined } as unknown as Record<string, string> }),
    ).rejects.toThrow(/env value for "PATH" must be a string/);
  });
});
