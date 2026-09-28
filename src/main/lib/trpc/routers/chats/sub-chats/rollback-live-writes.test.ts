import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../../db/schema';
import { freshDb, type TestDb } from '../../../../db/test-utils/fresh-db';

// sc-3290 wiring: real router + repo + in-memory DB, git held open, so a write landing during
// the git await must survive the truncation.
let db: TestDb;
let releaseGit: (() => void) | undefined;

vi.mock('../../../../db', () => ({ getDatabase: () => db }));
vi.mock('../../../../git/stash', () => ({
  applyRollbackStash: () =>
    new Promise((resolve) => {
      releaseGit = () => resolve({ success: true, checkpointFound: true });
    }),
}));

const planPart = (status: string) => ({
  type: 'tool-frink-plan',
  toolCallId: 'plan-1',
  input: { planId: 'plan-1', status, summary: 's' },
});

async function seed(): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-1', worktreePath: '/tmp/worktree' });
  const [row] = await db
    .insert(schema.subChats)
    .values({
      chatId: 'chat-1',
      messages: JSON.stringify([
        { id: 'u1', role: 'user', parts: [] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [planPart('awaiting_approval')],
          metadata: { sdkMessageUuid: 'sdk-1' },
        },
        { id: 'u2', role: 'user', parts: [] },
        { id: 'a2', role: 'assistant', parts: [], metadata: { sdkMessageUuid: 'sdk-2' } },
      ]),
    })
    .returning();
  return row.id;
}

describe('rollbackToMessage against the real repo', () => {
  beforeEach(async () => {
    db = freshDb();
    const { __resetSubChatLocks } = await import('../../../../db/repos/sub-chat-mutex');
    __resetSubChatLocks();
    releaseGit = undefined;
  });
  afterEach(() => {
    releaseGit?.();
  });

  it('keeps a plan approval that landed on an earlier message while git was reverting', async () => {
    const subChatId = await seed();
    const { subChatRollbackRouter } = await import('./rollback');
    const { getSubChatById, markPlanApproved } = await import('../../../../db/repos/sub-chats');
    const caller = subChatRollbackRouter.createCaller({ getWindow: () => null });

    const rollback = caller.rollbackToMessage({ subChatId, userMessageId: 'u2' });
    await vi.waitFor(() => expect(releaseGit).toBeDefined());
    await markPlanApproved(db, subChatId, 'plan-1');
    releaseGit?.();

    const result = await rollback;
    expect(result.success).toBe(true);
    const stored = (await getSubChatById(db, subChatId))?.messages ?? [];
    expect(stored.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect((stored[1].parts[0] as ReturnType<typeof planPart>).input.status).toBe('approved');
    // The renderer is handed the same fresh transcript it will render.
    if (!result.success) return;
    expect(result.messages).toEqual(stored);
  });
});
