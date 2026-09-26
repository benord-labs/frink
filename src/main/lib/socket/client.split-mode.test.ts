import { describe, expect, it, vi } from 'vitest';

// Chat dispatch runs in-process: sendMessage persists locally, then notifies executor listeners.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/tmp/frink-test-home' : '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const {
  appendUserMessageLocalMock,
  getSubChatByIdLocalMock,
  resolveSendModeMock,
  setStreamIdLocalMock,
} = vi.hoisted(() => ({
  appendUserMessageLocalMock: vi.fn(async () => {}),
  getSubChatByIdLocalMock: vi.fn(async () => ({ sessionId: null })),
  resolveSendModeMock: vi.fn(
    async (_db: unknown, _subChatId: string, intent?: string): Promise<string> => intent ?? 'agent',
  ),
  setStreamIdLocalMock: vi.fn(async () => {}),
}));

vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({}) as unknown) }));

vi.mock('../db/repos/sub-chats', () => ({
  appendUserMessageLocal: appendUserMessageLocalMock,
  getSubChatByIdLocal: getSubChatByIdLocalMock,
  resolveSendMode: resolveSendModeMock,
  setStreamIdLocal: setStreamIdLocalMock,
  upsertAssistantMessageLocal: vi.fn(async () => {}),
  finalizeAssistantMessageLocal: vi.fn(async () => {}),
  markPlanApprovedLocal: vi.fn(async () => {}),
}));

// `../credentials` imports `claudeCodeCredentials` from the real `../db`
// schema; with `../db` mocked the schema export is gone, so the module
// fails to evaluate. Mock the credentials surface client.ts uses so the
// transitive import never reaches that line.
vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  // Mirrors the real predicate (credentials.ts): passthrough rows are token-null by design,
  // so `passthrough` — not token presence — is what the spawn pre-flight gates on.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

import { registerPendingDispatchMode } from '../task-executor/dispatch-registry';
import {
  onExecuteRequest,
  sendMessage,
} from './client';

describe('socket client chat dispatch', () => {
  it('sendMessage notifies local executor listeners', async () => {
    const listener = vi.fn();
    const off = onExecuteRequest(listener);
    try {
      await sendMessage({
        chatId: 'c1',
        subChatId: 's1',
        projectId: 'p1',
        trigger: 'submit-message',
        userMessage: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        mode: 'agent',
      } as unknown as Parameters<typeof sendMessage>[0]);

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  // Row-vs-intent semantics (persist, refuse-on-missing-row) live in the repo's own suite
  // (sub-chats.test.ts resolveSendMode); here we pin that sendMessage routes THROUGH it and
  // dispatches whatever it resolves.
  describe('mode resolution at dispatch (decision `sub-chat-mode-ownership`)', () => {
    const basePayload = (over: Record<string, unknown> = {}) =>
      ({
        chatId: 'c1',
        subChatId: 's1',
        projectId: 'p1',
        trigger: 'submit-message',
        userMessage: { id: 'u-mode', role: 'user', parts: [{ type: 'text', text: 'go' }] },
        ...over,
      }) as unknown as Parameters<typeof sendMessage>[0];

    it('absent intent → dispatches the row-resolved mode', async () => {
      resolveSendModeMock.mockResolvedValueOnce('plan');
      const listener = vi.fn();
      const off = onExecuteRequest(listener);
      try {
        await sendMessage(basePayload());
        expect(resolveSendModeMock).toHaveBeenCalledWith(expect.anything(), 's1', undefined);
        expect(listener.mock.calls[0][0]).toMatchObject({ mode: 'plan' });
      } finally {
        off();
      }
    });

    it('resolution refusal (no row, no intent) fails the send before any persistence', async () => {
      appendUserMessageLocalMock.mockClear();
      resolveSendModeMock.mockRejectedValueOnce(new Error('Cannot resolve chat mode for s1'));
      await expect(sendMessage(basePayload())).rejects.toThrow(/Cannot resolve chat mode/);
      expect(appendUserMessageLocalMock).not.toHaveBeenCalled();
    });

    it('explicit intent → passed to resolution and dispatched', async () => {
      const listener = vi.fn();
      const off = onExecuteRequest(listener);
      try {
        await sendMessage(basePayload({ mode: 'agent' }));
        expect(resolveSendModeMock).toHaveBeenCalledWith(expect.anything(), 's1', 'agent');
        expect(listener.mock.calls[0][0]).toMatchObject({ mode: 'agent' });
      } finally {
        off();
      }
    });

    // Machine-turn authority: a send carrying the dispatch's task id binds the mode from the
    // dispatching task, overriding any renderer-carried intent (decision `sub-chat-mode-ownership`,
    // machine-turn amendment).
    it('task-dispatched send → task mode overrides a renderer-carried intent', async () => {
      registerPendingDispatchMode('s-dispatch', 'task-d1', 'plan');
      const listener = vi.fn();
      const off = onExecuteRequest(listener);
      try {
        await sendMessage(
          basePayload({ subChatId: 's-dispatch', mode: 'agent', dispatchTaskId: 'task-d1' }),
        );
        expect(resolveSendModeMock).toHaveBeenCalledWith(expect.anything(), 's-dispatch', 'plan');
        expect(listener.mock.calls[0][0]).toMatchObject({ mode: 'plan' });
      } finally {
        off();
      }
    });

    // Consume-after-commit: the record settles only once resolveSendMode's row write lands, so a
    // failed write leaves it for the requeued retry to re-match instead of falling back to
    // renderer-carried state (the race this override exists to eliminate).
    it('task-dispatched send whose row write fails keeps the record; the retry re-binds', async () => {
      registerPendingDispatchMode('s-retry', 'task-d2', 'plan');
      const dispatched = () =>
        basePayload({ subChatId: 's-retry', mode: 'agent', dispatchTaskId: 'task-d2' });
      resolveSendModeMock.mockRejectedValueOnce(new Error('row write failed'));
      await expect(sendMessage(dispatched())).rejects.toThrow(/row write failed/);

      const listener = vi.fn();
      const off = onExecuteRequest(listener);
      try {
        await sendMessage(dispatched());
        expect(resolveSendModeMock).toHaveBeenLastCalledWith(expect.anything(), 's-retry', 'plan');
        expect(listener.mock.calls[0][0]).toMatchObject({ mode: 'plan' });
      } finally {
        off();
      }
    });

    it('user reply on a sub-chat with a dispatch record → intent/row resolution untouched', async () => {
      registerPendingDispatchMode('s-reply', 'task-d3', 'plan');
      const listener = vi.fn();
      const off = onExecuteRequest(listener);
      try {
        await sendMessage(
          basePayload({
            subChatId: 's-reply',
            mode: 'agent',
            userMessage: { id: 'u-d2', role: 'user', parts: [{ type: 'text', text: 'carry on' }] },
          }),
        );
        expect(resolveSendModeMock).toHaveBeenCalledWith(expect.anything(), 's-reply', 'agent');
        expect(listener.mock.calls[0][0]).toMatchObject({ mode: 'agent' });
      } finally {
        off();
      }
    });
  });
});
