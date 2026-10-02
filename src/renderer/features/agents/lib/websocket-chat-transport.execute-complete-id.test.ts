// @vitest-environment happy-dom

// sc-3232 slice (websocket-chat-transport.test.ts is at its size ceiling).

import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { cleanupTransportListeners, WebSocketChatTransport } from './websocket-chat-transport';

type Payload = Record<string, unknown>;

const waitForAsync = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startTurn(subChatId: string) {
  const chunks: Array<{ type: string }> = [];
  const onExecuteComplete = vi.fn();
  let fireStreamChunk: (payload: Payload) => void = () => {};
  let fireExecuteComplete: (payload: Payload) => void = () => {};
  (window as unknown as Record<string, unknown>).desktopApi = {
    onSocketStreamChunk: vi.fn((cb: (payload: Payload) => void) => {
      fireStreamChunk = cb;
      return vi.fn();
    }),
    onSocketExecuteComplete: vi.fn((cb: (payload: Payload) => void) => {
      fireExecuteComplete = cb;
      return vi.fn();
    }),
    onSocketError: vi.fn(() => vi.fn()),
    onSocketMessageSaved: vi.fn(() => vi.fn()),
  };
  const transport = new WebSocketChatTransport({
    getExecutionAccountType: () => 'claude-code' as const,
    chatId: `chat-${subChatId}`,
    subChatId,
    projectId: 'proj-1',
    mode: 'agent',
    onExecuteComplete,
  });
  const messages: UIMessage[] = [
    { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'go' }] },
  ];
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: `chat-${subChatId}`,
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  const sink = new WritableStream<{ type: string }>({ write: (c) => void chunks.push(c) });
  void stream.pipeTo(sink as WritableStream).catch(() => {});
  await waitForAsync();
  expect(hasActiveTransport(subChatId)).toBe(true);
  return {
    onExecuteComplete,
    finishCount: () => chunks.filter((c) => c.type === 'finish').length,
    raw: (payload: Payload) => fireExecuteComplete({ subChatId, ...payload }),
    chunk: (assistantMessageId: string) =>
      fireStreamChunk({ subChatId, assistantMessageId, chunk: { type: 'text-delta', delta: 'x' } }),
    complete: (assistantMessageId?: string) =>
      fireExecuteComplete(assistantMessageId ? { subChatId, assistantMessageId } : { subChatId }),
  };
}

describe('execute-complete without assistantMessageId', () => {
  const subChatId = 'ec-no-id';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appStore.get).mockImplementation((target: unknown) =>
      String(target).includes('lastSelectedModelId') ? 'sonnet' : new Map(),
    );
  });

  afterEach(() => {
    cleanupTransportListeners(subChatId);
    delete (window as unknown as Record<string, unknown>).desktopApi;
  });

  it('does not finalize the run while the transport streams msg-A', async () => {
    const run = await startTurn(subChatId);
    run.chunk('msg-A');
    await waitForAsync();

    run.complete();
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(true);

    // The matching-id completion still finalizes exactly as before.
    run.complete('msg-A');
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(false);
  });

  it('is not buffered when it arrives before the run id is known', async () => {
    const run = await startTurn(subChatId);
    run.complete();
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(true);

    // A buffered id-less payload would be flushed by this first chunk; it must not be.
    run.chunk('msg-A');
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(true);

    run.complete('msg-A');
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(false);
  });

  it('does not clobber a buffered matching completion that is still awaiting its first chunk', async () => {
    const run = await startTurn(subChatId);
    run.complete('msg-A');
    run.complete();
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(true);

    run.chunk('msg-A');
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(false);
    expect(run.finishCount()).toBe(1);
  });

  it.each([
    ['an empty-string id', { assistantMessageId: '' }],
    ['a null id', { assistantMessageId: null }],
    ['only a streamEpoch', { streamEpoch: 'epoch-1' }],
  ])('ignores a completion carrying %s', async (_label, payload) => {
    const run = await startTurn(subChatId);
    run.chunk('msg-A');
    await waitForAsync();

    run.raw(payload);
    await waitForAsync();
    expect(hasActiveTransport(subChatId)).toBe(true);
  });

  it('emits no finish chunk and no refetch for an id-less completion; the matching one does both once', async () => {
    const run = await startTurn(subChatId);
    run.chunk('msg-A');
    await waitForAsync();

    run.complete();
    await waitForAsync();
    expect(run.finishCount()).toBe(0);
    expect(run.onExecuteComplete).not.toHaveBeenCalled();

    run.complete('msg-A');
    await waitForAsync();
    expect(run.finishCount()).toBe(1);
    expect(run.onExecuteComplete).toHaveBeenCalledTimes(1);
    expect(run.onExecuteComplete).toHaveBeenCalledWith(`chat-${subChatId}`);
  });
});
