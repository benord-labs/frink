import { beforeEach, describe, expect, it, vi } from 'vitest';

// sc-3214: main decides whether a person typed a send; the executor marks those turns for the agent.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? '/tmp/frink-test-home' : '/tmp'),
  },
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
vi.mock('../db/repos/project-ai-accounts', () => ({
  assertChatLogin: vi.fn(),
}));

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

vi.mock('../tasks/dispatch-cancel-fence', () => ({
  abortIfTaskNoLongerRunning: fenceMock,
}));

import { isTypedByPerson, onExecuteRequest, sendMessage } from './client';

const payload = (over: Record<string, unknown> = {}) =>
  ({
    chatId: 'c1',
    subChatId: 's-typed',
    projectId: 'p1',
    trigger: 'submit-message',
    userMessage: {
      id: 'u-typed',
      role: 'user',
      parts: [{ type: 'text', text: 'I edited it' }],
    },
    ...over,
  }) as unknown as Parameters<typeof sendMessage>[0];

const typed = (over: Record<string, unknown>, text = 'I edited it') =>
  isTypedByPerson(payload(over), text);

describe('isTypedByPerson', () => {
  it('is true for a plain send — composer, park answer, or phone', () => {
    expect(typed({})).toBe(true);
    expect(typed({ expectedFlowTaskId: 'task-1' })).toBe(true);
  });

  it('is false for every machine-originated send', () => {
    expect(typed({ dispatchTaskId: 'task-1' })).toBe(false);
    expect(typed({ approvedPlanContext: { planId: 'p', planText: 'x' } })).toBe(false);
    expect(typed({ trigger: 'regenerate-message' })).toBe(false);
    expect(
      typed({
        userMessage: {
          id: 'u',
          role: 'user',
          parts: [],
          metadata: { source: 'flow-dispatch' },
        },
      }),
    ).toBe(false);
    expect(typed({}, '<!--FRINK_HIDDEN_WAKE-->Continue the paused run.')).toBe(false);
  });
});

describe('sendMessage → execute request', () => {
  async function capture(over: Record<string, unknown>): Promise<{ typedByPerson?: boolean }> {
    let seen: { typedByPerson?: boolean } = {};
    const off = onExecuteRequest(
      (p: { typedByPerson?: boolean; onExecutionStarted?: () => void }) => {
        seen = p;
        p.onExecutionStarted?.();
      },
    );
    try {
      await sendMessage(payload(over)).catch(() => {});
    } finally {
      off();
    }
    return seen;
  }

  beforeEach(() => fenceMock.mockClear());

  it('forwards typedByPerson computed in main, not from the payload', async () => {
    expect((await capture({})).typedByPerson).toBe(true);
    expect((await capture({ dispatchTaskId: 'task-9' })).typedByPerson).toBe(false);
    // A renderer cannot assert it: the field is recomputed regardless of what was sent.
    expect((await capture({ dispatchTaskId: 'task-9', typedByPerson: true })).typedByPerson).toBe(
      false,
    );
  });
});
