import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../../../../db';
import { createSubChat, getSubChatById } from '../../../../db/repos/sub-chats';
import * as schema from '../../../../db/schema';
import { freshDb, type TestDb } from '../../../../db/test-utils/fresh-db';
import * as stash from '../../../../git/stash';
import * as wakeHold from '../../../../socket/claude-wake-hold';
import { withMessageAdmission } from '../../../../socket/execution/send-admission';
import {
  _clearActiveExecutionsForTests,
  setActiveExecution,
} from '../../../../socket/streaming/execution-registry';

// Real router + repo + admission mutex, git held open: the window between the liveness check and
// the transcript write is where a turn used to be able to start.
let db: TestDb;
let releaseGit: (() => void) | undefined;
const holds = new Map<string, { retracted: boolean }>();

async function seed(): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-1', worktreePath: '/tmp/worktree' });
  const row = await createSubChat(db, {
    chatId: 'chat-1',
    sessionId: 'session-1',
    messages: JSON.stringify([
      { id: 'u1', role: 'user', parts: [] },
      { id: 'a1', role: 'assistant', parts: [], metadata: { sdkMessageUuid: 'sdk-1' } },
      { id: 'u2', role: 'user', parts: [] },
      { id: 'a2', role: 'assistant', parts: [], metadata: { sdkMessageUuid: 'sdk-2' } },
    ]),
  });
  return row.id;
}

async function rollbackToSecondTurn(subChatId: string) {
  const { subChatRollbackRouter } = await import('./rollback');
  const caller = subChatRollbackRouter.createCaller({ getWindow: () => null });
  return caller.rollbackToMessage({ subChatId, userMessageId: 'u2' });
}

async function storedIds(subChatId: string): Promise<string[]> {
  return ((await getSubChatById(db, subChatId))?.messages ?? []).map((message) => message.id);
}

describe('rollbackToMessage against a live sub-chat', () => {
  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(database, 'getDatabase').mockImplementation(() => db);
    vi.spyOn(stash, 'applyRollbackStash').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseGit = () => resolve({ success: true, checkpointFound: true });
        }),
    );
    // SAFETY: the liveness check reads only `retracted` off a hold.
    vi.spyOn(wakeHold, 'readWakeHolds').mockReturnValue(holds as never);
    const { __resetSubChatLocks } = await import('../../../../db/repos/sub-chat-mutex');
    __resetSubChatLocks();
    _clearActiveExecutionsForTests();
    holds.clear();
    releaseGit = undefined;
  });
  afterEach(() => {
    releaseGit?.();
    vi.restoreAllMocks();
  });

  it('refuses while a turn is running, before touching git, the session or the transcript', async () => {
    const subChatId = await seed();
    setActiveExecution(subChatId, new AbortController());

    const result = await rollbackToSecondTurn(subChatId);

    expect(result).toEqual({ success: false, error: expect.stringContaining('still working') });
    expect(releaseGit).toBeUndefined();
    expect(await storedIds(subChatId)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect((await getSubChatById(db, subChatId))?.sessionId).toBe('session-1');
  });

  it('refuses while a wake hold is armed and proceeds once the user has stopped it', async () => {
    const subChatId = await seed();
    const hold = { retracted: false };
    holds.set(subChatId, hold);

    expect((await rollbackToSecondTurn(subChatId)).success).toBe(false);
    expect(releaseGit).toBeUndefined();

    hold.retracted = true;
    const rollback = rollbackToSecondTurn(subChatId);
    await vi.waitFor(() => expect(releaseGit).toBeDefined());
    releaseGit?.();
    expect((await rollback).success).toBe(true);
    expect(await storedIds(subChatId)).toEqual(['u1', 'a1']);
  });

  it('holds back a turn that tries to start while the rollback is still reverting', async () => {
    const subChatId = await seed();
    const rollback = rollbackToSecondTurn(subChatId);
    await vi.waitFor(() => expect(releaseGit).toBeDefined());

    let transcriptAtRegistration: string[] | undefined;
    const send = withMessageAdmission(subChatId, false, async (started) => {
      transcriptAtRegistration = await storedIds(subChatId);
      setActiveExecution(subChatId, new AbortController());
      started();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transcriptAtRegistration).toBeUndefined();

    releaseGit?.();
    expect((await rollback).success).toBe(true);
    await send;
    expect(transcriptAtRegistration).toEqual(['u1', 'a1']);
  });

  it('waits for a turn that is already starting, then refuses instead of truncating under it', async () => {
    const subChatId = await seed();
    let register!: () => void;
    const admitted = new Promise<void>((resolve) => {
      void withMessageAdmission(subChatId, false, async (started) => {
        register = () => {
          setActiveExecution(subChatId, new AbortController());
          started();
        };
        resolve();
      });
    });
    await admitted;

    const rollback = rollbackToSecondTurn(subChatId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(releaseGit).toBeUndefined();

    register();
    expect((await rollback).success).toBe(false);
    expect(releaseGit).toBeUndefined();
    expect(await storedIds(subChatId)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});
