// @vitest-environment happy-dom

/** sc-2281: a compacted chat's history starts from its summary. Split from
 * websocket-chat-transport.test.ts, which is at its recorded size ceiling. */

import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

// Copied as-is from websocket-chat-transport.test.ts. Symbol tags are how assertions below tell
// one atom family from another; keep them in that format.
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

vi.mock('../../../../main/lib/claude/types', () => ({}));

vi.mock('../../../../shared/lib/models', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/lib/models')>();
  return {
    ...real,
    // Intentionally simplified vs the real catalog (getClaudeCliModel collapses Opus to `opus`);
    // effort and Ultra stay real, only coerced because some cases leave the model id unset.
    getClaudeSdkEffort: (modelId: unknown) => real.getClaudeSdkEffort(String(modelId ?? '')),
    isClaudeUltraModel: (modelId: unknown) => real.isClaudeUltraModel(String(modelId ?? '')),
    getClaudeCliModel: (modelId: unknown) => {
      const id = String(modelId ?? '');
      if (id.startsWith('opus-4.8')) return 'claude-opus-4-8';
      if (id.startsWith('opus-4.7')) return 'claude-opus-4-7';
      if (id.startsWith('opus')) return 'opus';
      if (id.startsWith('sonnet')) return 'sonnet';
      if (id === 'haiku') return 'haiku';
      return 'sonnet';
    },
    getClaudeThinkingBudget: (modelId: unknown) => {
      const id = String(modelId ?? '');
      if (id.includes('-low')) return 10_000;
      if (id.includes('-high')) return 60_000;
      return 32_000; // Standard/default
    },
    claudeModelRequires1M: (modelId: unknown) => {
      return String(modelId ?? '').includes('-1m');
    },
  };
});

vi.mock('../../../lib/stores/mode-intent', () => ({
  pendingModeIntentAtomFamily: vi.fn((id: string) => Symbol(`pendingModeIntent:${id}`)),
  armModeIntentIfEmpty: vi.fn(() => true),
  ackModeIntent: vi.fn(),
  takeModeIntentForSend: vi.fn(() => undefined),
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

import { trpcClient } from '../../../lib/trpc';
import { clearRollbackFilter, setRollbackFilter } from '../stores/message-store';
import { cleanupTransportListeners, WebSocketChatTransport } from './websocket-chat-transport';

function text(id: string, role: UIMessage['role'], value: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text: value }] } as UIMessage;
}

function compacted(id: string, summary: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'data-compact',
        id: `compact-${id}`,
        data: { state: 'output-available', trigger: 'manual', summary },
      },
    ],
  } as UIMessage;
}

/** Sends `messages` (the last user message is the live prompt) and returns the history it carried. */
async function sentHistory(subChatId: string, messages: UIMessage[]) {
  (window as unknown as Record<string, unknown>).desktopApi = {
    onSocketStreamChunk: vi.fn(() => vi.fn()),
    onSocketExecuteComplete: vi.fn(() => vi.fn()),
    onSocketError: vi.fn(() => vi.fn()),
    onSocketMessageSaved: vi.fn(() => vi.fn()),
  };
  const transport = new WebSocketChatTransport({
    getExecutionAccountType: () => 'claude-code',
    chatId: `chat-${subChatId}`,
    subChatId,
    projectId: 'proj-1',
    mode: 'agent',
  });
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: `chat-${subChatId}`,
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  await stream.cancel();
  const sendCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
    | { history?: Array<{ role: string; content: string }> }
    | undefined;
  cleanupTransportListeners(subChatId);
  return sendCall?.history;
}

describe('history sent for a compacted chat', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).desktopApi;
  });

  it('starts from the compaction summary, not the pre-compaction transcript', async () => {
    const history = await sentHistory('sub-compacted-history', [
      text('u1', 'user', 'long-gone question'),
      text('a1', 'assistant', 'long-gone answer'),
      text('u2', 'user', '/compact'),
      compacted('a2', 'the gist'),
      text('u3', 'user', 'after compaction'),
      text('a3', 'assistant', 'reply after'),
      text('u4', 'user', 'live prompt'),
    ]);

    expect(history).toEqual([
      { role: 'user', content: '[Earlier conversation was compacted. Summary:]\n\nthe gist' },
      { role: 'user', content: 'after compaction' },
      { role: 'assistant', content: 'reply after' },
    ]);
  });

  it('sends the whole history when the compaction itself was rolled back', async () => {
    // The rolled-back card no longer speaks for the chat, so its summary must not replace history.
    const subChatId = 'sub-compaction-rolled-back';
    setRollbackFilter(subChatId, ['compact-user', 'compact-assistant']);

    const history = await sentHistory(subChatId, [
      text('u1', 'user', 'kept question'),
      text('a1', 'assistant', 'kept answer'),
      text('compact-user', 'user', '/compact'),
      compacted('compact-assistant', 'rolled-back summary'),
      text('u2', 'user', 'live prompt'),
    ]);
    clearRollbackFilter(subChatId);

    expect(history).toEqual([
      { role: 'user', content: 'kept question' },
      { role: 'assistant', content: 'kept answer' },
    ]);
  });
});
