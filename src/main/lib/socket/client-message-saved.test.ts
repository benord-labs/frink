import { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A send that no window initiated (the phone) must still put the user bubble in every window.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/tmp/frink-test-home' : '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { appendUserMessageLocalMock } = vi.hoisted(() => ({
  appendUserMessageLocalMock: vi.fn(async () => {}),
}));

vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({}) as unknown) }));
vi.mock('../db/repos/project-ai-accounts', () => ({ assertChatLogin: vi.fn() }));

vi.mock('../db/repos/sub-chats', () => ({
  appendUserMessage: appendUserMessageLocalMock,
  getSubChatById: vi.fn(async () => ({ sessionId: null, messages: [] })),
  resolveSendMode: vi.fn(async (_db: unknown, _id: string, intent?: string) => intent ?? 'agent'),
  setStreamId: vi.fn(async () => {}),
  markPlanApproved: vi.fn(async () => {}),
}));

vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  isResolvedCredential: () => true,
}));

import { assertChatLogin } from '../db/repos/project-ai-accounts';
import { setStreamId } from '../db/repos/sub-chats';
import { onExecuteRequest, sendMessage } from './client';

const send = vi.fn();
const events: string[] = [];

async function sendFromPhone(over: Record<string, unknown> = {}): Promise<void> {
  const off = onExecuteRequest((p: { onExecutionStarted?: (e?: Error) => void }) => {
    events.push('execute');
    p.onExecutionStarted?.();
  });
  try {
    await sendMessage({
      chatId: 'c1',
      subChatId: 's1',
      projectId: 'p1',
      trigger: 'submit-message',
      userMessage: {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        metadata: { source: 'mobile' },
      },
      ...over,
    } as unknown as Parameters<typeof sendMessage>[0]);
  } finally {
    off();
  }
}

describe('sendMessage → socket:message-saved', () => {
  beforeEach(() => {
    events.length = 0;
    send.mockReset();
    send.mockImplementation((channel: string) => events.push(channel));
    appendUserMessageLocalMock.mockReset();
    appendUserMessageLocalMock.mockResolvedValue(undefined);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isDestroyed: () => false, webContents: { isCrashed: () => false, id: 1, send } },
    ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
  });

  it('broadcasts the persisted user message before the turn is dispatched', async () => {
    await sendFromPhone();

    expect(send).toHaveBeenCalledWith('socket:message-saved', {
      chatId: 'c1',
      subChatId: 's1',
      message: {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        metadata: { source: 'mobile' },
      },
    });
    expect(events.indexOf('socket:message-saved')).toBeLessThan(events.indexOf('execute'));
  });

  it("stamps a dispatched prompt with its task, the resume gate's proof the prompt was sent", async () => {
    await sendFromPhone({ dispatchTaskId: 'task-1' });

    expect(appendUserMessageLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      's1',
      expect.objectContaining({ metadata: { source: 'mobile', dispatchTaskId: 'task-1' } }),
    );
  });

  it('does not broadcast a regenerate, which appends no new user message', async () => {
    await sendFromPhone({ trigger: 'regenerate-message' });

    expect(send).not.toHaveBeenCalledWith('socket:message-saved', expect.anything());
  });

  it('does not announce a user message that failed to persist', async () => {
    appendUserMessageLocalMock.mockRejectedValueOnce(new Error('disk full'));

    await sendFromPhone();

    expect(send).not.toHaveBeenCalledWith('socket:message-saved', expect.anything());
  });

  it('keeps the message but never starts a turn in a chat whose login was removed', async () => {
    const blocked = Object.assign(new Error('removed'), { category: 'LOGIN_REMOVED' });
    vi.mocked(assertChatLogin).mockRejectedValueOnce(blocked);
    vi.mocked(setStreamId).mockClear();

    await expect(sendFromPhone()).rejects.toBe(blocked);

    expect(send).toHaveBeenCalledWith('socket:message-saved', expect.anything());
    expect(events).not.toContain('execute');
    expect(setStreamId).not.toHaveBeenCalled();
  });
});
