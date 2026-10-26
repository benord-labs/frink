import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { createTurnStream, frameTurn, type TurnStream } from '.';

/** A runner's chunks: `chunk` from its translator, then its queue; its cleanup never yields. */
async function* runner(
  { queue, emit }: TurnStream,
  chunk: UIMessageChunk,
  ran: { cleanup: boolean },
): AsyncGenerator<UIMessageChunk, void, undefined> {
  try {
    emit(chunk);
    queue.finish();
    yield* queue.drain();
  } finally {
    ran.cleanup = true;
  }
}

/** A turn framed around `runner`, with session `s1` and a spied release. */
function framed(chunk: UIMessageChunk) {
  const stream = createTurnStream();
  const ran = { cleanup: false };
  const release = vi.fn();
  const turn = frameTurn(stream, runner(stream, chunk, ran), () => 's1', release);
  return { turn, ran, release };
}

const TEXT: UIMessageChunk = { type: 'text-delta', id: 't1', delta: 'hi' };
const THOUGHT: UIMessageChunk = { type: 'reasoning-delta', id: 'r1', delta: 'hmm' };

describe('frameTurn', () => {
  it('starts the turn, brackets its text, closes it, then finishes with its session', async () => {
    const { turn, release } = framed(TEXT);
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of turn) chunks.push(chunk);
    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      TEXT,
      { type: 'text-end', id: 't1' },
      { type: 'finish', messageMetadata: { sessionId: 's1' } },
    ]);
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    ['text', TEXT, { type: 'text-end', id: 't1' }],
    [
      'thought',
      THOUGHT,
      expect.objectContaining({ type: 'tool-input-available', toolName: 'Thinking' }),
    ],
  ])(
    "runs the runner's cleanup before closing an open %s for a reader that stops early",
    async (_, chunk, closing) => {
      const { turn, ran } = framed(chunk);
      await turn.next(); // start
      await turn.next(); // the run's first chunk: it is open now
      expect((await turn.return(undefined)).value).toEqual(closing);
      expect(ran.cleanup).toBe(true);
    },
  );

  it('releases what the runner holds when its reader stops at start', async () => {
    const { turn, ran, release } = framed(TEXT);
    await turn.next(); // start
    await turn.return(undefined);
    expect(release).toHaveBeenCalledOnce();
    expect(ran.cleanup).toBe(false);
  });
});
