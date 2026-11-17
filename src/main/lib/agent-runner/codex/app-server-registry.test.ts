/**
 * app-server registry unit tests. CodexAppServerClient is mocked (no real
 * process); these assert spawn-once/reuse, concurrent in-flight sharing,
 * failed-handshake eviction, and disposal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./app-server-client', () => ({
  CodexAppServerClient: vi.fn(),
}));

import { getRuntimeTopologySnapshot } from '../../diagnostics/provider-topology';
import { ensureLoginShellEnv } from '../../platform/login-shell-env';
import { CodexAppServerClient } from './app-server-client';
import {
  codexAppServerCount,
  disposeAllCodexAppServers,
  disposeCodexAppServerSession,
  disposeCodexAppServerSessionAndWait,
  getCodexAppServer,
} from './app-server-registry';

const OPTS = { binary: '/usr/bin/codex', clientInfo: { name: 'frink', version: '0' } };

/** Spawn args carrying a sub-chat's baked-in MCP URL — the identity that must not be shared. */
const argsFor = (channel: string, toolset = 'agent:signal') => ({
  ...OPTS,
  args: ['--config', `mcp_servers.frink.url="http://127.0.0.1:1/?channel=${channel}&${toolset}"`],
});

/** Build a fake client constructor; `start` resolves unless `fail` is set. (Must be a
 * regular function — the registry calls it with `new`, which arrow fns reject.)
 * Captures close/error handlers so a test can simulate the process dying via `fireClose()` or a
 * transport failure that leaves the connection open via `fireError()`. */
function fakeClientImpl(opts: { fail?: boolean } = {}) {
  return function FakeClient() {
    const closeHandlers = new Set<() => void>();
    const errorHandlers = new Set<(e: unknown) => void>();
    return {
      start: opts.fail
        ? vi.fn().mockRejectedValue(new Error('handshake failed'))
        : vi.fn().mockResolvedValue({}),
      dispose: vi.fn(),
      disposeAndWait: vi.fn().mockResolvedValue(undefined),
      onClose: (h: () => void) => {
        closeHandlers.add(h);
        return { dispose: () => closeHandlers.delete(h) };
      },
      fireClose: () => {
        for (const h of closeHandlers) h();
      },
      onError: (h: (e: unknown) => void) => {
        errorHandlers.add(h);
        return { dispose: () => errorHandlers.delete(h) };
      },
      fireError: (e: unknown = [new Error('write EPIPE'), undefined, undefined]) => {
        for (const h of [...errorHandlers]) h(e);
      },
      errorHandlerCount: () => errorHandlers.size,
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(CodexAppServerClient).mockImplementation(fakeClientImpl() as never);
});
afterEach(() => disposeAllCodexAppServers());

describe('getCodexAppServer', () => {
  it('spawns once and reuses the same client for the same (cwd, credentialId)', async () => {
    const a = await getCodexAppServer('/repo', 'cred1', OPTS);
    const b = await getCodexAppServer('/repo', 'cred1', OPTS);
    expect(a).toBe(b);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(codexAppServerCount()).toBe(1);
    expect(getRuntimeTopologySnapshot().codexAppServerCount).toBe(1);
  });

  it('starts the client only after the login-shell PATH is ready (sc-4724)', async () => {
    await getCodexAppServer('/repo', 'cred1', OPTS);
    expect(vi.mocked(CodexAppServerClient).mock.calls[0][0]).toMatchObject({
      ...OPTS,
      beforeSpawn: ensureLoginShellEnv,
    });
  });

  it('keeps the replacement when a superseded client fails to start late', async () => {
    // Client A is still waiting for the login-shell PATH when its turn is aborted and the next
    // turn starts client B under the same key; A's late rejection must not evict B.
    let rejectA: (e: Error) => void = () => {};
    const slowStart = new Promise((_, reject) => (rejectA = reject));
    slowStart.catch(() => {});
    // SAFETY: the registry only calls start/dispose/onClose/onError, all present on this fake.
    vi.mocked(CodexAppServerClient).mockImplementationOnce(function SlowClient() {
      return { ...fakeClientImpl()(), start: vi.fn(() => slowStart) };
    } as never);
    const a = getCodexAppServer('/repo', 'cred1', OPTS, 'sub-a');
    disposeCodexAppServerSession('/repo', 'cred1', 'sub-a');
    const b = await getCodexAppServer('/repo', 'cred1', OPTS, 'sub-a');

    rejectA(new Error('disposed before it started'));
    await expect(a).rejects.toThrow('disposed before it started');

    expect(codexAppServerCount()).toBe(1);
    expect(await getCodexAppServer('/repo', 'cred1', OPTS, 'sub-a')).toBe(b);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(2);
  });

  it('never shares a server between sub-chats in one project+credential', async () => {
    // The spawn args carry a sub-chat-scoped MCP URL; sharing would resolve chat B's tool calls
    // into chat A's execution context.
    const a = await getCodexAppServer('/repo', 'cred1', argsFor('chan-a'), 'sub-a');
    const b = await getCodexAppServer('/repo', 'cred1', argsFor('chan-b'), 'sub-b');
    expect(a).not.toBe(b);
    expect(codexAppServerCount()).toBe(2);
  });

  it('respawns when a sub-chat asks for spawn args its warm server was not started with', async () => {
    // A running process cannot be re-argued, so a changed tool list / MCP URL must not be served
    // by the old one — and the superseded entry must go now, not linger to the idle TTL.
    const stale = (await getCodexAppServer(
      '/repo',
      'cred1',
      argsFor('chan-a', 'agent:nosignal'),
      'sub-a',
    )) as unknown as { dispose: ReturnType<typeof vi.fn> };
    const fresh = await getCodexAppServer('/repo', 'cred1', argsFor('chan-a'), 'sub-a');
    expect(fresh).not.toBe(stale);
    expect(stale.dispose).toHaveBeenCalled();
    expect(codexAppServerCount()).toBe(1);
    expect(vi.mocked(CodexAppServerClient).mock.calls.at(-1)?.[0]).toMatchObject(argsFor('chan-a'));
  });

  it('keeps one warm server while a sub-chat asks for the same args', async () => {
    const a = await getCodexAppServer('/repo', 'cred1', argsFor('chan-a'), 'sub-a');
    const b = await getCodexAppServer('/repo', 'cred1', argsFor('chan-a'), 'sub-a');
    expect(a).toBe(b);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
  });

  it('respawns when the effective MCP revision changes without exposing the revision to argv', async () => {
    const stale = (await getCodexAppServer(
      '/repo',
      'cred1',
      argsFor('chan-a'),
      'sub-a',
      'revision-one',
    )) as unknown as { dispose: ReturnType<typeof vi.fn> };
    const fresh = await getCodexAppServer(
      '/repo',
      'cred1',
      argsFor('chan-a'),
      'sub-a',
      'revision-two',
    );

    expect(fresh).not.toBe(stale);
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(vi.mocked(CodexAppServerClient).mock.calls.at(-1)?.[0]).toMatchObject(argsFor('chan-a'));
    expect(vi.mocked(CodexAppServerClient).mock.calls.at(-1)?.[0]?.args).not.toContain(
      'revision-two',
    );
  });

  it('shares one server across callers when no session key is given', async () => {
    // No sessionKey means the args carry no caller identity (read-only / homedir turns inject no
    // frink MCP at all), so sharing is safe and saves a process.
    const a = await getCodexAppServer('/repo', 'cred1', OPTS);
    const b = await getCodexAppServer('/repo', 'cred1', OPTS);
    expect(a).toBe(b);
    expect(codexAppServerCount()).toBe(1);
  });

  it('keeps separate servers for different keys', async () => {
    await getCodexAppServer('/repo', 'cred1', OPTS);
    await getCodexAppServer('/other', 'cred1', OPTS);
    await getCodexAppServer('/repo', 'cred2', OPTS);
    expect(codexAppServerCount()).toBe(3);
  });

  it('shares one in-flight start across concurrent callers', async () => {
    const [a, b] = await Promise.all([
      getCodexAppServer('/repo', 'cred1', OPTS),
      getCodexAppServer('/repo', 'cred1', OPTS),
    ]);
    expect(a).toBe(b);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
  });

  it('self-evicts a server that closes (crashes) on its own', async () => {
    await getCodexAppServer('/repo', 'cred1', OPTS);
    expect(codexAppServerCount()).toBe(1);
    const inst = vi.mocked(CodexAppServerClient).mock.results.at(-1)?.value as {
      fireClose: () => void;
      dispose: ReturnType<typeof vi.fn>;
    };
    inst.fireClose(); // process died — no turn/completed, must self-evict
    expect(codexAppServerCount()).toBe(0);
    expect(inst.dispose).toHaveBeenCalled();
  });

  it('does not cache a client whose handshake failed', async () => {
    vi.mocked(CodexAppServerClient).mockImplementation(fakeClientImpl({ fail: true }) as never);
    await expect(getCodexAppServer('/repo', 'cred1', OPTS)).rejects.toThrow('handshake failed');
    expect(codexAppServerCount()).toBe(0);
    // A later call can retry cleanly.
    vi.mocked(CodexAppServerClient).mockImplementation(fakeClientImpl() as never);
    await getCodexAppServer('/repo', 'cred1', OPTS);
    expect(codexAppServerCount()).toBe(1);
  });

  it('tears an idle server down after the idle TTL', async () => {
    vi.useFakeTimers();
    try {
      const client = await getCodexAppServer('/repo', 'cred1', OPTS);
      expect(codexAppServerCount()).toBe(1);
      // Advance past the 5-minute idle TTL — the timer must dispose + drop it.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      expect(codexAppServerCount()).toBe(0);
      expect(
        (client as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose,
      ).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms the idle timer on every reuse so an active server stays warm', async () => {
    vi.useFakeTimers();
    try {
      await getCodexAppServer('/repo', 'cred1', OPTS);
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000); // not yet idle
      await getCodexAppServer('/repo', 'cred1', OPTS); // touch → re-arm
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000); // would have expired at 5m without re-arm
      expect(codexAppServerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dead client closing after re-spawn does not evict the fresh entry', async () => {
    // Race: server A crashes; a new turn re-spawns server B under the same key;
    // A's (late) close handler must see the registry no longer holds A (the
    // `registry.get(key) === created` guard) and leave B alone.
    const a = (await getCodexAppServer('/repo', 'cred1', OPTS)) as unknown as {
      fireClose: () => void;
    };
    a.fireClose(); // A crashes → self-evicts
    const b = await getCodexAppServer('/repo', 'cred1', OPTS); // re-spawn B under same key
    expect(codexAppServerCount()).toBe(1);

    a.fireClose(); // A's belated close — must NOT evict B
    expect(codexAppServerCount()).toBe(1);
    expect(await getCodexAppServer('/repo', 'cred1', OPTS)).toBe(b);
  });
});

type FakeHandle = {
  dispose: ReturnType<typeof vi.fn>;
  fireClose: () => void;
  fireError: (e?: unknown) => void;
  errorHandlerCount: () => number;
};

describe('transport-error eviction (sc-966)', () => {
  it('evicts a client on a transport error that does not close, so the next turn respawns', async () => {
    // Broken stdin (EPIPE) fires onError but no close: without eviction the next turn would be
    // handed the dead client.
    const a = (await getCodexAppServer('/repo', 'cred1', OPTS)) as unknown as FakeHandle;
    a.fireError();

    expect(a.dispose).toHaveBeenCalledOnce();
    expect(codexAppServerCount()).toBe(0);
    const b = await getCodexAppServer('/repo', 'cred1', OPTS);
    expect(b).not.toBe(a);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(2);
  });

  it('a late error from a replaced client does not evict its replacement', async () => {
    const a = (await getCodexAppServer('/repo', 'cred1', OPTS)) as unknown as FakeHandle;
    a.fireClose(); // A dies and self-evicts
    const b = await getCodexAppServer('/repo', 'cred1', OPTS);

    a.fireError(); // A's belated transport error — must NOT evict B
    expect(codexAppServerCount()).toBe(1);
    expect((b as unknown as FakeHandle).dispose).not.toHaveBeenCalled();
    expect(await getCodexAppServer('/repo', 'cred1', OPTS)).toBe(b);
  });

  it('an error then the close that usually follows it tears down exactly once', async () => {
    // Real sequence on a dying child: stdin EPIPE, then stdout end. The second signal must not
    // re-dispose or evict a server spawned in between.
    const a = (await getCodexAppServer('/repo', 'cred1', OPTS)) as unknown as FakeHandle;
    a.fireError();
    const b = await getCodexAppServer('/repo', 'cred1', OPTS);
    a.fireClose();

    expect(a.dispose).toHaveBeenCalledOnce();
    expect(await getCodexAppServer('/repo', 'cred1', OPTS)).toBe(b);
  });

  it('an error on one sub-chat server leaves its siblings warm', async () => {
    const a = (await getCodexAppServer(
      '/repo',
      'cred1',
      argsFor('chan-a'),
      'sub-a',
    )) as unknown as FakeHandle;
    const sibling = await getCodexAppServer('/repo', 'cred1', argsFor('chan-b'), 'sub-b');

    a.fireError();

    expect(codexAppServerCount()).toBe(1);
    expect((sibling as unknown as FakeHandle).dispose).not.toHaveBeenCalled();
    expect(await getCodexAppServer('/repo', 'cred1', argsFor('chan-b'), 'sub-b')).toBe(sibling);
  });

  it('drops its error subscription on every teardown path', async () => {
    const idle = (await getCodexAppServer('/a', 'c', OPTS)) as unknown as FakeHandle;
    const session = (await getCodexAppServer(
      '/b',
      'c',
      argsFor('chan-a'),
      'sub-a',
    )) as unknown as FakeHandle;
    expect(idle.errorHandlerCount()).toBe(1);

    disposeCodexAppServerSession('/b', 'c', 'sub-a');
    disposeAllCodexAppServers();

    expect(idle.errorHandlerCount()).toBe(0);
    expect(session.errorHandlerCount()).toBe(0);
  });

  it('clears the idle timer on error eviction so the TTL never re-disposes', async () => {
    vi.useFakeTimers();
    try {
      const a = (await getCodexAppServer('/repo', 'cred1', OPTS)) as unknown as FakeHandle;
      a.fireError();
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(a.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('disposal', () => {
  it('disposes one sub-chat on abort without touching its siblings', async () => {
    // An aborted turn's in-flight MCP call carries no turn identity, so it would resolve onto the
    // NEXT turn's execution context. Ending only this sub-chat's process makes that impossible
    // while leaving other chats' warm servers alone.
    const aborted = (await getCodexAppServer(
      '/repo',
      'cred1',
      argsFor('chan-a'),
      'sub-a',
    )) as unknown as { dispose: ReturnType<typeof vi.fn> };
    const sibling = await getCodexAppServer('/repo', 'cred1', argsFor('chan-b'), 'sub-b');

    disposeCodexAppServerSession('/repo', 'cred1', 'sub-a');

    expect(aborted.dispose).toHaveBeenCalled();
    expect(codexAppServerCount()).toBe(1);
    expect(await getCodexAppServer('/repo', 'cred1', argsFor('chan-b'), 'sub-b')).toBe(sibling);
  });

  it('exposes the exact child-close settlement while detaching synchronously', async () => {
    const client = (await getCodexAppServer(
      '/repo',
      'cred1',
      argsFor('chan-a'),
      'sub-a',
    )) as unknown as { disposeAndWait: ReturnType<typeof vi.fn> };
    let closeChild = () => {};
    const childClosed = new Promise<void>((resolve) => {
      closeChild = resolve;
    });
    client.disposeAndWait.mockReturnValueOnce(childClosed);

    const settlement = disposeCodexAppServerSessionAndWait('/repo', 'cred1', 'sub-a');
    expect(client.disposeAndWait).toHaveBeenCalledOnce();
    expect(codexAppServerCount()).toBe(0);

    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    closeChild();
    await settlement;
    expect(settled).toBe(true);
  });

  it('disposes every server on shutdown', async () => {
    await getCodexAppServer('/a', 'c', OPTS);
    await getCodexAppServer('/b', 'c', OPTS);
    expect(codexAppServerCount()).toBe(2);
    disposeAllCodexAppServers();
    expect(codexAppServerCount()).toBe(0);
  });
});
