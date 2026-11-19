import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findApprovablePlan, type PlanMessageLike } from '../../../../../../shared/types/plan';
import { buildFrinkPlanChunks } from '../../../../agent-runner/plan-document';
import * as database from '../../../../db';
import * as transcripts from '../../../../db/repos/sub-chat-messages';
import { createSubChat, type Message } from '../../../../db/repos/sub-chats';
import * as schema from '../../../../db/schema';
import { freshDb, type TestDb } from '../../../../db/test-utils/fresh-db';
import { subChatGetRouter } from './get';

let db: TestDb;
const caller = subChatGetRouter.createCaller({ getWindow: () => null });

const message = (id: string): Message => ({ id, role: 'user', parts: [] });

async function seed(messages: Message[], sessionId: string | null = null): Promise<void> {
  await createSubChat(db, {
    id: 's1',
    chatId: 'c1',
    sessionId,
    messages: JSON.stringify(messages),
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  db = freshDb();
  vi.spyOn(database, 'getDatabase').mockReturnValue(db);
  await db.insert(schema.chats).values({ id: 'c1' });
});

describe('getSubChatMessages', () => {
  it('returns empty when the sub-chat is missing', async () => {
    expect(await caller.getSubChatMessages({ subChatId: 'unknown', limit: 20 })).toEqual({
      messages: [],
      hasMore: false,
      sessionId: null,
    });
  });

  it('reads the first page from the newest rows without reading the whole transcript', async () => {
    await seed(['m1', 'm2', 'm3', 'm4'].map(message), 'sess-1');
    const whole = vi.spyOn(transcripts, 'readTranscript');

    const result = await caller.getSubChatMessages({ subChatId: 's1', limit: 2 });

    expect(result).toEqual({
      messages: [message('m3'), message('m4')],
      hasMore: true,
      sessionId: 'sess-1',
    });
    expect(whole).not.toHaveBeenCalled();
  });

  it('pages older messages before an id exactly as before', async () => {
    await seed(['m1', 'm2', 'm3', 'm4', 'm5'].map(message));

    const page = (beforeMessageId: string) =>
      caller.getSubChatMessages({ subChatId: 's1', limit: 2, beforeMessageId });

    expect(await page('m4')).toMatchObject({
      messages: [message('m2'), message('m3')],
      hasMore: true,
    });
    expect(await page('m2')).toMatchObject({ messages: [message('m1')], hasMore: false });
    expect(await page('missing')).toMatchObject({ messages: [], hasMore: false });
  });

  const corrupt = (...seqs: number[]) =>
    db
      .update(schema.subChatMessages)
      .set({ message: '{corrupt' })
      .where(
        and(eq(schema.subChatMessages.subChatId, 's1'), inArray(schema.subChatMessages.seq, seqs)),
      );

  it('skips a corrupt row in the newest page and pages the rest as before', async () => {
    await seed(['m1', 'm2', 'm3', 'm4'].map(message));
    await corrupt(3);

    const first = await caller.getSubChatMessages({ subChatId: 's1', limit: 2 });

    expect(first).toMatchObject({ messages: [message('m2'), message('m3')], hasMore: true });
    const older = await caller.getSubChatMessages({
      subChatId: 's1',
      limit: 2,
      beforeMessageId: 'm2',
    });
    expect(older).toMatchObject({ messages: [message('m1')], hasMore: false });
  });

  it('returns the older message when every newest row is corrupt', async () => {
    await seed(['m1', 'm2', 'm3'].map(message));
    await corrupt(1, 2);

    const first = await caller.getSubChatMessages({ subChatId: 's1', limit: 2 });

    expect(first).toMatchObject({ messages: [message('m1')], hasMore: false });
  });

  // The renderer reads stored tool-part keys (`input.file_path`) verbatim.
  it('keeps persisted tool-part keys, MCP and Codex inputs verbatim', async () => {
    const assistant: Message = {
      id: 'a1',
      role: 'assistant',
      metadata: { sdkMessageUuid: 'sdk-1' },
      parts: [
        {
          type: 'tool-Edit',
          state: 'output-available',
          input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y\nz' },
        },
        {
          type: 'tool-mcp__docs__search',
          state: 'output-available',
          input: { 'max-results': 5, page_token: 'p2' },
          output: { next_page_token: null },
        },
        {
          type: 'tool-Edit',
          state: 'output-available',
          input: { changes: [{ path: '/repo/a.ts', kind: { type: 'update', move_path: null } }] },
        },
        { type: 'tool-Task', state: 'output-available', output: { duration_ms: 1200 } },
      ],
    };
    await seed([assistant], 'sess-1');

    const result = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });

    expect(result).toEqual({ messages: [assistant], hasMore: false, sessionId: 'sess-1' });
  });

  // The phone approves plans from this procedure's output, so pin producer → procedure → finder.
  it('keeps a persisted frink-plan part approvable', async () => {
    const chunks = buildFrinkPlanChunks('s1', '## Retry webhooks', null);
    const inputChunk = chunks.find((chunk) => chunk.type === 'tool-input-available');
    const outputChunk = chunks.find((chunk) => chunk.type === 'tool-output-available');
    if (!inputChunk || !outputChunk) throw new Error('expected plan input and output chunks');
    await seed([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            toolCallId: inputChunk.toolCallId,
            state: 'output-available',
            input: inputChunk.input,
            output: outputChunk.output,
          },
        ],
      },
    ]);

    const { messages } = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });

    // SAFETY: the stored transcript holds plan-shaped messages.
    expect(findApprovablePlan(messages as PlanMessageLike[], true)).toEqual({
      planId: inputChunk.toolCallId,
      planText: '## Retry webhooks',
    });
  });
});
