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
vi.mock('../db/repos/project-ai-accounts', () => ({ assertChatLogin: vi.fn() }));

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

import { isDispatchPending, registerPendingDispatchMode } from '../task-executor/dispatch-registry';
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

describe('dispatch identity on the execute request (sc-2775)', () => {
  async function executePayload(over: Record<string, unknown>) {
    let seen: Record<string, unknown> | undefined;
    const off = onExecuteRequest((p: Record<string, unknown>) => {
      seen = p;
      (p.onExecutionStarted as (e?: Error) => void)?.();
    });
    try {
      await sendMessage(payload(over)).catch(() => {});
    } finally {
      off();
    }
    return seen;
  }

  const DISPATCHED_AT = '2026-10-02T10:30:13.000Z';
  function holdDispatch(taskId: string): void {
    registerPendingDispatchMode('s-fence', taskId, 'execute', {
      chatId: 'c1',
      subChatId: 's-fence',
      taskId,
      prompt: 'go',
      dispatchGeneration: DISPATCHED_AT,
      projectId: null,
      projectPath: null,
      startMode: 'execute',
      skipReview: true,
      headless: true,
    });
  }

  it("forwards the dispatch attempt so the executor can stamp that step's turn as started", async () => {
    holdDispatch('task-d1');
    expect(
      await executePayload({ dispatchTaskId: 'task-d1', dispatchGeneration: DISPATCHED_AT }),
    ).toMatchObject({
      dispatch: { taskId: 'task-d1', dispatchedAt: DISPATCHED_AT },
    });
  });

  // A retry or re-claim reuses the task id (and maybe the prompt); only the attempt tells them apart.
  it("drops a send naming an earlier attempt of the held dispatch's task", async () => {
    holdDispatch('task-d2');
    expect(
      await executePayload({
        dispatchTaskId: 'task-d2',
        dispatchGeneration: '2026-10-02T09:00:00.000Z',
      }),
    ).not.toHaveProperty('dispatch');
  });

  it('drops a send naming no attempt at all', async () => {
    holdDispatch('task-d3');
    expect(await executePayload({ dispatchTaskId: 'task-d3' })).not.toHaveProperty('dispatch');
  });

  // A renderer-supplied id is only a claim: without a held dispatch it must not arm or stamp a step.
  it('drops a dispatch id that matches no held dispatch', async () => {
    expect(await executePayload({ dispatchTaskId: 'task-unheld' })).not.toHaveProperty('dispatch');
  });

  it('carries no dispatch identity for a user send', async () => {
    expect(await executePayload({})).not.toHaveProperty('dispatch');
  });
});

describe('a dispatched send that never starts a turn (sc-2775)', () => {
  const held = () =>
    registerPendingDispatchMode('s-fence', 'task-r1', 'execute', {
      chatId: 'c1',
      subChatId: 's-fence',
      taskId: 'task-r1',
      prompt: 'go',
      projectId: null,
      projectPath: null,
      startMode: 'execute',
      skipReview: true,
      headless: true,
      dispatchGeneration: 'gen-r1',
    });

  it('keeps its dispatch pending when the executor declines it, so the retry still proves it', async () => {
    held();
    await send({ dispatchTaskId: 'task-r1', dispatchGeneration: 'gen-r1' }, new Error('declined'));
    expect(isDispatchPending('s-fence', 'task-r1')).toBe(true);
  });

  it('keeps its dispatch pending when the send throws before execution', async () => {
    held();
    await sendMessage(payload({ dispatchTaskId: 'task-r1', dispatchGeneration: 'gen-r1' })).catch(
      () => {},
    );
    expect(isDispatchPending('s-fence', 'task-r1')).toBe(true);
  });

  it("a stale attempt's send never settles the current attempt's dispatch, nor takes its mode", async () => {
    held();
    resolveSendModeMock.mockClear();
    await send({ dispatchTaskId: 'task-r1', dispatchGeneration: 'gen-older' });
    expect(isDispatchPending('s-fence', 'task-r1')).toBe(true);
    expect(resolveSendModeMock.mock.calls.at(-1)?.[2]).toBeUndefined();
  });

  it("binds the current attempt's send to the dispatch's mode", async () => {
    held();
    resolveSendModeMock.mockClear();
    await send({ dispatchTaskId: 'task-r1', dispatchGeneration: 'gen-r1' });
    expect(resolveSendModeMock.mock.calls.at(-1)?.[2]).toBe('agent');
  });

  // A prompt can wait behind a long turn: its attempt is still provable after the mode TTL.
  it('still proves a flow dispatch queued for longer than 15 minutes', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    held();
    now.mockReturnValue(start + 20 * 60_000);
    let seen: Record<string, unknown> | undefined;
    const off = onExecuteRequest((p: Record<string, unknown>) => {
      seen = p;
      (p.onExecutionStarted as (e?: Error) => void)?.();
    });
    try {
      await sendMessage(payload({ dispatchTaskId: 'task-r1', dispatchGeneration: 'gen-r1' }));
    } finally {
      off();
      now.mockRestore();
    }
    expect(seen).toMatchObject({ dispatch: { taskId: 'task-r1', dispatchedAt: 'gen-r1' } });
  });

  it('settles it once the turn starts', async () => {
    held();
    await send({ dispatchTaskId: 'task-r1', dispatchGeneration: 'gen-r1' });
    expect(isDispatchPending('s-fence', 'task-r1')).toBe(false);
  });
});
