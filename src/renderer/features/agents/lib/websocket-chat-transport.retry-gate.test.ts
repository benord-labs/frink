// @vitest-environment happy-dom

/**
 * The pending-retry gate: a failed turn only offers Retry when it has something to re-send.
 * Retry re-runs the SAME turn from the message list (never a stored payload), so the gate must
 * agree with what the send actually carries — extractText + extractImages, nothing else.
 *
 * Lives beside websocket-chat-transport.test.ts rather than inside it: that file is at its
 * recorded size ceiling, and this slice needs only a fraction of its mock harness.
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

vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({ allSubChats: [], updateSubChatMode: vi.fn() }),
  },
}));

import { appStore } from '../../../lib/jotai-store';
import { WebSocketChatTransport } from './websocket-chat-transport';

type ErrorPayload = { subChatId: string; error: string; category?: string };

const waitForAsync = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setupErrorTransport(subChatId: string, accountType = 'claude-code') {
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
    getExecutionAccountType: () => accountType as 'claude-code',
    chatId: `chat-${subChatId}`,
    subChatId,
    projectId: 'proj-1',
    mode: 'agent',
    onExecutionError,
  });
  return { transport, onExecutionError, fireSocketError: (p: ErrorPayload) => fireSocketError(p) };
}

/** Start a turn so its send-time content is captured in the retry gate's closure. */
async function startTurn(
  transport: WebSocketChatTransport,
  subChatId: string,
  parts: unknown[],
): Promise<void> {
  const messages = parts.length
    ? ([{ id: 'msg-1', role: 'user', parts }] as unknown as UIMessage[])
    : ([{ id: 'msg-1', role: 'assistant', parts: [] }] as unknown as UIMessage[]);
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: `chat-${subChatId}`,
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  void stream.pipeTo(new WritableStream()).catch(() => {});
  await waitForAsync();
}

function retryWritten(subChatId: string): boolean {
  const setCalls = (appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } }).mock
    .calls;
  return setCalls.some(
    (call) => String(call[0]).includes(`pendingChatRetry:${subChatId}`) && call[1] != null,
  );
}

/** Drive one turn to failure and report whether a pending retry was written for it. */
async function retryOfferedFor(subChatId: string, parts: unknown[]): Promise<boolean> {
  const { transport, fireSocketError } = setupErrorTransport(subChatId);
  await startTurn(transport, subChatId, parts);
  fireSocketError({ subChatId, error: 'provider unavailable' });
  await waitForAsync();
  return retryWritten(subChatId);
}

const imagePart = (data: Record<string, unknown>) => ({ type: 'data-image', data });

beforeEach(() => {
  vi.clearAllMocks();
  // The real model helpers run here, so the selected-model atom must read back as a model id.
  vi.mocked(appStore.get).mockImplementation((target: unknown) =>
    String(target).includes('lastSelectedModelId') ? 'sonnet' : new Map(),
  );
});

describe('websocket-chat-transport pending-retry gate', () => {
  it('offers retry for a text turn', async () => {
    expect(await retryOfferedFor('gate-text', [{ type: 'text', text: 'hello' }])).toBe(true);
  });

  it('offers retry for an image-only turn with a usable image', async () => {
    const parts = [imagePart({ base64Data: 'aGk=', mediaType: 'image/jpeg' })];
    expect(await retryOfferedFor('gate-image-ok', parts)).toBe(true);
  });

  it('does not offer retry when the only image has no base64Data', async () => {
    const parts = [imagePart({ mediaType: 'image/png', filename: 'shot.png' })];
    expect(await retryOfferedFor('gate-image-nodata', parts)).toBe(false);
  });

  it('offers retry when the only image omits mediaType', async () => {
    // Not an oversight: extractImages defaults a missing mediaType to 'image/png', so the image is
    // still sent. The gate tracks the send, so it must stay true here.
    const parts = [imagePart({ base64Data: 'aGk=' })];
    expect(await retryOfferedFor('gate-image-nomime', parts)).toBe(true);
  });

  it('does not offer retry for a file-only turn', async () => {
    // data-file parts never reach the outgoing payload, so retrying one would re-send nothing.
    const parts = [{ type: 'data-file', data: { url: 'https://x/f.pdf', filename: 'f.pdf' } }];
    expect(await retryOfferedFor('gate-file-only', parts)).toBe(false);
  });

  it('does not offer retry, and does not throw, when the turn has no user message', async () => {
    expect(await retryOfferedFor('gate-no-user', [])).toBe(false);
  });

  it('offers retry for an SDK-shaped file image part', async () => {
    // Providers that hand back SDK-style parts (mimeType + data) instead of UI-style data-image
    // still produce a sendable image, so the gate must recognise both shapes.
    const parts = [{ type: 'file', mimeType: 'image/png', data: 'aGk=' }];
    expect(await retryOfferedFor('gate-sdk-file', parts)).toBe(true);
  });

  it('does not offer retry for an empty text part with nothing else', async () => {
    expect(await retryOfferedFor('gate-empty-text', [{ type: 'text', text: '' }])).toBe(false);
  });

  it('keeps the retry offer when the failure also triggers a rollback', async () => {
    // The retry write is deliberately the handler's last statement; the rollback callback runs
    // before it and must not cost the user the Retry affordance.
    const subChatId = 'gate-rollback';
    const { transport, onExecutionError, fireSocketError } = setupErrorTransport(subChatId);
    await startTurn(transport, subChatId, [{ type: 'text', text: 'hello' }]);

    fireSocketError({ subChatId, error: 'claude stream exploded' });
    await waitForAsync();

    expect(onExecutionError).toHaveBeenCalledWith(subChatId);
    expect(retryWritten(subChatId)).toBe(true);
  });

  it('gates each pane on its own content when two sub-chats fail together', async () => {
    const withText = 'gate-pane-text';
    const withBadImage = 'gate-pane-image';
    const paneA = setupErrorTransport(withText);
    await startTurn(paneA.transport, withText, [{ type: 'text', text: 'hello' }]);
    const paneB = setupErrorTransport(withBadImage);
    await startTurn(paneB.transport, withBadImage, [imagePart({ mediaType: 'image/png' })]);

    paneB.fireSocketError({ subChatId: withBadImage, error: 'provider unavailable' });
    paneA.fireSocketError({ subChatId: withText, error: 'provider unavailable' });
    await waitForAsync();

    expect(retryWritten(withText)).toBe(true);
    expect(retryWritten(withBadImage)).toBe(false);
  });

  it('still surfaces the error when persisting the retry throws', async () => {
    const subChatId = 'gate-storage-throws';
    // The retry atom is localStorage-backed; a quota rejection must not swallow the user's error.
    vi.mocked(appStore.set).mockImplementation((target: unknown) => {
      if (String(target).includes(`pendingChatRetry:${subChatId}`)) {
        throw new Error('QuotaExceededError');
      }
    });

    const { transport, fireSocketError } = setupErrorTransport(subChatId);
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: `chat-${subChatId}`,
      messageId: undefined,
      messages: [
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ] as unknown as UIMessage[],
      abortSignal: undefined,
    });
    void stream.pipeTo(new WritableStream()).catch(() => {});
    await waitForAsync();

    // The write is the handler's last statement, so the throw escapes to the IPC emitter by design
    // — cheaper than a try/catch, and by then every user-visible effect has already happened.
    try {
      fireSocketError({ subChatId, error: 'provider unavailable' });
    } catch {
      /* expected */
    }
    await waitForAsync();

    expect(toast.error).toHaveBeenCalled();
    const targets = (
      appStore.set as unknown as { mock: { calls: Array<[unknown, unknown]> } }
    ).mock.calls.map((call) => String(call[0]));
    // Error signal raised and the run torn down, despite the failed retry write.
    expect(targets.some((t) => t.includes(`taskExecutionError:${subChatId}`))).toBe(true);
    expect(targets.some((t) => t.includes(`approvedPlanContext:${subChatId}`))).toBe(true);
  });
});
