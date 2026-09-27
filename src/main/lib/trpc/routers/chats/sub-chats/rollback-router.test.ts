import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSubChatByIdMock = vi.fn();
const getChatByIdMock = vi.fn();
const applyRollbackStashMock = vi.fn();
// Ordered log of the persistence calls — rollback's writes are three separate awaits, so their
// relative order is a correctness property, not an implementation detail (see the ordering test).
const writeOrder: string[] = [];
const updateSubChatMessagesMock = vi.fn();
const updateSubChatSessionMock = vi.fn();
const clearStreamIdMock = vi.fn();

// The db module throws under test env by design (see docs/decisions/test-environment-isolation.md),
// so it is mocked rather than initialized. The handle is opaque here — every repo call is mocked,
// and assertions match it with expect.anything() in the first position.
vi.mock('../../../../db', () => ({
  getDatabase: () => ({}) as unknown,
}));

vi.mock('../../../../db/repos/sub-chats', () => ({
  getSubChatById: (...args: unknown[]) => getSubChatByIdMock(...args),
  updateSubChatMessages: (...args: unknown[]) => updateSubChatMessagesMock(...args),
  updateSubChatSession: (...args: unknown[]) => updateSubChatSessionMock(...args),
  clearStreamId: (...args: unknown[]) => clearStreamIdMock(...args),
}));

vi.mock('../../../../db/repos/chats', () => ({
  getChatById: (...args: unknown[]) => getChatByIdMock(...args),
}));

vi.mock('../../../../git/stash', () => ({
  applyRollbackStash: (...args: unknown[]) => applyRollbackStashMock(...args),
}));

// Stand-in for the repo: apply the transform to the row as it reads now (getSubChatById, unless
// a test sets `freshRowOverride` to simulate a concurrent write).
let freshRowOverride: { messages: unknown[] } | null | undefined;
async function applyTransformToFreshRow(
  db: unknown,
  subChatId: string,
  transform: (fresh: unknown[]) => unknown[] | null,
) {
  writeOrder.push('messages');
  const row =
    freshRowOverride !== undefined ? freshRowOverride : await getSubChatByIdMock(db, subChatId);
  if (!row) return null;
  return { ...row, messages: transform(row.messages) ?? row.messages };
}

/** Clear every repo mock and the write-order log between cases. */
function resetMocks(): void {
  getSubChatByIdMock.mockReset();
  getChatByIdMock.mockReset();
  applyRollbackStashMock.mockReset();
  updateSubChatMessagesMock.mockReset();
  updateSubChatSessionMock.mockReset();
  clearStreamIdMock.mockReset();
  writeOrder.length = 0;
  freshRowOverride = undefined;
  // Re-arm the order log after the reset — a test that overrides one of these (e.g. to throw)
  // must not leak its implementation into the next.
  updateSubChatMessagesMock.mockImplementation(applyTransformToFreshRow);
  updateSubChatSessionMock.mockImplementation(() => void writeOrder.push('session'));
  clearStreamIdMock.mockImplementation(() => void writeOrder.push('streamId'));
}

/**
 * Invoke the router through a caller. Imported per-call so each case picks up its own mock state.
 */
async function callRollback(input: {
  subChatId: string;
  sdkMessageUuid?: string;
  userMessageId?: string;
  mode?: 'chat' | 'chat-and-code';
}) {
  const { subChatRollbackRouter } = await import('./rollback');
  const caller = subChatRollbackRouter.createCaller({ getWindow: () => null });
  return caller.rollbackToMessage(input);
}

describe('subChatRollbackRouter.rollbackToMessage', () => {
  beforeEach(resetMocks);

  it('clears persisted session so the next prompt starts a fresh Claude session', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [{ metadata: { sdkMessageUuid: 'm-1' } }, { metadata: { sdkMessageUuid: 'm-2' } }],
    });
    getChatByIdMock.mockResolvedValue({ id: 'chat-1', worktreePath: '/tmp/project' });
    applyRollbackStashMock.mockResolvedValue({ success: true, checkpointFound: true });

    const result = await callRollback({ subChatId: 'sub-1', sdkMessageUuid: 'm-2' });

    expect(result.success).toBe(true);
    expect(updateSubChatMessagesMock).toHaveBeenCalledTimes(1);
    expect(updateSubChatSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      'sub-1',
      '',
      'rollback',
    );
    // stream_id must clear too, else an in-flight chunk re-appends the rolled-back message.
    expect(clearStreamIdMock).toHaveBeenCalledWith(expect.anything(), 'sub-1');
  });

  it('skips git rollback entirely when mode is "chat"', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [{ metadata: { sdkMessageUuid: 'm-1' } }, { metadata: { sdkMessageUuid: 'm-2' } }],
    });

    const result = await callRollback({
      subChatId: 'sub-1',
      sdkMessageUuid: 'm-1',
      mode: 'chat',
    });

    expect(result.success).toBe(true);
    expect(getChatByIdMock).not.toHaveBeenCalled();
    expect(applyRollbackStashMock).not.toHaveBeenCalled();
    // But messages are still truncated.
    expect(updateSubChatMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('skips git when mode is "chat-and-code" but the chat has no worktree', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [{ metadata: { sdkMessageUuid: 'm-1' } }, { metadata: { sdkMessageUuid: 'm-2' } }],
    });
    getChatByIdMock.mockResolvedValue({ id: 'chat-1', worktreePath: null });

    const result = await callRollback({
      subChatId: 'sub-1',
      sdkMessageUuid: 'm-1',
      mode: 'chat-and-code',
    });

    expect(result.success).toBe(true);
    expect(getChatByIdMock).toHaveBeenCalledWith(expect.anything(), 'chat-1');
    expect(applyRollbackStashMock).not.toHaveBeenCalled();
    expect(updateSubChatMessagesMock).toHaveBeenCalledTimes(1);
  });
});

describe('subChatRollbackRouter — persistence ordering under a concurrent stream', () => {
  beforeEach(resetMocks);

  /**
   * The three writes are separate awaits, so withSubChatLock serializes each one but does NOT
   * span them, making their relative order a correctness property. Two rules, asserted as one
   * exact sequence so ANY reordering fails:
   *
   * 1. stream_id first. upsertAssistantMessage only drops a stray chunk when stream_id is already
   *    null (db/repos/sub-chats.ts). Truncating while stream_id was still set leaves a window
   *    where a chunk persister sees idx === -1, skips that guard, and re-appends a message the
   *    user just rolled away.
   * 2. The transcript LAST. Every write before it is one whose partial application is benign, so
   *    a failure mid-sequence cannot leave a truncated transcript still pointing at a live
   *    session — history the resumed session would no longer contain.
   */
  it('writes stream teardown first and the transcript last', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [{ metadata: { sdkMessageUuid: 'm-1' } }, { metadata: { sdkMessageUuid: 'm-2' } }],
    });

    await callRollback({ subChatId: 'sub-1', sdkMessageUuid: 'm-1', mode: 'chat' });

    expect(writeOrder).toEqual(['streamId', 'session', 'messages']);
  });

  /**
   * Same window, the other direction: if truncation fails, the surviving partial state must be
   * the benign one — a cleared session over an intact transcript. The harmful inverse (truncated
   * transcript still pointing at a live Claude session) would resume an old session against
   * history that no longer exists.
   */
  it('leaves the transcript intact when the truncating write fails', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [{ metadata: { sdkMessageUuid: 'm-1' } }, { metadata: { sdkMessageUuid: 'm-2' } }],
    });
    updateSubChatMessagesMock.mockImplementation(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });

    await expect(
      callRollback({ subChatId: 'sub-1', sdkMessageUuid: 'm-1', mode: 'chat' }),
    ).rejects.toThrow('SQLITE_FULL');

    // The session was already cleared, so the next prompt starts fresh rather than resuming
    // a session whose transcript we failed to truncate.
    expect(updateSubChatSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      'sub-1',
      '',
      'rollback',
    );
    expect(clearStreamIdMock).toHaveBeenCalledWith(expect.anything(), 'sub-1');
  });
});

/**
 * A failed read is not a missing row. See docs/decisions/sub-chat-read-failure-posture.md:
 * tRPC procedures propagate a read failure so the caller can report it honestly, and only a
 * genuinely absent row answers "not found".
 */
describe('subChatRollbackRouter — read failure vs missing row', () => {
  beforeEach(resetMocks);

  it('propagates a read failure instead of reporting it as a missing sub-chat', async () => {
    getSubChatByIdMock.mockRejectedValue(new Error('SQLITE_IOERR: disk I/O error'));

    await expect(callRollback({ subChatId: 'sub-1', sdkMessageUuid: 'm-1' })).rejects.toThrow(
      'SQLITE_IOERR',
    );
    // Nothing may be written when we could not even read the current state.
    expect(updateSubChatMessagesMock).not.toHaveBeenCalled();
    expect(applyRollbackStashMock).not.toHaveBeenCalled();
  });

  it('still reports a genuinely absent row as not found', async () => {
    getSubChatByIdMock.mockResolvedValue(null);

    const result = await callRollback({ subChatId: 'gone', sdkMessageUuid: 'm-1' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('Sub-chat not found');
    expect(updateSubChatMessagesMock).not.toHaveBeenCalled();
  });
});

describe('subChatRollbackRouter — userMessageId rollback', () => {
  beforeEach(resetMocks);

  it('finds user message by id and truncates to that point', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
        { id: 'u2', role: 'user', metadata: {} },
        { id: 'a2', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-2' } },
      ],
    });

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // User message is excluded — its text goes to the editor for re-editing.
    expect(result.messages).toHaveLength(2);
    expect((result.messages[0] as Record<string, unknown>).id).toBe('u1');
    expect((result.messages[1] as Record<string, unknown>).id).toBe('a1');
  });

  it('uses preceding assistant sdkMessageUuid as git checkpoint for chat-and-code', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
        { id: 'u2', role: 'user', metadata: {} },
        { id: 'a2', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-2' } },
      ],
    });
    getChatByIdMock.mockResolvedValue({ id: 'chat-1', worktreePath: '/tmp/project' });
    applyRollbackStashMock.mockResolvedValue({ success: true, checkpointFound: true });

    await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat-and-code' });

    expect(applyRollbackStashMock).toHaveBeenCalledWith('/tmp/project', 'sdk-1');
  });

  it('skips git revert when the first user message has no preceding assistant', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
      ],
    });

    const result = await callRollback({
      subChatId: 'sub-1',
      userMessageId: 'u1',
      mode: 'chat-and-code',
    });

    expect(result.success).toBe(true);
    expect(applyRollbackStashMock).not.toHaveBeenCalled();
    if (!result.success) return;
    // First user message excluded — nothing before it.
    expect(result.messages).toHaveLength(0);
  });

  it('sets shouldResume on the preceding assistant, not the user message', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
        { id: 'u2', role: 'user', metadata: {} },
        { id: 'a2', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-2' } },
      ],
    });

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.messages).toHaveLength(2);

    // shouldResume lands on the last assistant (a1) — claude.ts resume logic reads it there.
    const assistantMeta = (result.messages[1] as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(assistantMeta.shouldResume).toBe(true);
  });

  it('sets shouldResume on no message when rolling back to the first user message', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
      ],
    });

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u1', mode: 'chat' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.messages).toHaveLength(0);
  });

  it('rejects a userMessageId pointing at a non-user message', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
      ],
    });

    // Caller passes an assistant id where userMessageId is expected. Applying the user-message
    // path here would truncate wrongly and pick the wrong checkpoint.
    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'a1', mode: 'chat' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('userMessageId must reference a user message');
    expect(updateSubChatMessagesMock).not.toHaveBeenCalled();
    expect(applyRollbackStashMock).not.toHaveBeenCalled();
  });

  it('returns an error when userMessageId matches no message', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [{ id: 'u1', role: 'user', metadata: {} }],
    });

    const result = await callRollback({
      subChatId: 'sub-1',
      userMessageId: 'nonexistent',
      mode: 'chat',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('Message not found');
  });

  it('skips an orphan leading assistant with no sdkMessageUuid when seeking a checkpoint', async () => {
    // Flows post assistant messages via chat_reply with no sdkMessageUuid. Rolling back to a user
    // message that follows such an orphan must not revert against it — there is no checkpoint.
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'orphan-1', role: 'assistant', metadata: {} },
        { id: 'u1', role: 'user', metadata: {} },
      ],
    });
    getChatByIdMock.mockResolvedValue({ id: 'chat-1', worktreePath: '/tmp/project' });

    const result = await callRollback({
      subChatId: 'sub-1',
      userMessageId: 'u1',
      mode: 'chat-and-code',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(applyRollbackStashMock).not.toHaveBeenCalled();
    expect(result.gitReverted).toBe(false);
    // Truncation still excludes u1 — the orphan stays as history.
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as Record<string, unknown>).id).toBe('orphan-1');
  });

  it('walks back past an orphan leading assistant to find a real checkpoint', async () => {
    // messages = [orphan (no uuid), u1, a1 (uuid), u2] — rolling back u2 uses a1's uuid.
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'orphan-1', role: 'assistant', metadata: {} },
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' } },
        { id: 'u2', role: 'user', metadata: {} },
      ],
    });
    getChatByIdMock.mockResolvedValue({ id: 'chat-1', worktreePath: '/tmp/project' });
    applyRollbackStashMock.mockResolvedValue({ success: true, checkpointFound: true });

    await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat-and-code' });

    expect(applyRollbackStashMock).toHaveBeenCalledWith('/tmp/project', 'sdk-1');
  });

  it('clears a stale shouldResume when a later assistant becomes the resume target', async () => {
    getSubChatByIdMock.mockResolvedValue({
      id: 'sub-1',
      chatId: 'chat-1',
      messages: [
        { id: 'u1', role: 'user', metadata: {} },
        { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1', shouldResume: true } },
        { id: 'u2', role: 'user', metadata: {} },
        { id: 'a2', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-2' } },
        { id: 'u3', role: 'user', metadata: {} },
      ],
    });

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u3', mode: 'chat' });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // a1 had a stale shouldResume — it must be cleared.
    const a1Meta = (result.messages[1] as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(a1Meta.shouldResume).toBeUndefined();

    // a2 is now the last assistant — it gets shouldResume.
    const a2Meta = (result.messages[3] as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(a2Meta.shouldResume).toBe(true);
  });
});

// sc-3290: truncation is computed from the row at write time (after the git await), and two
// rollbacks of one sub-chat never overlap.
describe('subChatRollbackRouter — concurrent writers during the git await', () => {
  beforeEach(resetMocks);

  const transcript = [
    { id: 'u1', role: 'user', metadata: {} },
    { id: 'a1', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-1' }, parts: [] },
    { id: 'u2', role: 'user', metadata: {} },
    { id: 'a2', role: 'assistant', metadata: { sdkMessageUuid: 'sdk-2' } },
  ];

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function armGitRollback() {
    getSubChatByIdMock.mockResolvedValue({ id: 'sub-1', chatId: 'chat-1', messages: transcript });
    getChatByIdMock.mockResolvedValue({ id: 'chat-1', worktreePath: '/tmp/project' });
    const git = deferred<{ success: true; checkpointFound: true }>();
    applyRollbackStashMock.mockReturnValue(git.promise);
    return git;
  }

  it('rejects a second rollback of the same sub-chat while the first is mid-git', async () => {
    const git = armGitRollback();

    const first = callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });
    await vi.waitFor(() => expect(applyRollbackStashMock).toHaveBeenCalledTimes(1));
    const second = await callRollback({ subChatId: 'sub-1', sdkMessageUuid: 'sdk-2' });

    expect(second).toEqual({ success: false, error: 'Rollback already in progress' });
    git.resolve({ success: true, checkpointFound: true });
    expect((await first).success).toBe(true);
    expect(applyRollbackStashMock).toHaveBeenCalledTimes(1);
    expect(updateSubChatMessagesMock).toHaveBeenCalledTimes(1);
  });

  it('allows a rollback again once the previous one finished', async () => {
    getSubChatByIdMock.mockResolvedValue({ id: 'sub-1', chatId: 'chat-1', messages: transcript });

    await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat' });
    const again = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat' });

    expect(again.success).toBe(true);
  });

  it('releases the guard when the rollback throws, so the sub-chat is not locked out forever', async () => {
    getSubChatByIdMock.mockResolvedValue({ id: 'sub-1', chatId: 'chat-1', messages: transcript });
    clearStreamIdMock.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });

    await expect(
      callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat' }),
    ).rejects.toThrow('SQLITE_BUSY');
    const retry = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2', mode: 'chat' });

    expect(retry.success).toBe(true);
  });

  it('does not block a rollback of a different sub-chat (multi-pane, separate chats)', async () => {
    const git = armGitRollback();

    const first = callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });
    await vi.waitFor(() => expect(applyRollbackStashMock).toHaveBeenCalledTimes(1));
    const other = await callRollback({ subChatId: 'sub-2', userMessageId: 'u2', mode: 'chat' });

    expect(other.success).toBe(true);
    git.resolve({ success: true, checkpointFound: true });
    await first;
  });

  it('returns the fresh truncated transcript, keeping an edit that landed during the git await', async () => {
    armGitRollback().resolve({ success: true, checkpointFound: true });
    freshRowOverride = {
      messages: [
        transcript[0],
        { ...transcript[1], parts: [{ type: 'tool-frink-plan', input: { status: 'approved' } }] },
        transcript[2],
        transcript[3],
        { id: 'a3', role: 'assistant', metadata: {} }, // a late stream chunk past the target
      ],
    };

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['u1', 'a1']);
    expect((result.messages[1] as { parts: unknown[] }).parts).toEqual([
      { type: 'tool-frink-plan', input: { status: 'approved' } },
    ]);
  });

  it('fails before any teardown write when the target vanished during the git await', async () => {
    armGitRollback().resolve({ success: true, checkpointFound: true });
    getSubChatByIdMock
      .mockResolvedValueOnce({ id: 'sub-1', chatId: 'chat-1', messages: transcript })
      .mockResolvedValueOnce({ id: 'sub-1', chatId: 'chat-1', messages: transcript.slice(0, 2) });

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });

    expect(result).toEqual({
      success: false,
      error: 'Message no longer exists — code may already have been reverted',
    });
    // Session and stream_id stay intact alongside the intact transcript — nothing is stranded.
    expect(writeOrder).toEqual([]);
  });

  it('fails before any teardown write when the row was deleted during the git await', async () => {
    armGitRollback().resolve({ success: true, checkpointFound: true });
    getSubChatByIdMock
      .mockResolvedValueOnce({ id: 'sub-1', chatId: 'chat-1', messages: transcript })
      .mockResolvedValueOnce(null);

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });

    expect(result).toEqual({ success: false, error: 'Sub-chat not found' });
    expect(writeOrder).toEqual([]);
  });

  it('still refuses the write if the target vanishes after the teardown re-check', async () => {
    armGitRollback().resolve({ success: true, checkpointFound: true });
    freshRowOverride = { messages: [transcript[0], transcript[1]] };

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });

    expect(result).toEqual({
      success: false,
      error: 'Message no longer exists — code may already have been reverted',
    });
    // The teardown writes still ran first, in order; the transcript write was attempted last.
    expect(writeOrder).toEqual(['streamId', 'session', 'messages']);
  });

  it('reports not found when the row was deleted during the git await', async () => {
    armGitRollback().resolve({ success: true, checkpointFound: true });
    freshRowOverride = null;

    const result = await callRollback({ subChatId: 'sub-1', userMessageId: 'u2' });

    expect(result).toEqual({ success: false, error: 'Sub-chat not found' });
  });
});
