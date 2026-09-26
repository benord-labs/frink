/**
 * Tests for TerminalManager.cleanup() shutdown behavior.
 *
 * Edge cases covered:
 * - EC#1 (MEDIUM): All TSF disposables (onData, onExit, initCommand) disposed before pty.kill()
 * - EC#5 (LOW-MEDIUM): session created after cleanup iteration starts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./port-manager', () => ({
  portManager: {
    registerSession: vi.fn(),
    unregisterSession: vi.fn(),
  },
}));

vi.mock('./env', () => ({
  SHELL_CRASH_THRESHOLD_MS: 5000,
}));

vi.mock('./session', () => ({
  createSession: vi.fn(),
  setupInitialCommands: vi.fn(),
}));

// Helpers
function makeMockSession(
  paneId: string,
  overrides: Partial<{
    isAlive: boolean;
  }> = {},
) {
  const callOrder: string[] = [];
  return {
    session: {
      pty: {
        kill: vi.fn(() => {
          callOrder.push('kill');
        }),
        onData: vi.fn(),
        onExit: vi.fn(),
      },
      batcher: {
        dispose: vi.fn(() => {
          callOrder.push('batcher:dispose');
        }),
      },
      dataDisposable: {
        dispose: vi.fn(() => {
          callOrder.push('dispose:onData');
        }),
      },
      exitDisposable: {
        dispose: vi.fn(() => {
          callOrder.push('dispose:onExit');
        }),
      },
      paneId,
      workspaceId: 'ws-1',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      lastActive: Date.now(),
      isAlive: overrides.isAlive ?? true,
      shell: '/bin/zsh',
      startTime: Date.now(),
      usedFallback: false,
    },
    callOrder,
  };
}

describe('TerminalManager.cleanup()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disposes dataDisposable BEFORE calling pty.kill()', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session, callOrder } = makeMockSession('pane-1');
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', session);

    await manager.cleanup();

    // dataDisposable.dispose() must come before kill()
    const disposeIdx = callOrder.indexOf('dispose:onData');
    const killIdx = callOrder.indexOf('kill');
    expect(disposeIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeLessThan(killIdx);
  });

  it('handles sessions without exitDisposable (backward compat)', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session } = makeMockSession('pane-1');
    (session as { exitDisposable?: unknown }).exitDisposable = undefined;
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', session);

    await manager.cleanup();

    // Should not throw — exitDisposable?.dispose() is safe with undefined
    expect(session.pty.kill).toHaveBeenCalledTimes(1);
    expect(session.dataDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up multiple sessions', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const s1 = makeMockSession('pane-1');
    const s2 = makeMockSession('pane-2');
    const s3 = makeMockSession('pane-3');

    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', s1.session);
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-2', s2.session);
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-3', s3.session);

    await manager.cleanup();

    expect(s1.session.pty.kill).toHaveBeenCalled();
    expect(s2.session.pty.kill).toHaveBeenCalled();
    expect(s3.session.pty.kill).toHaveBeenCalled();

    // Sessions map should be empty
    // @ts-expect-error — accessing private for test
    expect(manager.sessions.size).toBe(0);
  });

  it('disposes batcher during cleanup', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session } = makeMockSession('pane-1');
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', session);

    await manager.cleanup();

    expect(session.batcher.dispose).toHaveBeenCalledTimes(1);
  });

  it('skips dead sessions during cleanup', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session } = makeMockSession('pane-dead', { isAlive: false });
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-dead', session);

    await manager.cleanup();

    // Dead session should not have kill called
    expect(session.pty.kill).not.toHaveBeenCalled();
    expect(session.dataDisposable.dispose).not.toHaveBeenCalled();
  });

  /**
   * EC#1 (MEDIUM): exitDisposable is stored on the session and disposed
   * before pty.kill() in cleanup(), preventing stale TSF callbacks.
   */
  it('[EC#1] exitDisposable from setupExitHandler IS disposed during cleanup', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session, callOrder } = makeMockSession('pane-1');

    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', session);

    await manager.cleanup();

    // exitDisposable.dispose() must be called before kill()
    expect(session.exitDisposable.dispose).toHaveBeenCalledTimes(1);
    const disposeExitIdx = callOrder.indexOf('dispose:onExit');
    const killIdx = callOrder.indexOf('kill');
    expect(disposeExitIdx).toBeGreaterThanOrEqual(0);
    expect(disposeExitIdx).toBeLessThan(killIdx);
  });

  it('disposes initCommandDisposable when present', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session, callOrder } = makeMockSession('pane-1');
    const initDisposable = {
      dispose: vi.fn(() => callOrder.push('dispose:initCommand')),
    };
    // @ts-expect-error — adding optional field
    session.initCommandDisposable = initDisposable;

    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', session);

    await manager.cleanup();

    expect(initDisposable.dispose).toHaveBeenCalledTimes(1);
    const disposeIdx = callOrder.indexOf('dispose:initCommand');
    const killIdx = callOrder.indexOf('kill');
    expect(disposeIdx).toBeLessThan(killIdx);
  });

  /**
   * EC#5 (LOW-MEDIUM): A session created after cleanup's for-loop starts
   * but before sessions.clear() would survive with live TSF handles.
   * The 5s force-exit timer and app.exit(0) are the safety nets.
   *
   * This test verifies cleanup() clears sessions even if a new one was added
   * during iteration (Map behavior — new entries during iteration ARE visited
   * in insertion order per spec, but the session wouldn't have been killed).
   */
  it('[EC#5] session added during cleanup iteration is cleared but not killed', async () => {
    const { TerminalManager } = await import('./manager');
    const manager = new TerminalManager();

    const { session: s1 } = makeMockSession('pane-1');
    // @ts-expect-error — accessing private for test
    manager.sessions.set('pane-1', s1);

    // Intercept the kill to add a new session mid-cleanup
    const { session: s2 } = makeMockSession('pane-late');
    s1.pty.kill.mockImplementation(() => {
      // Simulate: renderer creates a new session while cleanup is running
      // @ts-expect-error — accessing private for test
      manager.sessions.set('pane-late', s2);
    });

    await manager.cleanup();

    // sessions.clear() wipes everything — including the late session
    // @ts-expect-error — accessing private for test
    expect(manager.sessions.size).toBe(0);
  });
});
