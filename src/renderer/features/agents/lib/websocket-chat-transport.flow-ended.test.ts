// @vitest-environment happy-dom

/**
 * FLOW_RUN_ENDED handling: a send declined because the flow run already settled (provider
 * preflight in main stamps the category) must surface as an actionable, deduped toast — never as
 * an execution failure that rolls the user's message back, persists a doomed retry, or leaves the
 * composer latched failed after recovery.
 *
 * Lives beside websocket-chat-transport.test.ts for the same reason as the retry-gate slice: that
 * file is at its recorded size ceiling and this needs only the error-path harness.
 */

import type { UIMessage } from 'ai';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../lib/atoms', () => ({
  extendedThinkingEnabledAtom: Symbol('extendedThinkingEnabledAtom'),
  sessionInfoAtom: Symbol('sessionInfoAtom'),
}));

vi.mock('../../../lib/jotai-store', () => ({
  appStore: {
    get: vi.fn(() => new Map()),
    set: vi.fn(),
  },
}));

vi.mock('../../../lib/trpc', () => ({
  trpcClient: {
    socket: {
      sendMessage: { mutate: vi.fn(async () => ({})) },
      sendStop: { mutate: vi.fn(async () => ({})) },
    },
    external: {
      openExternal: { mutate: vi.fn() },
    },
  },
}));

// Symbol-tagged atom families, same convention as the sibling transport tests.
vi.mock('../atoms', () => ({
  approvedPlanContextAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`approvedPlanContext:${subChatId}`),
  ),
  askUserQuestionResultsAtom: Symbol('askUserQuestionResultsAtom'),
  autoModePerChatAtomFamily: vi.fn((chatId: string) => Symbol(`autoModePerChat:${chatId}`)),
  compactingSubChatsAtom: Symbol('compactingSubChatsAtom'),
  enableTasksAtom: Symbol('enableTasksAtom'),
  expiredUserQuestionsAtom: Symbol('expiredUserQuestionsAtom'),
  lastSelectedModelIdAtomFamily: vi.fn((chatId: string) => Symbol(`lastSelectedModelId:${chatId}`)),
  navigationSessionIdAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`navigationSessionId:${subChatId}`),
  ),
  pendingChatRetryAtomFamily: vi.fn((subChatId: string) => Symbol(`pendingChatRetry:${subChatId}`)),
  pendingModeIntentAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`pendingModeIntent:${subChatId}`),
  ),
  pendingUserQuestionsAtom: Symbol('pendingUserQuestionsAtom'),
  retryInFlightAtomFamily: vi.fn((subChatId: string) => Symbol(`retryInFlight:${subChatId}`)),
  taskExecutionErrorAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`taskExecutionError:${subChatId}`),
  ),
}));

vi.mock('../stores/streaming-status-store', () => ({
  useStreamingStatusStore: {
    getState: () => ({ setStatus: vi.fn() }),
  },
}));

vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({ allSubChats: [], updateSubChatMode: vi.fn() }),
  },
}));

import { appStore } from '../../../lib/jotai-store';
import { hasActiveTransport } from '../../../lib/stores/active-transport-registry';
import { trpcClient } from '../../../lib/trpc';
import { agentChatStore } from '../stores/agent-chat-store';
import { cleanupTransportListeners, WebSocketChatTransport } from './websocket-chat-transport';

type ErrorPayload = { subChatId: string; error: string; category?: string };
type StreamChunkPayload = {
  subChatId: string;
  assistantMessageId?: string;
  chunk: { type: string; [key: string]: unknown };
};

const waitForAsync = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setupTransport(subChatId: string) {
  let fireSocketError: (payload: ErrorPayload) => void = () => {};
  let fireStreamChunk: (payload: StreamChunkPayload) => void = () => {};
  (window as unknown as Record<string, unknown>).desktopApi = {
    onSocketStreamChunk: vi.fn((cb: (payload: StreamChunkPayload) => void) => {
      fireStreamChunk = cb;
      return vi.fn();
    }),
    onSocketExecuteComplete: vi.fn(() => vi.fn()),
    onSocketError: vi.fn((cb: (payload: ErrorPayload) => void) => {
      fireSocketError = cb;
      return vi.fn();
    }),
    onSocketMessageSaved: vi.fn(() => vi.fn()),
  };
  const onExecutionError = vi.fn();
  const transport = new WebSocketChatTransport({
    getExecutionAccountType: () => 'claude-code' as const,
    chatId: `chat-${subChatId}`,
    subChatId,
    projectId: 'proj-1',
    mode: 'agent',
    onExecutionError,
  });
  return {
    transport,
    onExecutionError,
    fireSocketError: (p: ErrorPayload) => fireSocketError(p),
    fireStreamChunk: (p: StreamChunkPayload) => fireStreamChunk(p),
  };
}

const userTurn = (text: string): UIMessage[] => [
  { id: 'msg-1', role: 'user', parts: [{ type: 'text', text }] },
];

async function startTurn(transport: WebSocketChatTransport, subChatId: string): Promise<void> {
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: `chat-${subChatId}`,
    messageId: undefined,
    messages: userTurn('carry on please'),
    abortSignal: undefined,
  });
  void stream.pipeTo(new WritableStream()).catch(() => {});
  await waitForAsync();
}

function setCalls(): Array<[unknown, unknown]> {
  return (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } }).mock.calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(appStore.get).mockImplementation((target: unknown) =>
    String(target).includes('lastSelectedModelId') ? 'sonnet' : new Map(),
  );
});

describe('FLOW_RUN_ENDED socket error', () => {
  const DECLINE_TEXT = 'Flow task t1 is no longer execution-eligible';

  it('shows the actionable deduped toast instead of a generic execution failure', async () => {
    const subChatId = 'fre-toast';
    const { transport, fireSocketError } = setupTransport(subChatId);
    await startTurn(transport, subChatId);

    fireSocketError({ subChatId, error: DECLINE_TEXT, category: 'FLOW_RUN_ENDED' });
    await waitForAsync();

    expect(toast.error).toHaveBeenCalledWith(
      'This flow run has ended',
      expect.objectContaining({
        description: 'Use Re-run step (or Resume) above the composer to continue this flow.',
        // Dedup id is per sub-chat: concurrent declines in two chats must keep both toasts.
        id: 'flow-run-ended:fre-toast',
      }),
    );
  });

  it('does not roll the typed message back and does not persist a doomed retry', async () => {
    const subChatId = 'fre-no-rollback';
    const { transport, onExecutionError, fireSocketError } = setupTransport(subChatId);
    await startTurn(transport, subChatId);

    fireSocketError({ subChatId, error: DECLINE_TEXT, category: 'FLOW_RUN_ENDED' });
    await waitForAsync();

    expect(onExecutionError).not.toHaveBeenCalled();
    expect(
      setCalls().some(
        (call) => String(call[0]).includes(`pendingChatRetry:${subChatId}`) && call[1] != null,
      ),
    ).toBe(false);
    // The failure is still signalled to the task-error surface (recovery clears it).
    expect(
      setCalls().some(
        (call) => String(call[0]).includes(`taskExecutionError:${subChatId}`) && call[1] != null,
      ),
    ).toBe(true);
  });

  it('an uncategorized error keeps today’s execution-failure handling', async () => {
    const subChatId = 'fre-regression';
    const { transport, onExecutionError, fireSocketError } = setupTransport(subChatId);
    await startTurn(transport, subChatId);

    fireSocketError({ subChatId, error: 'provider unavailable' });
    await waitForAsync();

    expect(onExecutionError).toHaveBeenCalledWith(subChatId);
    expect(
      setCalls().some(
        (call) => String(call[0]).includes(`pendingChatRetry:${subChatId}`) && call[1] != null,
      ),
    ).toBe(true);
  });
});

describe('ambient stream chunks never clear the latched task-execution error', () => {
  // The latch is cleared only on deliberate recovery intent (a new manual send in useMessageSend,
  // or the InterruptedRunControls button). An ambient start chunk must NOT clear it: a concurrent
  // turn on the same sub-chat would otherwise erase a live failure from a different send.
  it('a start chunk leaves taskExecutionErrorAtomFamily alone', async () => {
    const subChatId = 'fre-no-ambient-clear';
    const { transport, fireStreamChunk } = setupTransport(subChatId);
    await startTurn(transport, subChatId);

    fireStreamChunk({ subChatId, chunk: { type: 'start' } });
    await waitForAsync();

    expect(
      setCalls().some((call) => String(call[0]).includes(`taskExecutionError:${subChatId}`)),
    ).toBe(false);
  });
});

describe('transport teardown settles the owned stream', () => {
  // A Chat deleted mid-turn tears its transport down; the stream must close so the awaited
  // `sendMessage` settles — an orphaned stream held the QueueProcessor's per-sub-chat lock forever.
  async function openStream(subChatId: string) {
    const { transport } = setupTransport(subChatId);
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: `chat-${subChatId}`,
      messageId: undefined,
      messages: userTurn('go'),
      abortSignal: undefined,
    });
    const reader = stream.getReader();
    await reader.read(); // the synthetic `start` chunk; the next read waits on main
    let settled = false;
    const pending = reader.read().then((r) => {
      settled = true;
      return r;
    });
    await waitForAsync();
    return { pending, isSettled: () => settled };
  }

  it('teardown closes the stream so a pending read settles as done', async () => {
    const subChatId = 'teardown-close';
    const { pending, isSettled } = await openStream(subChatId);
    expect(isSettled()).toBe(false);

    cleanupTransportListeners(subChatId);

    expect((await pending).done).toBe(true);
    expect(hasActiveTransport(subChatId)).toBe(false);
  });

  it('the start-of-send re-register path leaves the previous stream open', async () => {
    const subChatId = 'teardown-resend';
    const { isSettled } = await openStream(subChatId);

    cleanupTransportListeners(subChatId, false);
    await waitForAsync();

    expect(isSettled()).toBe(false);
    cleanupTransportListeners(subChatId);
  });

  it('marks the deleted Chat instance torn down; a replacement on the same sub-chat is not', async () => {
    // Main still runs the turn when the close makes the SDK finish, so that instance must not
    // chime — and the flag is per instance, so a re-created Chat's real completion still does.
    const subChatId = 'teardown-flag';
    // SAFETY: identity-only stubs — the store keys on the instance and never calls a Chat method.
    const [oldChat, newChat] = [{} as never, {} as never];
    agentChatStore.set(subChatId, oldChat, `chat-${subChatId}`);
    await openStream(subChatId);
    agentChatStore.delete(subChatId);
    agentChatStore.set(subChatId, newChat, `chat-${subChatId}`);
    await waitForAsync();

    expect(agentChatStore.wasTornDown(oldChat)).toBe(true);
    expect(agentChatStore.wasTornDown(newChat)).toBe(false);
    expect(agentChatStore.wasManuallyAborted(subChatId)).toBe(false);
  });

  type SendResult = Awaited<ReturnType<typeof trpcClient.socket.sendMessage.mutate>>;

  function deferSend() {
    let resolve: (value: SendResult) => void = () => {};
    let reject: (reason: Error) => void = () => {};
    vi.mocked(trpcClient.socket.sendMessage.mutate).mockImplementationOnce(
      () =>
        new Promise<SendResult>((res, rej) => {
          resolve = res;
          reject = rej;
        }),
    );
    return { resolve: (v: SendResult) => resolve(v), reject: (e: Error) => reject(e) };
  }

  async function openUnsentStream(subChatId: string) {
    const { transport } = setupTransport(subChatId);
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: `chat-${subChatId}`,
      messageId: undefined,
      messages: userTurn('go'),
      abortSignal: undefined,
    });
    return stream.getReader();
  }

  it('teardown before main accepted the send closes only once the send resolves', async () => {
    // A rehydration replace can land between the queue pop and the socket mutate resolving; the
    // popped prompt must still reach main before the stream the sender awaits is closed.
    const send = deferSend();
    const subChatId = 'teardown-early';
    const reader = await openUnsentStream(subChatId);
    let settled = false;
    const pending = reader.read().then((r) => {
      settled = true;
      return r;
    });

    cleanupTransportListeners(subChatId);
    await waitForAsync();
    expect(settled).toBe(false);

    send.resolve({ success: true });
    expect((await pending).value).toEqual({ type: 'start' });
    expect((await reader.read()).done).toBe(true);
    expect(hasActiveTransport(subChatId)).toBe(false);
  });

  it('teardown before a send that then fails still surfaces the error to the sender', async () => {
    const send = deferSend();
    const subChatId = 'teardown-early-fail';
    const reader = await openUnsentStream(subChatId);
    const pending = reader.read();

    cleanupTransportListeners(subChatId);
    send.reject(new Error('socket down'));

    expect((await pending).value).toMatchObject({ type: 'error', errorText: 'socket down' });
    expect((await reader.read()).done).toBe(true);
  });

  it('a deleted Chat whose sub-chat was re-sent meanwhile leaves the newer transport alone', async () => {
    const subChatId = 'teardown-identity';
    await openStream(subChatId);

    agentChatStore.delete(subChatId); // snapshots the old listener, then imports lazily
    const replacement = await openStream(subChatId); // registers a newer transport first
    await waitForAsync();

    expect(replacement.isSettled()).toBe(false);
    expect(hasActiveTransport(subChatId)).toBe(true);
    cleanupTransportListeners(subChatId);
  });
});
