import { beforeEach, describe, expect, it, vi } from 'vitest';

// sc-3263: a task-dispatched send re-checks its task once the executor registers the turn.
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
  fenceMock,
} = vi.hoisted(() => ({
  fenceMock: vi.fn(async () => {}),
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

// `../db` is mocked, so the real `../credentials` (which reads its schema) cannot load.
vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  // Mirrors the real predicate (credentials.ts): passthrough rows are token-null by design,
  // so `passthrough` — not token presence — is what the spawn pre-flight gates on.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

vi.mock('../tasks/dispatch-cancel-fence', () => ({ abortIfTaskNoLongerRunning: fenceMock }));

import { onExecuteRequest, sendMessage } from './client';

const payload = (over: Record<string, unknown> = {}) =>
  ({
    chatId: 'c1',
    subChatId: 's-fence',
    projectId: 'p1',
    trigger: 'submit-message',
    userMessage: { id: 'u-fence', role: 'user', parts: [{ type: 'text', text: 'go' }] },
    ...over,
  }) as unknown as Parameters<typeof sendMessage>[0];

async function send(over: Record<string, unknown>, startError?: Error): Promise<void> {
  const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) =>
    p.onExecutionStarted?.(startError),
  );
  try {
    await sendMessage(payload(over)).catch(() => {});
  } finally {
    off();
  }
}

describe('dispatched turn → dispatch-cancel fence', () => {
  beforeEach(() => fenceMock.mockClear());

  it('re-checks the dispatching task once the executor has registered the turn', async () => {
    await send({ dispatchTaskId: 'task-f1' });
    expect(fenceMock).toHaveBeenCalledWith('task-f1', 's-fence');
  });

  it('skips the fence when the executor declined to start (nothing registered to abort)', async () => {
    await send({ dispatchTaskId: 'task-f2' }, new Error('busy'));
    expect(fenceMock).not.toHaveBeenCalled();
  });

  it('never fences a user send (no dispatch task id)', async () => {
    await send({});
    expect(fenceMock).not.toHaveBeenCalled();
  });
});
