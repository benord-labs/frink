// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStreamingStatusStore } from '../../../stores/streaming-status-store';

// error-toast-config transitively imports the trpc client, which needs the preload global.
const recoveryMocks = vi.hoisted(() => ({
  getLiveStreamSeed: vi.fn(),
  invalidateSubChatMessages: vi.fn(),
}));
vi.mock('../../../../../lib/trpc', () => ({
  trpcClient: {
    socket: { getLiveStreamSeed: { query: recoveryMocks.getLiveStreamSeed } },
  },
}));
vi.mock('../../../../../lib/mock-api', () => ({
  api: {
    useUtils: () => ({
      chats: {
        getSubChatMessages: { invalidate: recoveryMocks.invalidateSubChatMessages },
      },
    }),
  },
}));

import { useRealtimeSync } from './useRealtimeSync';

const appStoreSet = vi.fn();
const hasActiveTransportMock = vi.fn();
const toastError = vi.fn();
const taskExecutionErrorAtomFamilyMock = vi.fn((subChatId: string) => `taskError:${subChatId}`);
const applyAskUserQuestionChunkMock = vi.fn();

/** Atom values the hook reads back (only observedRunAtomFamily today). */
const atomValues = new Map<string, unknown>();

type StreamChunkPayload = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  chunk: unknown;
  parts?: unknown[];
  messageIndex: number;
  streamEpoch?: string;
};
type ExecuteStartPayload = { chatId: string; subChatId: string; assistantMessageId: string };
type TerminalDurability = { durability: 'committed' } | { durability: 'non-durable' };
type ExecuteCompletePayload = ExecuteStartPayload & {
  metadata?: unknown;
  finalParts?: unknown[];
  wakeBurst?: boolean;
};

let onSocketErrorHandler:
  | ((payload: {
      chatId: string;
      subChatId: string;
      error: string;
      category?: string;
      assistantMessageId?: string;
      streamEpoch?: string;
      terminalDurability?: TerminalDurability;
    }) => void)
  | null = null;
let onStreamChunkHandler: ((payload: StreamChunkPayload) => void) | null = null;
let onExecuteStartHandler: ((payload: ExecuteStartPayload) => void) | null = null;
let onExecuteCompleteHandler: ((payload: ExecuteCompletePayload) => void) | null = null;
let onStreamSettledHandler:
  | ((
      payload: ExecuteStartPayload & {
        streamEpoch: string;
        terminalDurability?: TerminalDurability;
      },
    ) => void)
  | null = null;

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('../../../../../lib/jotai-store', () => ({
  appStore: {
    set: (...args: unknown[]) => {
      atomValues.set(String(args[0]), args[1]);
      return appStoreSet(...args);
    },
    get: (atom: unknown) => atomValues.get(String(atom)),
  },
}));

vi.mock('../../../../../lib/utils/platform', () => ({
  isDesktopApp: () => true,
}));

vi.mock('../../../lib/websocket-chat-transport', () => ({
  hasActiveTransport: (...args: unknown[]) => hasActiveTransportMock(...args),
}));

vi.mock('../../../lib/ask-user-question-chunks', () => ({
  applyAskUserQuestionChunk: (...args: unknown[]) => applyAskUserQuestionChunkMock(...args),
}));

vi.mock('../../../atoms', () => ({
  taskExecutionErrorAtomFamily: (subChatId: string) => taskExecutionErrorAtomFamilyMock(subChatId),
}));

vi.mock('../../../stores/message-store', () => ({
  chatStatusAtom: 'chatStatusAtom',
  remoteStreamingAtom: 'remoteStreamingAtom',
  syncMessagesWithStatusAtom: 'syncMessagesWithStatusAtom',
}));

vi.mock('../../../../../lib/stores/active-transport-registry', () => ({
  observedRunAtomFamily: (subChatId: string) => `observedRun:${subChatId}`,
}));

function createDesktopApiMock() {
  onSocketErrorHandler = null;
  onStreamChunkHandler = null;
  onExecuteStartHandler = null;
  onExecuteCompleteHandler = null;
  onStreamSettledHandler = null;
  return {
    onSocketExecuteStart: vi.fn((handler: (p: ExecuteStartPayload) => void) => {
      onExecuteStartHandler = handler;
      return vi.fn();
    }),
    onSocketStreamChunk: vi.fn((handler: (p: StreamChunkPayload) => void) => {
      onStreamChunkHandler = handler;
      return vi.fn();
    }),
    onSocketMessageSaved: vi.fn(() => vi.fn()),
    onSocketExecuteComplete: vi.fn((handler: (p: ExecuteCompletePayload) => void) => {
      onExecuteCompleteHandler = handler;
      return vi.fn();
    }),
    onSocketError: vi.fn(
      (handler: (payload: { chatId: string; subChatId: string; error: string }) => void) => {
        onSocketErrorHandler = handler;
        return vi.fn();
      },
    ),
    on: vi.fn(
      (
        channel: string,
        handler: (
          payload: ExecuteStartPayload & {
            streamEpoch: string;
            terminalDurability?: TerminalDurability;
          },
        ) => void,
      ) => {
        if (channel === 'socket:stream-settled') onStreamSettledHandler = handler;
        return vi.fn();
      },
    ),
  };
}

/** Mount the hook over a tiny message store so functional setMessages updates are observable. */
function mountHook(options: { isActive?: boolean; subChatId?: string } = {}) {
  const state: { messages: UIMessage[] } = { messages: [] };
  const setMessages = vi.fn((next: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => {
    state.messages = typeof next === 'function' ? next(state.messages) : next;
  });
  const { unmount } = renderHook(() =>
    useRealtimeSync({
      subChatId: options.subChatId ?? 'sub-1',
      chatId: 'chat-1',
      messages: [],
      setMessages,
      isActive: options.isActive ?? true,
    }),
  );
  return Object.assign(state, { unmount });
}

const chunkPayload = (over: Partial<StreamChunkPayload> = {}): StreamChunkPayload => ({
  chatId: 'chat-1',
  subChatId: 'sub-1',
  assistantMessageId: 'msg-1',
  chunk: { type: 'text-delta' },
  parts: [{ type: 'text', text: 'hello' }],
  messageIndex: 1,
  ...over,
});

describe('useRealtimeSync', () => {
  beforeEach(() => {
    appStoreSet.mockReset();
    hasActiveTransportMock.mockReset();
    toastError.mockReset();
    taskExecutionErrorAtomFamilyMock.mockClear();
    applyAskUserQuestionChunkMock.mockReset();
    atomValues.clear();
    recoveryMocks.getLiveStreamSeed.mockReset();
    recoveryMocks.getLiveStreamSeed.mockResolvedValue({
      streams: [],
      terminals: [],
      pendingQuestions: [],
    });
    recoveryMocks.invalidateSubChatMessages.mockReset();
    hasActiveTransportMock.mockReturnValue(false);
    (window as unknown as { desktopApi: unknown }).desktopApi = createDesktopApiMock();
  });

  describe('observer lane — a run no local transport owns (wake burst)', () => {
    it('marks the run observed on the first snapshot chunk', () => {
      // A wake burst has no execute-start of its own (broadcasting one would let its
      // execute-complete finalize a concurrent turn's transport), so liveness starts on content.
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload());

      // Liveness is the app-level lane's to publish; this pane only lands the transcript.
      expect(appStoreSet).not.toHaveBeenCalledWith('observedRun:sub-1', true);
      expect(state.messages).toHaveLength(1);
    });

    it('applies a chunk that carries a parts snapshot', () => {
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload());

      expect(state.messages).toEqual([
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
      ]);
    });

    it('drops a delta-only chunk — no snapshot to repaint from', () => {
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload({ parts: undefined }));

      expect(state.messages).toEqual([]);
    });

    it('ignores chunks while an active transport owns the sub-chat', () => {
      hasActiveTransportMock.mockReturnValue(true);
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload());

      expect(state.messages).toEqual([]);
    });

    it('drops a stale messageIndex so the cumulative snapshot never rewinds', () => {
      const state = mountHook();

      onStreamChunkHandler?.(
        chunkPayload({ messageIndex: 5, parts: [{ type: 'text', text: 'up to date' }] }),
      );
      onStreamChunkHandler?.(
        chunkPayload({ messageIndex: 2, parts: [{ type: 'text', text: 'stale' }] }),
      );

      expect(state.messages).toEqual([
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'up to date' }] },
      ]);
    });

    it('appends a SECOND bubble for the next burst rather than overwriting the first', () => {
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload({ assistantMessageId: 'burst-1' }));
      onStreamChunkHandler?.(
        chunkPayload({ assistantMessageId: 'burst-2', parts: [{ type: 'text', text: 'second' }] }),
      );

      expect(state.messages.map((m) => m.id)).toEqual(['burst-1', 'burst-2']);
    });

    it('raises the question card for a burst that calls AskUserQuestion', () => {
      mountHook();

      const chunk = { type: 'ask-user-question', toolUseId: 'tool-1', questions: [] };
      onStreamChunkHandler?.(chunkPayload({ chunk, parts: undefined }));

      expect(applyAskUserQuestionChunkMock).toHaveBeenCalledWith({
        chunk,
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
      });
    });

    it('execute-complete lands finalParts without touching the observed flag', () => {
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload());
      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
        finalParts: [{ type: 'text', text: 'tail after the last checkpoint' }],
        wakeBurst: true,
      });

      // A completion for ANY message id used to zero the shared flag from a freshly mounted pane
      // (chat switch) while the run was still streaming; the app-level lane owns that flag now.
      expect(appStoreSet).not.toHaveBeenCalledWith('observedRun:sub-1', false);
      expect(state.messages).toEqual([
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'tail after the last checkpoint' }],
        },
      ]);
    });

    it('a burst that produced nothing leaves no bubble behind', () => {
      const state = mountHook();

      // No finalParts at all: an empty burst is simply invisible rather than a blank bubble.
      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
      });

      expect(state.messages).toEqual([]);
    });

    it('keeps a bubble that already streamed content when finalParts is absent', () => {
      const state = mountHook();

      onStreamChunkHandler?.(chunkPayload());
      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
      });

      expect(state.messages).toEqual([
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
      ]);
    });

    it('clears remoteStreaming on completion even from an unfocused pane', () => {
      mountHook({ isActive: false });
      onStreamChunkHandler?.(chunkPayload());

      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
        wakeBurst: true,
      });

      // Leaving it set wedges the FOREGROUND chat's status: syncMessagesWithStatusAtom refuses to
      // touch chatStatusAtom while remoteStreaming is true.
      expect(appStoreSet).toHaveBeenCalledWith('remoteStreamingAtom', false);
      expect(appStoreSet).not.toHaveBeenCalledWith('chatStatusAtom', 'ready');
    });

    it('applies finalParts for a burst that never checkpointed', () => {
      const state = mountHook();

      // A short all-tool burst can complete without a single snapshot chunk reaching this lane.
      // Gating the tail on "did we see a chunk" would silently discard real content.
      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
        finalParts: [{ type: 'text', text: 'ran one command' }],
        wakeBurst: true,
      });

      expect(state.messages).toEqual([
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'ran one command' }] },
      ]);
    });

    it('never applies finalParts for a turn the producer did not mark as a burst', () => {
      // The transport's own execute-complete listener registers first on a pane remount, so by the
      // time this handler runs its finalizeRun has already cleared activeListeners. Reading the
      // registry here would report "no transport" and stomp the AI SDK's own final render — hence
      // the absent wakeBurst flag, not a registry read, is what keeps us out.
      hasActiveTransportMock.mockReturnValue(false);
      const state = mountHook();

      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
        finalParts: [{ type: 'text', text: 'transport owns this' }],
      });

      expect(state.messages).toEqual([]);
    });

    it('still merges sdkMessageUuid so the rollback button appears', () => {
      const state = mountHook();
      onStreamChunkHandler?.(chunkPayload());

      onExecuteCompleteHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
        metadata: { sdkMessageUuid: 'uuid-1' },
      });

      expect(state.messages[0]?.metadata).toEqual({ sdkMessageUuid: 'uuid-1' });
    });
  });

  describe('split view — only the focused pane speaks for the global atoms', () => {
    it('an unfocused pane still subscribes and repaints', () => {
      const state = mountHook({ isActive: false });

      onStreamChunkHandler?.(chunkPayload());

      expect(state.messages).toHaveLength(1);
      expect(appStoreSet).toHaveBeenCalledWith(
        'syncMessagesWithStatusAtom',
        expect.objectContaining({ isActive: false }),
      );
    });

    it('an unfocused pane never writes chatStatus/remoteStreaming', () => {
      mountHook({ isActive: false });

      onStreamChunkHandler?.(chunkPayload());

      expect(appStoreSet).not.toHaveBeenCalledWith('chatStatusAtom', expect.anything());
      expect(appStoreSet).not.toHaveBeenCalledWith('remoteStreamingAtom', expect.anything());
    });

    it('the focused pane does write them', () => {
      mountHook({ isActive: true });

      onExecuteStartHandler?.({
        chatId: 'chat-1',
        subChatId: 'sub-1',
        assistantMessageId: 'msg-1',
      });

      expect(appStoreSet).toHaveBeenCalledWith('chatStatusAtom', 'streaming');
      expect(appStoreSet).toHaveBeenCalledWith('remoteStreamingAtom', true);
    });
  });

  it('writes task execution error signal on socket error for matching sub-chat', () => {
    mountHook();

    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      error: 'Execution failed remotely',
    });

    expect(taskExecutionErrorAtomFamilyMock).toHaveBeenCalledWith('sub-1');
    expect(appStoreSet).toHaveBeenCalledWith(
      'taskError:sub-1',
      expect.objectContaining({
        error: 'Execution failed remotely',
        category: 'UNKNOWN',
      }),
    );
    expect(toastError).toHaveBeenCalledWith('Execution failed', {
      description: 'Execution failed remotely',
    });
  });

  it('refetches a matching chat when observer error wins an in-flight stale seed', async () => {
    let resolveSeed!: (value: {
      streams: Array<{
        chatId: string;
        subChatId: string;
        assistantMessageId: string;
        streamEpoch: string;
        messageIndex: number;
        parts: unknown[];
        textOpen: boolean;
        status: 'active';
        observerOwned: boolean;
      }>;
      terminals: never[];
      pendingQuestions: never[];
    }) => void;
    recoveryMocks.getLiveStreamSeed.mockReturnValue(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );
    mountHook();
    await vi.waitFor(() => expect(recoveryMocks.getLiveStreamSeed).toHaveBeenCalledTimes(1));

    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      assistantMessageId: 'msg-1',
      streamEpoch: 'epoch-1',
      error: 'Execution failed after writing partial output',
      terminalDurability: { durability: 'committed' },
    });
    resolveSeed({
      streams: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          assistantMessageId: 'msg-1',
          streamEpoch: 'epoch-1',
          messageIndex: 0,
          parts: [{ type: 'text', text: 'stale pre-finalize snapshot' }],
          textOpen: true,
          status: 'active',
          observerOwned: true,
        },
      ],
      terminals: [],
      pendingQuestions: [],
    });

    await vi.waitFor(() =>
      expect(recoveryMocks.invalidateSubChatMessages).toHaveBeenCalledWith({ subChatId: 'sub-1' }),
    );
  });

  it('clears a non-durable error epoch without authorizing a transcript refetch', () => {
    mountHook();
    onStreamChunkHandler?.(chunkPayload({ streamEpoch: 'epoch-1' }));

    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      assistantMessageId: 'msg-1',
      streamEpoch: 'epoch-1',
      error: 'failed before SQLite committed',
      terminalDurability: { durability: 'non-durable' },
    });

    expect(recoveryMocks.invalidateSubChatMessages).not.toHaveBeenCalled();
  });

  it('invalidates only after an exact committed settlement', () => {
    mountHook();
    onStreamChunkHandler?.(chunkPayload({ streamEpoch: 'epoch-1' }));

    onStreamSettledHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      assistantMessageId: 'msg-1',
      streamEpoch: 'epoch-1',
      terminalDurability: { durability: 'committed' },
    });

    expect(recoveryMocks.invalidateSubChatMessages).toHaveBeenCalledWith({ subChatId: 'sub-1' });
  });

  it('ignores socket error from another sub-chat', () => {
    mountHook();

    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-2',
      error: 'Other chat failed',
    });

    expect(appStoreSet).not.toHaveBeenCalledWith(
      'taskError:sub-1',
      expect.objectContaining({ error: 'Other chat failed' }),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(recoveryMocks.invalidateSubChatMessages).not.toHaveBeenCalled();
  });

  it('does not invalidate an unrelated parent chat when sub-chat identity collides', () => {
    mountHook();

    onSocketErrorHandler?.({
      chatId: 'chat-2',
      subChatId: 'sub-1',
      error: 'Different parent chat failed',
    });

    expect(recoveryMocks.invalidateSubChatMessages).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a start chunk clears a latched FLOW_RUN_RESUMING signal — the continuation it declined for actually starting is the recovery', () => {
    mountHook();
    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      error: 'declined for re-admission',
      category: 'FLOW_RUN_RESUMING',
    });
    appStoreSet.mockClear();

    onStreamChunkHandler?.(chunkPayload({ chunk: { type: 'start' } }));

    expect(appStoreSet).toHaveBeenCalledWith('taskError:sub-1', null);
  });

  it('a start chunk never clears an UNRELATED latched failure (e.g. NETWORK_ERROR) — only a flow-run decline is scoped as recovered here', () => {
    mountHook();
    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      error: 'offline',
      category: 'NETWORK_ERROR',
    });
    appStoreSet.mockClear();

    onStreamChunkHandler?.(chunkPayload({ chunk: { type: 'start' } }));

    expect(appStoreSet).not.toHaveBeenCalledWith('taskError:sub-1', null);
  });

  it('does not emit fallback error updates when active transport owns sub-chat', () => {
    hasActiveTransportMock.mockReturnValue(true);
    mountHook();

    onSocketErrorHandler?.({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      error: 'Owned by active transport',
    });

    expect(appStoreSet).not.toHaveBeenCalledWith(
      'taskError:sub-1',
      expect.objectContaining({ error: 'Owned by active transport' }),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(recoveryMocks.invalidateSubChatMessages).not.toHaveBeenCalled();
  });

  it('surfaces an error that completed while the replacement renderer was loading', async () => {
    recoveryMocks.getLiveStreamSeed.mockResolvedValue({
      streams: [],
      terminals: [
        {
          subChatId: 'sub-1',
          assistantMessageId: 'assistant-1',
          streamEpoch: 'epoch-error',
          status: 'error',
          error: 'Claude process exited unexpectedly',
          category: 'UNKNOWN',
          durability: 'non-durable',
        },
      ],
      pendingQuestions: [],
    });
    mountHook();

    await vi.waitFor(() =>
      expect(appStoreSet).toHaveBeenCalledWith(
        'taskError:sub-1',
        expect.objectContaining({ error: 'Claude process exited unexpectedly' }),
      ),
    );
    expect(toastError).toHaveBeenCalledWith('Execution failed', {
      description: 'Claude process exited unexpectedly',
    });
  });
});
