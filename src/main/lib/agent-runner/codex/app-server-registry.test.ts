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
import { CodexAppServerClient } from './app-server-client';
import {
  codexAppServerCount,
  disposeAllCodexAppServers,
  disposeCodexAppServer,
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
 * Captures close handlers so a test can simulate the process dying via `fireClose()`. */
function fakeClientImpl(opts: { fail?: boolean } = {}) {
  return function FakeClient() {
    const closeHandlers = new Set<() => void>();
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
    disposeCodexAppServer('/repo', 'cred1'); // drop A
    const b = await getCodexAppServer('/repo', 'cred1', OPTS); // re-spawn B under same key
    expect(codexAppServerCount()).toBe(1);

    a.fireClose(); // A's belated close — must NOT evict B
    expect(codexAppServerCount()).toBe(1);
    expect(await getCodexAppServer('/repo', 'cred1', OPTS)).toBe(b);
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

  it('disposes and drops a single server', async () => {
    const client = await getCodexAppServer('/repo', 'cred1', OPTS);
    disposeCodexAppServer('/repo', 'cred1');
    expect((client as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect(codexAppServerCount()).toBe(0);
  });

  it('disposes every server on shutdown', async () => {
    await getCodexAppServer('/a', 'c', OPTS);
    await getCodexAppServer('/b', 'c', OPTS);
    expect(codexAppServerCount()).toBe(2);
    disposeAllCodexAppServers();
    expect(codexAppServerCount()).toBe(0);
  });
});
