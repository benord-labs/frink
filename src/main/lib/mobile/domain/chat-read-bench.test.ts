import { describe, expect, it, vi } from 'vitest';
import * as database from '../../db';
import { transcriptHasMessage } from '../../db/repos/sub-chat-messages';
import { createSubChat } from '../../db/repos/sub-chats';
import * as schema from '../../db/schema';
import { freshDb } from '../../db/test-utils/fresh-db';
import { readMobileChat } from './chat';

const MESSAGES = 2000;
const READS = 50;

function median(timings: number[]): number {
  return timings.sort((a, b) => a - b)[timings.length >> 1];
}

async function time<T>(run: () => T): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

const message = (i: number) => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `message ${i} ${'lorem ipsum dolor sit amet '.repeat(40)}` }],
});

describe.runIf(process.env.BENCH === '1')('phone chat read bench (BENCH=1)', () => {
  it(`reads a ${MESSAGES}-message chat`, async () => {
    const db = freshDb();
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    await db.insert(schema.chats).values({ id: 'c1' });
    const transcript = Array.from({ length: MESSAGES }, (_, i) => message(i));
    await createSubChat(db, { id: 's1', chatId: 'c1', messages: JSON.stringify(transcript) });

    const read = () => readMobileChat({ type: 'chat', id: 'c1', subChatId: 's1' });
    expect((await read()).messages.at(-1)?.id).toBe(`m${MESSAGES - 1}`);
    const reads: number[] = [];
    const duplicateChecks: number[] = [];
    for (let i = 0; i < READS; i++) {
      reads.push(await time(read));
      duplicateChecks.push(await time(() => transcriptHasMessage(db, 's1', 'absent')));
    }
    process.stdout.write(
      `\n=== ${MESSAGES} messages: readMobileChat median ${median(reads).toFixed(2)}ms, ` +
        `duplicate-id check median ${median(duplicateChecks).toFixed(2)}ms ===\n`,
    );
  }, 300_000);
});
