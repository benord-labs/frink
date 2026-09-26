// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMode } from '../../../../../../shared/types/chat-mode';

// ── Hoisted mocks ──

const {
  setChatModeMock,
  mutateMock,
  invalidateMock,
  cancelPendingPlanApprovalsMock,
  invalidatePendingPlanApprovalsMock,
  updateSubChatModeMock,
  appStoreSetMock,
  onErrorCapture,
  onSuccessCapture,
} = vi.hoisted(() => {
  const onErrorCapture: { current: null | ((error: unknown, variables: unknown) => void) } = {
    current: null,
  };
  const onSuccessCapture: { current: null | ((data: unknown, variables: unknown) => void) } = {
    current: null,
  };
  return {
    setChatModeMock: vi.fn(),
    mutateMock: vi.fn(),
    invalidateMock: vi.fn(),
    cancelPendingPlanApprovalsMock: vi.fn(async () => undefined),
    invalidatePendingPlanApprovalsMock: vi.fn(async () => undefined),
    updateSubChatModeMock: vi.fn((id: string, mode: ChatMode) => {
      const row = subChatsState.find((sc) => sc.id === id);
      if (row) row.mode = mode;
    }),
    appStoreSetMock: vi.fn(),
    onErrorCapture,
    onSuccessCapture,
  };
});

let currentChatMode: ChatMode = 'agent';

/** Mutable sub-chat row for init effect + revert guard */
const subChatsState: Array<{ id: string; mode: ChatMode }> = [{ id: 'sub-1', mode: 'agent' }];

/** The init effect seeds the shared atom only from the ACTIVE tab. */
const activeState = { activeSubChatId: 'sub-1' as string | null };

vi.mock('jotai', () => ({
  useAtom: vi.fn(() => [
    currentChatMode,
    (value: ChatMode) => {
      currentChatMode = value;
      setChatModeMock(value);
    },
  ]),
}));

vi.mock('../../../../../lib/mock-api', () => ({
  api: {
    useUtils: () => ({
      agents: {
        getAgentChat: { invalidate: invalidateMock },
        getPendingPlanApprovals: {
          cancel: cancelPendingPlanApprovalsMock,
          invalidate: invalidatePendingPlanApprovalsMock,
        },
      },
    }),
    agents: {
      updateSubChatMode: {
        useMutation: (config: {
          onSuccess?: (data: unknown, variables: unknown) => void;
          onError?: (error: unknown, variables: unknown) => void;
        }) => {
          onErrorCapture.current = config.onError ?? null;
          onSuccessCapture.current = config.onSuccess ?? null;
          return { mutate: mutateMock };
        },
      },
    },
  },
}));

vi.mock('../../../atoms', () => ({
  chatModeAtomFamily: vi.fn((id: string) => Symbol(`chatMode-${id}`)),
}));

vi.mock('../../../../../lib/jotai-store', () => ({
  appStore: { set: appStoreSetMock, get: vi.fn() },
}));

const ackModeIntentMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../lib/stores/mode-intent', () => ({
  pendingModeIntentAtomFamily: vi.fn((id: string) => Symbol(`pendingModeIntent:${id}`)),
  ackModeIntent: ackModeIntentMock,
}));

vi.mock('../../../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({
      get subChatsById() {
        return Object.fromEntries(subChatsState.map((sc) => [sc.id, sc]));
      },
      get activeSubChatId() {
        return activeState.activeSubChatId;
      },
      updateSubChatMode: updateSubChatModeMock,
    }),
  },
}));

// ── Import under test (after mocks) ──

import { useChatMode } from './usePlanMode';

function invokeOnError(err: Error, variables: { subChatId: string; mode: ChatMode }) {
  const fn = onErrorCapture.current;
  if (fn == null) throw new Error('onError not set');
  void fn(err, variables);
}

function invokeOnSuccess(data: unknown, variables: { subChatId: string; mode: ChatMode }) {
  const fn = onSuccessCapture.current;
  if (fn == null) throw new Error('onSuccess not set');
  void fn(data, variables);
}

// ── Tests ──

describe('useChatMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentChatMode = 'agent';
    subChatsState.length = 0;
    subChatsState.push({ id: 'sub-1', mode: 'agent' });
    activeState.activeSubChatId = 'sub-1';
    onErrorCapture.current = null;
    onSuccessCapture.current = null;
  });

  it('arms the pending transition intent on a user mode change (decision `sub-chat-mode-ownership`)', () => {
    const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
    act(() => {
      result.current.commitModeChange('plan');
    });
    const intentCall = appStoreSetMock.mock.calls.find((c) =>
      String(c[0]).includes('pendingModeIntent:sub-1'),
    );
    expect(intentCall?.[1]).toBe('plan');
  });

  it('a same-mode commit is a no-op (no persist, no intent)', () => {
    const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
    act(() => {
      result.current.commitModeChange('agent');
    });
    expect(mutateMock).not.toHaveBeenCalled();
    expect(appStoreSetMock).not.toHaveBeenCalled();
  });

  it('CAS-acks its own mode on mutation success — a newer toggle survives a stale ack', () => {
    const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
    act(() => {
      result.current.commitModeChange('plan');
    });
    act(() => {
      invokeOnSuccess({}, { subChatId: 'sub-1', mode: 'plan' as ChatMode });
    });
    // CAS semantics (only-clears-matching) are pinned in lib/stores/mode-intent.test.ts.
    expect(ackModeIntentMock).toHaveBeenCalledWith('sub-1', 'plan');
  });

  it('CAS-acks the failed mode on mutation error — the revert must not leave it armed', () => {
    const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
    act(() => {
      result.current.commitModeChange('plan');
    });
    act(() => {
      invokeOnError(new Error('DB error'), { subChatId: 'sub-1', mode: 'plan' as ChatMode });
    });
    expect(ackModeIntentMock).toHaveBeenCalledWith('sub-1', 'plan');
  });

  it('the plain atom setter updates the atom without firing the persist mutation or arming intent', () => {
    const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
    act(() => {
      result.current.setChatMode('plan');
    });
    expect(mutateMock).not.toHaveBeenCalled();
    const armed = appStoreSetMock.mock.calls.some((c) =>
      String(c[0]).includes('pendingModeIntent:sub-1'),
    );
    expect(armed).toBe(false);
  });

  describe('onError revert logic (3-mode / prior snapshot)', () => {
    it('reverts to agent when mutation for debug fails and previous mode was agent', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
      expect(onErrorCapture.current).toBeTruthy();

      act(() => {
        result.current.commitModeChange('debug');
      });
      act(() => {
        invokeOnError(new Error('DB error'), {
          subChatId: 'sub-1',
          mode: 'debug' as ChatMode,
        });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'agent', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('agent');
    });

    it('reverts to plan when mutation for debug fails and previous mode was plan', () => {
      subChatsState[0].mode = 'plan';
      currentChatMode = 'plan';
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
      expect(onErrorCapture.current).toBeTruthy();

      act(() => {
        result.current.commitModeChange('debug');
      });
      act(() => {
        invokeOnError(new Error('DB error'), {
          subChatId: 'sub-1',
          mode: 'debug' as ChatMode,
        });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'plan', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('plan');
    });

    it('reverts to debug when mutation for agent fails and previous mode was debug', () => {
      subChatsState[0].mode = 'debug';
      currentChatMode = 'debug';
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
      expect(onErrorCapture.current).toBeTruthy();

      act(() => {
        result.current.commitModeChange('agent');
      });
      act(() => {
        invokeOnError(new Error('DB error'), {
          subChatId: 'sub-1',
          mode: 'agent' as ChatMode,
        });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'debug', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('debug');
    });

    it('reverts to debug when mutation for plan fails and previous mode was debug', () => {
      subChatsState[0].mode = 'debug';
      currentChatMode = 'debug';
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
      expect(onErrorCapture.current).toBeTruthy();

      act(() => {
        result.current.commitModeChange('plan');
      });
      act(() => {
        invokeOnError(new Error('DB error'), {
          subChatId: 'sub-1',
          mode: 'plan' as ChatMode,
        });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'debug', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('debug');
    });

    it('a null result (no row yet) keeps the intent armed as the sole carrier for the first send', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));

      act(() => {
        result.current.commitModeChange('debug');
      });
      act(() => {
        invokeOnSuccess(null, { subChatId: 'sub-1', mode: 'debug' });
      });

      expect(ackModeIntentMock).not.toHaveBeenCalled();
    });

    it('a stale failure after a newer toggle does not drag the display back', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));

      act(() => {
        result.current.commitModeChange('plan');
      });
      act(() => {
        result.current.commitModeChange('debug');
      });
      setChatModeMock.mockClear();
      updateSubChatModeMock.mockClear();

      act(() => {
        invokeOnError(new Error('DB error'), { subChatId: 'sub-1', mode: 'plan' });
      });

      expect(ackModeIntentMock).toHaveBeenCalledWith('sub-1', 'plan');
      expect(updateSubChatModeMock).not.toHaveBeenCalled();
      expect(setChatModeMock).not.toHaveBeenCalled();
    });

    it('the revert is display-only: no second mutation fires and no new intent arms', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));

      act(() => {
        result.current.commitModeChange('plan');
      });
      appStoreSetMock.mockClear();
      act(() => {
        invokeOnError(new Error('DB error'), { subChatId: 'sub-1', mode: 'plan' });
      });

      expect(mutateMock).toHaveBeenCalledTimes(1);
      const rearmed = appStoreSetMock.mock.calls.some((c) =>
        String(c[0]).includes('pendingModeIntent:sub-1'),
      );
      expect(rearmed).toBe(false);
    });

    it('correctly reverts agent<->plan (2-mode transitions still work)', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));
      expect(onErrorCapture.current).toBeTruthy();

      act(() => {
        result.current.commitModeChange('plan');
      });
      act(() => {
        invokeOnError(new Error('DB error'), {
          subChatId: 'sub-1',
          mode: 'plan' as ChatMode,
        });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'agent', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('agent');
    });

    it('an earlier toggle succeeding does not clobber a later toggle’s revert target', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));

      act(() => {
        result.current.commitModeChange('plan');
      });
      act(() => {
        result.current.commitModeChange('debug');
      });
      act(() => {
        invokeOnSuccess({}, { subChatId: 'sub-1', mode: 'plan' });
      });
      act(() => {
        invokeOnError(new Error('DB error'), { subChatId: 'sub-1', mode: 'debug' });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'plan', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('plan');
    });

    it('chained failures revert to the last mode that was actually persisted', () => {
      const { result } = renderHook(() => useChatMode('sub-1', 'chat-1'));

      act(() => {
        result.current.commitModeChange('plan');
      });
      act(() => {
        result.current.commitModeChange('debug');
      });
      act(() => {
        invokeOnError(new Error('DB error'), { subChatId: 'sub-1', mode: 'plan' });
      });
      act(() => {
        invokeOnError(new Error('DB error'), { subChatId: 'sub-1', mode: 'debug' });
      });

      expect(updateSubChatModeMock).toHaveBeenLastCalledWith('sub-1', 'agent', 'chat-1');
      expect(setChatModeMock).toHaveBeenLastCalledWith('agent');
    });

    it('cancels stale plan approval reads before refetching after mode persistence', async () => {
      renderHook(() => useChatMode('sub-1', 'chat-1'));

      await act(async () => {
        invokeOnSuccess(null, { subChatId: 'sub-1', mode: 'agent' });
        await vi.waitFor(() => {
          expect(invalidatePendingPlanApprovalsMock).toHaveBeenCalledTimes(1);
        });
      });

      expect(cancelPendingPlanApprovalsMock).toHaveBeenCalledTimes(1);
      expect(cancelPendingPlanApprovalsMock.mock.invocationCallOrder[0]).toBeLessThan(
        invalidatePendingPlanApprovalsMock.mock.invocationCallOrder[0] ?? 0,
      );
    });
  });

  /**
   * The mode atom is CHAT-scoped while this hook mounts once per open TAB/PANE. Only the
   * sidebar-active tab may SEED the shared atom from its row at init: two tabs with disagreeing
   * persisted modes would otherwise correct each other on every remount (the visible agent/plan
   * flapping loop).
   */
  describe('background-tab initialization (multi-tab)', () => {
    it('a background tab initializing does not stamp its row mode over the shared atom', () => {
      subChatsState.push({ id: 'sub-bg', mode: 'plan' });
      renderHook(() => useChatMode('sub-1', 'chat-1'));
      renderHook(() => useChatMode('sub-bg', 'chat-1'));

      expect(currentChatMode).toBe('agent');
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('switching to another ACTIVE sub-chat re-seeds the shared atom from its row', () => {
      subChatsState.push({ id: 'sub-2', mode: 'plan' });
      const hook = renderHook(({ id }) => useChatMode(id, 'chat-1'), {
        initialProps: { id: 'sub-1' },
      });

      activeState.activeSubChatId = 'sub-2';
      hook.rerender({ id: 'sub-2' });

      expect(currentChatMode).toBe('plan');
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('a split pane still persists its own gesture (persistence is not active-tab gated)', () => {
      activeState.activeSubChatId = 'somewhere-else';
      const pane = renderHook(() => useChatMode('sub-1', 'chat-1'));

      act(() => pane.result.current.commitModeChange('plan'));

      expect(mutateMock).toHaveBeenCalledTimes(1);
      expect(mutateMock).toHaveBeenCalledWith({ subChatId: 'sub-1', mode: 'plan' });
    });
  });
});
