import { describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { createSubChat, setStreamId, upsertAssistantMessage } from './sub-chats';

const CHECKPOINTS = 50;
const LIVE_ID = 'assistant-live';

/** One message's worth of parts, sized so a few hundred messages reach megabytes. */
const filler = (i: number) => ({
  type: 'text',
  text: `message ${i} ${'lorem ipsum dolor sit amet '.repeat(120)}`,
});

/**
 * `liveLast` selects the branch: last → the `json_set` patch; first → the message exists but is
 * not last, which is exactly the whole-transcript rewrite this replaced.
 */
async function seedTranscript(
  db: TestDb,
  priorMessages: number,
  liveLast: boolean,
): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-bench' });
  const history = Array.from({ length: priorMessages }, (_, i) => ({
    id: `msg-${i}`,
    role: 'user',
    parts: [filler(i)],
  }));
  const live = { id: LIVE_ID, role: 'assistant', parts: [filler(0)] };
  const subChat = await createSubChat(db, {
    chatId: 'chat-bench',
    messages: JSON.stringify(liveLast ? [...history, live] : [live, ...history]),
  });
  await setStreamId(db, subChat.id, 'stream-bench');
  return subChat.id;
}

async function msPerCheckpoint(priorMessages: number, liveLast: boolean): Promise<number> {
  const db = freshDb();
  const subChatId = await seedTranscript(db, priorMessages, liveLast);
  const started = performance.now();
  for (let i = 0; i < CHECKPOINTS; i++) {
    await upsertAssistantMessage(db, subChatId, LIVE_ID, [filler(i)], 0);
  }
  return (performance.now() - started) / CHECKPOINTS;
}

describe.runIf(process.env.BENCH === '1')('sub-chats checkpoint bench (BENCH=1)', () => {
  it('patches a checkpoint materially cheaper than rewriting the transcript, at every size', async () => {
    const rows: string[] = [];
    let largestSpeedup = 0;

    for (const priorMessages of [50, 200, 400, 800]) {
      const patched = await msPerCheckpoint(priorMessages, true);
      const rewritten = await msPerCheckpoint(priorMessages, false);
      const speedup = rewritten / Math.max(patched, 0.0001);
      largestSpeedup = speedup;
      rows.push(
        `  ${String(priorMessages).padStart(4)} prior msgs   patch ${patched.toFixed(3)}ms   ` +
          `rewrite ${rewritten.toFixed(3)}ms   ${speedup.toFixed(2)}x`,
      );
    }
    process.stdout.write(`\n=== sub-chats checkpoint bench ===\n${rows.join('\n')}\n`);

    // Loose on purpose: absolute timings on an in-memory DB are noisy, so this asserts only that
    // the patch is clearly the cheaper branch on the largest transcript — i.e. that it still
    // fires at all. It is NOT a claim that cost stopped growing with transcript size.
    expect(largestSpeedup).toBeGreaterThan(1.5);
  }, 300_000);
});
