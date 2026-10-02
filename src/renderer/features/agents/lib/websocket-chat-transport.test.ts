/* eslint-disable max-lines */
// @vitest-environment happy-dom

import type { UIMessage } from 'ai';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_ABORT_ERROR_PATTERNS } from '../../../../shared/lib/user-abort-error';

vi.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../main/lib/claude/types', () => ({}));

const launchFlagsState = vi.hoisted(() => ({ overrides: {} as Record<string, boolean> }));
vi.mock('../../../../shared/launch-flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/launch-flags')>();
  return {
    get LAUNCH_FLAGS() {
      return { ...actual.LAUNCH_FLAGS, ...launchFlagsState.overrides };
    },
  };
});

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
  pendingUserQuestionsAtom: Symbol('pendingUserQuestionsAtom'),
  retryInFlightAtomFamily: vi.fn((subChatId: string) => Symbol(`retryInFlight:${subChatId}`)),
  taskExecutionErrorAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`taskExecutionError:${subChatId}`),
  ),
}));

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

const subChatStoreMock = vi.hoisted(() => ({
  allSubChats: [] as Array<{ id: string; mode: string }>,
  updateSubChatMode: vi.fn(),
}));
vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({
      allSubChats: subChatStoreMock.allSubChats,
      updateSubChatMode: subChatStoreMock.updateSubChatMode,
    }),
  },
}));

import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import { appStore } from '../../../lib/jotai-store';
import { trpcClient } from '../../../lib/trpc';
import { clearRollbackFilter, setRollbackFilter } from '../stores/message-store';
import {
  cleanupTransportListeners,
  hasActiveTransport,
  WebSocketChatTransport,
} from './websocket-chat-transport';

/** Allow async listener delivery and stream enqueue; single place to switch to fake timers if needed. */
const waitForAsync = async (ms = 50): Promise<void> => {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(ms);
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
};

const USER_ABORT_ERROR_VARIANTS = [...USER_ABORT_ERROR_PATTERNS];

const defaultSendMessagesPayload = (chatId: string) => ({
  trigger: 'submit-message' as const,
  chatId,
  messageId: undefined as string | undefined,
  messages: [
    {
      id: 'msg-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'hello' }],
    },
  ],
  abortSignal: undefined as AbortSignal | undefined,
});

beforeEach(() => {
  vi.mocked(appStore.get).mockImplementation(() => new Map());
});

describe('websocket-chat-transport', () => {
  describe('hasActiveTransport', () => {
    it('returns false for unknown subChatId', () => {
      expect(hasActiveTransport('nonexistent')).toBe(false);
    });
  });

  describe('cleanupTransportListeners', () => {
    it('does not throw for unknown subChatId', () => {
      expect(() => cleanupTransportListeners('nonexistent')).not.toThrow();
    });

    it('clears the observed-run flag on teardown but NOT when re-registering for a send', () => {
      const setSpy = vi.mocked(appStore.set);

      // Teardown (chat deleted/moved, or run aborted): the flag must not outlive the chat.
      setSpy.mockClear();
      cleanupTransportListeners('sub-teardown');
      expect(setSpy).toHaveBeenCalledWith(expect.anything(), false);

      // Re-register before a new send: an adopted wake burst keeps streaming under its own
      // assistant id, so clearing here would make the observer lane drop that burst's finalParts.
      setSpy.mockClear();
      cleanupTransportListeners('sub-resend', false);
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  describe('WebSocketChatTransport', () => {
    it('can be constructed', () => {
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'proj-1',
        mode: 'agent',
      });
      expect(transport).toBeDefined();
    });

    describe('flow plan resume — flips plan→agent before send', () => {
      const FLOW_PLAN_SUBCHAT = 'sub-flow-plan';
      const flowPlanReadyMessages = [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'tool-frink-plan', input: { status: 'awaiting_approval', flowDriven: true } },
          ],
        },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'carry on' }] },
      ] as unknown as UIMessage[];

      const makeTransport = () =>
        new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-flow-plan',
          subChatId: FLOW_PLAN_SUBCHAT,
          projectId: 'proj-1',
          mode: 'plan',
        });

      beforeEach(() => {
        subChatStoreMock.allSubChats = [{ id: FLOW_PLAN_SUBCHAT, mode: 'plan' }];
        subChatStoreMock.updateSubChatMode.mockClear();
      });

      it('flips plan→agent when a flow-driven plan is parked and the user replies', async () => {
        // The flip is synchronous (before currentMode is read); the rest of sendMessages may reject
        // in the mocked env, so swallow it — the assertion is about the pre-send flip.
        await makeTransport()
          .sendMessages({
            ...defaultSendMessagesPayload('chat-flow-plan'),
            messages: flowPlanReadyMessages,
          })
          .catch(() => undefined);
        expect(subChatStoreMock.updateSubChatMode).toHaveBeenCalledWith(FLOW_PLAN_SUBCHAT, 'agent');
      });

      it('does NOT flip a non-flow plan chat (plan-ready without flowDriven)', async () => {
        const messages = [
          {
            id: 'a1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-frink-plan',
                input: { status: 'awaiting_approval', flowDriven: false },
              },
            ],
          },
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'tweak the plan' }] },
        ] as unknown as UIMessage[];
        await makeTransport()
          .sendMessages({ ...defaultSendMessagesPayload('chat-flow-plan'), messages })
          .catch(() => undefined);
        expect(subChatStoreMock.updateSubChatMode).not.toHaveBeenCalled();
      });

      it('does NOT flip on regenerate (only a real submit resumes)', async () => {
        await makeTransport()
          .sendMessages({
            ...defaultSendMessagesPayload('chat-flow-plan'),
            trigger: 'regenerate-message',
            messages: flowPlanReadyMessages,
          })
          .catch(() => undefined);
        expect(subChatStoreMock.updateSubChatMode).not.toHaveBeenCalled();
      });

      it('does NOT flip a flow-dispatched prompt (a later plan node must stay in plan mode)', async () => {
        // A second plan node continuing this chat sends its prompt through the message queue with
        // FLOW_DISPATCH_SOURCE metadata; only human-typed replies mean approve-then-execute.
        const messages = [
          flowPlanReadyMessages[0],
          {
            id: 'u-flow',
            role: 'user',
            parts: [{ type: 'text', text: 'plan the next story' }],
            metadata: { source: 'flow-dispatch' },
          },
        ] as unknown as UIMessage[];
        await makeTransport()
          .sendMessages({ ...defaultSendMessagesPayload('chat-flow-plan'), messages })
          .catch(() => undefined);
        expect(subChatStoreMock.updateSubChatMode).not.toHaveBeenCalled();
      });

      // Store-gating/intent cases live in websocket-chat-transport.mode-intent.test.ts.
    });

    it('keeps AskUserQuestion timeout/result lifecycle consistent', async () => {
      const subChatId = 'sub-ask-lifecycle';
      let onSocketStreamChunk: (payload: {
        subChatId: string;
        assistantMessageId: string;
        chunk: { type: string; toolUseId?: string; result?: unknown };
      }) => void = () => {};
      const pendingState = new Map<string, { subChatId: string; toolUseId: string }>([
        ['tool-ask-1', { subChatId, toolUseId: 'tool-ask-1' }],
      ]);
      const expiredState = new Map<string, { toolUseId: string }>();
      const resultState = new Map<string, unknown>();

      vi.mocked(appStore.get).mockImplementation((atom) => {
        const key = String(atom);
        if (key.includes('pendingUserQuestionsAtom')) return pendingState;
        if (key.includes('expiredUserQuestionsAtom')) return expiredState;
        if (key.includes('askUserQuestionResultsAtom')) return resultState;
        return new Map();
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        const key = String(atom);
        const syncMap = (target: Map<string, unknown>, next: unknown) => {
          if (!(next instanceof Map)) return;
          target.clear();
          for (const [entryKey, entryValue] of next.entries()) {
            target.set(entryKey, entryValue);
          }
        };
        if (key.includes('pendingUserQuestionsAtom')) {
          syncMap(pendingState as unknown as Map<string, unknown>, value);
        }
        if (key.includes('expiredUserQuestionsAtom')) {
          syncMap(expiredState as unknown as Map<string, unknown>, value);
        }
        if (key.includes('askUserQuestionResultsAtom')) {
          syncMap(resultState, value);
        }
      });

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              assistantMessageId: string;
              chunk: { type: string; toolUseId?: string; result?: unknown };
            }) => void,
          ) => {
            onSocketStreamChunk = cb;
            return vi.fn();
          },
        ),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-ask-lifecycle',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const stream = await transport.sendMessages(defaultSendMessagesPayload('chat-ask-lifecycle'));

      // One question's lifecycle belongs to ONE assistant message; the run only adopts an id once.
      onSocketStreamChunk({
        subChatId,
        assistantMessageId: 'assistant-ask-1',
        chunk: { type: 'ask-user-question-timeout', toolUseId: 'tool-ask-1' },
      });
      await waitForAsync();
      expect(pendingState.has('tool-ask-1')).toBe(false);
      expect(expiredState.get('tool-ask-1')).toEqual({ subChatId, toolUseId: 'tool-ask-1' });

      onSocketStreamChunk({
        subChatId,
        assistantMessageId: 'assistant-ask-1',
        chunk: {
          type: 'ask-user-question-result',
          toolUseId: 'tool-ask-1',
          result: { answers: { approved: true } },
        },
      });
      await waitForAsync();
      expect(resultState.get('tool-ask-1')).toEqual({ answers: { approved: true } });
      expect(expiredState.get('tool-ask-1')).toEqual({ subChatId, toolUseId: 'tool-ask-1' });

      await stream.cancel();
      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('forwards regenerate trigger to socket sendMessage mutation', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-trigger',
        subChatId: 'sub-trigger',
        projectId: 'proj-1',
        mode: 'agent',
      });

      const stream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-trigger'),
        trigger: 'regenerate-message',
      });
      await stream.cancel();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { trigger?: string }
        | undefined;
      expect(call?.trigger).toBe('regenerate-message');

      cleanupTransportListeners('sub-trigger');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('expects the dispatching task as the Flow step; a user reply expects none', async () => {
      const taskUuid = '550e8400-e29b-41d4-a716-446655440001';
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-eft',
        subChatId: 'sub-eft',
        projectId: 'proj-1',
        mode: 'agent',
      });
      const lastCall = () => vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0];
      await (await transport.sendMessages(defaultSendMessagesPayload('chat-eft'))).cancel();
      expect(lastCall()?.expectedFlowTaskId).toBeUndefined();

      const payload = defaultSendMessagesPayload('chat-eft');
      const messages = [{ ...payload.messages[0], metadata: { dispatchTaskId: taskUuid } }];
      await (await transport.sendMessages({ ...payload, messages })).cancel();
      expect(lastCall()).toEqual(
        expect.objectContaining({ dispatchTaskId: taskUuid, expectedFlowTaskId: taskUuid }),
      );
      cleanupTransportListeners('sub-eft');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('forwards user metadata for persistence and cross-window message sync', async () => {
      const subChatId = 'sub-user-metadata';
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
      const metadata = {
        source: 'flow-dispatch',
        answeredQuestions: [{ question: 'Proceed?', answer: 'Yes' }],
      };
      const payload = defaultSendMessagesPayload('chat-user-metadata');
      (payload.messages[0] as unknown as { metadata?: typeof metadata }).metadata = metadata;

      try {
        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-user-metadata',
          subChatId,
          projectId: 'proj-1',
          mode: 'agent',
        });
        const stream = await transport.sendMessages(payload);
        await stream.cancel();

        const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
          | { userMessage?: { metadata?: typeof metadata } }
          | undefined;
        expect(call?.userMessage?.metadata).toEqual(metadata);
      } finally {
        cleanupTransportListeners(subChatId);
        delete (window as unknown as Record<string, unknown>).desktopApi;
      }
    });

    /**
     * Send one message through a transport and return the settings sent via tRPC.
     * Handles desktopApi setup/teardown so each model-resolution test is a one-liner.
     */
    async function sendAndGetSettings(
      modelId: string,
      accountType: 'codex' | 'claude-code',
      tag: string,
    ): Promise<Record<string, unknown>> {
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (String(atom).includes('lastSelectedModelId')) return modelId;
        return new Map();
      });
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
      const subId = `sub-${tag}`;
      try {
        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => accountType,
          chatId: `chat-${tag}`,
          subChatId: subId,
          projectId: 'proj-1',
          mode: 'agent',
        });
        const stream = await transport.sendMessages(defaultSendMessagesPayload(`chat-${tag}`));
        await stream.cancel();
        return (
          (
            vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
              | { settings?: Record<string, unknown> }
              | undefined
          )?.settings ?? {}
        );
      } finally {
        cleanupTransportListeners(subId);
        delete (window as unknown as Record<string, unknown>).desktopApi;
      }
    }

    it('forwards a Codex picker id raw — the executor owns the slug/effort split', async () => {
      const s = await sendAndGetSettings('codex-gpt-5.3-codex-high', 'codex', 'model-codex');
      expect(s.model).toBe('codex-gpt-5.3-codex-high');
      expect(s.maxThinkingTokens).toBeUndefined();
    });

    it('reads getExecutionAccountType at send time so account switch updates mapping', async () => {
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (String(atom).includes('lastSelectedModelId')) return 'sonnet';
        return new Map();
      });
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      let sendIdx = 0;
      const account = vi.fn(() => (sendIdx++ === 0 ? 'claude-code' : 'codex'));

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: account,
        chatId: 'chat-switch',
        subChatId: 'sub-switch',
        projectId: 'proj-1',
        mode: 'agent',
      });
      const first = await transport.sendMessages(defaultSendMessagesPayload('chat-switch'));
      await first.cancel();
      const second = await transport.sendMessages(defaultSendMessagesPayload('chat-switch'));
      await second.cancel();

      const calls = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.slice(-2);
      // SAFETY: the mutate mock records the payload the transport sent; only settings.model is read.
      expect((calls[0]?.[0] as { settings?: { model?: string } })?.settings?.model).toBe('sonnet');
      // SAFETY: same recorded payload, second send.
      expect((calls[1]?.[0] as { settings?: { model?: string } })?.settings?.model).toBe('sonnet');

      cleanupTransportListeners('sub-switch');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('falls back to sonnet when selected model id is unknown', async () => {
      expect(
        (await sendAndGetSettings('unknown-model', 'claude-code', 'model-fallback')).model,
      ).toBe('sonnet');
    });

    it('keeps model resolution scoped per chat id across consecutive sends', async () => {
      vi.mocked(appStore.get).mockImplementation((atom) => {
        const key = String(atom);
        if (key.includes('lastSelectedModelId:chat-A')) return 'codex-gpt-5.3-codex-high';
        if (key.includes('lastSelectedModelId:chat-B')) return 'sonnet';
        return new Map();
      });
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transportA = new WebSocketChatTransport({
        getExecutionAccountType: () => 'codex',
        chatId: 'chat-A',
        subChatId: 'sub-A',
        projectId: 'proj-1',
        mode: 'agent',
      });
      const streamA = await transportA.sendMessages(defaultSendMessagesPayload('chat-A'));
      await streamA.cancel();

      const transportB = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-B',
        subChatId: 'sub-B',
        projectId: 'proj-2',
        mode: 'agent',
      });
      const streamB = await transportB.sendMessages(defaultSendMessagesPayload('chat-B'));
      await streamB.cancel();

      const [callA, callB] = vi
        .mocked(trpcClient.socket.sendMessage.mutate)
        .mock.calls.slice(-2)
        .map((entry) => entry[0] as { settings?: { model?: string } });
      expect(callA.settings?.model).toBe('codex-gpt-5.3-codex-high');
      // With the new model system, 'sonnet' maps to 'sonnet' CLI value
      expect(callB.settings?.model).toBe('sonnet');

      cleanupTransportListeners('sub-A');
      cleanupTransportListeners('sub-B');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('does not reuse previous chat model after move-driven chat switch', async () => {
      vi.mocked(appStore.get).mockImplementation((atom) => {
        const key = String(atom);
        if (key.includes('lastSelectedModelId:chat-before-move')) return 'codex-gpt-5.3-codex-high';
        if (key.includes('lastSelectedModelId:chat-after-move')) return 'unknown-model';
        return new Map();
      });
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const beforeMove = new WebSocketChatTransport({
        getExecutionAccountType: () => 'codex',
        chatId: 'chat-before-move',
        subChatId: 'sub-before-move',
        projectId: 'proj-old',
        mode: 'agent',
      });
      const beforeStream = await beforeMove.sendMessages(
        defaultSendMessagesPayload('chat-before-move'),
      );
      await beforeStream.cancel();

      const afterMove = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-after-move',
        subChatId: 'sub-after-move',
        projectId: 'proj-new',
        mode: 'agent',
      });
      const afterStream = await afterMove.sendMessages(
        defaultSendMessagesPayload('chat-after-move'),
      );
      await afterStream.cancel();

      const [beforeCall, afterCall] = vi
        .mocked(trpcClient.socket.sendMessage.mutate)
        .mock.calls.slice(-2)
        .map((entry) => entry[0] as { settings?: { model?: string } });
      expect(beforeCall.settings?.model).toBe('codex-gpt-5.3-codex-high');
      // 'unknown-model' falls back to 'sonnet' with the new model system
      expect(afterCall.settings?.model).toBe('sonnet');

      cleanupTransportListeners('sub-before-move');
      cleanupTransportListeners('sub-after-move');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });
  });

  describe('rollback classification (shouldRollbackExecutionError)', () => {
    it('does not call onExecutionError for "not authenticated on this machine" (no rollback)', async () => {
      const subChatId = 'rollback-auth-sub';
      let onSocketError: (payload: { subChatId: string; error: string }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn((cb: (payload: { subChatId: string; error: string }) => void) => {
          onSocketError = cb;
          return vi.fn();
        }),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const onExecutionError = vi.fn();
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-rollback',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
        onExecutionError,
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-rollback'));
      onSocketError({
        subChatId,
        error: 'Account is not authenticated on this machine. Sign in on the execution machine.',
      });
      await waitForAsync();

      expect(onExecutionError).not.toHaveBeenCalled();
      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('ignores user-abort onSocketError without rollback or toast', async () => {
      const subChatId = 'rollback-user-abort-sub';
      let onSocketError: (payload: { subChatId: string; error: string }) => void = () => {};
      const cleanupStreamChunk = vi.fn();
      const cleanupExecuteComplete = vi.fn();
      const cleanupError = vi.fn();
      const cleanupMessageSaved = vi.fn();

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => cleanupStreamChunk),
        onSocketExecuteComplete: vi.fn(() => cleanupExecuteComplete),
        onSocketError: vi.fn((cb: (payload: { subChatId: string; error: string }) => void) => {
          onSocketError = cb;
          return cleanupError;
        }),
        onSocketMessageSaved: vi.fn(() => cleanupMessageSaved),
      };

      const onExecutionError = vi.fn();
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-rollback-user-abort',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
        onExecutionError,
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-rollback-user-abort'));
      onSocketError({ subChatId, error: 'Claude Code process aborted by user' });
      await waitForAsync();

      expect(onExecutionError).not.toHaveBeenCalled();
      expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
        'Execution failed',
        expect.objectContaining({ description: expect.stringContaining('aborted by user') }),
      );
      expect(cleanupStreamChunk).toHaveBeenCalledTimes(1);
      expect(cleanupExecuteComplete).toHaveBeenCalledTimes(1);
      expect(cleanupError).toHaveBeenCalledTimes(1);
      expect(cleanupMessageSaved).toHaveBeenCalledTimes(1);
      const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } })
        .mock.calls;
      const clearTaskErrorCall = setCalls.find(
        (call) => String(call[0]).includes(`taskExecutionError:${subChatId}`) && call[1] === null,
      );
      expect(clearTaskErrorCall).toBeTruthy();
      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it.each(USER_ABORT_ERROR_VARIANTS)(
      'suppresses onSocketError variant: %s',
      async (abortErrorText) => {
        const subChatId = `rollback-user-abort-${abortErrorText.replaceAll(/\W+/g, '-').toLowerCase()}`;
        let onSocketError: (payload: { subChatId: string; error: string }) => void = () => {};

        (window as unknown as Record<string, unknown>).desktopApi = {
          onSocketStreamChunk: vi.fn(() => vi.fn()),
          onSocketExecuteComplete: vi.fn(() => vi.fn()),
          onSocketError: vi.fn((cb: (payload: { subChatId: string; error: string }) => void) => {
            onSocketError = cb;
            return vi.fn();
          }),
          onSocketMessageSaved: vi.fn(() => vi.fn()),
        };

        const onExecutionError = vi.fn();
        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-rollback-user-abort-variants',
          subChatId,
          projectId: 'proj-1',
          mode: 'agent',
          onExecutionError,
        });

        await transport.sendMessages(
          defaultSendMessagesPayload('chat-rollback-user-abort-variants'),
        );
        onSocketError({ subChatId, error: abortErrorText });
        await waitForAsync();

        expect(onExecutionError).not.toHaveBeenCalled();
        expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
          'Execution failed',
          expect.objectContaining({ description: expect.stringContaining('aborted') }),
        );
        cleanupTransportListeners(subChatId);
        delete (window as unknown as Record<string, unknown>).desktopApi;
      },
    );
  });

  describe('socket:error category threading (usage limit must not fail tasks or roll back)', () => {
    type ErrorPayload = { subChatId: string; error: string; category?: string };

    function setupErrorTransport(chatId: string, subChatId: string) {
      let fireSocketError: (payload: ErrorPayload) => void = () => {};
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn((cb: (payload: ErrorPayload) => void) => {
          fireSocketError = cb;
          return vi.fn();
        }),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
      const onExecutionError = vi.fn();
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId,
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
        onExecutionError,
      });
      return {
        transport,
        onExecutionError,
        fireSocketError: (p: ErrorPayload) => fireSocketError(p),
      };
    }

    function taskErrorSignalFor(subChatId: string): { category?: string } | undefined {
      const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } })
        .mock.calls;
      const call = setCalls.find(
        (c) => String(c[0]).includes(`taskExecutionError:${subChatId}`) && c[1] != null,
      );
      return call?.[1] as { category?: string } | undefined;
    }

    it('RATE_LIMIT_SDK: limit toast, signal carries the category, NO rollback', async () => {
      const subChatId = 'limit-category-sub';
      const { transport, onExecutionError, fireSocketError } = setupErrorTransport(
        'chat-limit-category',
        subChatId,
      );

      await transport.sendMessages(defaultSendMessagesPayload('chat-limit-category'));
      fireSocketError({
        subChatId,
        error: "Claude Code returned an error result: You've hit your limit · resets 2:20pm",
        category: 'RATE_LIMIT_SDK',
      });
      await waitForAsync();

      // The categorized toast (with View-usage action), not the generic failure toast.
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Session limit reached',
        expect.objectContaining({ description: "You've hit the Claude Code usage limit." }),
      );
      // Signal category drives isExecutionLevelFailure → useTaskCompletionDetection must NOT
      // fail the task (RATE_LIMIT_SDK is a non-execution category).
      expect(taskErrorSignalFor(subChatId)?.category).toBe('RATE_LIMIT_SDK');
      // No user-message rollback on a resumable limit interruption.
      expect(onExecutionError).not.toHaveBeenCalled();

      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('a send declined with a server category shows only that category toast', async () => {
      const { transport } = setupErrorTransport('chat-declined', 'sub-declined');
      vi.mocked(trpcClient.socket.sendMessage.mutate).mockResolvedValueOnce({
        success: false,
        reason: 'This Flow step changed. Refresh before replying.',
        category: 'FLOW_RUN_ENDED',
      } as never);
      await (await transport.sendMessages(defaultSendMessagesPayload('chat-declined'))).cancel();
      await waitForAsync();
      // Same title and dedup id as the run error the executor emits for the same decline.
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'This flow run has ended',
        expect.objectContaining({ id: 'flow-run-ended:sub-declined' }),
      );
      expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
        'Failed to send message',
        expect.anything(),
      );
      cleanupTransportListeners('sub-declined');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('no category: generic failure toast, UNKNOWN signal, rollback preserved', async () => {
      const subChatId = 'unknown-category-sub';
      const { transport, onExecutionError, fireSocketError } = setupErrorTransport(
        'chat-unknown-category',
        subChatId,
      );

      await transport.sendMessages(defaultSendMessagesPayload('chat-unknown-category'));
      fireSocketError({ subChatId, error: 'claude stream exploded' });
      await waitForAsync();

      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Execution failed',
        expect.objectContaining({ description: expect.stringContaining('exploded') }),
      );
      expect(taskErrorSignalFor(subChatId)?.category).toBe('UNKNOWN');
      expect(onExecutionError).toHaveBeenCalledWith(subChatId);

      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });
  });

  describe('persistent retry metadata capture', () => {
    it('stores retry payload when socket execute:error fires', async () => {
      const subChatId = 'retry-meta-sub';
      let onSocketError: (payload: { subChatId: string; error: string }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn((cb: (payload: { subChatId: string; error: string }) => void) => {
          onSocketError = cb;
          return vi.fn();
        }),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-retry-meta',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-retry-meta'));
      onSocketError({ subChatId, error: 'provider unavailable' });
      await waitForAsync();

      const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } })
        .mock.calls;
      const retryCall = setCalls.find(
        (call) =>
          typeof call[1] === 'object' &&
          call[1] !== null &&
          (call[1] as { subChatId?: string }).subChatId === subChatId &&
          (call[1] as { errorCategory?: string }).errorCategory === 'UNKNOWN',
      );

      expect(retryCall).toBeTruthy();
      const payload = retryCall?.[1] as { errorText?: string };
      expect(payload).not.toHaveProperty('parts');
      expect(payload.errorText).toBe('provider unavailable');

      const taskErrorSignalCall = setCalls.find((call) => {
        const target = String(call[0]);
        return (
          target.includes(`taskExecutionError:${subChatId}`) &&
          typeof call[1] === 'object' &&
          call[1] !== null &&
          (call[1] as { error?: string }).error === 'provider unavailable' &&
          (call[1] as { category?: string }).category === 'UNKNOWN'
        );
      });
      expect(taskErrorSignalCall).toBeTruthy();
      expect(typeof (taskErrorSignalCall?.[1] as { timestamp?: unknown }).timestamp).toBe('number');
    });

    it('writes task execution error signal when error arrives via stream chunk', async () => {
      const subChatId = 'retry-meta-stream-sub';
      let onSocketStreamChunk: (payload: {
        subChatId: string;
        assistantMessageId: string;
        chunk: { type: string; errorText?: string; debugInfo?: { category?: string } };
      }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              assistantMessageId: string;
              chunk: { type: string; errorText?: string; debugInfo?: { category?: string } };
            }) => void,
          ) => {
            onSocketStreamChunk = cb;
            return vi.fn();
          },
        ),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-retry-meta-stream',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-retry-meta-stream'));
      onSocketStreamChunk({
        subChatId,
        assistantMessageId: 'assistant-stream-error',
        chunk: {
          type: 'error',
          errorText: 'streamed execution failure',
          debugInfo: { category: 'UNKNOWN' },
        },
      });
      await waitForAsync();

      const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } })
        .mock.calls;
      const taskErrorSignalCall = setCalls.find((call) => {
        const target = String(call[0]);
        return (
          target.includes(`taskExecutionError:${subChatId}`) &&
          typeof call[1] === 'object' &&
          call[1] !== null &&
          (call[1] as { error?: string }).error === 'streamed execution failure' &&
          (call[1] as { category?: string }).category === 'UNKNOWN'
        );
      });

      expect(taskErrorSignalCall).toBeTruthy();
      expect(typeof (taskErrorSignalCall?.[1] as { timestamp?: unknown }).timestamp).toBe('number');
    });

    it('suppresses user-abort stream errors without retry/toast side effects', async () => {
      const subChatId = 'retry-meta-stream-user-abort';
      let onSocketStreamChunk: (payload: {
        subChatId: string;
        assistantMessageId: string;
        chunk: { type: string; errorText?: string; debugInfo?: { category?: string } };
      }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              assistantMessageId: string;
              chunk: { type: string; errorText?: string; debugInfo?: { category?: string } };
            }) => void,
          ) => {
            onSocketStreamChunk = cb;
            return vi.fn();
          },
        ),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-retry-meta-stream-user-abort',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-retry-meta-stream-user-abort'));
      onSocketStreamChunk({
        subChatId,
        assistantMessageId: 'assistant-stream-user-abort',
        chunk: {
          type: 'error',
          errorText: 'Claude Code process aborted by user',
          debugInfo: { category: 'UNKNOWN' },
        },
      });
      await waitForAsync();

      expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
        'Chat error',
        expect.objectContaining({ description: expect.stringContaining('aborted by user') }),
      );
      const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } })
        .mock.calls;
      const taskErrorSet = setCalls.find((call) =>
        String(call[0]).includes(`taskExecutionError:${subChatId}`),
      );
      expect(taskErrorSet?.[1]).toBeNull();
    });

    it.each(USER_ABORT_ERROR_VARIANTS)(
      'suppresses stream error variant: %s',
      async (abortErrorText) => {
        const subChatId = `retry-meta-stream-${abortErrorText.replaceAll(/\W+/g, '-').toLowerCase()}`;
        let onSocketStreamChunk: (payload: {
          subChatId: string;
          assistantMessageId: string;
          chunk: { type: string; errorText?: string; debugInfo?: { category?: string } };
        }) => void = () => {};

        (window as unknown as Record<string, unknown>).desktopApi = {
          onSocketStreamChunk: vi.fn(
            (
              cb: (payload: {
                subChatId: string;
                assistantMessageId: string;
                chunk: { type: string; errorText?: string; debugInfo?: { category?: string } };
              }) => void,
            ) => {
              onSocketStreamChunk = cb;
              return vi.fn();
            },
          ),
          onSocketExecuteComplete: vi.fn(() => vi.fn()),
          onSocketError: vi.fn(() => vi.fn()),
          onSocketMessageSaved: vi.fn(() => vi.fn()),
        };

        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-retry-meta-stream-variants',
          subChatId,
          projectId: 'proj-1',
          mode: 'agent',
        });

        await transport.sendMessages(defaultSendMessagesPayload('chat-retry-meta-stream-variants'));
        onSocketStreamChunk({
          subChatId,
          assistantMessageId: 'assistant-stream-user-abort-variant',
          chunk: {
            type: 'error',
            errorText: abortErrorText,
            debugInfo: { category: 'UNKNOWN' },
          },
        });
        await waitForAsync();

        expect(vi.mocked(toast.error)).not.toHaveBeenCalledWith(
          'Chat error',
          expect.objectContaining({ description: expect.stringContaining('aborted') }),
        );
        const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } })
          .mock.calls;
        const taskErrorSet = setCalls.find((call) =>
          String(call[0]).includes(`taskExecutionError:${subChatId}`),
        );
        expect(taskErrorSet?.[1]).toBeNull();
      },
    );
  });

  describe('stale onSocketError race protection', () => {
    it('ignores stale prior-run socket errors while a new run is active in same subChat', async () => {
      const subChatId = 'stale-error-race-subchat';
      let onSocketError: (payload: {
        subChatId: string;
        error: string;
        assistantMessageId?: string;
      }) => void = () => {};
      let onSocketStreamChunk: (payload: {
        subChatId: string;
        assistantMessageId: string;
        chunk: { type: string };
      }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              assistantMessageId: string;
              chunk: { type: string };
            }) => void,
          ) => {
            onSocketStreamChunk = cb;
            return vi.fn();
          },
        ),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              error: string;
              assistantMessageId?: string;
            }) => void,
          ) => {
            onSocketError = cb;
            return vi.fn();
          },
        ),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-stale-race',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const first = await transport.sendMessages(defaultSendMessagesPayload('chat-stale-race'));
      const second = await transport.sendMessages(defaultSendMessagesPayload('chat-stale-race'));
      await first.cancel();

      onSocketStreamChunk({
        subChatId,
        assistantMessageId: 'assistant-current-run',
        chunk: { type: 'text-delta' },
      });
      onSocketError({
        subChatId,
        error: 'provider unavailable',
        assistantMessageId: 'assistant-stale-run',
      });
      await waitForAsync();

      expect(hasActiveTransport(subChatId)).toBe(true);
      await second.cancel();
    });

    it('ignores stale socket errors emitted before first chunk when execute-start set run id', async () => {
      const subChatId = 'stale-error-before-first-chunk-subchat';
      let onSocketError: (payload: {
        subChatId: string;
        error: string;
        assistantMessageId?: string;
      }) => void = () => {};
      let onSocketExecuteStart: (payload: {
        subChatId: string;
        assistantMessageId: string;
      }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteStart: vi.fn(
          (cb: (payload: { subChatId: string; assistantMessageId: string }) => void) => {
            onSocketExecuteStart = cb;
            return vi.fn();
          },
        ),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              error: string;
              assistantMessageId?: string;
            }) => void,
          ) => {
            onSocketError = cb;
            return vi.fn();
          },
        ),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-stale-before-first-chunk',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const first = await transport.sendMessages(
        defaultSendMessagesPayload('chat-stale-before-first-chunk'),
      );
      const second = await transport.sendMessages(
        defaultSendMessagesPayload('chat-stale-before-first-chunk'),
      );
      await first.cancel();

      onSocketExecuteStart({
        subChatId,
        assistantMessageId: 'assistant-current-run',
      });
      onSocketError({
        subChatId,
        error: 'provider unavailable',
        assistantMessageId: 'assistant-stale-run',
      });
      await waitForAsync();

      expect(hasActiveTransport(subChatId)).toBe(true);
      await second.cancel();
    });

    it('ignores delayed stale execute:start that would otherwise poison run identity', async () => {
      const subChatId = 'stale-delayed-start-poison-subchat';
      let onSocketError: (payload: {
        subChatId: string;
        error: string;
        assistantMessageId?: string;
      }) => void = () => {};
      let onSocketExecuteStart: (payload: {
        subChatId: string;
        assistantMessageId: string;
      }) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteStart: vi.fn(
          (cb: (payload: { subChatId: string; assistantMessageId: string }) => void) => {
            onSocketExecuteStart = cb;
            return vi.fn();
          },
        ),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(
          (
            cb: (payload: {
              subChatId: string;
              error: string;
              assistantMessageId?: string;
            }) => void,
          ) => {
            onSocketError = cb;
            return vi.fn();
          },
        ),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-stale-delayed-start-poison',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const first = await transport.sendMessages(
        defaultSendMessagesPayload('chat-stale-delayed-start-poison'),
      );
      const second = await transport.sendMessages(
        defaultSendMessagesPayload('chat-stale-delayed-start-poison'),
      );
      await first.cancel();

      // Current run starts as B.
      onSocketExecuteStart({
        subChatId,
        assistantMessageId: 'assistant-current-run',
      });
      const toastErrorCallCountBefore = vi.mocked(toast.error).mock.calls.length;
      // Delayed stale start from A should be ignored.
      onSocketExecuteStart({
        subChatId,
        assistantMessageId: 'assistant-stale-run',
      });
      // Stale error from A must still be ignored.
      onSocketError({
        subChatId,
        error: 'provider unavailable',
        assistantMessageId: 'assistant-stale-run',
      });
      await waitForAsync();

      const newToastCalls = vi.mocked(toast.error).mock.calls.slice(toastErrorCallCountBefore);
      const hasProviderUnavailableToast = newToastCalls.some((call) => {
        const [title, options] = call;
        return (
          title === 'Execution failed' &&
          typeof options === 'object' &&
          options !== null &&
          'description' in options &&
          options.description === 'provider unavailable'
        );
      });
      expect(hasProviderUnavailableToast).toBe(false);
      expect(hasActiveTransport(subChatId)).toBe(true);
      await second.cancel();
    });
  });

  describe('ReadableStream cancel calls cleanupTransportListeners', () => {
    let transport: WebSocketChatTransport;
    const subChatId = 'cancel-test-sub';

    beforeEach(() => {
      transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-cancel',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      // Stub desktopApi to provide no-op listeners (avoids null guard early return)
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
    });

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
      cleanupTransportListeners(subChatId);
    });

    it('cancelling the ReadableStream triggers cleanup', async () => {
      const stream = await transport.sendMessages(defaultSendMessagesPayload('chat-cancel'));

      // After sendMessages, the subChatId should have an active listener
      expect(hasActiveTransport(subChatId)).toBe(true);

      // Cancel the stream (simulates React unmount or abort)
      await stream.cancel();

      // Cleanup should have removed the active listener
      expect(hasActiveTransport(subChatId)).toBe(false);
    });
  });

  describe('approved plan context handoff', () => {
    const subChatId = 'approved-plan-sub';

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
      cleanupTransportListeners(subChatId);
      vi.mocked(appStore.get).mockImplementation(() => new Map());
      vi.mocked(appStore.set).mockImplementation(() => undefined);
      vi.clearAllMocks();
    });

    it('forwards approvedPlanContext once and clears it from store', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-1',
        planText: 'Implement the approved plan',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return new Map();
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const firstStream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved'),
        messages: [
          {
            id: 'msg-trigger-1',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await firstStream.cancel();

      const firstCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(firstCall?.approvedPlanContext).toEqual(approvedCtx);
      expect(storedContext).toBeNull();

      const secondStream = await transport.sendMessages(
        defaultSendMessagesPayload('chat-approved'),
      );
      await secondStream.cancel();

      const secondCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(secondCall?.approvedPlanContext).toBeUndefined();
    });

    it('does not forward approvedPlanContext for non-trigger messages and clears stale context', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-non-trigger',
        planText: 'Should not be injected for normal messages',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-non-trigger',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const stream = await transport.sendMessages(
        defaultSendMessagesPayload('chat-approved-non-trigger'),
      );
      await stream.cancel();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(call?.approvedPlanContext).toBeUndefined();
      expect(storedContext).toBeNull();
    });

    it('treats near-match trigger text as non-trigger and clears stale context', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-near-match',
        planText: 'Should only inject on exact trigger text',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-near-match',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const stream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-near-match'),
        messages: [
          {
            id: 'msg-near-match',
            role: 'user',
            parts: [{ type: 'text', text: `${PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT} please` }],
          },
        ],
      });
      await stream.cancel();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(call?.approvedPlanContext).toBeUndefined();
      expect(storedContext).toBeNull();
    });

    it('keeps approved context available for trigger send during concurrent same-subchat sends', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-concurrent',
        planText: 'Concurrent send race',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      const pendingResolvers: Array<() => void> = [];
      vi.mocked(trpcClient.socket.sendMessage.mutate).mockImplementation(
        () =>
          new Promise((resolve) => {
            pendingResolvers.push(() => resolve({} as never));
          }) as never,
      );

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-concurrent',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const normalStream = await transport.sendMessages(
        defaultSendMessagesPayload('chat-approved-concurrent'),
      );
      const triggerStream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-concurrent'),
        messages: [
          {
            id: 'msg-trigger-concurrent',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await waitForAsync();

      const calls = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls;
      const triggerCall = calls
        .map(
          (entry) =>
            entry[0] as {
              userMessage?: { parts?: Array<{ type?: string; text?: string }> };
              approvedPlanContext?: unknown;
            },
        )
        .find((payload) =>
          payload.userMessage?.parts?.some(
            (part) => part.type === 'text' && part.text === PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT,
          ),
        );
      expect(triggerCall?.approvedPlanContext).toEqual(approvedCtx);

      for (const resolve of pendingResolvers) resolve();
      await waitForAsync();
      await normalStream.cancel();
      await triggerStream.cancel();
    });

    it('keeps approved context for trigger when non-trigger resolves first', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-concurrent-order',
        planText: 'Concurrent order race',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      let resolveNormal: (() => void) | null = null;
      let resolveTrigger: (() => void) | null = null;
      vi.mocked(trpcClient.socket.sendMessage.mutate).mockImplementation((payload) => {
        const text = (
          payload as { userMessage?: { parts?: Array<{ type?: string; text?: string }> } }
        ).userMessage?.parts?.find((part) => part.type === 'text')?.text;
        return new Promise((resolve) => {
          if (text === PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT) {
            resolveTrigger = () => resolve({} as never);
          } else {
            resolveNormal = () => resolve({} as never);
          }
        }) as never;
      });

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-concurrent-order',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const normalStream = await transport.sendMessages(
        defaultSendMessagesPayload('chat-approved-concurrent-order'),
      );
      const triggerStream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-concurrent-order'),
        messages: [
          {
            id: 'msg-trigger-order',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await waitForAsync();

      // Resolve non-trigger first while trigger is still in-flight.
      const resolveNormalFn = resolveNormal as (() => void) | null;
      if (resolveNormalFn) {
        resolveNormalFn();
      }
      await waitForAsync();
      expect(storedContext).toEqual(approvedCtx);

      const calls = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls;
      const triggerCall = calls
        .map(
          (entry) =>
            entry[0] as {
              userMessage?: { parts?: Array<{ type?: string; text?: string }> };
              approvedPlanContext?: unknown;
            },
        )
        .find((payload) =>
          payload.userMessage?.parts?.some(
            (part) => part.type === 'text' && part.text === PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT,
          ),
        );
      expect(triggerCall?.approvedPlanContext).toEqual(approvedCtx);

      const resolveTriggerFn = resolveTrigger as (() => void) | null;
      if (resolveTriggerFn) {
        resolveTriggerFn();
      }
      await waitForAsync();
      await normalStream.cancel();
      await triggerStream.cancel();
    });

    it('does not leak approved context across sub-chats', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtxA = {
        planId: 'plan-a',
        planText: 'Approved for subchat A',
      };
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (
          typeof atom === 'symbol' &&
          String(atom).includes('approvedPlanContext:sub-approved-a')
        ) {
          return approvedCtxA;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation(() => undefined);

      const transportA = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-a',
        subChatId: 'sub-approved-a',
        projectId: 'proj-1',
        mode: 'agent',
      });
      const transportB = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-b',
        subChatId: 'sub-approved-b',
        projectId: 'proj-1',
        mode: 'agent',
      });

      const streamA = await transportA.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-a'),
        messages: [
          {
            id: 'msg-trigger-a',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await streamA.cancel();

      const callA = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(callA?.approvedPlanContext).toEqual(approvedCtxA);

      const streamB = await transportB.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-b'),
        messages: [
          {
            id: 'msg-trigger-b',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await streamB.cancel();

      const callB = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(callB?.approvedPlanContext).toBeUndefined();

      cleanupTransportListeners('sub-approved-a');
      cleanupTransportListeners('sub-approved-b');
    });

    it('retains approvedPlanContext when send fails, so retry can reuse it', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-retry',
        planText: 'Retry-safe plan context',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return new Map();
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });
      vi.mocked(trpcClient.socket.sendMessage.mutate).mockRejectedValueOnce(
        new Error('Socket not connected'),
      );

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-failure',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const stream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-failure'),
        messages: [
          {
            id: 'msg-trigger-failure',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await stream.cancel();
      await waitForAsync();

      expect(storedContext).toEqual(approvedCtx);
    });

    it('clears approvedPlanContext when socket execution error arrives after trigger send', async () => {
      let onSocketError: (payload: { subChatId: string; error: string }) => void = () => {};
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn((cb: (payload: { subChatId: string; error: string }) => void) => {
          onSocketError = cb;
          return vi.fn();
        }),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-socket-error',
        planText: 'clear on socket error',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-socket-error',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const stream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-socket-error'),
        messages: [
          {
            id: 'msg-trigger-socket-error',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      onSocketError({ subChatId, error: 'boom' });
      await waitForAsync();

      expect(storedContext).toBeNull();
      await stream.cancel().catch(() => undefined);
    });

    it('clears approvedPlanContext when abort signal fires after trigger send', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-abort',
        planText: 'clear on abort',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return undefined;
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      const abortController = new AbortController();
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-abort',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const stream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-abort'),
        abortSignal: abortController.signal,
        messages: [
          {
            id: 'msg-trigger-abort',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      abortController.abort();
      await waitForAsync();

      expect(storedContext).toBeNull();
      await stream.cancel().catch(() => undefined);
    });

    it('persists approvedPlanContext across transport reload after failure, then clears after success', async () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const approvedCtx = {
        planId: 'plan-reload',
        planText: 'Reload-safe context',
      };
      let storedContext: typeof approvedCtx | null = approvedCtx;
      vi.mocked(appStore.get).mockImplementation((atom) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          return storedContext;
        }
        return new Map();
      });
      vi.mocked(appStore.set).mockImplementation((atom, value) => {
        if (typeof atom === 'symbol' && String(atom).includes('approvedPlanContext')) {
          storedContext = value as typeof approvedCtx | null;
        }
      });

      vi.mocked(trpcClient.socket.sendMessage.mutate)
        .mockRejectedValueOnce(new Error('Socket not connected'))
        .mockResolvedValueOnce({ ok: true } as never);

      const firstTransport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-reload',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const failedStream = await firstTransport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-reload'),
        messages: [
          {
            id: 'msg-trigger-reload-failed',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await failedStream.cancel();
      await waitForAsync();
      expect(storedContext).toEqual(approvedCtx);

      // Simulate chat reload by constructing a new transport instance.
      const secondTransport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-approved-reload',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const successStream = await secondTransport.sendMessages({
        ...defaultSendMessagesPayload('chat-approved-reload'),
        messages: [
          {
            id: 'msg-trigger-reload-success',
            role: 'user',
            parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
          },
        ],
      });
      await successStream.cancel();
      await waitForAsync();

      const secondCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { approvedPlanContext?: unknown }
        | undefined;
      expect(secondCall?.approvedPlanContext).toEqual(approvedCtx);
      expect(storedContext).toBeNull();
    });
  });

  describe('execute-complete guard: currentRunAssistantMessageId', () => {
    const subChatId = 'guard-test-sub';
    let capturedChunks: unknown[];
    let onExecuteComplete: (payload: Record<string, unknown>) => void;
    let onStreamChunk: (payload: Record<string, unknown>) => void;

    beforeEach(async () => {
      capturedChunks = [];
      let executeCompleteHandler: (payload: Record<string, unknown>) => void = () => {};
      let streamChunkHandler: (payload: Record<string, unknown>) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          streamChunkHandler = cb;
          return vi.fn();
        }),
        onSocketExecuteComplete: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          executeCompleteHandler = cb;
          return vi.fn();
        }),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-guard',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const stream = await transport.sendMessages({
        ...defaultSendMessagesPayload('chat-guard'),
        messages: [
          {
            id: 'msg-1',
            role: 'user' as const,
            parts: [{ type: 'text' as const, text: 'test' }],
          },
        ],
      });

      // Read chunks in background
      const reader = stream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            capturedChunks.push(value);
          }
        } catch {
          // Stream cancelled or errored
        }
      })();

      await waitForAsync();

      onExecuteComplete = executeCompleteHandler;
      onStreamChunk = streamChunkHandler;
    });

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
      cleanupTransportListeners(subChatId);
    });

    it('buffers execute-complete until first stream chunk establishes run identity', async () => {
      const msgId = 'buffered-msg-id';
      onExecuteComplete({
        subChatId,
        assistantMessageId: msgId,
      });
      await waitForAsync();
      expect(hasActiveTransport(subChatId)).toBe(true);

      onStreamChunk({
        subChatId,
        assistantMessageId: msgId,
        chunk: { type: 'text-delta', delta: 'hi after early complete' },
      });
      await waitForAsync();
      expect(hasActiveTransport(subChatId)).toBe(false);
    });

    it('ignores execute-complete with mismatched assistantMessageId', async () => {
      onStreamChunk({
        subChatId,
        assistantMessageId: 'current-run-msg',
        chunk: { type: 'text-delta', delta: 'hi' },
      });
      await waitForAsync();
      onExecuteComplete({
        subChatId,
        assistantMessageId: 'wrong-msg-id',
      });
      await waitForAsync();
      expect(hasActiveTransport(subChatId)).toBe(true);
    });

    it('closes stream on execute-complete with matching assistantMessageId', async () => {
      const msgId = 'matching-msg-id';
      onStreamChunk({
        subChatId,
        assistantMessageId: msgId,
        chunk: { type: 'text-delta', delta: 'hello' },
      });
      await waitForAsync();
      onExecuteComplete({
        subChatId,
        assistantMessageId: msgId,
      });
      await waitForAsync();
      expect(hasActiveTransport(subChatId)).toBe(false);
      expect(
        vi
          .mocked(appStore.set)
          .mock.calls.some(
            ([atom, value]) =>
              typeof atom === 'symbol' &&
              String(atom).includes('approvedPlanContext') &&
              value === null,
          ),
      ).toBe(true);
    });

    it('ignores late stream chunks after execute-complete closed the run', async () => {
      const msgId = 'late-chunk-msg-id';
      onStreamChunk({
        subChatId,
        assistantMessageId: msgId,
        chunk: { type: 'text-delta', delta: 'before close' },
      });
      await waitForAsync();
      onExecuteComplete({
        subChatId,
        assistantMessageId: msgId,
      });
      await waitForAsync();

      const chunkCountAfterClose = capturedChunks.length;
      onStreamChunk({
        subChatId,
        assistantMessageId: msgId,
        chunk: { type: 'text-delta', delta: 'after close should be ignored' },
      });
      await waitForAsync();

      expect(hasActiveTransport(subChatId)).toBe(false);
      expect(capturedChunks.length).toBe(chunkCountAfterClose);
    });

    it('synthesizes missing tool-input when tool-output arrives first', async () => {
      onStreamChunk({
        subChatId,
        assistantMessageId: 'tool-order-msg',
        chunk: {
          type: 'tool-output-available',
          toolCallId: 'tool-1',
          output: { ok: true },
        },
      });
      await waitForAsync();

      const toolChunks = capturedChunks.filter(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          (chunk as { type?: string }).type?.startsWith('tool-'),
      ) as Array<{ type: string; toolCallId: string; toolName?: string }>;

      expect(toolChunks[0]).toMatchObject({
        type: 'tool-input-available',
        toolCallId: 'tool-1',
        toolName: 'UnknownTool',
      });
      expect(toolChunks[1]).toMatchObject({
        type: 'tool-output-available',
        toolCallId: 'tool-1',
      });
    });

    it('updates retry-related atoms on start-step chunk', async () => {
      onStreamChunk({
        subChatId,
        assistantMessageId: 'start-step-msg',
        chunk: { type: 'start-step' },
      });
      await waitForAsync();

      const setCalls = vi.mocked(appStore.set).mock.calls;
      expect(
        setCalls.some(
          ([, value]) => value === null || (typeof value === 'boolean' && value === false),
        ),
      ).toBe(true);
    });
  });

  describe('execute-complete guard under multi-sub-chat interleaving', () => {
    const subChatA = 'guard-multi-sub-a';
    const subChatB = 'guard-multi-sub-b';
    let executeCompleteHandlers: Array<(payload: Record<string, unknown>) => void>;
    let streamChunkHandlers: Array<(payload: Record<string, unknown>) => void>;

    const emitExecuteComplete = (payload: Record<string, unknown>) => {
      for (const handler of executeCompleteHandlers) handler(payload);
    };
    const emitStreamChunk = (payload: Record<string, unknown>) => {
      for (const handler of streamChunkHandlers) handler(payload);
    };

    beforeEach(() => {
      executeCompleteHandlers = [];
      streamChunkHandlers = [];
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          streamChunkHandlers.push(cb);
          return vi.fn();
        }),
        onSocketExecuteComplete: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          executeCompleteHandlers.push(cb);
          return vi.fn();
        }),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
    });

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
      cleanupTransportListeners(subChatA);
      cleanupTransportListeners(subChatB);
    });

    it('keeps pending execute-complete state isolated per sub-chat when both runs complete plan mode', async () => {
      const transportA = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-multi-a',
        subChatId: subChatA,
        projectId: 'proj-1',
        mode: 'plan',
      });
      const transportB = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-multi-b',
        subChatId: subChatB,
        projectId: 'proj-1',
        mode: 'plan',
      });

      const streamA = await transportA.sendMessages(defaultSendMessagesPayload('chat-multi-a'));
      const streamB = await transportB.sendMessages(defaultSendMessagesPayload('chat-multi-b'));
      streamA
        .getReader()
        .read()
        .catch(() => undefined);
      streamB
        .getReader()
        .read()
        .catch(() => undefined);
      await waitForAsync();

      emitExecuteComplete({ subChatId: subChatA, assistantMessageId: 'run-a' });
      emitExecuteComplete({ subChatId: subChatB, assistantMessageId: 'run-b' });
      await waitForAsync();
      expect(hasActiveTransport(subChatA)).toBe(true);
      expect(hasActiveTransport(subChatB)).toBe(true);

      emitStreamChunk({
        subChatId: subChatA,
        assistantMessageId: 'run-a',
        chunk: {
          type: 'tool-output-available',
          toolCallId: 'exit-a',
          output: { filePath: '/tmp/a.plan.md' },
        },
      });
      await waitForAsync();
      expect(hasActiveTransport(subChatA)).toBe(false);
      expect(hasActiveTransport(subChatB)).toBe(true);

      emitStreamChunk({
        subChatId: subChatB,
        assistantMessageId: 'run-b',
        chunk: {
          type: 'tool-output-available',
          toolCallId: 'exit-b',
          output: { filePath: '/tmp/b.plan.md' },
        },
      });
      await waitForAsync();
      expect(hasActiveTransport(subChatB)).toBe(false);
    });

    it('does not allow cross-chat assistantMessageId mismatches to finalize the wrong sub-chat', async () => {
      const transportA = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-multi-mismatch-a',
        subChatId: subChatA,
        projectId: 'proj-1',
        mode: 'plan',
      });
      const transportB = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-multi-mismatch-b',
        subChatId: subChatB,
        projectId: 'proj-1',
        mode: 'plan',
      });

      const streamA = await transportA.sendMessages(
        defaultSendMessagesPayload('chat-multi-mismatch-a'),
      );
      const streamB = await transportB.sendMessages(
        defaultSendMessagesPayload('chat-multi-mismatch-b'),
      );
      streamA
        .getReader()
        .read()
        .catch(() => undefined);
      streamB
        .getReader()
        .read()
        .catch(() => undefined);
      await waitForAsync();

      emitStreamChunk({
        subChatId: subChatA,
        assistantMessageId: 'run-a',
        chunk: { type: 'text-delta', delta: 'a' },
      });
      emitStreamChunk({
        subChatId: subChatB,
        assistantMessageId: 'run-b',
        chunk: { type: 'text-delta', delta: 'b' },
      });
      await waitForAsync();

      emitExecuteComplete({ subChatId: subChatA, assistantMessageId: 'run-b' });
      emitExecuteComplete({ subChatId: subChatB, assistantMessageId: 'run-a' });
      await waitForAsync();
      expect(hasActiveTransport(subChatA)).toBe(true);
      expect(hasActiveTransport(subChatB)).toBe(true);

      emitExecuteComplete({ subChatId: subChatA, assistantMessageId: 'run-a' });
      emitExecuteComplete({ subChatId: subChatB, assistantMessageId: 'run-b' });
      await waitForAsync();
      expect(hasActiveTransport(subChatA)).toBe(false);
      expect(hasActiveTransport(subChatB)).toBe(false);
    });

    it('replaces listener ownership cleanly when two transports use the same sub-chat id', async () => {
      const sameSubChatId = 'guard-same-subchat';
      const transportOne = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-same-sub-1',
        subChatId: sameSubChatId,
        projectId: 'proj-1',
        mode: 'plan',
      });
      const transportTwo = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-same-sub-2',
        subChatId: sameSubChatId,
        projectId: 'proj-1',
        mode: 'plan',
      });

      const streamOne = await transportOne.sendMessages(
        defaultSendMessagesPayload('chat-same-sub-1'),
      );
      const streamTwo = await transportTwo.sendMessages(
        defaultSendMessagesPayload('chat-same-sub-2'),
      );
      const readerOne = streamOne.getReader();
      const readerTwo = streamTwo.getReader();
      readerOne.read().catch(() => undefined);
      readerTwo.read().catch(() => undefined);
      await waitForAsync();

      // Latest transport should own the listener, and execute-complete should close it deterministically.
      expect(hasActiveTransport(sameSubChatId)).toBe(true);
      emitStreamChunk({
        subChatId: sameSubChatId,
        assistantMessageId: 'run-same',
        chunk: { type: 'text-delta', delta: 'same-sub' },
      });
      await waitForAsync();
      emitExecuteComplete({ subChatId: sameSubChatId, assistantMessageId: 'run-same' });
      await waitForAsync();
      expect(hasActiveTransport(sameSubChatId)).toBe(false);

      await readerOne.cancel().catch(() => undefined);
      await readerTwo.cancel().catch(() => undefined);
      cleanupTransportListeners(sameSubChatId);
    });
  });

  // Edge Case Tests - Critical Priority
  describe('Edge Case: Thinking Toggle + Effort Tiers (Critical)', () => {
    let extendedThinkingMockValue = false;
    let selectedModelMockValue = 'sonnet';

    beforeEach(() => {
      extendedThinkingMockValue = false;
      selectedModelMockValue = 'sonnet';

      vi.mocked(appStore.get).mockImplementation((atom) => {
        const key = String(atom);
        if (key.includes('extendedThinkingEnabledAtom')) {
          return extendedThinkingMockValue;
        }
        if (key.includes('lastSelectedModelId')) {
          return selectedModelMockValue;
        }
        if (key.includes('sessionInfoAtom')) {
          return { accountType: 'claude-code' };
        }
        return new Map();
      });

      vi.mocked(trpcClient.socket.sendMessage.mutate).mockClear();
    });

    it('thinking is enabled when toggle is ON and base model is selected', async () => {
      extendedThinkingMockValue = true;
      selectedModelMockValue = 'sonnet';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-1',
        subChatId: 'sub-thinking-1',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-1'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.maxThinkingTokens).toBe(32_000);
      expect(payload?.settings?.effort).toBe('medium');
    });

    it('thinking is disabled when toggle is OFF regardless of model effort tier', async () => {
      extendedThinkingMockValue = false;
      selectedModelMockValue = 'opus-4.8-low-ultra';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-2',
        subChatId: 'sub-thinking-2',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-2'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.maxThinkingTokens).toBeUndefined();
      expect(payload?.settings?.effort).toBeUndefined();
      expect(payload?.settings?.ultra).toBe(true);
    });

    it('toggle ON with high-effort model uses high budget', async () => {
      extendedThinkingMockValue = true;
      selectedModelMockValue = 'sonnet-high';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-3',
        subChatId: 'sub-thinking-3',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-3'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.maxThinkingTokens).toBe(60_000);
      expect(payload?.settings?.effort).toBe('high');
    });

    it('thinking is disabled when toggle is OFF and base model is selected', async () => {
      extendedThinkingMockValue = false;
      selectedModelMockValue = 'haiku';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-4',
        subChatId: 'sub-thinking-4',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-4'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.maxThinkingTokens).toBeUndefined();
    });

    it('model is correctly mapped when effort variant is selected', async () => {
      extendedThinkingMockValue = true;
      selectedModelMockValue = 'opus-low';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-5',
        subChatId: 'sub-thinking-5',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-5'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.model).toBe('opus');
      expect(payload?.settings?.maxThinkingTokens).toBe(10_000);
      expect(payload?.settings?.effort).toBe('low');
    });

    it('Opus 4.7 Max maps effort max when thinking is on', async () => {
      extendedThinkingMockValue = true;
      selectedModelMockValue = 'opus-4.7-max';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-max',
        subChatId: 'sub-thinking-max',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-max'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      const payload = call?.[0];
      expect(payload?.settings?.model).toBe('claude-opus-4-7');
      expect(payload?.settings?.effort).toBe('max');
    });

    it.each<[string, { effort: string; ultra?: true }]>([
      ['opus-4.8-xhigh', { effort: 'xhigh' }],
      ['opus-4.8-low-ultra', { effort: 'low', ultra: true }],
    ])('%s maps its effort settings when thinking is on', async (model, settings) => {
      extendedThinkingMockValue = true;
      selectedModelMockValue = model;
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: `chat-${model}`,
        subChatId: `sub-${model}`,
        projectId: 'proj-1',
        mode: 'agent',
      });
      await transport.sendMessages(defaultSendMessagesPayload(`chat-${model}`));
      await waitForAsync();
      const payload = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0]?.[0];
      expect(payload?.settings?.model).toBe('claude-opus-4-8');
      expect(payload?.settings).toMatchObject(settings);
      expect(payload?.settings?.ultra).toBe(settings.ultra);
    });

    it('unknown model defaults to sonnet with no thinking', async () => {
      extendedThinkingMockValue = false;
      selectedModelMockValue = 'unknown-future-model';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-thinking-test-6',
        subChatId: 'sub-thinking-6',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-thinking-test-6'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.model).toBe('sonnet');
      expect(payload?.settings?.maxThinkingTokens).toBeUndefined();
    });
  });

  describe('Edge Case: 1M Context Beta Propagation (Critical)', () => {
    let selectedModel1M = 'opus-1m';

    beforeEach(() => {
      vi.mocked(appStore.get).mockImplementation((atom) => {
        const key = String(atom);
        if (key.includes('lastSelectedModelId')) return selectedModel1M;
        if (key.includes('sessionInfoAtom')) return { accountType: 'claude-code' };
        if (key.includes('extendedThinkingEnabledAtom')) return false;
        return new Map();
      });
      vi.mocked(trpcClient.socket.sendMessage.mutate).mockClear();
    });

    it('sends betas array when a 1M model variant is selected', async () => {
      selectedModel1M = 'opus-1m';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-1m-test-1',
        subChatId: 'sub-1m-1',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-1m-test-1'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.betas).toEqual(['context-1m-2025-08-07']);
      expect(payload?.settings?.model).toBe('opus');
    });

    it('does not send betas for standard 200k models', async () => {
      selectedModel1M = 'opus';

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-1m-test-2',
        subChatId: 'sub-1m-2',
        projectId: 'proj-1',
        mode: 'agent',
      });

      await transport.sendMessages(defaultSendMessagesPayload('chat-1m-test-2'));
      await waitForAsync();

      const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[0];
      expect(payload?.settings?.betas).toBeUndefined();
    });
  });

  describe('Edge Case: Model Selection During Message Send (Critical)', () => {
    it('uses model state at the time sendMessages is called, not when queued', async () => {
      let selectedModelMockValue = 'opus';

      // Clear and reset mock
      vi.mocked(appStore.get).mockClear();
      vi.mocked(appStore.get).mockImplementation((atom) => {
        const key = String(atom);
        if (key.includes('lastSelectedModelId')) {
          return selectedModelMockValue;
        }
        if (key.includes('sessionInfoAtom')) {
          return { accountType: 'claude-code' };
        }
        if (key.includes('extendedThinkingEnabledAtom')) {
          return false;
        }
        return new Map();
      });

      vi.mocked(trpcClient.socket.sendMessage.mutate).mockClear();

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-race-test-1',
        subChatId: 'sub-race-1',
        projectId: 'proj-1',
        mode: 'agent',
      });

      // Send with opus
      const stream1 = await transport.sendMessages(defaultSendMessagesPayload('chat-race-test-1'));
      await stream1.cancel();
      await waitForAsync();

      const firstCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[0];
      expect(firstCall?.[0]?.settings?.model).toBe('opus');

      // Change model
      selectedModelMockValue = 'haiku';

      // Send again - should use new model
      const stream2 = await transport.sendMessages(defaultSendMessagesPayload('chat-race-test-1'));
      await stream2.cancel();
      await waitForAsync();

      const secondCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls[1];
      expect(secondCall?.[0]?.settings?.model).toBe('haiku');

      cleanupTransportListeners('sub-race-1');
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });
  });

  describe('finalizeRun idempotency on duplicate execute:complete', () => {
    const subChatId = 'sub-idempotent-finalize';

    afterEach(() => {
      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    // Guards against double-firing onExecuteComplete (chat refetch, status flip) if
    // execute:complete arrives twice — e.g. server re-broadcast, network retry, or
    // race between execute:complete and a cancel cleanup path.
    it('invokes onExecuteComplete config callback only once when execute:complete fires twice', async () => {
      let executeCompleteHandler: (payload: Record<string, unknown>) => void = () => {};
      let streamChunkHandler: (payload: Record<string, unknown>) => void = () => {};

      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          streamChunkHandler = cb;
          return vi.fn();
        }),
        onSocketExecuteComplete: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          executeCompleteHandler = cb;
          return vi.fn();
        }),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      const onExecuteCompleteSpy = vi.fn();
      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-idempotent',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
        onExecuteComplete: onExecuteCompleteSpy,
      });
      const stream = await transport.sendMessages(defaultSendMessagesPayload('chat-idempotent'));

      // Drain stream in the background.
      const reader = stream.getReader();
      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // closed
        }
      })();
      await waitForAsync();

      const assistantMessageId = 'assistant-done';
      // Establish run identity so execute:complete is not buffered.
      streamChunkHandler({
        subChatId,
        assistantMessageId,
        chunk: { type: 'text-delta', delta: 'hello' },
      });
      await waitForAsync();

      executeCompleteHandler({ subChatId, assistantMessageId });
      await waitForAsync();
      executeCompleteHandler({ subChatId, assistantMessageId });
      await waitForAsync();

      expect(onExecuteCompleteSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('listener cleanup on onSocketError non-abort path', () => {
    const subChatId = 'sub-error-cleanup';
    let ipcUnsubs: Array<ReturnType<typeof vi.fn>>;
    let errorHandler: (payload: Record<string, unknown>) => void;

    const trackUnsub = () => {
      const u = vi.fn();
      ipcUnsubs.push(u);
      return u;
    };

    beforeEach(async () => {
      ipcUnsubs = [];
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketExecuteStart: vi.fn(() => trackUnsub()),
        onSocketStreamChunk: vi.fn(() => trackUnsub()),
        onSocketExecuteComplete: vi.fn(() => trackUnsub()),
        onSocketError: vi.fn((cb: (p: Record<string, unknown>) => void) => {
          errorHandler = cb;
          return trackUnsub();
        }),
        onSocketMessageSaved: vi.fn(() => trackUnsub()),
        on: vi.fn(() => trackUnsub()),
      };

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-error-cleanup',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });
      const stream = await transport.sendMessages(defaultSendMessagesPayload('chat-error-cleanup'));
      const reader = stream.getReader();
      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // closed
        }
      })();
      await waitForAsync();
    });

    afterEach(() => {
      cleanupTransportListeners(subChatId);
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    // Guards against the same listener-leak pattern that finalizeRun and the grace
    // timer had — every backend execute:error was leaving a full set of IPC handlers
    // attached to ipcRenderer.
    it('calls every registered IPC unsub when execute:error fires (non-abort path)', async () => {
      const snapshot = [...ipcUnsubs];
      expect(snapshot.length).toBeGreaterThanOrEqual(5);
      errorHandler({ subChatId, error: 'something failed server-side' });
      await waitForAsync();

      for (const unsub of snapshot) {
        expect(unsub).toHaveBeenCalled();
      }
      expect(hasActiveTransport(subChatId)).toBe(false);
    });
  });

  describe('outgoing images', () => {
    const TINY_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

    const setupDesktopApi = () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
    };

    const teardownDesktopApi = () => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
    };

    const makeImageMessage = (chatId: string) => ({
      trigger: 'submit-message' as const,
      chatId,
      messageId: undefined as string | undefined,
      messages: [
        {
          id: 'msg-img',
          role: 'user' as const,
          parts: [
            { type: 'text' as const, text: 'describe this image' },
            { type: 'file' as const, mimeType: 'image/png', data: TINY_PNG_BASE64 },
          ],
        },
      ] as unknown as UIMessage[],
      abortSignal: undefined as AbortSignal | undefined,
    });

    it('sends images as inline base64', async () => {
      setupDesktopApi();
      const subChatId = 'sub-img-local';
      try {
        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-img-local',
          subChatId,
          projectId: 'proj-1',
          mode: 'agent',
        });
        const stream = await transport.sendMessages(makeImageMessage('chat-img-local'));
        await vi.waitFor(() => expect(trpcClient.socket.sendMessage.mutate).toHaveBeenCalled());
        await stream.cancel();

        const sentPayload = vi
          .mocked(trpcClient.socket.sendMessage.mutate)
          .mock.calls.at(-1)?.[0] as
          | { userMessage?: { parts?: Array<{ type: string; data?: string }> } }
          | undefined;
        const imagePart = sentPayload?.userMessage?.parts?.find((p) => p.type === 'file');
        expect(imagePart?.data).toBe(TINY_PNG_BASE64);
      } finally {
        cleanupTransportListeners(subChatId);
        teardownDesktopApi();
      }
    });
  });

  // Regression protection: an `await` in `sendMessages` BEFORE the
  // `return new ReadableStream(...)` makes React flush the AI SDK's
  // `'submitted'` status notification before `start()` runs, which
  // causes `MessageSyncManager.getEffectiveStatus` to downgrade the
  // per-subChat status to `'ready'` (because `!hasActiveTransport`).
  // Result: no Stop button, no planning shimmer, no "Thinking…" until
  // the first chunk arrives. These tests pin the contract that
  // `hasActiveTransport(subChatId)` is `true` synchronously the moment
  // `await sendMessages` resolves.
  describe('hasActiveTransport synchronously after sendMessages', () => {
    const setupDesktopApi = () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
    };
    const teardownDesktopApi = () => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
    };

    it('text-only message: transport is active immediately after sendMessages resolves', async () => {
      setupDesktopApi();
      const subChatId = 'sub-active-sync-text';
      try {
        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-active-sync-text',
          subChatId,
          projectId: 'proj-1',
          mode: 'agent',
        });
        expect(hasActiveTransport(subChatId)).toBe(false);
        const stream = await transport.sendMessages(
          defaultSendMessagesPayload('chat-active-sync-text'),
        );
        // CRITICAL: must be true before any further microtasks. Do not
        // insert an `await waitForAsync()` here — the whole point is that
        // the transport is registered synchronously inside the
        // ReadableStream constructor's `start()` callback.
        expect(hasActiveTransport(subChatId)).toBe(true);
        await stream.cancel();
      } finally {
        cleanupTransportListeners(subChatId);
        teardownDesktopApi();
      }
    });
  });

  describe('rollback filter — agent context isolation', () => {
    /**
     * After a user-message rollback, the AI SDK Chat instance still holds the
     * rolled-back messages internally and will keep providing them in
     * `options.messages`. Without filtering at the transport boundary, the
     * agent receives the rolled-back content as conversation history.
     */
    const setupDesktopApi = () => {
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };
    };

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).desktopApi;
    });

    it('strips rolled-back ids from the history payload sent to the agent', async () => {
      const subChatId = 'sub-rollback-filter-history';
      clearRollbackFilter(subChatId);
      setRollbackFilter(subChatId, ['rolled-back-user', 'rolled-back-assistant']);

      setupDesktopApi();

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-rollback-filter-history',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-rollback-filter-history',
        messageId: undefined,
        messages: [
          {
            id: 'rolled-back-user',
            role: 'user',
            parts: [{ type: 'text', text: 'first message (should be stripped)' }],
          },
          {
            id: 'rolled-back-assistant',
            role: 'assistant',
            parts: [{ type: 'text', text: 'first reply (should be stripped)' }],
          },
          {
            id: 'live-user',
            role: 'user',
            parts: [{ type: 'text', text: 'new message after rollback' }],
          },
        ],
        abortSignal: undefined,
      });
      await stream.cancel();

      const sendCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | {
            history?: Array<{ role: string; content: string }>;
            userMessage?: { parts: Array<{ type: string; text?: string }> };
          }
        | undefined;

      // History (everything except the last user message) — rolled-back content gone
      const historyTexts = (sendCall?.history ?? []).map((h) => h.content);
      expect(historyTexts).not.toContain('first message (should be stripped)');
      expect(historyTexts).not.toContain('first reply (should be stripped)');
      // History should be empty here (only the live user message remained, and that becomes prompt)
      expect(sendCall?.history).toBeUndefined();

      // Prompt comes from the surviving user message
      const promptText = sendCall?.userMessage?.parts.find((p) => p.type === 'text')?.text;
      expect(promptText).toBe('new message after rollback');

      cleanupTransportListeners(subChatId);
      clearRollbackFilter(subChatId);
    });

    it('picks lastUser from filtered messages so the prompt is not the rolled-back text', async () => {
      // Edge: rollback happens, but then setMessages re-provides the rolled-back user
      // as the LAST user message (because no fresh user has been sent yet). The transport
      // would use that stale id as the prompt without the filter.
      const subChatId = 'sub-rollback-filter-lastuser';
      clearRollbackFilter(subChatId);
      setRollbackFilter(subChatId, ['stale-user']);

      setupDesktopApi();

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-rollback-filter-lastuser',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-rollback-filter-lastuser',
        messageId: undefined,
        // The "live" user message comes BEFORE the stale one in the array — useChat
        // ordering is not guaranteed after rollback. lastUser walks from the end and
        // would otherwise pick `stale-user`.
        messages: [
          {
            id: 'live-user',
            role: 'user',
            parts: [{ type: 'text', text: 'real prompt' }],
          },
          {
            id: 'stale-user',
            role: 'user',
            parts: [{ type: 'text', text: 'rolled back prompt' }],
          },
        ],
        abortSignal: undefined,
      });
      await stream.cancel();

      const sendCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | { userMessage?: { parts: Array<{ type: string; text?: string }> } }
        | undefined;

      const promptText = sendCall?.userMessage?.parts.find((p) => p.type === 'text')?.text;
      expect(promptText).toBe('real prompt');
      expect(promptText).not.toBe('rolled back prompt');

      cleanupTransportListeners(subChatId);
      clearRollbackFilter(subChatId);
    });

    it('strips display markers from history when no rollback filter is set', async () => {
      const subChatId = 'sub-rollback-filter-passthrough';
      clearRollbackFilter(subChatId);

      setupDesktopApi();

      const transport = new WebSocketChatTransport({
        getExecutionAccountType: () => 'claude-code',
        chatId: 'chat-rollback-filter-passthrough',
        subChatId,
        projectId: 'proj-1',
        mode: 'agent',
      });

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-rollback-filter-passthrough',
        messageId: undefined,
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [
              { type: 'text', text: '<!--TRIGGER_BUBBLE:{"id":"trigger"}-->\n\nhistory user' },
            ],
          },
          {
            id: 'a1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'history reply' }],
          },
          {
            id: 'u2',
            role: 'user',
            parts: [{ type: 'text', text: 'live prompt' }],
          },
        ],
        abortSignal: undefined,
      });
      await stream.cancel();

      const sendCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
        | {
            history?: Array<{ role: string; content: string }>;
            userMessage?: { parts: Array<{ type: string; text?: string }> };
          }
        | undefined;

      expect(sendCall?.history).toEqual([
        { role: 'user', content: 'history user' },
        { role: 'assistant', content: 'history reply' },
      ]);
      const promptText = sendCall?.userMessage?.parts.find((p) => p.type === 'text')?.text;
      expect(promptText).toBe('live prompt');

      cleanupTransportListeners(subChatId);
    });

    it('persists user message with the AI SDK id (so rollback-by-id locates freshly-sent messages)', async () => {
      // Bug regression: the transport used to generate `msg-${Date.now()}` for the
      // persisted user message id, while the AI SDK Chat instance kept its own
      // internal id. The two diverged, and clicking rollback on a freshly-sent
      // message would send the AI-SDK id to the backend, which couldn't find it
      // in the DB (where it was stored under the timestamp id).
      const subChatId = 'sub-id-alignment';
      (window as unknown as Record<string, unknown>).desktopApi = {
        onSocketStreamChunk: vi.fn(() => vi.fn()),
        onSocketExecuteComplete: vi.fn(() => vi.fn()),
        onSocketError: vi.fn(() => vi.fn()),
        onSocketMessageSaved: vi.fn(() => vi.fn()),
      };

      try {
        const transport = new WebSocketChatTransport({
          getExecutionAccountType: () => 'claude-code',
          chatId: 'chat-id-alignment',
          subChatId,
          projectId: 'proj-1',
          mode: 'agent',
        });

        const stream = await transport.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-id-alignment',
          messageId: undefined,
          messages: [
            {
              id: 'ai-sdk-internal-abc123',
              role: 'user',
              parts: [{ type: 'text', text: 'hi' }],
            },
          ],
          abortSignal: undefined,
        });
        await stream.cancel();

        const sendCall = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
          | { userMessage?: { id?: string } }
          | undefined;

        expect(sendCall?.userMessage?.id).toBe('ai-sdk-internal-abc123');
        expect(sendCall?.userMessage?.id).not.toMatch(/^msg-\d+$/);
      } finally {
        cleanupTransportListeners(subChatId);
        delete (window as unknown as Record<string, unknown>).desktopApi;
      }
    });
  });
});
