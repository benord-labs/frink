import { beforeEach, describe, expect, it, vi } from 'vitest';

// sc-2512: a send whose turn never starts must release the stream_id it wrote, or the renderer's
// first-message replay (which skips while stream_id is set) never re-sends it.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/tmp/frink-test-home' : '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { setStreamIdMock, clearStreamIdIfCurrentMock, writeOrder, captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  setStreamIdMock: vi.fn(async () => {}),
  clearStreamIdIfCurrentMock: vi.fn(async () => {}),
  writeOrder: [] as string[],
}));

vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({}) as unknown) }));
vi.mock('../db/repos/project-ai-accounts', () => ({ assertChatLogin: vi.fn() }));

vi.mock('../db/repos/sub-chats', () => ({
  appendUserMessage: vi.fn(async () => {}),
  getSubChatById: vi.fn(async () => ({ sessionId: null })),
  resolveSendMode: vi.fn(async (_db: unknown, _id: string, intent?: string) => intent ?? 'agent'),
  setStreamId: setStreamIdMock,
  clearStreamIdIfCurrent: clearStreamIdIfCurrentMock,
  markPlanApproved: vi.fn(async () => {}),
}));

// `../db` is mocked, so the real `../credentials` (which reads its schema) cannot load.
vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

vi.mock('../sentry/init', () => ({
  captureMainException: captureMock,
  captureMainMessage: vi.fn(),
}));

vi.mock('../tasks/dispatch-cancel-fence', () => ({ abortIfTaskNoLongerRunning: vi.fn() }));

import { onExecuteRequest, sendMessage } from './client';

const payload = () =>
  ({
    chatId: 'c1',
    subChatId: 's-release',
    projectId: 'p1',
    trigger: 'regenerate-message',
    userMessage: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'go' }] },
  }) as unknown as Parameters<typeof sendMessage>[0];

function writtenStreamId(): string {
  const call = setStreamIdMock.mock.calls[0] as unknown as [unknown, string, string] | undefined;
  if (!call) throw new Error('stream_id was never written');
  return call[2];
}

describe('sendMessage → stream_id release when no turn starts', () => {
  beforeEach(() => {
    setStreamIdMock.mockClear();
    captureMock.mockClear();
    clearStreamIdIfCurrentMock.mockReset();
    clearStreamIdIfCurrentMock.mockImplementation(async () => void writeOrder.push('clear'));
    writeOrder.length = 0;
  });

  it('releases the written stream_id before reporting an executor start failure', async () => {
    const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) =>
      p.onExecutionStarted?.(new Error('could not start')),
    );
    try {
      await expect(sendMessage(payload())).rejects.toThrow('could not start');
    } finally {
      off();
    }
    expect(clearStreamIdIfCurrentMock).toHaveBeenCalledWith(
      expect.anything(),
      's-release',
      writtenStreamId(),
    );
    expect(writeOrder).toEqual(['clear']);
  });

  it('releases the written stream_id when no executor is listening', async () => {
    await expect(sendMessage(payload())).rejects.toThrow('Chat execution is not ready.');
    expect(clearStreamIdIfCurrentMock).toHaveBeenCalledWith(
      expect.anything(),
      's-release',
      writtenStreamId(),
    );
  });

  it('retries a failed release once before reporting the start failure', async () => {
    clearStreamIdIfCurrentMock.mockRejectedValueOnce(new Error('db locked'));
    const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) =>
      p.onExecutionStarted?.(new Error('could not start')),
    );
    try {
      await expect(sendMessage(payload())).rejects.toThrow('could not start');
    } finally {
      off();
    }
    expect(clearStreamIdIfCurrentMock).toHaveBeenCalledTimes(2);
    expect(writeOrder).toEqual(['clear']);
    expect(captureMock).not.toHaveBeenCalled();
  });

  // A stream_id that cannot be released blocks replay on reopen, so it must reach Sentry.
  it('reports a release that keeps failing, and still surfaces the start failure', async () => {
    clearStreamIdIfCurrentMock.mockRejectedValue(new Error('disk I/O error'));
    const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) =>
      p.onExecutionStarted?.(new Error('could not start')),
    );
    try {
      await expect(sendMessage(payload())).rejects.toThrow('could not start');
    } finally {
      off();
    }
    expect(clearStreamIdIfCurrentMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'stream-id-release',
    });
  });

  // flows/startup acknowledges with an error whenever handleRemoteExecute rejects — including a
  // run that already acknowledged its start. That turn DID start; its stream_id is not ours to drop.
  it('ignores an error acknowledgement that arrives after the turn started', async () => {
    let lateError: (() => void) | undefined;
    const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) => {
      p.onExecutionStarted?.();
      lateError = () => p.onExecutionStarted?.(new Error('handler rejected mid-run'));
    });
    try {
      await sendMessage(payload());
      lateError?.();
      await Promise.resolve();
    } finally {
      off();
    }
    expect(clearStreamIdIfCurrentMock).not.toHaveBeenCalled();
  });

  // Admission serializes per sub-chat: the next send must not write its stream_id until the failed
  // send's release has landed, or the release would race the newer turn's write.
  it("releases a failed send's stream_id before the next send on the sub-chat writes its own", async () => {
    let finishRelease!: () => void;
    clearStreamIdIfCurrentMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = () => {
            writeOrder.push('clear');
            resolve();
          };
        }),
    );
    setStreamIdMock.mockImplementation(async () => void writeOrder.push('set'));
    let calls = 0;
    const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) => {
      calls += 1;
      p.onExecutionStarted?.(calls === 1 ? new Error('could not start') : undefined);
    });
    try {
      const first = sendMessage(payload()).catch((e: Error) => e.message);
      const second = sendMessage({
        ...payload(),
        userMessage: { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'again' }] },
      } as unknown as Parameters<typeof sendMessage>[0]);
      await vi.waitFor(() => expect(clearStreamIdIfCurrentMock).toHaveBeenCalledTimes(1));
      expect(writeOrder).toEqual(['set']);
      finishRelease();
      await expect(first).resolves.toBe('could not start');
      await second;
    } finally {
      off();
      setStreamIdMock.mockImplementation(async () => {});
    }
    expect(writeOrder).toEqual(['set', 'clear', 'set']);
  });

  it('keeps stream_id when the turn started', async () => {
    const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) =>
      p.onExecutionStarted?.(),
    );
    try {
      await sendMessage(payload());
    } finally {
      off();
    }
    expect(setStreamIdMock).toHaveBeenCalledTimes(1);
    expect(clearStreamIdIfCurrentMock).not.toHaveBeenCalled();
  });
});
