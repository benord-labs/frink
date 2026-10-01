import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetStreamCadenceForTests,
  drainStreamCadenceSnapshot,
} from '../../../diagnostics/stream-cadence';
import * as schema from '../../schema';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import {
  _resetCorruptTranscriptReportsForTests,
  _setCorruptTranscriptCaptureForTests,
} from '../../transcript-corruption';
import { __resetSubChatLocks } from '../sub-chat-mutex';
import {
  appendUserMessage,
  createSubChat,
  finalizeAssistantMessage,
  getSubChatById,
  setStreamId,
  updateSubChatMessages,
  upsertAssistantMessage,
} from '../sub-chats';

/** The corruption capture is fire-and-forget behind a lazy import; observe it through the seam. */
const captureMainException = vi.fn();
_setCorruptTranscriptCaptureForTests(captureMainException);

let db: TestDb;

describe('upsertAssistantMessage branch selection', () => {
  beforeEach(() => {
    db = freshDb();
    __resetSubChatLocks();
  });
  afterEach(() => {
    __resetSubChatLocks();
  });

  const seedRaw = async (rawMessages: string, streamId: string | null = 'stream-1') => {
    await db.insert(schema.chats).values({ id: 'chat-branch' });
    const subChat = await createSubChat(db, { chatId: 'chat-branch', messages: rawMessages });
    if (streamId) await setStreamId(db, subChat.id, streamId);
    return subChat.id;
  };

  const { subChatMessages } = schema;
  /** Stores each string verbatim as the next message row, bypassing the writer. */
  const seedRawRows = (subChatId: string, rows: string[]) =>
    rows.forEach((message, seq) => {
      db.insert(subChatMessages).values({ subChatId, seq, message }).run();
    });
  const rawMessages = async (subChatId: string): Promise<string> => {
    const rows = db
      .select({ message: subChatMessages.message })
      .from(subChatMessages)
      .where(eq(subChatMessages.subChatId, subChatId))
      .orderBy(asc(subChatMessages.seq))
      .all();
    return `[${rows.map((row) => row.message).join(',')}]`;
  };

  const assistant = (id: string, text: string) =>
    JSON.stringify({ id, role: 'assistant', parts: [{ type: 'text', text }] });

  it('rewrites when the target message exists but is not last', async () => {
    const subChatId = await seedRaw(
      `[${assistant('assistant-1', 'first')},{"id":"user-2","role":"user","parts":[]}]`,
    );
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], 0)).toBe(
      'rewritten',
    );
    const messages = (await getSubChatById(db, subChatId))?.messages ?? [];
    expect(messages.map((m) => m.id)).toEqual(['assistant-1', 'user-2']);
    expect(messages[0].parts).toEqual([{ type: 'text' }]);
  });

  it('appends on the first write for a new message', async () => {
    const subChatId = await seedRaw('[]');
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], 0)).toBe(
      'appended',
    );
    expect((await getSubChatById(db, subChatId))?.messages).toHaveLength(1);
  });

  it("appends a successor run's first checkpoint after the superseded run finalized", async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    await finalizeAssistantMessage(
      db,
      subChatId,
      'assistant-1',
      [{ type: 'text', text: 'done' }],
      null,
    );
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-2', [{ type: 'text' }], 0)).toBe(
      'appended',
    );
    expect((await getSubChatById(db, subChatId))?.messages.map((m) => m.id)).toEqual([
      'assistant-1',
      'assistant-2',
    ]);
  });

  it('keeps patching the arming message for a wake burst long after its turn finalized', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    await finalizeAssistantMessage(
      db,
      subChatId,
      'assistant-1',
      [{ type: 'text', text: 'done' }],
      null,
    );
    expect(
      await upsertAssistantMessage(
        db,
        subChatId,
        'assistant-1',
        [{ type: 'text', text: 'burst' }],
        0,
      ),
    ).toBe('patched');
  });

  it("keeps dropping a run's checkpoints for the rest of its life after a rollback", async () => {
    // Sticky for the epoch: a rollback refuses every later chunk of that run, not just the write
    // queued behind the truncation — which is what stops the message being re-appended later.
    const startedAt = 0;
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    await updateSubChatMessages(db, subChatId, () => []);

    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], startedAt),
    ).toBe('dropped');
    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], startedAt),
    ).toBe('dropped');
    expect(await rawMessages(subChatId)).toBe('[]');
  });

  it('fences a run that started before a rollback, even before it had written', async () => {
    // Its context was truncated away, so appending its message would orphan it under a transcript
    // that no longer contains the turn it was answering.
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    const startedAt = 0;
    await updateSubChatMessages(db, subChatId, () => []);

    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-2', [{ type: 'text' }], startedAt),
    ).toBe('dropped');
  });

  it('refuses a finalize whose turn was rolled away, instead of appending it back', async () => {
    // finalize APPENDS a message it cannot find, so the terminal write needs the same fence.
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    await updateSubChatMessages(db, subChatId, () => []);

    expect(
      await finalizeAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], null, {}, 0),
    ).toBeNull();
    expect(await rawMessages(subChatId)).toBe('[]');
  });

  it('still finalizes a turn whose transcript never moved', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);

    expect(
      await finalizeAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], null, {}, 0),
    ).not.toBeNull();
  });

  it('leaves an active stream alone when a replacement rewrites the same transcript', async () => {
    // withMessagesSync short-circuits an identical write, and fencing on a no-op would silently
    // stop a live run persisting for the rest of its life.
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    const before = await getSubChatById(db, subChatId);
    await updateSubChatMessages(db, subChatId, () => before?.messages ?? []);

    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'on' }], 0),
    ).toBe('patched');
  });

  it('drops a checkpoint that queued behind a rollback instead of resurrecting the message', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    // Both calls queue on the sub-chat mutex in this order; the checkpoint captured its generation
    // before the truncation ran.
    const truncation = updateSubChatMessages(db, subChatId, () => []);
    const straggler = upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], 0);
    expect(await straggler).toBe('dropped');
    await truncation;
    expect(await rawMessages(subChatId)).toBe('[]');
  });

  it('drops a queued last-row patch too, not only a new-row append', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    const truncation = updateSubChatMessages(db, subChatId, () => [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'kept' }] },
    ]);
    const straggler = upsertAssistantMessage(
      db,
      subChatId,
      'assistant-1',
      [{ type: 'text', text: 'rolled away' }],
      0,
    );
    expect(await straggler).toBe('dropped');
    await truncation;
    expect(await rawMessages(subChatId)).toContain('kept');
    expect(await rawMessages(subChatId)).not.toContain('rolled away');
  });

  it('captures an unparseable message to Sentry, so the loss is not silent', async () => {
    // Skipping the message discards history and throws NOTHING, so without a capture the
    // only trace is a local warn nobody reads and the user finds out on reload.
    captureMainException.mockClear();
    _resetCorruptTranscriptReportsForTests();
    const subChatId = await seedRaw('[]');
    seedRawRows(subChatId, ['{not json']);

    await getSubChatById(db, subChatId);
    await vi.waitFor(() => expect(captureMainException).toHaveBeenCalled());

    expect(captureMainException).toHaveBeenCalledWith(expect.anything(), {
      surface: 'sub-chats-transcript-corruption',
    });
  });

  it('captures a corrupt row once, not on every hydrate read', async () => {
    // hydrate() re-parses on every list/get, so an un-deduped capture turns one bad row into a
    // Sentry flood for the life of the process.
    captureMainException.mockClear();
    _resetCorruptTranscriptReportsForTests();
    const subChatId = await seedRaw('[]');
    seedRawRows(subChatId, ['{not json']);

    await getSubChatById(db, subChatId);
    await vi.waitFor(() => expect(captureMainException).toHaveBeenCalledTimes(1));
    await getSubChatById(db, subChatId);
    await getSubChatById(db, subChatId);

    expect(captureMainException).toHaveBeenCalledTimes(1);
  });

  it('heals a corrupt row rather than throwing on malformed JSON', async () => {
    const subChatId = await seedRaw('[]');
    seedRawRows(subChatId, ['{not json']);
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], 0)).toBe(
      'appended',
    );
    expect((await getSubChatById(db, subChatId))?.messages).toHaveLength(1);
  });

  it('times the write itself, not the wait for the per-sub-chat lock', async () => {
    // persistAssistantChunkLocally is fire-and-forget, so checkpoints for one sub-chat queue on
    // withSubChatLock. Timing from the caller would bill that queue wait as loop-blocking and
    // over-report a Frink-side stall in the very incident this metric exists to diagnose.
    _resetStreamCadenceForTests();
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: `p${i}` }], 0),
      ),
    );

    const snapshot = drainStreamCadenceSnapshot();
    expect(snapshot.checkpointPersistCount).toBe(5);
    // Five serialized writes: summing lock wait would make the total superlinear in queue depth.
    expect(snapshot.checkpointPersistMsTotal).toBeLessThan(500);
  });

  it('patches to an empty parts array rather than treating it as nothing to write', async () => {
    // A turn can legitimately checkpoint with no parts yet (a burst that has only opened a text
    // run). Skipping the write would leave the row showing the PREVIOUS checkpoint's content.
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-1', [], 0)).toBe('patched');
    expect((await getSubChatById(db, subChatId))?.messages[0].parts).toEqual([]);
  });

  it('lets a rollback truncation queued behind a checkpoint win', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);

    await Promise.all([
      upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'late' }], 0),
      updateSubChatMessages(db, subChatId, () => []),
    ]);

    expect((await getSubChatById(db, subChatId))?.messages).toEqual([]);
  });

  // sc-3290: the replacement is computed from the row as it reads INSIDE the lock, never from a
  // caller's earlier read — a stale array used to overwrite whatever landed in between.
  it('hands the transform the row as it reads now, including a write queued ahead of it', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`, null);
    const staleRead = (await getSubChatById(db, subChatId))?.messages ?? [];

    // Both queue on the sub-chat mutex in this order; the append lands between the caller's read
    // and the replacement.
    await Promise.all([
      appendUserMessage(db, subChatId, { id: 'user-2', role: 'user', parts: [] }),
      updateSubChatMessages(db, subChatId, (fresh) => [
        ...fresh,
        { id: 'user-3', role: 'user', parts: [] },
      ]),
    ]);

    expect(staleRead.map((m) => m.id)).toEqual(['assistant-1']);
    const ids = ((await getSubChatById(db, subChatId))?.messages ?? []).map((m) => m.id);
    expect(ids).toEqual(['assistant-1', 'user-2', 'user-3']);
  });

  it('writes nothing and leaves a live stream unfenced when the transform returns null', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);
    const before = await rawMessages(subChatId);

    await updateSubChatMessages(db, subChatId, () => null);

    expect(await rawMessages(subChatId)).toBe(before);
    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'on' }], 0),
    ).toBe('patched');
  });

  it('leaves a live stream unfenced when the transform returns the fresh array itself', async () => {
    // The pitfall the old identity check had: the no-op branch returns the parsed row, so
    // "returned array === written array" was true without any write and fenced the stream.
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);

    await updateSubChatMessages(db, subChatId, (fresh) => fresh);

    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'on' }], 0),
    ).toBe('patched');
  });

  it('returns null without calling the transform when the row does not exist', async () => {
    const transform = vi.fn(() => []);
    expect(await updateSubChatMessages(db, 'missing', transform)).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });

  it('rolls back, keeps streams unfenced and frees the lock when the transform throws', async () => {
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);
    const before = await rawMessages(subChatId);

    await expect(
      updateSubChatMessages(db, subChatId, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await rawMessages(subChatId)).toBe(before);
    // The lock was released and the generation untouched: the next writer still gets through.
    expect(
      await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'on' }], 0),
    ).toBe('patched');
  });

  it('keeps two concurrently streaming sub-chats writing to their own rows', async () => {
    // Multi-pane. withSubChatLock is keyed PER sub-chat, so these two never serialize against each
    // other — the isolation has to come from the statement's own WHERE clause.
    await db.insert(schema.chats).values({ id: 'chat-multi' });
    const a = await createSubChat(db, {
      chatId: 'chat-multi',
      messages: `[${assistant('assistant-a', 'a')}]`,
    });
    const b = await createSubChat(db, {
      chatId: 'chat-multi',
      messages: `[${assistant('assistant-b', 'b')}]`,
    });
    await setStreamId(db, a.id, 'stream-a');
    await setStreamId(db, b.id, 'stream-b');

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => [
        upsertAssistantMessage(db, a.id, 'assistant-a', [{ type: 'text', text: `a${i}` }], 0),
        upsertAssistantMessage(db, b.id, 'assistant-b', [{ type: 'text', text: `b${i}` }], 0),
      ]).flat(),
    );

    const textOf = async (subChatId: string): Promise<string> => {
      const messages = (await getSubChatById(db, subChatId))?.messages ?? [];
      expect(messages).toHaveLength(1);
      // SAFETY: every write in this test seeds exactly one text part.
      return (messages[0].parts as Array<{ text: string }>)[0].text;
    };

    // Each row holds one of ITS OWN writes — never the other pane's.
    expect(await textOf(a.id)).toMatch(/^a\d+$/);
    expect(await textOf(b.id)).toMatch(/^b\d+$/);
  });

  it('lets a finalize win the row after a concurrent checkpoint, keeping one message', async () => {
    // Checkpoint and finalize target the SAME id and take different branches (patch vs rewrite).
    // Whichever order the mutex grants, the transcript must not end up with two copies.
    const subChatId = await seedRaw(`[${assistant('assistant-1', 'first')}]`);

    await Promise.all([
      upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text', text: 'chunk' }], 0),
      finalizeAssistantMessage(
        db,
        subChatId,
        'assistant-1',
        [{ type: 'text', text: 'final' }],
        'session-1',
      ),
    ]);

    const messages = (await getSubChatById(db, subChatId))?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('assistant-1');
  });

  // A re-serialised row would renormalise these (1e+21, a/b), so they prove which rows were written.
  const exotic = '{"id":"user-1","role":"user","parts":[{"n":1e21,"s":"a\\/b"}]}';

  it('leaves untouched messages byte-identical', async () => {
    const subChatId = await seedRaw('[]');
    seedRawRows(subChatId, [exotic, assistant('assistant-1', 'first')]);
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], 0)).toBe(
      'patched',
    );
    expect(await rawMessages(subChatId)).toContain(exotic);
  });

  it('rewrites only the targeted row when the message is not last', async () => {
    const subChatId = await seedRaw('[]');
    seedRawRows(subChatId, [assistant('assistant-1', 'first'), exotic]);
    expect(await upsertAssistantMessage(db, subChatId, 'assistant-1', [{ type: 'text' }], 0)).toBe(
      'rewritten',
    );
    expect(await rawMessages(subChatId)).toBe(
      `[{"id":"assistant-1","role":"assistant","parts":[{"type":"text"}]},${exotic}]`,
    );
  });
});
