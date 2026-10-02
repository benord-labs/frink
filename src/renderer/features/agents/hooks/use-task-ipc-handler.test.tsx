// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskChatReadyData } from '../../../../shared/types/task-chat-ready';
import { activeOverlayAtom, agentsSettingsDialogOpenAtom } from '../../../lib/atoms';
import { codexSpeedAtomFamily } from '../../../lib/atoms/codex-speed';
import {
  autoModePerChatAtomFamily,
  chatModeAtomFamily,
  lastSelectedModelIdAtomFamily,
  selectedAgentChatIdAtom,
} from '../atoms';
import { agentChatStore } from '../stores/agent-chat-store';
import { useMessageQueueStore } from '../stores/message-queue-store';
import { UNDELIVERED_PULL_RETRY_MS, useTaskIpcHandler } from './use-task-ipc-handler';

const {
  createAgentChat,
  fetchResolvedAccount,
  getResolvedAccountData,
  getSubChatMessages,
  invalidateAgentChat,
  listUndeliveredDispatches,
} = vi.hoisted(() => ({
  createAgentChat: vi.fn(),
  fetchResolvedAccount: vi.fn(async () => undefined),
  getResolvedAccountData: vi.fn(() => ({ type: 'claude-code' })),
  getSubChatMessages: vi.fn(async () => ({ messages: [], hasMore: false, sessionId: null })),
  invalidateAgentChat: vi.fn(async () => undefined),
  listUndeliveredDispatches: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('../lib/create-agent-chat', () => ({ createAgentChat }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/electron/renderer', () => ({ captureException }));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      claudeCode: {
        getResolvedAccount: { fetch: fetchResolvedAccount, getData: getResolvedAccountData },
      },
    }),
  },
  trpcClient: {
    chats: { getSubChatMessages: { query: getSubChatMessages } },
    tasks: { listUndeliveredDispatches: { query: listUndeliveredDispatches } },
  },
}));

// getAgentChat lives on the `api` client (lib/mock-api), not the main-process trpc router.
vi.mock('../../../lib/mock-api', () => ({
  api: { useUtils: () => ({ agents: { getAgentChat: { invalidate: invalidateAgentChat } } }) },
}));

function validPayload(overrides: Partial<TaskChatReadyData> = {}): TaskChatReadyData {
  return {
    chatId: 'chat-1',
    subChatId: 'sub-1',
    taskId: 'task-1',
    prompt: 'Do the thing',
    projectId: 'proj-1',
    projectPath: null,
    startMode: 'execute',
    skipReview: false,
    headless: true,
    ...overrides,
  };
}

describe('useTaskIpcHandler', () => {
  let jotaiStore: ReturnType<typeof createStore>;
  let ipcCallback: ((data: unknown) => void) | null;

  beforeEach(() => {
    jotaiStore = createStore();
    ipcCallback = null;
    createAgentChat.mockClear();
    captureException.mockClear();
    fetchResolvedAccount.mockClear();
    getSubChatMessages.mockClear();
    invalidateAgentChat.mockClear();
    listUndeliveredDispatches.mockReset().mockResolvedValue([]);
    getResolvedAccountData.mockReturnValue({ type: 'claude-code' as const });
    // Mirror the real factory: register the Chat in agentChatStore so the handler's
    // `agentChatStore.has(subChatId)` idempotency re-check and message dedup behave realistically.
    createAgentChat.mockImplementation((params: unknown) => {
      const p = params as { subChatId: string; chatId: string; initialMessages?: unknown[] };
      const chat = { messages: p.initialMessages ?? [] };
      agentChatStore.set(p.subChatId, chat as never, p.chatId);
      return chat;
    });
    agentChatStore.clear();
    useMessageQueueStore.setState({ queues: {}, editingItemIds: {} });

    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onTaskChatReady: vi.fn((cb: (data: unknown) => void) => {
          ipcCallback = cb;
          return () => {
            ipcCallback = null;
          };
        }),
      },
    });
  });

  afterEach(() => {
    agentChatStore.clear();
    useMessageQueueStore.setState({ queues: {}, editingItemIds: {} });
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <Provider store={jotaiStore}>{children}</Provider>;
  }

  it('creates the chat headlessly and enqueues the prompt without stealing focus (flow task)', async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    expect(ipcCallback).toBeTypeOf('function');

    act(() => ipcCallback?.(validPayload()));

    // Flow task (headless) must NOT navigate.
    expect(jotaiStore.get(selectedAgentChatIdAtom)).toBeNull();

    await waitFor(() => expect(createAgentChat).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const queue = useMessageQueueStore.getState().getQueue('sub-1');
      expect(queue.some((item) => item.message === 'Do the thing')).toBe(true);
    });
    // Prefetch opens QueueProcessor's account-gate for a chat the user never navigated to.
    expect(fetchResolvedAccount).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });

  it("queues a flow dispatch with its attempt, so main can tell it from an earlier attempt's", async () => {
    listUndeliveredDispatches.mockResolvedValue([
      validPayload({ dispatchGeneration: '2026-10-02T10:30:13.000Z' }),
    ]);
    renderHook(() => useTaskIpcHandler(), { wrapper });

    await waitFor(() => {
      const queue = useMessageQueueStore.getState().getQueue('sub-1');
      expect(queue.map((item) => item.dispatchGeneration)).toEqual(['2026-10-02T10:30:13.000Z']);
    });
  });

  it('moves a still-queued copy of the prompt onto the newer attempt instead of stranding it', async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ dispatchGeneration: 'gen-a' })));
    await waitFor(() => expect(useMessageQueueStore.getState().getQueue('sub-1')).toHaveLength(1));

    act(() => ipcCallback?.(validPayload({ dispatchGeneration: 'gen-b' })));

    await waitFor(() => {
      const queue = useMessageQueueStore.getState().getQueue('sub-1');
      expect(queue.map((item) => item.dispatchGeneration)).toEqual(['gen-b']);
    });
  });

  it('never downgrades a queued attempt for a delayed, older dispatch', async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ dispatchGeneration: '2026-10-02T10:40:00.000Z' })));
    await waitFor(() => expect(useMessageQueueStore.getState().getQueue('sub-1')).toHaveLength(1));

    act(() => ipcCallback?.(validPayload({ dispatchGeneration: '2026-10-02T10:30:00.000Z' })));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useMessageQueueStore.getState().getQueue('sub-1')[0]?.dispatchGeneration).toBe(
      '2026-10-02T10:40:00.000Z',
    );
  });

  it("refreshes this task's queued copy, not another task's with the same text", async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ taskId: 'task-other', dispatchGeneration: 'gen-o' })));
    await waitFor(() => expect(useMessageQueueStore.getState().getQueue('sub-1')).toHaveLength(1));
    act(() => {
      useMessageQueueStore.getState().addToQueue('sub-1', {
        ...useMessageQueueStore.getState().getQueue('sub-1')[0],
        id: 'own-copy',
        dispatchTaskId: 'task-1',
        dispatchGeneration: 'gen-a',
      });
    });

    act(() => ipcCallback?.(validPayload({ dispatchGeneration: 'gen-b' })));

    await waitFor(() => {
      const byTask = Object.fromEntries(
        useMessageQueueStore
          .getState()
          .getQueue('sub-1')
          .map((item) => [item.dispatchTaskId, item.dispatchGeneration]),
      );
      expect(byTask).toEqual({ 'task-other': 'gen-o', 'task-1': 'gen-b' });
    });
  });

  it('delivers a dispatch that fired before the listener mounted, once, via the mount pull', async () => {
    // A renderer reload (or slow lazy layout load) misses the one-shot IPC event; main still holds
    // the undelivered payload. A live re-fire of the same dispatch must not double-enqueue it.
    listUndeliveredDispatches.mockResolvedValue([validPayload({ startMode: 'plan' })]);
    renderHook(() => useTaskIpcHandler(), { wrapper });

    await waitFor(() => {
      const queue = useMessageQueueStore.getState().getQueue('sub-1');
      expect(queue.map((item) => item.dispatchTaskId)).toEqual(['task-1']);
    });
    expect(jotaiStore.get(chatModeAtomFamily('chat-1'))).toBe('plan');

    act(() => ipcCallback?.(validPayload({ startMode: 'plan' })));
    await waitFor(() => expect(useMessageQueueStore.getState().getQueue('sub-1')).toHaveLength(1));
  });

  it('retries a failed mount pull instead of treating it as nothing pending', async () => {
    vi.useFakeTimers();
    try {
      listUndeliveredDispatches
        .mockRejectedValueOnce(new Error('ipc unavailable'))
        .mockResolvedValue([validPayload()]);
      renderHook(() => useTaskIpcHandler(), { wrapper });
      await vi.advanceTimersByTimeAsync(0);
      expect(useMessageQueueStore.getState().getQueue('sub-1')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(UNDELIVERED_PULL_RETRY_MS);
      expect(listUndeliveredDispatches).toHaveBeenCalledTimes(2);
      expect(useMessageQueueStore.getState().getQueue('sub-1')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds the chat's Auto setting from the Flow and tags the prompt flow-dispatched", async () => {
    // The tag is for plan-mode semantics only: without it, a plan node continuing a chat that holds
    // an earlier node's parked plan card would be re-flipped to agent mode at send
    // (approve-then-execute is for human replies only). Auto rides the seeded chat setting instead.
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ autoReviewTools: true })));

    await waitFor(() => {
      const queue = useMessageQueueStore.getState().getQueue('sub-1');
      expect(queue).toHaveLength(1);
      expect(queue[0].source).toBe('flow-dispatch');
    });
    expect(jotaiStore.get(autoModePerChatAtomFamily('chat-1'))).toBe(true);
  });

  it('seeds Auto off when the Flow disables it', async () => {
    jotaiStore.set(autoModePerChatAtomFamily('chat-1'), true);
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ autoReviewTools: false })));

    await waitFor(() => {
      expect(jotaiStore.get(autoModePerChatAtomFamily('chat-1'))).toBe(false);
    });
  });

  it("seeds the chat's Codex speed from the Flow", async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ codexSpeed: 'ultrafast' })));

    await waitFor(() => {
      expect(jotaiStore.get(codexSpeedAtomFamily('chat-1'))).toBe('ultrafast');
    });
  });

  it('clears a chat left on Fast when the Flow runs standard', async () => {
    // The chat's value outlives the run that set it, so `standard` has to actively win, or one Fast
    // flow bills every later run in the same chat.
    jotaiStore.set(codexSpeedAtomFamily('chat-1'), 'fast');
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ codexSpeed: 'standard' })));

    await waitFor(() => {
      expect(jotaiStore.get(codexSpeedAtomFamily('chat-1'))).toBe('standard');
    });
  });

  it('leaves the chat Fast setting alone when the payload omits it', async () => {
    // Manual and non-flow dispatches carry no value; they must not reset the user's own choice.
    jotaiStore.set(codexSpeedAtomFamily('chat-1'), 'fast');
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ autoReviewTools: true })));

    await waitFor(() => {
      expect(jotaiStore.get(autoModePerChatAtomFamily('chat-1'))).toBe(true);
    });
    expect(jotaiStore.get(codexSpeedAtomFamily('chat-1'))).toBe('fast');
  });

  it('navigates from Work Queue-owned Settings to a non-flow task chat', async () => {
    jotaiStore.set(autoModePerChatAtomFamily('chat-1'), false);
    jotaiStore.set(activeOverlayAtom, 'workqueue');
    jotaiStore.set(agentsSettingsDialogOpenAtom, true);
    expect(jotaiStore.get(activeOverlayAtom)).toBe('settings');

    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ headless: false })));

    expect(jotaiStore.get(selectedAgentChatIdAtom)).toBe('chat-1');
    expect(jotaiStore.get(activeOverlayAtom)).toBeNull();
    jotaiStore.set(agentsSettingsDialogOpenAtom, false);
    expect(jotaiStore.get(activeOverlayAtom)).toBeNull();

    await waitFor(() => {
      expect(useMessageQueueStore.getState().getQueue('sub-1')[0]?.source).toBeUndefined();
    });
    // A payload carrying no Flow-owned value must never write the user's own setting.
    expect(jotaiStore.get(autoModePerChatAtomFamily('chat-1'))).toBe(false);
  });

  it('seeds Auto for a cloud fire-and-forget dispatch, which is not headless', async () => {
    // Fire-and-forget agent tasks carry the Flow's value with no flow_run_id link, so the seed
    // keys off the value's presence rather than `headless` — but they keep their non-flow focus
    // and chime behaviour.
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ headless: false, autoReviewTools: true })));

    await waitFor(() => {
      expect(jotaiStore.get(autoModePerChatAtomFamily('chat-1'))).toBe(true);
    });
    expect(agentChatStore.isFlowChat('chat-1')).toBe(false);
    expect(jotaiStore.get(selectedAgentChatIdAtom)).toBe('chat-1');
  });

  it('still seeds Auto when the re-dispatch is swallowed by the already-sent dedup', async () => {
    // The seed must precede the dedup return: a re-claimed flow task whose prompt is already
    // persisted still governs the turns that follow it.
    agentChatStore.set(
      'sub-1',
      { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Do the thing' }] }] } as never,
      'chat-1',
    );
    // Seeded to the OPPOSITE of what the dispatch carries: asserting the atom's own default here
    // would pass even if the seed never ran at all.
    jotaiStore.set(autoModePerChatAtomFamily('chat-1'), true);
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ autoReviewTools: false })));
    await Promise.resolve();

    expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(0);
    expect(jotaiStore.get(autoModePerChatAtomFamily('chat-1'))).toBe(false);
  });

  it('invalidates the active-chat query so the header Task badge appears live (chats.taskId just linked)', () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload()));
    expect(invalidateAgentChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });

  it('marks the chat flow-driven on a headless chat-ready, even when reusing an existing Chat', () => {
    // Heals a stale Chat created before the flow linked the chat (whose per-node turns
    // would otherwise chime): the mark must land on the reuse path too.
    agentChatStore.set('sub-1', {} as never, 'chat-1');
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload()));

    expect(agentChatStore.isFlowChat('chat-1')).toBe(true);
  });

  it('never marks a non-flow work-queue task chat as flow-driven (its away-ping must survive)', () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ headless: false })));

    expect(agentChatStore.isFlowChat('chat-1')).toBe(false);
  });

  it('reuses an already-registered chat instead of creating a duplicate', async () => {
    // Simulate a mounted ActiveChat (or prior agent) that already owns the Chat.
    agentChatStore.set('sub-1', {} as never, 'chat-1');
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload()));

    await waitFor(() => {
      expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(1);
    });
    expect(createAgentChat).not.toHaveBeenCalled();
  });

  it('does not re-enqueue when the chat already contains the prompt (re-claim / second window)', async () => {
    // Existing chat already has the task's prompt persisted (e.g. a re-claimed task after a
    // heartbeat lapse, or a second app window handling the same broadcast).
    agentChatStore.set(
      'sub-1',
      { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Do the thing' }] }] } as never,
      'chat-1',
    );
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload()));
    await Promise.resolve();

    expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(0);
    expect(createAgentChat).not.toHaveBeenCalled();
    // A swallowed HEADLESS (flow) dispatch is a silent stall — it must reach Sentry.
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('isRetry bypasses the already-sent dedup — a retried prompt legitimately exists as a persisted message', async () => {
    // A user-requested retry re-dispatches a prompt that IS already a persisted user message from
    // the failed attempt. Without the bypass the enqueue is swallowed, no stream listener is
    // registered, and the retry is a dead-end (sidebar shows Running, panel frozen on the error).
    agentChatStore.set(
      'sub-1',
      { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Do the thing' }] }] } as never,
      'chat-1',
    );
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => ipcCallback?.(validPayload({ isRetry: true })));

    await waitFor(() => {
      expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(1);
    });
  });

  it('isRetry still respects the already-queued dedup (retry while a retry is pending)', async () => {
    agentChatStore.set(
      'sub-1',
      { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Do the thing' }] }] } as never,
      'chat-1',
    );
    renderHook(() => useTaskIpcHandler(), { wrapper });

    act(() => {
      ipcCallback?.(validPayload({ isRetry: true }));
      ipcCallback?.(validPayload({ isRetry: true }));
    });
    await waitFor(() => {
      expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(1);
    });
  });

  it('sets the chat mode to plan for a plan-gated flow agent (Plan-Gated Build)', () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ startMode: 'plan' })));
    // The transport reads the chat mode at send time; plan must survive into the headless path or
    // a plan-gated agent silently runs in execute mode.
    expect(jotaiStore.get(chatModeAtomFamily('chat-1'))).toBe('plan');
  });

  it('resolves the execution account type lazily from the resolved-account cache', async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload()));
    await waitFor(() => expect(createAgentChat).toHaveBeenCalledTimes(1));

    const params = createAgentChat.mock.calls[0]?.[0] as {
      getExecutionAccountType: () => string;
    };
    // Read at SEND time (after the account-gate resolves), not snapshotted at create — a Codex
    // user must not run on the wrong CLI.
    getResolvedAccountData.mockReturnValueOnce({ type: 'codex' as const });
    expect(params.getExecutionAccountType()).toBe('codex');
  });

  it('forwards initial-prompt vision images onto the queued item (base64 reaches the agent)', async () => {
    const image = { base64Data: 'AAAA', mediaType: 'image/png', filename: 'shot.png' };
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ images: [image] })));

    await waitFor(() => expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(1));
    const item = useMessageQueueStore.getState().getQueue('sub-1')[0];
    expect(item.images?.[0]?.base64Data).toBe('AAAA');
    expect(item.images?.[0]?.mediaType).toBe('image/png');
  });

  it('collapses concurrent duplicate task:chat-ready for the same sub-chat to one create + one send', async () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => {
      ipcCallback?.(validPayload());
      ipcCallback?.(validPayload());
    });

    await waitFor(() => expect(createAgentChat).toHaveBeenCalledTimes(1));
    expect(useMessageQueueStore.getState().getQueue('sub-1').length).toBe(1);
  });

  it('sets the per-chat model atom when the payload carries a model (transport reads it at send time)', () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ model: 'sonnet' })));
    // The queued prompt sends with the flow-configured model, not the chat's prior selection.
    expect(jotaiStore.get(lastSelectedModelIdAtomFamily('chat-1'))).toBe('sonnet');
  });

  it('re-asserts the model per dispatch: a later node in the same chat overrides the earlier model', () => {
    // Plan node (opus) then execute node (sonnet) share a chat; each dispatch must land its own
    // model so the queued turn sends with the node's model, not the previous node's. Mirrors the
    // per-node mode re-assertion the transport relies on at send time.
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload({ model: 'opus-4.8' })));
    act(() => ipcCallback?.(validPayload({ model: 'sonnet' })));
    expect(jotaiStore.get(lastSelectedModelIdAtomFamily('chat-1'))).toBe('sonnet');
  });

  it('leaves the per-chat model atom untouched when the payload carries no model', () => {
    // Seed a SENTINEL (not the atom default): a default-value assertion would pass even if the
    // guarded write fired with a default, so the sentinel proves the no-model path never writes.
    jotaiStore.set(lastSelectedModelIdAtomFamily('chat-1'), 'opus-4.8');
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.(validPayload()));
    expect(jotaiStore.get(lastSelectedModelIdAtomFamily('chat-1'))).toBe('opus-4.8');
  });

  it('ignores invalid payloads without mutating atoms or the queue', () => {
    renderHook(() => useTaskIpcHandler(), { wrapper });
    act(() => ipcCallback?.({ not: 'valid' }));
    expect(jotaiStore.get(selectedAgentChatIdAtom)).toBeNull();
    expect(useMessageQueueStore.getState().queues).toEqual({});
    expect(createAgentChat).not.toHaveBeenCalled();
  });
});
