// @vitest-environment happy-dom
/**
 * The wake-hold IPC boundary. `socket:wake-hold-changed` arrives as `unknown`, and its payload is
 * what decides whether a chat renders "working in the background" instead of its end-of-run rows —
 * so a malformed frame must leave the previous state standing rather than raise or clear a wait.
 *
 * Plus the boot rehydrate: hold state lives only in memory on this side, so a window that reloads
 * mid-wait re-seeds it from main's live registry or renders a still-pumping chat as finished.
 */
import { act, renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heldChatIdsAtom, heldSubChatsAtom, wakeHeldAtomFamily } from './active-transport-registry';
import {
  deferUntilWaitOver,
  isWakeHoldPayload,
  isWakeHoldState,
  useWakeHoldSync,
} from './use-wake-hold-sync';

const queryWakeHolds = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());
vi.mock('../trpc', () => ({
  trpcClient: { socket: { listWakeHolds: { query: queryWakeHolds } } },
}));
vi.mock('@sentry/electron/renderer', () => ({ captureException }));

afterEach(() => {
  vi.useRealTimers();
});

describe('isWakeHoldState', () => {
  it('accepts a non-empty list of labels', () => {
    expect(isWakeHoldState({ waitingOn: ['Monitor'] })).toBe(true);
    expect(isWakeHoldState({ waitingOn: ['Monitor', 'Command'] })).toBe(true);
  });

  // A hold is only ever armed with at least one pending item, so an empty list means the payload is
  // malformed — not that the agent is idly waiting on nothing.
  it('rejects an empty list', () => {
    expect(isWakeHoldState({ waitingOn: [] })).toBe(false);
  });

  it('rejects a list carrying anything but strings, which the row would render as undefined', () => {
    expect(isWakeHoldState({ waitingOn: ['Monitor', 2] })).toBe(false);
    expect(isWakeHoldState({ waitingOn: [null] })).toBe(false);
  });

  it('rejects a missing or wrongly-typed waitingOn', () => {
    expect(isWakeHoldState({})).toBe(false);
    expect(isWakeHoldState({ waitingOn: 'Monitor' })).toBe(false);
    expect(isWakeHoldState(null)).toBe(false);
    expect(isWakeHoldState(undefined)).toBe(false);
  });
});

describe('isWakeHoldPayload', () => {
  it('accepts a retraction, which travels with no detail', () => {
    expect(isWakeHoldPayload({ subChatId: 'sc1', chatId: 'c1', held: false })).toBe(true);
  });

  it('accepts a hold that names what it is waiting on', () => {
    expect(
      isWakeHoldPayload({
        subChatId: 'sc1',
        chatId: 'c1',
        held: true,
        pending: { waitingOn: ['Monitor'] },
      }),
    ).toBe(true);
  });

  // Rejecting rather than defaulting: a held:true whose detail is unusable would otherwise render a
  // wait the row cannot describe, and there is no honest label to invent for it.
  it('rejects a hold with missing or malformed detail', () => {
    expect(isWakeHoldPayload({ subChatId: 'sc1', chatId: 'c1', held: true })).toBe(false);
    expect(
      isWakeHoldPayload({ subChatId: 'sc1', chatId: 'c1', held: true, pending: { waitingOn: [] } }),
    ).toBe(false);
    expect(isWakeHoldPayload({ subChatId: 'sc1', chatId: 'c1', held: true, pending: null })).toBe(
      false,
    );
  });

  it('rejects a frame with no usable sub-chat id, chat id or held flag', () => {
    expect(isWakeHoldPayload({ chatId: 'c1', held: false })).toBe(false);
    expect(isWakeHoldPayload({ subChatId: 'sc1' })).toBe(false);
    expect(isWakeHoldPayload({ subChatId: 42, chatId: 'c1', held: false })).toBe(false);
    expect(isWakeHoldPayload({ subChatId: 'sc1', chatId: 'c1', held: 'yes' })).toBe(false);
  });

  it('rejects a non-object frame', () => {
    expect(isWakeHoldPayload(null)).toBe(false);
    expect(isWakeHoldPayload(undefined)).toBe(false);
    expect(isWakeHoldPayload('held')).toBe(false);
  });
});

describe('useWakeHoldSync — boot rehydrate', () => {
  let emit: (data: unknown) => void = () => {};

  beforeEach(() => {
    queryWakeHolds.mockReset();
    captureException.mockReset();
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
  });

  it('seeds the waits main is still pumping, which a reload would otherwise render as finished', async () => {
    queryWakeHolds.mockResolvedValue([
      { subChatId: 'sc1', chatId: 'c1', pending: { waitingOn: ['Monitor'] } },
    ]);

    renderHook(() => useWakeHoldSync());
    await act(async () => {});

    expect(getDefaultStore().get(wakeHeldAtomFamily('sc1'))).toEqual({ waitingOn: ['Monitor'] });
  });

  // The snapshot is taken before the frame, so seeding over it would re-raise the wait the user
  // just ended — and nothing would ever retract it again.
  it('lets a retraction landing mid-fetch win over the boot snapshot', async () => {
    let resolveQuery: (holds: unknown) => void = () => {};
    queryWakeHolds.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );

    renderHook(() => useWakeHoldSync());
    act(() => emit({ subChatId: 'sc2', chatId: 'c1', held: false }));
    await act(async () => {
      resolveQuery([{ subChatId: 'sc2', chatId: 'c1', pending: { waitingOn: ['Command'] } }]);
    });

    expect(getDefaultStore().get(wakeHeldAtomFamily('sc2'))).toBeNull();
  });

  it('reports a failed seed instead of leaving a held chat quietly without a Stop', async () => {
    queryWakeHolds.mockRejectedValue(new Error('ipc unavailable'));

    renderHook(() => useWakeHoldSync());
    await act(async () => {});

    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: 'wake-hold-rehydrate' },
    });
  });

  it('retries the hold snapshot exactly once after a transient failure', async () => {
    vi.useFakeTimers();
    queryWakeHolds
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValueOnce([
        { subChatId: 'sc-retry', chatId: 'c1', pending: { waitingOn: ['Monitor'] } },
      ]);
    const hook = renderHook(() => useWakeHoldSync());
    await act(async () => {});

    expect(queryWakeHolds).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(queryWakeHolds).toHaveBeenCalledTimes(2);
    expect(getDefaultStore().get(wakeHeldAtomFamily('sc-retry'))).toEqual({
      waitingOn: ['Monitor'],
    });
    hook.unmount();
  });

  it('gives up silently after the single retry also fails', async () => {
    vi.useFakeTimers();
    queryWakeHolds.mockRejectedValue(new Error('ipc still unavailable'));
    const hook = renderHook(() => useWakeHoldSync());
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(queryWakeHolds).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(queryWakeHolds).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});

describe('useWakeHoldSync — boot rehydrate edge cases', () => {
  let emit: (data: unknown) => void = () => {};
  const deferredQuery = () => {
    let resolveQuery: (holds: unknown) => void = () => {};
    queryWakeHolds.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    return (holds: unknown) => act(async () => resolveQuery(holds));
  };

  beforeEach(() => {
    queryWakeHolds.mockReset();
    captureException.mockReset();
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
  });

  // A frame speaks for ITS chat only. A guard that latched globally would leave every other held
  // chat unseeded on the strength of one unrelated retraction.
  it('still seeds the chats no frame spoke for', async () => {
    const resolveWith = deferredQuery();
    renderHook(() => useWakeHoldSync());

    act(() => emit({ subChatId: 'sc3', chatId: 'c1', held: false }));
    await resolveWith([
      { subChatId: 'sc3', chatId: 'c1', pending: { waitingOn: ['Command'] } },
      { subChatId: 'sc4', chatId: 'c1', pending: { waitingOn: ['Agent'] } },
    ]);

    const store = getDefaultStore();
    expect(store.get(wakeHeldAtomFamily('sc3'))).toBeNull();
    expect(store.get(wakeHeldAtomFamily('sc4'))).toEqual({ waitingOn: ['Agent'] });
  });

  // A discarded frame never spoke, so it must not out-rank the snapshot — else garbage on the wire
  // leaves a live wait unseeded and stopless.
  it('does not let a malformed frame suppress that chat’s seed', async () => {
    const resolveWith = deferredQuery();
    renderHook(() => useWakeHoldSync());

    act(() => emit({ subChatId: 'sc5', chatId: 'c1', held: true })); // held with no detail — rejected
    await resolveWith([{ subChatId: 'sc5', chatId: 'c1', pending: { waitingOn: ['Monitor'] } }]);

    expect(getDefaultStore().get(wakeHeldAtomFamily('sc5'))).toEqual({ waitingOn: ['Monitor'] });
  });

  it('asks nothing when there is no desktop bridge to ask', async () => {
    // No main process to hold anything: querying would only reject on every boot of the web surface.
    (window as unknown as { desktopApi: unknown }).desktopApi = undefined;

    renderHook(() => useWakeHoldSync());
    await act(async () => {});

    expect(queryWakeHolds).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('useWakeHoldSync — a snapshot outliving its own effect', () => {
  let emit: (data: unknown) => void = () => {};

  beforeEach(() => {
    queryWakeHolds.mockReset();
    captureException.mockReset();
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
  });

  // Each mount closes over its own `spokenFor`, so a snapshot answered after ITS effect was torn
  // down knows nothing of what the LIVE listener has since seen. Left ungated it re-raises a wait
  // that was retracted in between, and nothing retracts it twice.
  it('ignores a snapshot answered after its own effect was torn down', async () => {
    let resolveFirst: (holds: unknown) => void = () => {};
    queryWakeHolds.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    queryWakeHolds.mockResolvedValueOnce([]);

    const first = renderHook(() => useWakeHoldSync());
    first.unmount();
    renderHook(() => useWakeHoldSync());

    act(() => emit({ subChatId: 'sc6', chatId: 'c1', held: false }));
    await act(async () => {
      resolveFirst([{ subChatId: 'sc6', chatId: 'c1', pending: { waitingOn: ['Command'] } }]);
    });

    expect(getDefaultStore().get(wakeHeldAtomFamily('sc6'))).toBeNull();
  });

  it('does not report a seed query that failed after its effect was torn down', async () => {
    let rejectFirst: (error: unknown) => void = () => {};
    queryWakeHolds.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );

    const first = renderHook(() => useWakeHoldSync());
    first.unmount();
    await act(async () => {
      rejectFirst(new Error('torn down mid-flight'));
    });

    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('useWakeHoldSync — the chat-level held map', () => {
  let emit: (data: unknown) => void = () => {};
  const store = getDefaultStore();
  const monitor = { waitingOn: ['Monitor'] };

  beforeEach(() => {
    queryWakeHolds.mockReset();
    queryWakeHolds.mockResolvedValue([]);
    store.set(heldSubChatsAtom, new Map());
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
  });

  it('tracks a hold and its retraction in the same step as the sub-chat atom', () => {
    renderHook(() => useWakeHoldSync());

    act(() => emit({ subChatId: 'm1', chatId: 'chat-m', held: true, pending: monitor }));
    expect(store.get(heldSubChatsAtom).get('m1')).toBe('chat-m');
    expect(store.get(wakeHeldAtomFamily('m1'))).toEqual(monitor);

    act(() => emit({ subChatId: 'm1', chatId: 'chat-m', held: false }));
    expect(store.get(heldSubChatsAtom).has('m1')).toBe(false);
    expect(store.get(wakeHeldAtomFamily('m1'))).toBeNull();
  });

  it('ignores a frame with no chat id', () => {
    renderHook(() => useWakeHoldSync());

    act(() => emit({ subChatId: 'm2', held: true, pending: monitor }));
    expect(store.get(heldSubChatsAtom).has('m2')).toBe(false);
    expect(store.get(wakeHeldAtomFamily('m2'))).toBeNull();
  });

  it('seeds the map on boot, letting a frame that lands mid-fetch win', async () => {
    let resolveQuery: (holds: unknown) => void = () => {};
    queryWakeHolds.mockReturnValue(new Promise((resolve) => (resolveQuery = resolve)));
    renderHook(() => useWakeHoldSync());

    act(() => emit({ subChatId: 'm3', chatId: 'chat-m3', held: false }));
    await act(async () =>
      resolveQuery([
        { subChatId: 'm3', chatId: 'chat-m3', pending: monitor },
        { subChatId: 'm4', chatId: 'chat-m4', pending: monitor },
      ]),
    );

    expect([...store.get(heldSubChatsAtom)]).toEqual([['m4', 'chat-m4']]);
  });

  // Every wake burst re-publishes its hold; a fresh map each time would re-render the sidebar.
  it('keeps the same map when a burst re-publishes a hold it already has', () => {
    renderHook(() => useWakeHoldSync());
    act(() => emit({ subChatId: 'm5', chatId: 'chat-m5', held: true, pending: monitor }));
    const before = store.get(heldSubChatsAtom);

    act(() =>
      emit({ subChatId: 'm5', chatId: 'chat-m5', held: true, pending: { waitingOn: ['Command'] } }),
    );
    expect(store.get(heldSubChatsAtom)).toBe(before);
  });

  it('keeps a chat held while any of its sub-chats still is', () => {
    renderHook(() => useWakeHoldSync());
    act(() => emit({ subChatId: 'm6', chatId: 'chat-two', held: true, pending: monitor }));
    act(() => emit({ subChatId: 'm7', chatId: 'chat-two', held: true, pending: monitor }));

    act(() => emit({ subChatId: 'm6', chatId: 'chat-two', held: false }));
    expect(store.get(heldChatIdsAtom).has('chat-two')).toBe(true);
    act(() => emit({ subChatId: 'm7', chatId: 'chat-two', held: false }));
    expect(store.get(heldChatIdsAtom).has('chat-two')).toBe(false);
  });
});

// A held chat's finish chime waits for the wait to end on its own. Every other retraction (Stop, a
// follow-up adopting the hold) means the work did not finish, so the chime is dropped unplayed.
describe('deferUntilWaitOver', () => {
  let emit: (data: unknown) => void = () => {};
  const HELD = { held: true, pending: { waitingOn: ['Monitor'] } };

  beforeEach(() => {
    queryWakeHolds.mockReset().mockResolvedValue([]);
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      on: (_channel: string, callback: (data: unknown) => void) => {
        emit = callback;
        return () => {};
      },
    };
    renderHook(() => useWakeHoldSync());
  });

  it('fires exactly once when the wait ends on its own', () => {
    const fire = vi.fn();
    deferUntilWaitOver('dw1', fire);
    act(() => emit({ chatId: 'c1', subChatId: 'dw1', held: false, endReason: 'wait-over' }));
    act(() => emit({ chatId: 'c1', subChatId: 'dw1', held: false, endReason: 'wait-over' }));
    expect(fire).toHaveBeenCalledOnce();
  });

  it('drops the callback unfired on a retraction with no reason', () => {
    const fire = vi.fn();
    deferUntilWaitOver('dw2', fire);
    act(() => emit({ chatId: 'c1', subChatId: 'dw2', held: false }));
    act(() => emit({ chatId: 'c1', subChatId: 'dw2', held: false, endReason: 'wait-over' }));
    expect(fire).not.toHaveBeenCalled();
  });

  it('keeps the callback pending across a held:true re-publish', () => {
    const fire = vi.fn();
    deferUntilWaitOver('dw3', fire);
    act(() => emit({ chatId: 'c1', subChatId: 'dw3', ...HELD }));
    expect(fire).not.toHaveBeenCalled();
    act(() => emit({ chatId: 'c1', subChatId: 'dw3', held: false, endReason: 'wait-over' }));
    expect(fire).toHaveBeenCalledOnce();
  });

  it('keeps the first callback for a sub-chat, so a later non-adopting turn cannot replace it', () => {
    const first = vi.fn();
    const second = vi.fn();
    deferUntilWaitOver('dw4', first);
    deferUntilWaitOver('dw4', second);
    act(() => emit({ chatId: 'c1', subChatId: 'dw4', held: false, endReason: 'wait-over' }));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
});
