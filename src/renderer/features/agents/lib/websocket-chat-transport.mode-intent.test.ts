// @vitest-environment happy-dom

/**
 * The payload's mode is an optional TRANSITION INTENT (decision `sub-chat-mode-ownership`):
 * present only for a pending transition or a temp- sub-chat's first send; absent otherwise, so
 * main resolves from the sub-chat row and a wiped renderer store can never reopen a turn in a
 * mode the user already left.
 *
 * Lives beside websocket-chat-transport.test.ts rather than inside it: that file is at its
 * recorded size ceiling, and this slice needs only a fraction of its mock harness.
 */

import type { UIMessage } from 'ai';
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
      prewarmClaudeSession: { mutate: vi.fn(async () => ({})) },
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

vi.mock('../stores/streaming-status-store', () => ({
  useStreamingStatusStore: {
    getState: () => ({ setStatus: vi.fn() }),
  },
}));

const storeState = vi.hoisted(() => ({
  allSubChats: [] as Array<{ id: string; mode?: string }>,
  updateSubChatMode: vi.fn(),
}));

/** Single source of intent state for the suite: setIntent writes it, mocks read it. */
const intentState = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../../../lib/stores/mode-intent', () => ({
  pendingModeIntentAtomFamily: vi.fn((subChatId: string) =>
    Symbol(`pendingModeIntent:${subChatId}`),
  ),
  armModeIntentIfEmpty: vi.fn((_subChatId: string, mode: string) => {
    if (intentState.value) return false;
    intentState.value = mode;
    return true;
  }),
  ackModeIntent: vi.fn((_subChatId: string, carried: string) => {
    if (intentState.value === carried) intentState.value = null;
  }),
  // Mirrors the real resolution so the suite exercises the transport's use of it.
  takeModeIntentForSend: vi.fn(() => intentState.value ?? undefined),
}));

vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => storeState,
  },
}));

import { appStore } from '../../../lib/jotai-store';
import { trpcClient } from '../../../lib/trpc';
import {
  cleanupTransportListeners,
  requestClaudePrewarm,
  WebSocketChatTransport,
} from './websocket-chat-transport';

const waitForAsync = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Route the pendingModeIntent atom read; every other atom keeps the harness default. */
function setIntent(value: 'plan' | 'agent' | 'debug' | null): void {
  intentState.value = value;
  vi.mocked(appStore.get).mockImplementation((atom: unknown) => {
    const s = String(atom);
    if (s.includes('pendingModeIntent')) return intentState.value;
    if (s.includes('lastSelectedModelId')) return 'sonnet';
    return new Map();
  });
}

const flowPlanReadyMessages = [
  {
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'tool-frink-plan', input: { status: 'awaiting_approval', flowDriven: true } }],
  },
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'carry on' }] },
] as unknown as UIMessage[];

async function sendTurn(
  subChatId: string,
  trigger: 'submit-message' | 'regenerate-message' = 'submit-message',
  messages?: UIMessage[],
): Promise<{ mode?: string } | undefined> {
  (window as unknown as Record<string, unknown>).desktopApi = {
    onSocketStreamChunk: vi.fn(() => vi.fn()),
    onSocketExecuteComplete: vi.fn(() => vi.fn()),
    onSocketError: vi.fn(() => vi.fn()),
    onSocketMessageSaved: vi.fn(() => vi.fn()),
  };
  const transport = new WebSocketChatTransport({
    getExecutionAccountType: () => 'claude-code',
    chatId: 'chat-intent',
    subChatId,
    projectId: 'proj-1',
    mode: 'plan',
  });
  const stream = await transport.sendMessages({
    trigger,
    chatId: 'chat-intent',
    messageId: undefined,
    messages:
      messages ??
      ([
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'go' }] },
      ] as unknown as UIMessage[]),
    abortSignal: undefined,
  });
  await stream.cancel();
  await waitForAsync();
  delete (window as unknown as Record<string, unknown>).desktopApi;
  return vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
    | { mode?: string }
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  setIntent(null);
});

describe('websocket-chat-transport mode transition intent', () => {
  it('omits mode entirely when no intent is pending — main resolves from the sub-chat row', async () => {
    const call = await sendTurn('sub-intent-none');
    expect('mode' in (call ?? {})).toBe(false);
  });

  // Machine-dispatch identity: the queue item's dispatchTaskId (message metadata) must reach the
  // send payload top-level — main binds the turn's mode to the dispatching task with it. A plain
  // user send carries none, so it can never inherit a task's mode.
  it('forwards metadata.dispatchTaskId top-level; plain user sends carry none', async () => {
    const call = (await sendTurn('sub-dispatch-id', 'submit-message', [
      {
        id: 'msg-d1',
        role: 'user',
        parts: [{ type: 'text', text: 'dispatched prompt' }],
        metadata: { dispatchTaskId: 'task-abc' },
      },
    ] as unknown as UIMessage[])) as { dispatchTaskId?: string } | undefined;
    expect(call?.dispatchTaskId).toBe('task-abc');

    const plain = (await sendTurn('sub-dispatch-id')) as { dispatchTaskId?: string } | undefined;
    expect(plain?.dispatchTaskId).toBeUndefined();
  });

  // sc-2775: the dispatch attempt rides along so main can reject an earlier attempt's delayed send.
  it('forwards metadata.dispatchGeneration with its dispatch; never without one', async () => {
    const send = (metadata: Record<string, string>) =>
      sendTurn('sub-dispatch-gen', 'submit-message', [
        { id: 'msg-g1', role: 'user', parts: [{ type: 'text', text: 'dispatched' }], metadata },
      ] as unknown as UIMessage[]) as Promise<{ dispatchGeneration?: string } | undefined>;

    const call = await send({ dispatchTaskId: 'task-g', dispatchGeneration: 'gen-1' });
    expect(call?.dispatchGeneration).toBe('gen-1');
    expect((await send({ dispatchGeneration: 'gen-1' }))?.dispatchGeneration).toBeUndefined();
  });

  // A dispatch-carrying send never takes the intent lane: main binds its mode by identity, and a
  // user toggle armed during the dispatch window must stay armed (and never be falsely acked) so
  // the user's own next turn still carries it.
  it('a dispatch send leaves an armed user intent untouched', async () => {
    setIntent('debug');
    const call = (await sendTurn('sub-dispatch-intent', 'submit-message', [
      {
        id: 'msg-d2',
        role: 'user',
        parts: [{ type: 'text', text: 'dispatched prompt' }],
        metadata: { dispatchTaskId: 'task-xyz' },
      },
    ] as unknown as UIMessage[])) as { mode?: string } | undefined;
    expect(call?.mode).toBeUndefined();
    const { ackModeIntent } = await import('../../../lib/stores/mode-intent');
    expect(vi.mocked(ackModeIntent)).not.toHaveBeenCalled();
  });

  it('sends a pending transition intent as the payload mode and CAS-acks it on send success', async () => {
    setIntent('agent');
    const call = await sendTurn('sub-intent-set');
    expect(call?.mode).toBe('agent');
    // Correlated ack: the successful send acks exactly what it carried (CAS semantics live in
    // ackModeIntent, pinned by lib/stores/mode-intent.test.ts).
    const { ackModeIntent } = await import('../../../lib/stores/mode-intent');
    expect(vi.mocked(ackModeIntent)).toHaveBeenCalledWith('sub-intent-set', 'agent');
  });

  it('carries a still-armed intent on regenerate — armed means the row never got the transition', async () => {
    // A retry after a failed send re-enters with a regenerate-shaped trigger; dropping the armed
    // intent there would re-execute under the stale row mode (the exact bug class this fixes).
    // Settled intents were already disarmed by their correlated ack, so replays can't re-assert.
    setIntent('agent');
    const call = await sendTurn('sub-intent-regen', 'regenerate-message');
    expect(call?.mode).toBe('agent');
  });

  it('omits mode on regenerate when no intent is armed', async () => {
    const call = await sendTurn('sub-intent-regen-none', 'regenerate-message');
    expect('mode' in (call ?? {})).toBe(false);
  });
});

describe('flow plan-reply flip is not gated on the wipeable sub-chat store', () => {
  // Gating the reply-as-approval flip (`flow-agent-node-mode`) on the store's mode is how
  // approved chats reopened in plan mode: the store is wiped on chat switch and never hydrated
  // in split view. The flip must fire from the parked plan card alone; main no-ops an
  // already-'agent' row, so re-asserting is idempotent.
  it('flips even when the store is empty (wiped by chat switch / split view)', async () => {
    storeState.allSubChats = [];
    await sendTurn('sub-flip-empty', 'submit-message', flowPlanReadyMessages);
    expect(storeState.updateSubChatMode).toHaveBeenCalledWith('sub-flip-empty', 'agent');
  });

  it('still flips when the store says agent — main no-ops a matching row', async () => {
    storeState.allSubChats = [{ id: 'sub-flip-agent', mode: 'agent' }];
    await sendTurn('sub-flip-agent', 'submit-message', flowPlanReadyMessages);
    expect(storeState.updateSubChatMode).toHaveBeenCalledWith('sub-flip-agent', 'agent');
  });

  it('does NOT overwrite an explicitly armed toggle (fill-the-gap only)', async () => {
    // A user who toggled debug while the flow plan was parked keeps their choice; the flip
    // arms 'agent' only when no intent is pending.
    storeState.allSubChats = [];
    setIntent('plan');
    const call = await sendTurn('sub-flip-armed', 'submit-message', flowPlanReadyMessages);
    expect(storeState.updateSubChatMode).not.toHaveBeenCalled();
    expect(call?.mode).toBe('plan');
  });

  it('arms the pending intent alongside the store flip', async () => {
    storeState.allSubChats = [];
    const { armModeIntentIfEmpty } = await import('../../../lib/stores/mode-intent');
    await sendTurn('sub-flip-intent', 'submit-message', flowPlanReadyMessages);
    expect(vi.mocked(armModeIntentIfEmpty)).toHaveBeenCalledWith('sub-flip-intent', 'agent');
  });

  it('does NOT flip when the card is historical (a later assistant message displaced it)', async () => {
    // A resolved flow plan's card keeps status 'awaiting_approval' forever; only recency marks
    // it parked. A chat that once ran a flow plan must not have later plan/debug toggles or
    // ordinary sends stomped back to agent.
    storeState.allSubChats = [];
    const messages = [
      ...flowPlanReadyMessages,
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'implemented' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'now plan something new' }] },
    ] as unknown as UIMessage[];
    await sendTurn('sub-flip-stale', 'submit-message', messages);
    expect(storeState.updateSubChatMode).not.toHaveBeenCalled();
  });
});

/** The provider/model pairs the Auto matrix drives; a named type keeps the matrix parameters parsed. */
type AutoModelId = 'sonnet' | 'haiku' | 'gpt-5-codex';
type AutoAccountType = 'claude-code' | 'codex';

type AutoSendOptions = {
  perChat: boolean;
  tag: string;
  accountType?: AutoAccountType;
  modelId?: AutoModelId;
  isFlowDispatched?: boolean;
  mode?: 'agent' | 'plan';
  projectId?: string;
  /** Defaults to `chat-${tag}`. Set it to point two differently-built transports at one chat. */
  chatId?: string;
};

/** Send one turn and return the Auto value emitted on its transport settings. */
async function sendAndGetAutoReview(opts: AutoSendOptions): Promise<boolean | undefined> {
  const chatId = opts.chatId ?? `chat-${opts.tag}`;
  vi.mocked(appStore.get).mockImplementation((atom) => {
    const key = String(atom);
    if (key.includes('autoModePerChat')) return opts.perChat;
    if (key.includes('lastSelectedModelId')) return opts.modelId ?? 'sonnet';
    return new Map();
  });
  Object.assign(window, {
    desktopApi: {
      onSocketStreamChunk: vi.fn(() => vi.fn()),
      onSocketExecuteComplete: vi.fn(() => vi.fn()),
      onSocketError: vi.fn(() => vi.fn()),
      onSocketMessageSaved: vi.fn(() => vi.fn()),
    },
  });
  try {
    const transport = new WebSocketChatTransport({
      getExecutionAccountType: () => opts.accountType ?? 'claude-code',
      chatId,
      subChatId: `sub-${opts.tag}`,
      projectId: opts.projectId ?? 'proj-1',
      mode: opts.mode ?? 'agent',
    });
    const metadata = opts.isFlowDispatched ? { source: 'flow-dispatch' } : undefined;
    const messages: UIMessage[] = [
      { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }], metadata },
    ];
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId,
      messageId: undefined,
      messages,
      abortSignal: undefined,
    });
    await stream.cancel();
    // SAFETY: the mutate mock records the exact payload the transport sent; only the Auto flag on
    // `settings` is read here, and an absent send leaves the value undefined.
    const call = vi.mocked(trpcClient.socket.sendMessage.mutate).mock.calls.at(-1)?.[0] as
      | { settings?: { autoReviewTools?: boolean } }
      | undefined;
    return call?.settings?.autoReviewTools;
  } finally {
    cleanupTransportListeners(`sub-${opts.tag}`);
    Object.assign(window, { desktopApi: undefined });
  }
}

describe('websocket-chat-transport Auto Mode consent', () => {
  it("uses the chat's own Auto setting", async () => {
    expect(await sendAndGetAutoReview({ perChat: true, tag: 'am-on' })).toBe(true);
    expect(await sendAndGetAutoReview({ perChat: false, tag: 'am-off' })).toBeUndefined();
  });

  // The send path no longer branches on dispatch source: a Flow seeds the chat's own setting when
  // it dispatches, so its node turns and the user's replies resolve identically.
  it('reads the seeded chat setting for a Flow-dispatched prompt too', async () => {
    expect(
      await sendAndGetAutoReview({ perChat: true, isFlowDispatched: true, tag: 'am-flow-on' }),
    ).toBe(true);
    expect(
      await sendAndGetAutoReview({ perChat: false, isFlowDispatched: true, tag: 'am-flow-off' }),
    ).toBeUndefined();
  });

  // Removing the project axis must not remove the PROVIDER axis with it: a model with no
  // provider-native reviewer must not arm Auto, while Codex must still arm.
  it.each([
    ['claude-code', 'haiku', undefined],
    ['codex', 'gpt-5-codex', true],
    ['claude-code', 'sonnet', true],
  ] as const)(
    'resolves Auto in a projectless chat by provider/model alone: %s/%s',
    async (accountType: AutoAccountType, modelId: AutoModelId, expected?: boolean) => {
      expect(
        await sendAndGetAutoReview({
          perChat: true,
          accountType,
          modelId,
          projectId: '',
          tag: `am-projectless-${accountType}-${modelId}`,
        }),
      ).toBe(expected);
    },
  );

  // A flow-dispatched chat whose project is not localized has projectId null on the chat row while
  // the task still carries one, and the two transport constructors disagree: use-task-ipc-handler
  // passes the TASK's projectId, active-chat passes the CHAT's. While Auto read projectId, the value
  // sent depended on which one mounted first. It must not depend on that any more.
  it('sends the same Auto value however the transport was constructed for the chat', async () => {
    const fromTaskHandler = await sendAndGetAutoReview({
      perChat: true,
      chatId: 'chat-am-ctor-race',
      projectId: 'proj-1',
      tag: 'am-ctor-task',
    });
    const fromActiveChat = await sendAndGetAutoReview({
      perChat: true,
      chatId: 'chat-am-ctor-race',
      projectId: '',
      tag: 'am-ctor-chat',
    });
    expect(fromTaskHandler).toBe(true);
    expect(fromActiveChat).toBe(fromTaskHandler);
  });

  // Plan turns still carry consent: the executor opens the turn in `permissionMode: 'plan'` and
  // arms the reviewer at plan approval, so suppressing it here would leave it no way to know the
  // chat consented. See decision auto-mode-tool-approval.
  it('sends consent for a plan turn — the executor decides when to arm it', async () => {
    expect(await sendAndGetAutoReview({ perChat: true, mode: 'plan', tag: 'am-plan' })).toBe(true);
    expect(
      await sendAndGetAutoReview({ perChat: false, mode: 'plan', tag: 'am-plan-off' }),
    ).toBeUndefined();
  });
});

describe('requestClaudePrewarm', () => {
  it('asks with the pending intent and the settings a send would carry, taking nothing', async () => {
    setIntent('plan');
    requestClaudePrewarm('chat-intent', 'sub-prewarm', false);
    const warmed = vi.mocked(trpcClient.socket.prewarmClaudeSession.mutate).mock.calls[0]?.[0];
    const sent = (await sendTurn('sub-prewarm')) as { mode?: string; settings?: object };

    expect(warmed).toEqual({
      chatId: 'chat-intent',
      subChatId: 'sub-prewarm',
      mode: 'plan',
      settings: sent.settings,
    });
    expect(sent.mode).toBe('plan');
  });

  it('with a plan awaiting approval, asks for the agent mode the Approve send carries', () => {
    setIntent('plan');
    requestClaudePrewarm('chat-intent', 'sub-approve', true);

    expect(vi.mocked(trpcClient.socket.prewarmClaudeSession.mutate)).toHaveBeenLastCalledWith(
      expect.objectContaining({ subChatId: 'sub-approve', mode: 'agent' }),
    );
  });
});
