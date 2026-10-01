import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  _resetCorruptTranscriptReportsForTests,
  _setCorruptTranscriptCaptureForTests,
} from '../transcript-corruption';
import { __resetSubChatLocks } from './sub-chat-mutex';
import {
  appendHtmlArtifactMessage,
  appendUserMessage,
  createSubChat,
  finalizeAssistantMessage,
  getSubChatForChat,
  getSubChatById,
  getSubChatMode,
  listSubChatsByChat,
  markPlanApproved,
  pickOldestSubChat,
  resolveSendMode,
  type SubChatHydrated,
  seedUserMessageIfEmpty,
  setStreamId,
  updateSubChatMessages,
  upsertAssistantMessage,
} from './sub-chats';
import { getFlowDriveInfoForSubChat, isSubChatDrivenByActiveFlowTask } from './tasks';

/** The corruption capture is fire-and-forget behind a lazy import; observe it through the seam. */
const captureMainException = vi.fn();
_setCorruptTranscriptCaptureForTests(captureMainException);

let db: TestDb;

async function seedSubChatWithParts(parts: unknown[]): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-1' });
  const subChat = await createSubChat(db, {
    chatId: 'chat-1',
    messages: JSON.stringify([{ id: 'assistant-1', role: 'assistant', parts }]),
  });
  return subChat.id;
}

function planPart(opts: { type: string; planId: string; status: string }) {
  return {
    type: opts.type,
    toolCallId: opts.planId,
    input: { planId: opts.planId, status: opts.status, summary: 's' },
  };
}

async function readPlanStatus(subChatId: string): Promise<string | undefined> {
  const hydrated = await getSubChatById(db, subChatId);
  const part = hydrated?.messages[0]?.parts[0] as { input?: { status?: string } } | undefined;
  return part?.input?.status;
}

describe('seedUserMessageIfEmpty', () => {
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  const message = (id: string) => ({
    id,
    role: 'user' as const,
    parts: [{ type: 'text', text: id }],
  });

  it('lets exactly one concurrent seed initialize an empty sub-chat', async () => {
    await db.insert(schema.chats).values({ id: 'chat-seed' });
    const subChat = await createSubChat(db, { chatId: 'chat-seed', messages: '[]' });

    const results = await Promise.all([
      seedUserMessageIfEmpty(db, subChat.id, message('seed-a')),
      seedUserMessageIfEmpty(db, subChat.id, message('seed-b')),
    ]);

    expect(results.map((result) => result.seeded).sort()).toEqual([false, true]);
    const persisted = await getSubChatById(db, subChat.id);
    expect(persisted?.messages).toHaveLength(1);
  });

  it('never replaces a message appended before the seed owns the lock', async () => {
    await db.insert(schema.chats).values({ id: 'chat-existing' });
    const subChat = await createSubChat(db, { chatId: 'chat-existing', messages: '[]' });
    await appendUserMessage(db, subChat.id, message('live-message'));

    const result = await seedUserMessageIfEmpty(db, subChat.id, message('stale-seed'));

    expect(result.seeded).toBe(false);
    expect((await getSubChatById(db, subChat.id))?.messages).toEqual([message('live-message')]);
  });

  it.each(['{"broken"', '{}'])('never treats malformed history %s as empty', async (messages) => {
    await db.insert(schema.chats).values({ id: 'chat-malformed' });
    const subChat = await createSubChat(db, { chatId: 'chat-malformed', messages });

    const result = await seedUserMessageIfEmpty(db, subChat.id, message('stale-seed'));
    const persisted = db.select().from(schema.subChats).get();

    expect(result.seeded).toBe(false);
    expect(persisted?.messages).toBe(messages);
  });
});

describe('messages write short-circuit', () => {
  beforeEach(async () => {
    db = freshDb();
    __resetSubChatLocks();
    await db.insert(schema.chats).values({ id: 'chat-revision' });
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  const userMessage = (id: string) => ({
    id,
    role: 'user' as const,
    parts: [{ type: 'text', text: id }],
  });

  it('skips persisting a repeated identical checkpoint write (updatedAt untouched)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const subChat = await createSubChat(db, { chatId: 'chat-revision', messages: '[]' });
      await upsertAssistantMessage(
        db,
        subChat.id,
        'assistant-1',
        [{ type: 'text', text: 'partial' }],
        0,
      );
      const before = (await getSubChatById(db, subChat.id))?.updatedAt;
      vi.advanceTimersByTime(60_000);

      await upsertAssistantMessage(
        db,
        subChat.id,
        'assistant-1',
        [{ type: 'text', text: 'partial' }],
        0,
      );
      expect((await getSubChatById(db, subChat.id))?.updatedAt).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists a checkpoint write whose content actually changed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const subChat = await createSubChat(db, { chatId: 'chat-revision', messages: '[]' });
      await upsertAssistantMessage(
        db,
        subChat.id,
        'assistant-1',
        [{ type: 'text', text: 'partial' }],
        0,
      );
      const before = (await getSubChatById(db, subChat.id))?.updatedAt;
      vi.advanceTimersByTime(60_000);

      await upsertAssistantMessage(
        db,
        subChat.id,
        'assistant-1',
        [{ type: 'text', text: 'partial and more' }],
        0,
      );
      expect((await getSubChatById(db, subChat.id))?.updatedAt).not.toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a seed once the row already has messages, and skips writing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const subChat = await createSubChat(db, {
        chatId: 'chat-revision',
        messages: JSON.stringify([userMessage('existing')]),
      });
      const before = (await getSubChatById(db, subChat.id))?.updatedAt;
      vi.advanceTimersByTime(60_000);

      const refusedSeed = await seedUserMessageIfEmpty(db, subChat.id, userMessage('stale'));
      expect(refusedSeed.seeded).toBe(false);
      expect((await getSubChatById(db, subChat.id))?.updatedAt).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips persisting an identical replacement via updateSubChatMessages', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const subChat = await createSubChat(db, { chatId: 'chat-revision', messages: '[]' });
      const replacement = [userMessage('replacement')];
      await updateSubChatMessages(db, subChat.id, () => replacement);
      const before = (await getSubChatById(db, subChat.id))?.updatedAt;
      vi.advanceTimersByTime(60_000);

      await updateSubChatMessages(db, subChat.id, () => replacement);
      expect((await getSubChatById(db, subChat.id))?.updatedAt).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null rather than throwing when finalizing a missing row', async () => {
    expect(await finalizeAssistantMessage(db, 'missing', 'assistant', [], null)).toBeNull();
  });
});

describe('appendHtmlArtifactMessage', () => {
  beforeEach(() => {
    db = freshDb();
    __resetSubChatLocks();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  it('ignores malformed v1 artifacts when deduplicating', async () => {
    await db.insert(schema.chats).values({ id: 'chat-artifact' });
    const subChat = await createSubChat(db, {
      chatId: 'chat-artifact',
      messages: JSON.stringify([
        {
          id: 'old',
          role: 'assistant',
          parts: [
            {
              type: 'data-html-artifact',
              data: { version: 1, artifactId: 'retry', title: '\n', bodyHtml: '<p>old</p>' },
            },
          ],
        },
      ]),
    });
    const message = {
      id: 'new',
      role: 'assistant' as const,
      parts: [
        {
          type: 'data-html-artifact',
          data: {
            version: 1 as const,
            artifactId: 'retry',
            title: 'Retry',
            bodyHtml: '<p>valid retry</p>',
          },
        },
      ],
    };

    await expect(appendHtmlArtifactMessage(db, subChat.id, message, 'retry')).resolves.toBe(
      'inserted',
    );
    expect((await getSubChatById(db, subChat.id))?.messages).toHaveLength(2);
  });
});

describe('markPlanApproved', () => {
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  it('flips a canonical tool-frink-plan part from awaiting_approval to approved', async () => {
    const subChatId = await seedSubChatWithParts([
      planPart({ type: 'tool-frink-plan', planId: 'plan-1', status: 'awaiting_approval' }),
    ]);

    await markPlanApproved(db, subChatId, 'plan-1');

    expect(await readPlanStatus(subChatId)).toBe('approved');
  });

  it('flips a legacy frink-plan part type', async () => {
    const subChatId = await seedSubChatWithParts([
      planPart({ type: 'frink-plan', planId: 'plan-1', status: 'awaiting_approval' }),
    ]);

    await markPlanApproved(db, subChatId, 'plan-1');

    expect(await readPlanStatus(subChatId)).toBe('approved');
  });

  it('is a no-op when the planId does not match', async () => {
    const subChatId = await seedSubChatWithParts([
      planPart({ type: 'tool-frink-plan', planId: 'plan-1', status: 'awaiting_approval' }),
    ]);

    await markPlanApproved(db, subChatId, 'plan-other');

    expect(await readPlanStatus(subChatId)).toBe('awaiting_approval');
  });

  it('does not re-touch a plan already past awaiting_approval', async () => {
    const subChatId = await seedSubChatWithParts([
      planPart({ type: 'tool-frink-plan', planId: 'plan-1', status: 'in_progress' }),
    ]);

    await markPlanApproved(db, subChatId, 'plan-1');

    expect(await readPlanStatus(subChatId)).toBe('in_progress');
  });

  it('leaves non-plan parts untouched', async () => {
    const subChatId = await seedSubChatWithParts([
      { type: 'text', text: 'hello' },
      planPart({ type: 'tool-frink-plan', planId: 'plan-1', status: 'awaiting_approval' }),
    ]);

    await markPlanApproved(db, subChatId, 'plan-1');

    const hydrated = await getSubChatById(db, subChatId);
    const textPart = hydrated?.messages[0]?.parts[0] as { type?: string; text?: string };
    expect(textPart.type).toBe('text');
    expect(textPart.text).toBe('hello');
  });

  it('flips only the targeted plan when multiple plans exist in one message', async () => {
    const subChatId = await seedSubChatWithParts([
      planPart({ type: 'tool-frink-plan', planId: 'plan-1', status: 'awaiting_approval' }),
      planPart({ type: 'tool-frink-plan', planId: 'plan-2', status: 'awaiting_approval' }),
    ]);

    await markPlanApproved(db, subChatId, 'plan-2');

    const hydrated = await getSubChatById(db, subChatId);
    const parts = hydrated?.messages[0]?.parts as Array<{ input?: { status?: string } }>;
    expect(parts[0].input?.status).toBe('awaiting_approval');
    expect(parts[1].input?.status).toBe('approved');
  });

  it('flips the matching plan when plans span multiple assistant messages', async () => {
    await db.insert(schema.chats).values({ id: 'chat-1' });
    const subChat = await createSubChat(db, {
      chatId: 'chat-1',
      messages: JSON.stringify([
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            planPart({ type: 'tool-frink-plan', planId: 'plan-1', status: 'awaiting_approval' }),
          ],
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [
            planPart({ type: 'tool-frink-plan', planId: 'plan-2', status: 'awaiting_approval' }),
          ],
        },
      ]),
    });

    await markPlanApproved(db, subChat.id, 'plan-2');

    const hydrated = await getSubChatById(db, subChat.id);
    const msg1Part = hydrated?.messages[0]?.parts[0] as { input?: { status?: string } };
    const msg2Part = hydrated?.messages[1]?.parts[0] as { input?: { status?: string } };
    expect(msg1Part.input?.status).toBe('awaiting_approval');
    expect(msg2Part.input?.status).toBe('approved');
  });
});

describe('listSubChatsByChat', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('lists sub-chats without reading their transcripts', async () => {
    await db.insert(schema.chats).values({ id: 'chat-1' });
    await createSubChat(db, { id: 'sub-1', chatId: 'chat-1', messages: '[{"id":"m1"}]' });

    const [row] = await listSubChatsByChat(db, 'chat-1');

    expect(row?.id).toBe('sub-1');
    expect(row).not.toHaveProperty('messages');
  });
});

/**
 * The oldest sub-chat's title is the parent chat's title, so chat-rename and
 * sub-chat-rename both resolve "oldest" through this helper. `listSubChatsByChat`
 * has no ORDER BY (SQLite row order is undefined), so the pick MUST be a pure
 * function of (createdAt, id) — never array position — or the two rename paths
 * could disagree on which sub-chat is oldest and break the invariant.
 */
describe('resolveSendMode (decision `sub-chat-mode-ownership`)', () => {
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  async function seedPlanSubChat(): Promise<string> {
    await db.insert(schema.chats).values({ id: 'chat-1' });
    const subChat = await createSubChat(db, { chatId: 'chat-1', mode: 'plan', messages: '[]' });
    return subChat.id;
  }

  it('absent intent → resolves from the row without writing', async () => {
    vi.useFakeTimers();
    try {
      const id = await seedPlanSubChat();
      const before = (await getSubChatById(db, id))?.updatedAt;
      vi.advanceTimersByTime(60_000);
      await expect(resolveSendMode(db, id, undefined)).resolves.toBe('plan');
      expect(await getSubChatMode(db, id)).toBe('plan');
      expect((await getSubChatById(db, id))?.updatedAt).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('intent differing from the row → persists the transition', async () => {
    const id = await seedPlanSubChat();
    await expect(resolveSendMode(db, id, 'agent')).resolves.toBe('agent');
    expect(await getSubChatMode(db, id)).toBe('agent');
  });

  it('intent equal to the row → no redundant write (updatedAt untouched)', async () => {
    // Re-asserting an already-persisted mode is the common case once the echo lifecycle re-sends
    // an uncleared intent; it must not churn updatedAt (sync ordering keys off it).
    vi.useFakeTimers();
    try {
      const id = await seedPlanSubChat();
      const before = (await getSubChatById(db, id))?.updatedAt;
      vi.advanceTimersByTime(60_000);
      await expect(resolveSendMode(db, id, 'plan')).resolves.toBe('plan');
      expect((await getSubChatById(db, id))?.updatedAt).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no row and no intent → refuses rather than guessing a permissive mode', async () => {
    await expect(resolveSendMode(db, 'missing-sub-chat', undefined)).rejects.toThrow(
      /Cannot resolve chat mode/,
    );
  });

  it('no row but an explicit intent (temp- sub-chat first send) → runs in the intent', async () => {
    await expect(resolveSendMode(db, 'temp-fresh', 'plan')).resolves.toBe('plan');
  });
});

describe('pickOldestSubChat', () => {
  const sub = (id: string, createdAt: Date | null): SubChatHydrated =>
    ({ id, createdAt }) as unknown as SubChatHydrated;

  it('picks the earliest createdAt regardless of array order', () => {
    const older = sub('s-zzz', new Date('2026-01-01'));
    const newer = sub('s-aaa', new Date('2026-02-01'));
    // Even when the newer row sorts first by id and comes first in the array.
    expect(pickOldestSubChat([newer, older])?.id).toBe('s-zzz');
    expect(pickOldestSubChat([older, newer])?.id).toBe('s-zzz');
  });

  it('breaks createdAt ties by lexical id, deterministically across input orders', () => {
    const t = new Date('2026-01-01');
    const [a, b, c] = [sub('s-aaa', t), sub('s-bbb', t), sub('s-ccc', t)];
    expect(pickOldestSubChat([c, a, b])?.id).toBe('s-aaa');
    expect(pickOldestSubChat([b, c, a])?.id).toBe('s-aaa');
    expect(pickOldestSubChat([a, b, c])?.id).toBe('s-aaa');
  });

  it('treats a null createdAt as the epoch (oldest) and still tie-breaks by id', () => {
    const withDate = sub('s-aaa', new Date('2026-01-01'));
    const nullEarly = sub('s-yyy', null);
    const nullLate = sub('s-zzz', null);
    // null → epoch(0), older than any real timestamp.
    expect(pickOldestSubChat([withDate, nullLate])?.id).toBe('s-zzz');
    // Two nulls collapse to the same instant → lexical id wins.
    expect(pickOldestSubChat([nullLate, nullEarly])?.id).toBe('s-yyy');
  });
});

// Guards the chat-plan-card suppression signal: a flow task driving a sub-chat (running or paused
// at plan_ready/awaiting_input) reads as flow-driven so the in-chat Approve is suppressed; a
// finished flow task or a non-flow task must NOT (a later interactive plan turn keeps its Approve).
describe('isSubChatDrivenByActiveFlowTask', () => {
  async function seedTask(
    fdb: TestDb,
    opts: { source: string; status: string; subChatId: string | null },
  ) {
    await fdb.insert(schema.tasks).values({
      description: 'd',
      source: opts.source,
      status: opts.status as never,
      result: opts.subChatId ? { subChatId: opts.subChatId } : {},
    });
  }

  it('true when a running flow task drives the sub-chat', async () => {
    const fdb = freshDb();
    await seedTask(fdb, { source: 'flow', status: 'running', subChatId: 'sc-run' });
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-run')).toBe(true);
  });

  it('true while the flow is paused at plan_ready (the suppression window)', async () => {
    const fdb = freshDb();
    await seedTask(fdb, { source: 'flow', status: 'plan_ready', subChatId: 'sc-plan' });
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-plan')).toBe(true);
  });

  it('false for a finished flow task — interactive turns in the chat keep Approve', async () => {
    const fdb = freshDb();
    await seedTask(fdb, { source: 'flow', status: 'done', subChatId: 'sc-done' });
    await seedTask(fdb, { source: 'flow', status: 'completed', subChatId: 'sc-comp' });
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-done')).toBe(false);
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-comp')).toBe(false);
  });

  it('false for a non-flow task driving the sub-chat, and for unknown/empty input', async () => {
    const fdb = freshDb();
    await seedTask(fdb, { source: 'trigger', status: 'running', subChatId: 'sc-trig' });
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-trig')).toBe(false);
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-none')).toBe(false);
    expect(await isSubChatDrivenByActiveFlowTask(fdb, '')).toBe(false);
  });

  it('scopes to the queried sub-chat — a running flow on another sub-chat does not match (multi-pane)', async () => {
    const fdb = freshDb();
    await seedTask(fdb, { source: 'flow', status: 'running', subChatId: 'sc-a' });
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-a')).toBe(true);
    expect(await isSubChatDrivenByActiveFlowTask(fdb, 'sc-b')).toBe(false);
  });
});

// `autoApprovePlan` selects the auto-approve plan turn (startMode='plan' + skipReview) from the task
// driving THIS sub-chat — NOT the chat's pinned taskId, which stays linked to the first node (often
// `execute`). Getting this wrong is the original bug: the executor read the stale execute task and
// never auto-approved.
describe('getFlowDriveInfoForSubChat', () => {
  async function seedFlowTask(
    fdb: TestDb,
    opts: {
      status: string;
      subChatId: string;
      startMode?: string;
      skipReview?: boolean;
      createdAt?: Date;
      withResultFields?: boolean;
    },
  ) {
    const result =
      opts.withResultFields === false
        ? { subChatId: opts.subChatId }
        : { subChatId: opts.subChatId, startMode: opts.startMode, skipReview: opts.skipReview };
    const [row] = await fdb
      .insert(schema.tasks)
      .values({
        description: 'd',
        source: 'flow',
        status: opts.status as never,
        result,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      })
      .returning({ id: schema.tasks.id });
    return row.id;
  }

  it('autoApprovePlan true for a running plan task with skipReview', async () => {
    const fdb = freshDb();
    const id = await seedFlowTask(fdb, {
      status: 'running',
      subChatId: 'sc',
      startMode: 'plan',
      skipReview: true,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc')).toEqual({
      active: true,
      autoApprovePlan: true,
      taskId: id,
    });
  });

  it('autoApprovePlan false when plan task lacks skipReview (manual approval flow)', async () => {
    const fdb = freshDb();
    const id = await seedFlowTask(fdb, {
      status: 'running',
      subChatId: 'sc',
      startMode: 'plan',
      skipReview: false,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc')).toEqual({
      active: true,
      autoApprovePlan: false,
      taskId: id,
    });
  });

  it('autoApprovePlan false for a non-plan (execute) task even with skipReview — the stale-task guard', async () => {
    const fdb = freshDb();
    const id = await seedFlowTask(fdb, {
      status: 'running',
      subChatId: 'sc',
      startMode: 'execute',
      skipReview: true,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc')).toEqual({
      active: true,
      autoApprovePlan: false,
      taskId: id,
    });
  });

  it('autoApprovePlan false when the result has no startMode/skipReview', async () => {
    const fdb = freshDb();
    const id = await seedFlowTask(fdb, {
      status: 'running',
      subChatId: 'sc',
      withResultFields: false,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc')).toEqual({
      active: true,
      autoApprovePlan: false,
      taskId: id,
    });
  });

  it('inactive (and not auto-approve) when no flow task drives the sub-chat or input is empty', async () => {
    const fdb = freshDb();
    await seedFlowTask(fdb, {
      status: 'completed',
      subChatId: 'sc-done',
      startMode: 'plan',
      skipReview: true,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc-done')).toEqual({
      active: false,
      autoApprovePlan: false,
      taskId: null,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc-missing')).toEqual({
      active: false,
      autoApprovePlan: false,
      taskId: null,
    });
    expect(await getFlowDriveInfoForSubChat(fdb, '')).toEqual({
      active: false,
      autoApprovePlan: false,
      taskId: null,
    });
  });

  it('reads the MOST RECENT driving task when several share a sub-chat (plan node supersedes a lingering execute task)', async () => {
    const fdb = freshDb();
    // Older execute task (e.g. an earlier node left non-terminal) + newer plan node, same sub-chat.
    await seedFlowTask(fdb, {
      status: 'needs_attention',
      subChatId: 'sc',
      startMode: 'execute',
      skipReview: true,
      createdAt: new Date(1_000_000),
    });
    const newerId = await seedFlowTask(fdb, {
      status: 'running',
      subChatId: 'sc',
      startMode: 'plan',
      skipReview: true,
      createdAt: new Date(2_000_000),
    });
    expect(await getFlowDriveInfoForSubChat(fdb, 'sc')).toEqual({
      active: true,
      autoApprovePlan: true,
      taskId: newerId,
    });
  });
});

/**
 * Both writers replace the message wholesale. A caller with no metadata to offer must not be
 * treated as a caller asking to clear it — checkpoint writes and error-path finalizes never carry
 * it, and a wake burst appending to the turn that armed it would otherwise drop that turn's usage
 * and its `sdkMessageUuid`, which is what the rollback control resolves its stash by.
 */
describe('assistant message metadata is preserved across re-persists', () => {
  beforeEach(() => {
    db = freshDb();
    __resetSubChatLocks();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  const seed = async (metadata: unknown): Promise<string> => {
    await db.insert(schema.chats).values({ id: 'chat-meta' });
    const subChat = await createSubChat(db, {
      chatId: 'chat-meta',
      messages: JSON.stringify([
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'first' }],
          metadata,
        },
      ]),
    });
    await setStreamId(db, subChat.id, 'stream-1');
    return subChat.id;
  };

  const readMetadata = async (subChatId: string): Promise<unknown> =>
    (await getSubChatById(db, subChatId))?.messages[0]?.metadata;

  const original = { totalTokens: 7625, sdkMessageUuid: 'uuid-arming' };

  it('keeps it when a checkpoint write carries none', async () => {
    const subChatId = await seed(original);
    // 'patched' pins the in-SQLite fast path: it writes `$[#-1].parts` rather than replacing the
    // element, which is exactly why metadata survives here without a read-modify-write.
    expect(
      await upsertAssistantMessage(
        db,
        subChatId,
        'assistant-1',
        [{ type: 'text', text: 'more' }],
        0,
      ),
    ).toBe('patched');
    expect(await readMetadata(subChatId)).toEqual(original);
  });

  it('keeps it when a finalize carries none', async () => {
    const subChatId = await seed(original);
    await finalizeAssistantMessage(
      db,
      subChatId,
      'assistant-1',
      [{ type: 'text', text: 'done' }],
      null,
    );
    expect(await readMetadata(subChatId)).toEqual(original);
  });

  it('keeps a falsy-but-real metadata value rather than treating it as absent', async () => {
    // `metadata` is typed `unknown`, so a truthiness guard would silently drop 0, '' or false.
    const subChatId = await seed(0);
    await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'more' }], 0);
    expect(await readMetadata(subChatId)).toBe(0);
  });

  it('still lets a caller that has metadata replace it', async () => {
    const subChatId = await seed(original);
    const next = { totalTokens: 99, sdkMessageUuid: 'uuid-next' };
    await finalizeAssistantMessage(db, subChatId, 'assistant-1', [], null, next);
    expect(await readMetadata(subChatId)).toEqual(next);
  });
});

/**
 * A turn that dies before producing visible output finalizes with empty (or step-start-only)
 * parts; finalize REPLACES wholesale, so without a guard it wipes what mid-stream checkpoints
 * already persisted and the chat reads as a silent dead turn after reload.
 */
describe('contentless finalize preserves checkpointed parts', () => {
  beforeEach(() => {
    db = freshDb();
    __resetSubChatLocks();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  const checkpointed = [{ type: 'text', text: 'streamed answer' }];

  const readParts = async (subChatId: string): Promise<unknown[] | undefined> =>
    (await getSubChatById(db, subChatId))?.messages[0]?.parts;

  it('keeps checkpointed parts when finalize arrives with an empty array', async () => {
    const subChatId = await seedSubChatWithParts(checkpointed);
    await setStreamId(db, subChatId, 'stream-1');
    const finalized = await finalizeAssistantMessage(db, subChatId, 'assistant-1', [], null);
    expect(await readParts(subChatId)).toEqual(checkpointed);
    expect(finalized?.streamId).toBeNull();
  });

  it('treats step-start-only parts as contentless', async () => {
    const subChatId = await seedSubChatWithParts(checkpointed);
    await finalizeAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'step-start' }], null);
    expect(await readParts(subChatId)).toEqual(checkpointed);
  });

  it('lets a finalize that carries real parts replace the checkpoint as before', async () => {
    const subChatId = await seedSubChatWithParts(checkpointed);
    const final = [{ type: 'text', text: 'full answer' }];
    await finalizeAssistantMessage(db, subChatId, 'assistant-1', final, null);
    expect(await readParts(subChatId)).toEqual(final);
  });

  it('persists a contentless finalize unchanged when nothing was checkpointed', async () => {
    const subChatId = await seedSubChatWithParts([]);
    await finalizeAssistantMessage(db, subChatId, 'assistant-1', [], null, {
      interruptedBy: 'user',
    });
    expect(await readParts(subChatId)).toEqual([]);
    expect((await getSubChatById(db, subChatId))?.messages[0]?.metadata).toEqual({
      interruptedBy: 'user',
    });
  });
});

describe('getSubChatForChat', () => {
  it('returns null when the chat has no sub-chat yet', async () => {
    await db.insert(schema.chats).values({ id: 'chat-empty' });
    expect(await getSubChatForChat(db, 'chat-empty')).toBeNull();
  });

  it("returns the chat's sub-chat with mode and sessionId hydrated", async () => {
    await db.insert(schema.chats).values({ id: 'chat-n' });
    await db.insert(schema.subChats).values({
      id: 'sub-1',
      chatId: 'chat-n',
      name: 'one',
      mode: 'agent',
      messages: '[]',
      sessionId: 'sess-1',
    });
    const row = await getSubChatForChat(db, 'chat-n');
    expect(row?.id).toBe('sub-1');
    expect(row?.mode).toBe('agent');
    expect(row?.sessionId).toBe('sess-1');
  });
});
