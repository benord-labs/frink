import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSubChatForChatMock,
  createSubChatMock,
  updateSubChatModeMock,
  sendSubChatModeChangeMock,
} = vi.hoisted(() => ({
  getSubChatForChatMock: vi.fn(),
  createSubChatMock: vi.fn(),
  updateSubChatModeMock: vi.fn(),
  sendSubChatModeChangeMock: vi.fn(),
}));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../db/repos/sub-chats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/repos/sub-chats')>()),
  getSubChatForChat: getSubChatForChatMock,
  createSubChat: createSubChatMock,
  updateSubChatMode: updateSubChatModeMock,
}));

vi.mock('../socket/client', () => ({
  sendSubChatModeChange: sendSubChatModeChangeMock,
}));

import { resolveSubChatIdForExistingChat } from './index';

describe('resolveSubChatIdForExistingChat', () => {
  beforeEach(() => {
    getSubChatForChatMock.mockReset();
    createSubChatMock.mockReset();
    updateSubChatModeMock.mockReset();
    sendSubChatModeChangeMock.mockReset();
    updateSubChatModeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns existingSubChatId when set, aligning its mode to the task startMode', async () => {
    const { subChatId: id } = await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: 'sub-fixed',
      executionMode: 'continue_chat',
      startMode: 'plan',
    });
    expect(id).toBe('sub-fixed');
    expect(getSubChatForChatMock).not.toHaveBeenCalled();
    expect(createSubChatMock).not.toHaveBeenCalled();
    expect(updateSubChatModeMock).toHaveBeenCalledWith(expect.anything(), 'sub-fixed', 'plan');
    expect(sendSubChatModeChangeMock).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'sub-fixed',
      mode: 'plan',
    });
  });

  it("continue_chat: reuses the chat's sub-chat and aligns its mode to the task startMode", async () => {
    getSubChatForChatMock.mockResolvedValue({ id: 'newest' });

    const { subChatId: id } = await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: 'continue_chat',
      startMode: 'plan',
    });

    expect(id).toBe('newest');
    expect(createSubChatMock).not.toHaveBeenCalled();
    expect(updateSubChatModeMock).toHaveBeenCalledWith(expect.anything(), 'newest', 'plan');
    expect(sendSubChatModeChangeMock).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'newest',
      mode: 'plan',
    });
  });

  it('continue_chat reuse: a plan sub-chat is flipped back for an execute node', async () => {
    getSubChatForChatMock.mockResolvedValue({ id: 'planned' });

    await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: 'continue_chat',
      startMode: 'execute',
    });

    expect(updateSubChatModeMock).toHaveBeenCalledWith(expect.anything(), 'planned', 'agent');
  });

  it('continue_chat: creates sub-chat when none exist', async () => {
    getSubChatForChatMock.mockResolvedValue(null);
    createSubChatMock.mockResolvedValue({ id: 'created-sub' });

    const { subChatId: id } = await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: 'continue_chat',
      startMode: 'plan',
    });

    expect(id).toBe('created-sub');
    expect(updateSubChatModeMock).not.toHaveBeenCalled();
    expect(createSubChatMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: 'c1',
        name: 'Task Execution',
        mode: 'plan',
        messages: '[]',
      }),
    );
  });

  it('continue_chat reuse: debug startMode lands as debug mode', async () => {
    getSubChatForChatMock.mockResolvedValue({ id: 'reused' });

    await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: 'continue_chat',
      startMode: 'debug',
    });

    expect(updateSubChatModeMock).toHaveBeenCalledWith(expect.anything(), 'reused', 'debug');
    expect(sendSubChatModeChangeMock).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 'reused',
      mode: 'debug',
    });
  });

  it('rejects (no broadcast) when the mode write fails — task retries instead of running a stale mode', async () => {
    // Broadcasting without persisting would desync the renderer store from the DB row; failing the
    // claim sends the task back to pending where the next claim retries the write.
    updateSubChatModeMock.mockRejectedValue(new Error('db locked'));

    await expect(
      resolveSubChatIdForExistingChat({
        chatId: 'c1',
        existingSubChatId: 'sub-fixed',
        executionMode: 'continue_chat',
        startMode: 'plan',
      }),
    ).rejects.toThrow('db locked');
    expect(sendSubChatModeChangeMock).not.toHaveBeenCalled();
  });

  it('continuation pin: the seeded resume mode applies ONLY when the pick lands on the pinned sub-chat', async () => {
    getSubChatForChatMock.mockResolvedValue({ id: 'validated' });

    const hit = await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: 'continue_chat',
      startMode: 'plan',
      resume: { pinnedSubChatId: 'validated', startMode: 'execute' },
    });
    expect(hit).toEqual({ subChatId: 'validated', startMode: 'execute' });
    expect(updateSubChatModeMock).toHaveBeenCalledWith(expect.anything(), 'validated', 'agent');

    // The claim resolves a different sub-chat than the pinned one → CONFIGURED mode, not the clamp.
    updateSubChatModeMock.mockClear();
    getSubChatForChatMock.mockResolvedValue({ id: 'newer-gap' });
    const miss = await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: 'continue_chat',
      startMode: 'plan',
      resume: { pinnedSubChatId: 'validated', startMode: 'execute' },
    });
    expect(miss).toEqual({ subChatId: 'newer-gap', startMode: 'plan' });
    expect(updateSubChatModeMock).toHaveBeenCalledWith(expect.anything(), 'newer-gap', 'plan');
  });

  it('non-continue_chat: always createSubChat', async () => {
    getSubChatForChatMock.mockResolvedValue({ id: 'x' });
    createSubChatMock.mockResolvedValue({ id: 'fresh' });

    const { subChatId: id } = await resolveSubChatIdForExistingChat({
      chatId: 'c1',
      existingSubChatId: null,
      executionMode: null,
      startMode: 'execute',
    });

    expect(id).toBe('fresh');
    expect(getSubChatForChatMock).not.toHaveBeenCalled();
    expect(updateSubChatModeMock).not.toHaveBeenCalled();
    expect(createSubChatMock).toHaveBeenCalledTimes(1);
  });
});
