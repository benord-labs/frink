import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MobileChatDetail,
  MobileChatEvent,
  MobileMessage,
} from '../../../../shared/types/remote/mobile';
import type { LiveChatEvent } from '../../socket/streaming/live-stream/events';
import { createMobileStreamHub, type ChatEventEnvelope, type MobileStreamHub } from './hub';

type Frame = { channelId: string; envelope: ChatEventEnvelope; event: MobileChatEvent };

function detailOf(messages: MobileMessage[], hasMore = false): MobileChatDetail {
  return {
    chat: { id: 'chat', name: 'Chat', projectId: null },
    subChatId: 'sub-chat',
    subChats: [{ id: 'sub-chat', name: 'Chat', activity: 'running' }],
    messages,
    hasMore,
    activity: 'running',
    kind: 'chat',
    error: null,
    questions: [],
    permissions: [],
    pendingPlanId: null,
  };
}

const reply = (text: string): MobileMessage => ({
  id: 'reply',
  role: 'assistant',
  text,
  parts: [{ type: 'text', text }],
});

let current: MobileChatDetail;
let listener: (event: LiveChatEvent) => void;
let hub: MobileStreamHub;
let frames: Frame[];
const read = async () => structuredClone(current);

function record(channelId: string, envelope: ChatEventEnvelope) {
  const event: MobileChatEvent = JSON.parse(Buffer.from(envelope.body, 'base64').toString());
  frames.push({ channelId, envelope, event });
}

/** Registers `channelId` with a sender that records each frame and settles at once. */
function open(channelId: string) {
  hub.register(channelId, async (envelope) => record(channelId, envelope));
}

function chunk(channel = 'socket:stream-chunk', subChatId: string | null = 'sub-chat') {
  listener({ channel, subChatId });
}

/** The ops each frame for `sub` carried, in order. */
const opsFor = (sub: string | undefined) =>
  frames.filter((frame) => frame.envelope.sub === sub).map((frame) => frame.event.ops);

/** Watches `subChatId` on `phone`, reading the shared chat as that conversation. */
const watchAs = (subChatId: string) =>
  hub.watch('phone', async () => ({ ...structuredClone(current), subChatId }));

beforeEach(() => {
  vi.useFakeTimers();
  current = detailOf([reply('')]);
  frames = [];
  hub = createMobileStreamHub((next) => {
    listener = next;
    return () => {};
  });
});
afterEach(() => {
  hub.dispose();
  vi.useRealTimers();
});

describe('mobile stream hub', () => {
  it('answers a watch with the chat as read, and refuses a channel that is not open', async () => {
    open('phone');
    const watched = await hub.watch('phone', read);
    expect(watched?.detail).toEqual(current);
    expect(watched?.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect(await hub.watch('stranger', read)).toBeNull();
  });

  it('turns 50 stream chunks inside one flush into a single append', async () => {
    open('phone');
    const watched = await hub.watch('phone', read);
    for (let index = 0; index < 50; index++) {
      current.messages[0] = reply(current.messages[0].text + `word${index} `);
      chunk();
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toHaveLength(1);
    expect(frames[0].envelope).toMatchObject({ sub: watched?.sub, seq: 1 });
    expect(frames[0].event.ops).toEqual([
      { op: 'append', messageId: 'reply', partIndex: 0, text: current.messages[0].text },
    ]);
  });

  it('sends a changed tail as parts, a new message as an upsert and new state once', async () => {
    open('phone');
    await hub.watch('phone', read);
    current.messages[0] = {
      ...reply(''),
      parts: [
        { type: 'text', text: '' },
        { type: 'tool', id: 'tool', name: 'Read', state: 'running' },
      ],
    };
    const question: MobileMessage = { id: 'next', role: 'user', text: 'Hi', parts: [] };
    current.messages.push(question);
    current.activity = 'idle';
    current.chat = { ...current.chat, name: 'Renamed' };
    chunk('socket:stream-settled');
    await vi.advanceTimersByTimeAsync(300);
    const { messages, subChatId, ...state } = current;
    expect(frames[0].event.ops).toEqual([
      {
        op: 'parts',
        messageId: 'reply',
        from: 1,
        parts: [{ type: 'tool', id: 'tool', name: 'Read', state: 'running' }],
      },
      { op: 'upsert', message: question },
      { op: 'state', ...state },
    ]);
    expect(state.chat.name).toBe('Renamed');
    chunk('socket:stream-settled');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toHaveLength(1);
  });

  it('streams a 200 KB reply in frames far smaller than the reply', async () => {
    open('phone');
    await hub.watch('phone', read);
    const piece = 'x'.repeat(1_000);
    for (let index = 0; index < 200; index++) {
      current.messages[0] = reply(current.messages[0].text + piece);
      chunk();
      await vi.advanceTimersByTimeAsync(25);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    const sizes = frames.map((frame) => Buffer.from(frame.envelope.body, 'base64').length);
    expect(Math.max(...sizes)).toBeLessThan(16 * 1024);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(8 * 1024 * 1024);
    const streamed = frames
      .flatMap((frame) => frame.event.ops)
      .map((op) => op.op === 'append' && op.text);
    expect(streamed.join('')).toBe(current.messages[0].text);
    expect(frames.map((frame) => frame.envelope.seq)).toEqual(frames.map((_, index) => index + 1));
  });

  it('holds every phone together to 4 frames a second, taking turns', async () => {
    open('a');
    open('b');
    await hub.watch('a', read);
    await hub.watch('b', read);
    for (let tick = 0; tick < 100; tick++) {
      current.messages[0] = reply(`${current.messages[0].text}${tick} `);
      chunk();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(frames.length).toBeLessThanOrEqual(4 * 10 + 4);
    const perPhone = ['a', 'b'].map(
      (id) => frames.filter((frame) => frame.channelId === id).length,
    );
    expect(Math.abs(perPhone[0] - perPhone[1])).toBeLessThanOrEqual(2);
  });

  it('keeps one frame in flight, and follows a failed frame with a resync at its seq', async () => {
    let fail = () => {};
    let unhandled = 0;
    const countUnhandled = () => unhandled++;
    process.on('unhandledRejection', countUnhandled);
    let calls = 0;
    hub.register('phone', async (envelope) => {
      if (calls++ === 0) await new Promise<void>((_, reject) => (fail = () => reject(new Error())));
      record('phone', envelope);
    });
    const watched = await hub.watch('phone', read);
    for (let tick = 0; tick < 10; tick++) {
      current.messages[0] = reply(`${current.messages[0].text}${tick} `);
      chunk();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(calls).toBe(1);
    fail();
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    current.messages[0] = reply('later');
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    process.off('unhandledRejection', countUnhandled);
    expect(frames.map(({ envelope, event }) => [envelope.sub, envelope.seq, event.ops])).toEqual([
      [watched?.sub, 1, [{ op: 'resync' }]],
    ]);
    expect(unhandled).toBe(0);
  });

  it('tells the phone to resync, and ends the watch, rather than send an oversized change', async () => {
    open('phone');
    await hub.watch('phone', read);
    current.messages.push({ ...reply('y'.repeat(70 * 1024)), id: 'long' });
    chunk();
    await vi.advanceTimersByTimeAsync(300);
    expect(frames.map((frame) => frame.event.ops)).toEqual([[{ op: 'resync' }]]);
    current.messages[0] = reply('more');
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toHaveLength(1);
  });

  it('sends nothing to a channel with no watch, or once its channel or watch is gone', async () => {
    open('idle');
    open('phone');
    const watched = await hub.watch('phone', read);
    hub.unwatch('phone', watched!.sub);
    open('other');
    await hub.watch('other', read);
    hub.unregister('other');
    current.messages[0] = reply('changed');
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toEqual([]);
  });

  it('watching a conversation again ends the earlier watch of it with a resync', async () => {
    open('phone');
    const first = await hub.watch('phone', read);
    const second = await hub.watch('phone', read);
    current.messages[0] = reply('changed');
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opsFor(first?.sub)).toEqual([[{ op: 'resync' }]]);
    expect(opsFor(second?.sub)).toHaveLength(1);
    expect(second?.sub).not.toBe(first?.sub);
  });

  it('keeps the newest of two overlapping watches of a conversation, whichever read lands first', async () => {
    open('phone');
    for (const newerFirst of [false, true]) {
      frames = [];
      const releases: Array<() => void> = [];
      const slowRead = () => {
        const landed = new Promise<void>((resolve) => releases.push(resolve));
        return async () => {
          await landed;
          return structuredClone(current);
        };
      };
      const older = hub.watch('phone', slowRead());
      const newer = hub.watch('phone', slowRead());
      const order = newerFirst ? [1, 0] : [0, 1];
      for (const index of order) releases[index]();
      const [olderResult, newerResult] = await Promise.all([older, newer]);
      current.messages[0] = reply(`${current.messages[0].text}more `);
      chunk();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(opsFor(newerResult?.sub)).toHaveLength(1);
      // An older watch that was answered is told it ended; one that was not is answered with null.
      expect(opsFor(olderResult?.sub)).toEqual(olderResult ? [[{ op: 'resync' }]] : []);
    }
  });

  it('resyncs when a message the phone shows is removed, but not when it ages out of the page', async () => {
    open('phone');
    const first: MobileMessage = { id: 'first', role: 'user', text: 'Hi', parts: [] };
    current = detailOf([first, reply('Hello')], true);
    await hub.watch('phone', read);
    current = detailOf([reply('Hello'), { ...first, id: 'newest' }], true);
    chunk();
    await vi.advanceTimersByTimeAsync(300);
    expect(frames.map((frame) => frame.event.ops)).toEqual([
      [{ op: 'upsert', message: current.messages[1] }],
    ]);
    current = detailOf([reply('Hello')]);
    chunk();
    await vi.advanceTimersByTimeAsync(300);
    expect(frames.map((frame) => frame.event.ops)[1]).toEqual([{ op: 'resync' }]);
  });

  it('holds every phone together within 8 MiB of frame bodies in any minute', async () => {
    const sent: Array<{ at: number; bytes: number }> = [];
    for (const channelId of ['a', 'b']) {
      hub.register(channelId, async (envelope) => {
        sent.push({ at: Date.now(), bytes: envelope.body.length });
      });
      await hub.watch(channelId, read);
    }
    for (let tick = 0; tick < 720; tick++) {
      const text = String(tick % 10).repeat(35 * 1024);
      current.messages[0] = { ...reply(''), parts: [{ type: 'text', text }] };
      chunk();
      await vi.advanceTimersByTimeAsync(250);
    }
    const windows = sent.map(({ at }) =>
      sent
        .filter((frame) => frame.at >= at && frame.at < at + 60_000)
        .reduce((total, frame) => total + frame.bytes, 0),
    );
    expect(Math.max(...windows)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(sent.reduce((total, frame) => total + frame.bytes, 0)).toBeGreaterThan(16 * 1024 * 1024);
  });

  it('ends the watch with a resync once its chat can no longer be read', async () => {
    open('phone');
    let gone = false;
    await hub.watch('phone', async () => {
      if (gone) throw new Error('Chat not found.');
      return structuredClone(current);
    });
    gone = true;
    chunk();
    await vi.advanceTimersByTimeAsync(300);
    expect(frames.map((frame) => frame.event.ops)).toEqual([[{ op: 'resync' }]]);
    chunk();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toHaveLength(1);
  });

  it('sends a change made while the first read ran, and keeps only the newest four watches', async () => {
    open('phone');
    const watched = [];
    for (const subChatId of ['one', 'two', 'three', 'four', 'five']) {
      const reading = watchAs(subChatId);
      chunk('socket:stream-chunk', null);
      watched.push(await reading);
    }
    current.activity = 'idle';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opsFor(watched[0]?.sub)).toEqual([[{ op: 'resync' }]]);
    for (const watch of watched.slice(1)) expect(opsFor(watch?.sub)).toHaveLength(1);
  });

  it('retires the watch created first, not the one that sent least recently', async () => {
    open('phone');
    const watched = [];
    for (const subChatId of ['one', 'two', 'three', 'four']) watched.push(await watchAs(subChatId));
    current.activity = 'idle';
    chunk('socket:stream-chunk', 'one');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opsFor(watched[0]?.sub)).toHaveLength(1);
    watched.push(await watchAs('five'));
    current.messages[0] = reply('changed');
    chunk('socket:stream-chunk', null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opsFor(watched[0]?.sub)[1]).toEqual([{ op: 'resync' }]);
    for (const watch of watched.slice(1)) expect(opsFor(watch?.sub)).toHaveLength(1);
  });

  it('answers null to a watch the cap retires before its first read lands', async () => {
    open('phone');
    let land = () => {};
    const slow = hub.watch('phone', async () => {
      await new Promise<void>((resolve) => (land = resolve));
      return structuredClone(current);
    });
    for (const subChatId of ['two', 'three', 'four', 'five']) await watchAs(subChatId);
    land();
    expect(await slow).toBeNull();
  });

  it('sends a change to a sibling conversation, which the state carries', async () => {
    open('phone');
    current.subChats.push({ id: 'sibling', name: 'Sibling', activity: 'running' });
    await hub.watch('phone', read);
    current.subChats[1].activity = 'idle';
    chunk('socket:stream-settled', 'sibling');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames.map((frame) => frame.event.ops[0].op)).toEqual(['state']);
  });

  it('ignores broadcasts for other conversations and channels nobody watches for', async () => {
    open('phone');
    await hub.watch('phone', read);
    current.messages[0] = reply('changed');
    listener({ channel: 'socket:stream-chunk', subChatId: 'elsewhere' });
    listener({ channel: 'composer:changed', subChatId: 'sub-chat' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames).toEqual([]);
  });
});
