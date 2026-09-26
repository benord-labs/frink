import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createStreamingInputQueue } from './streaming-input-queue';

const turn = (text: string): SDKUserMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  }) as unknown as SDKUserMessage;

const textOf = (m: SDKUserMessage): unknown =>
  (m.message.content as Array<{ text?: string }>)[0]?.text;

describe('createStreamingInputQueue', () => {
  it('yields pushed messages in order, then ends after close', async () => {
    const q = createStreamingInputQueue();
    q.push(turn('one'));
    q.push(turn('two'));
    q.close();

    const seen: unknown[] = [];
    for await (const m of q.stream) seen.push(textOf(m));

    expect(seen).toEqual(['one', 'two']);
  });

  it('ends immediately when closed with nothing buffered', async () => {
    const q = createStreamingInputQueue();
    q.close();

    const seen: unknown[] = [];
    for await (const m of q.stream) seen.push(textOf(m));

    expect(seen).toEqual([]);
  });

  it('delivers a turn pushed AFTER the consumer is already awaiting (the persistent-chat case)', async () => {
    const q = createStreamingInputQueue();
    const seen: unknown[] = [];

    // Start consuming before any message exists — mirrors the SDK holding the
    // stream open between turns.
    const consumed = (async () => {
      for await (const m of q.stream) {
        seen.push(textOf(m));
        if (seen.length === 1) q.push(turn('turn-2')); // second turn arrives mid-session
        if (seen.length === 2) q.close();
      }
    })();

    await Promise.resolve(); // let the consumer reach its first await
    q.push(turn('turn-1'));
    await consumed;

    expect(seen).toEqual(['turn-1', 'turn-2']);
  });

  it('throws on push after close so a dropped turn never goes silent', () => {
    const q = createStreamingInputQueue();
    q.close();
    expect(() => q.push(turn('late'))).toThrow('push after close');
    expect(q.closed).toBe(true);
  });

  it('drains a multi-message backlog pushed while the consumer is awaiting, in order', async () => {
    const q = createStreamingInputQueue();
    const seen: unknown[] = [];
    const consumed = (async () => {
      for await (const m of q.stream) {
        seen.push(textOf(m));
        if (seen.length === 3) q.close();
      }
    })();

    await Promise.resolve(); // consumer reaches its first await with an empty buffer
    q.push(turn('a'));
    q.push(turn('b')); // b, c land while the consumer is still draining a's wake
    q.push(turn('c'));
    await consumed;

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('delivers an item pushed together with close while the consumer is awaiting', async () => {
    const q = createStreamingInputQueue();
    const seen: unknown[] = [];
    const consumed = (async () => {
      for await (const m of q.stream) seen.push(textOf(m));
    })();

    await Promise.resolve();
    q.push(turn('last'));
    q.close(); // close must not drop the buffered item

    await consumed;
    expect(seen).toEqual(['last']);
  });
});
