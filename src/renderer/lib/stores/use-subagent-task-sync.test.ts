// @vitest-environment happy-dom
/**
 * The subagent-task IPC boundary. `socket:subagent-task-changed` arrives as `unknown`, and a
 * malformed frame must leave the running set untouched — a garbage key written here would either
 * animate a card forever or never retire one.
 *
 * Plus the boot rehydrate: liveness lives only in memory on this side, so a window that reloads
 * mid-task re-seeds it from main's tracker or reads a running subagent as completed.
 */
import { act, renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runningSubagentToolIdsAtom } from './active-transport-registry';
import { isSubagentTaskPayload, useSubagentTaskSync } from './use-subagent-task-sync';

const queryRunningTasks = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());
vi.mock('../trpc', () => ({
  trpcClient: { socket: { listRunningSubagentTasks: { query: queryRunningTasks } } },
}));
vi.mock('@sentry/electron/renderer', () => ({ captureException }));

afterEach(() => {
  vi.useRealTimers();
});

describe('isSubagentTaskPayload', () => {
  it('accepts a well-formed start and retraction', () => {
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 'tu1', running: true })).toBe(
      true,
    );
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 'tu1', running: false })).toBe(
      true,
    );
  });

  it('rejects a missing or empty toolCallId — there is no card it could address', () => {
    expect(isSubagentTaskPayload({ subChatId: 'sc1', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: '', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 7, running: true })).toBe(false);
  });

  it('rejects a missing or wrongly-typed subChatId or running flag', () => {
    expect(isSubagentTaskPayload({ toolCallId: 'tu1', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 1, toolCallId: 'tu1', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 'tu1', running: 'yes' })).toBe(
      false,
    );
  });

  it('rejects a non-object frame', () => {
    expect(isSubagentTaskPayload(null)).toBe(false);
    expect(isSubagentTaskPayload(undefined)).toBe(false);
    expect(isSubagentTaskPayload('running')).toBe(false);
  });
});

describe('useSubagentTaskSync — boot rehydrate', () => {
  let emit: (data: unknown) => void = () => {};
  const running = () => getDefaultStore().get(runningSubagentToolIdsAtom);

  beforeEach(() => {
    queryRunningTasks.mockReset();
    captureException.mockReset();
    getDefaultStore().set(runningSubagentToolIdsAtom, new Set<string>());
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
  });

  it('seeds the subagents main still runs, which a reload would otherwise read as completed', async () => {
    queryRunningTasks.mockResolvedValue([{ subChatId: 'sc1', toolCallId: 'tu1', running: true }]);

    renderHook(() => useSubagentTaskSync());
    await act(async () => {});

    expect(running().has('tu1')).toBe(true);
  });

  // The snapshot predates the frame, so seeding over it would spin a card no frame ever retracts.
  it('lets a retraction landing mid-fetch win over the boot snapshot', async () => {
    let resolveQuery: (tasks: unknown) => void = () => {};
    queryRunningTasks.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );

    renderHook(() => useSubagentTaskSync());
    act(() => emit({ subChatId: 'sc1', toolCallId: 'tu2', running: false }));
    await act(async () => {
      resolveQuery([{ subChatId: 'sc1', toolCallId: 'tu2', running: true }]);
    });

    expect(running().has('tu2')).toBe(false);
  });

  it('ignores a malformed snapshot entry', async () => {
    queryRunningTasks.mockResolvedValue([
      { subChatId: 'sc1', toolCallId: '', running: true },
      null,
    ]);

    renderHook(() => useSubagentTaskSync());
    await act(async () => {});

    expect(running().size).toBe(0);
  });

  it('voids a snapshot answered after its effect was torn down', async () => {
    let resolveQuery: (tasks: unknown) => void = () => {};
    queryRunningTasks.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );

    const hook = renderHook(() => useSubagentTaskSync());
    hook.unmount();
    await act(async () => {
      resolveQuery([{ subChatId: 'sc1', toolCallId: 'tu3', running: true }]);
    });

    expect(running().has('tu3')).toBe(false);
  });

  it('reports once and retries exactly once after a transient failure', async () => {
    vi.useFakeTimers();
    queryRunningTasks
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValueOnce([{ subChatId: 'sc1', toolCallId: 'tu4', running: true }]);
    const hook = renderHook(() => useSubagentTaskSync());
    await act(async () => {});

    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: 'subagent-task-rehydrate' },
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(queryRunningTasks).toHaveBeenCalledTimes(2);
    expect(running().has('tu4')).toBe(true);
    hook.unmount();
  });

  it('gives up silently after the single retry also fails', async () => {
    vi.useFakeTimers();
    queryRunningTasks.mockRejectedValue(new Error('ipc still unavailable'));
    const hook = renderHook(() => useSubagentTaskSync());
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(queryRunningTasks).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});

describe('useSubagentTaskSync — boot rehydrate edge cases', () => {
  let emit: (data: unknown) => void = () => {};
  const running = () => getDefaultStore().get(runningSubagentToolIdsAtom);
  const deferredQuery = () => {
    let resolveQuery: (tasks: unknown) => void = () => {};
    queryRunningTasks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    return (tasks: unknown) => resolveQuery(tasks);
  };

  beforeEach(() => {
    queryRunningTasks.mockReset();
    captureException.mockReset();
    getDefaultStore().set(runningSubagentToolIdsAtom, new Set<string>());
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
  });

  // A frame speaks for ITS card only, and the seed only ever adds: a snapshot that predates a
  // start must not drop it, and one retraction must not leave the other panes' cards unseeded.
  it('seeds every card no frame spoke for, across sub-chats, and keeps a start it predates', async () => {
    const resolveWith = deferredQuery();
    renderHook(() => useSubagentTaskSync());
    act(() => emit({ subChatId: 'sc1', toolCallId: 'tu-new', running: true }));
    act(() => emit({ subChatId: 'sc1', toolCallId: 'tu-done', running: false }));
    await act(async () => {
      resolveWith([
        { subChatId: 'sc1', toolCallId: 'tu-done', running: true },
        { subChatId: 'sc1', toolCallId: 'tu-a', running: true },
        { subChatId: 'sc2', toolCallId: 'tu-b', running: true },
      ]);
    });

    expect([...running()].sort()).toEqual(['tu-a', 'tu-b', 'tu-new']);
  });

  it('retires a seeded card when its retraction arrives afterwards', async () => {
    queryRunningTasks.mockResolvedValue([{ subChatId: 'sc1', toolCallId: 'tu1', running: true }]);
    renderHook(() => useSubagentTaskSync());
    await act(async () => {});

    act(() => emit({ subChatId: 'sc1', toolCallId: 'tu1', running: false }));

    expect(running().size).toBe(0);
  });

  // The retried snapshot is as stale as the first: what the listener heard meanwhile still wins.
  it('lets a retraction heard during the retry delay win over the retried snapshot', async () => {
    vi.useFakeTimers();
    queryRunningTasks
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValueOnce([{ subChatId: 'sc1', toolCallId: 'tu-gone', running: true }]);
    const hook = renderHook(() => useSubagentTaskSync());
    await act(async () => {});
    act(() => emit({ subChatId: 'sc1', toolCallId: 'tu-gone', running: false }));
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(queryRunningTasks).toHaveBeenCalledTimes(2);
    expect(running().has('tu-gone')).toBe(false);
    hook.unmount();
  });

  it('abandons the retry when torn down during the delay', async () => {
    vi.useFakeTimers();
    queryRunningTasks.mockRejectedValue(new Error('ipc unavailable'));
    const hook = renderHook(() => useSubagentTaskSync());
    await act(async () => {});
    hook.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(queryRunningTasks).toHaveBeenCalledTimes(1);
  });

  // StrictMode / a remount: the torn-down instance's reply is void, the live one's still seeds.
  it("seeds from the remounted instance while voiding the first one's late reply", async () => {
    const resolveFirst = deferredQuery();
    const first = renderHook(() => useSubagentTaskSync());
    first.unmount();
    queryRunningTasks.mockResolvedValueOnce([
      { subChatId: 'sc1', toolCallId: 'tu-live', running: true },
    ]);
    const second = renderHook(() => useSubagentTaskSync());
    await act(async () => {
      resolveFirst([{ subChatId: 'sc1', toolCallId: 'tu-stale', running: true }]);
    });

    expect([...running()]).toEqual(['tu-live']);
    second.unmount();
  });

  it('asks nothing when there is no desktop bridge to ask', async () => {
    // No main process to track anything: querying would only reject on every boot of the web surface.
    (window as unknown as { desktopApi: unknown }).desktopApi = undefined;

    renderHook(() => useSubagentTaskSync());
    await act(async () => {});

    expect(queryRunningTasks).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
