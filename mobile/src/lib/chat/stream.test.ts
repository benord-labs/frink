import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MobileChatDetail,
  MobileChatEvent,
  MobileResponses,
} from '@frink/shared/types/remote/mobile';
import type { RelayEventHandler, RelayLink } from '../relay/client';
import { ApiError, linkLost, unreachable } from '../relay/error';
import { ChatStream, STREAM_RETRY_MS, nextStep, type ChatStreamDeps } from './stream';

const detail: MobileChatDetail = {
  chat: { id: 'chat', name: 'Chat', projectId: null },
  subChatId: 'sub-chat',
  subChats: [],
  messages: [{ id: 'reply', role: 'assistant', text: 'Hi', parts: [{ type: 'text', text: 'Hi' }] }],
  hasMore: false,
  activity: 'running',
  kind: 'chat',
  error: null,
  questions: [],
  permissions: [],
  pendingPlanId: null,
};
const encode = (event: MobileChatEvent) => new TextEncoder().encode(JSON.stringify(event));
const append = (text: string) =>
  encode({ ops: [{ op: 'append', messageId: 'reply', partIndex: 0, text }] });
const resync = encode({ ops: [{ op: 'resync' }] });
const textOf = (shown: MobileChatDetail | undefined) => shown?.messages[0].text;

describe('nextStep', () => {
  const watching = { sub: 'sub', seq: 2, detail };

  it('applies the next event in order and keeps every untouched field', () => {
    const step = nextStep(watching, 3, append(' there'));
    expect(step.kind === 'apply' && step.watching.seq).toBe(3);
    expect(step.kind === 'apply' && textOf(step.watching.detail)).toBe('Hi there');
    expect(step.kind === 'apply' && step.watching.detail.subChats).toBe(detail.subChats);
  });

  it('ignores a repeat, and treats a gap, a bad body or an op that does not fit as broken', () => {
    expect(nextStep(watching, 2, append('!')).kind).toBe('ignore');
    expect(nextStep(watching, 4, append('!')).kind).toBe('broken');
    expect(nextStep(watching, 3, new TextEncoder().encode('{')).kind).toBe('broken');
    expect(nextStep(watching, 3, encode({ ops: [] }).subarray(0, 0)).kind).toBe('broken');
    const unknown = encode({ ops: [{ op: 'append', messageId: 'gone', partIndex: 0, text: '!' }] });
    expect(nextStep(watching, 3, unknown).kind).toBe('broken');
  });

  it('obeys a resync at any seq, even one already applied', () => {
    expect(nextStep(watching, 2, resync).kind).toBe('ended');
    expect(nextStep(watching, 9, resync).kind).toBe('ended');
  });
});

class FakeLink implements RelayLink {
  lost = false;
  handlers = new Map<string, RelayEventHandler>();
  private listeners = new Set<(gone: boolean) => void>();
  listen(sub: string, handler: RelayEventHandler) {
    this.handlers.set(sub, handler);
    return () => void this.handlers.delete(sub);
  }
  onLost(listener: (gone: boolean) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  lose(gone = false) {
    this.lost = true;
    this.handlers.clear();
    for (const listener of [...this.listeners]) listener(gone);
    this.listeners.clear();
  }
  emit(sub: string, seq: number, body: Uint8Array) {
    this.handlers.get(sub)?.(seq, body);
  }
}

/** The link the next request uses, and the chat the stream last drew. */
type Shown = { link: FakeLink; shown?: MobileChatDetail };
type Answer = {
  resolve: (value: MobileResponses['watchChat']) => void;
  reject: (e: Error) => void;
};

/** A stream whose watches the test answers by hand; `link` is the link the next request uses. */
let made = 0;
function harness(conversation = `chat-${++made}`) {
  const answers: Answer[] = [];
  const state: Shown = { link: new FakeLink() };
  const deps = {
    link: () => state.link,
    watch: vi.fn(
      () =>
        new Promise<MobileResponses['watchChat']>((resolve, reject) =>
          answers.push({ resolve, reject }),
        ),
    ),
    unwatch: vi.fn<(sub: string) => void>(),
    canWatch: vi.fn(() => true),
    show: (shown: MobileChatDetail) => void (state.shown = shown),
    first: () => state.shown?.messages[0]?.id,
    live: vi.fn<(live: boolean) => void>(),
    conversation,
  } satisfies ChatStreamDeps;
  const stream = new ChatStream(deps);
  /** Answers the watch at `index` (the latest by default) and lets the stream take it. */
  async function answer(sub: string, index = answers.length - 1, snapshot = detail) {
    answers[index].resolve({ sub, detail: snapshot });
    await vi.advanceTimersByTimeAsync(0);
  }
  async function fail(error: Error, index = answers.length - 1) {
    answers[index].reject(error);
    await vi.advanceTimersByTimeAsync(0);
  }
  return { state, deps, stream, answer, fail };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ChatStream', () => {
  it('shows the watched chat, applies its events, and is live only while watching', async () => {
    const { state, deps, stream, answer } = harness();
    stream.start();
    await answer('one');
    expect(deps.live).toHaveBeenLastCalledWith(true);
    state.link.emit('one', 1, append(' there'));
    state.link.emit('one', 1, append(' there'));
    expect(textOf(state.shown)).toBe('Hi there');
    stream.stop();
    expect(deps.unwatch).toHaveBeenCalledWith('one');
    expect(deps.live).toHaveBeenLastCalledWith(false);
    state.link.emit('one', 2, append('!'));
    expect(textOf(state.shown)).toBe('Hi there');
  });

  it('takes a fresh copy on schedule during a steady stream, staying live and never stepping back', async () => {
    const { state, deps, stream, answer } = harness();
    stream.start();
    await answer('one');
    for (let second = 1; second <= 15; second++) {
      state.link.emit('one', second, append('.'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(deps.watch).toHaveBeenCalledTimes(2);
    expect(deps.unwatch).toHaveBeenCalledWith('one');
    state.link.emit('one', 16, append(' stale'));
    expect(textOf(state.shown)).toBe(`Hi${'.'.repeat(15)}`);
    await answer('two', 1, { ...detail, chat: { ...detail.chat, name: 'Renamed' } });
    expect(state.shown?.chat.name).toBe('Renamed');
    expect(deps.live.mock.calls).toEqual([[true]]);
    stream.stop();
  });

  it('takes no fresh copy while not live, nor after it stops', async () => {
    const waiting = harness();
    waiting.stream.start();
    const stopped = harness();
    stopped.stream.start();
    await stopped.answer('one');
    stopped.stream.stop();
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS * 2);
    expect(waiting.deps.watch).toHaveBeenCalledOnce();
    expect(stopped.deps.watch).toHaveBeenCalledOnce();
  });

  it('a page read between two events moves where the live chat starts, so it never grows back, even after a resync', async () => {
    const message = (id: string) => ({ ...detail.messages[0], id });
    const ids = () => state.shown?.messages.map(({ id }) => id);
    const { state, stream, answer } = harness();
    stream.start();
    await answer('one', 0, { ...detail, hasMore: true, messages: [message('a'), message('b')] });
    state.link.emit('one', 1, encode({ ops: [{ op: 'upsert', message: message('c') }] }));
    expect(ids()).toEqual(['a', 'b', 'c']);
    state.shown = { ...detail, hasMore: true, messages: [message('b'), message('c')] };
    state.link.emit('one', 2, encode({ ops: [{ op: 'upsert', message: message('d') }] }));
    expect(ids()).toEqual(['b', 'c', 'd']);
    state.link.emit('one', 3, resync);
    await answer('two', 1, { ...detail, messages: ['a', 'b', 'c', 'd'].map(message) });
    expect(ids()).toEqual(['b', 'c', 'd']);
    stream.stop();
  });

  it('a gap unwatches and watches again exactly once; a resync watches again without unwatching', async () => {
    const { state, deps, stream, answer } = harness();
    stream.start();
    await answer('one');
    state.link.emit('one', 2, append('!'));
    expect(deps.unwatch).toHaveBeenCalledWith('one');
    expect(deps.watch).toHaveBeenCalledTimes(2);
    await answer('two');
    state.link.emit('two', 1, resync);
    expect(deps.unwatch).toHaveBeenCalledTimes(1);
    expect(deps.watch).toHaveBeenCalledTimes(3);
  });

  it('watches again on the new link when the live one is lost', async () => {
    const { state, deps, stream, answer } = harness();
    stream.start();
    await answer('one');
    const old = state.link;
    state.link = new FakeLink();
    old.lose();
    expect(deps.unwatch).not.toHaveBeenCalled();
    expect(deps.watch).toHaveBeenCalledTimes(2);
    await answer('two');
    expect(state.link.handlers.has('two')).toBe(true);
  });

  it('does not watch again while the app is in the background', async () => {
    const { state, deps, stream, answer } = harness();
    stream.start();
    await answer('one');
    deps.canWatch.mockReturnValue(false);
    state.link.lose();
    expect(deps.watch).toHaveBeenCalledOnce();
  });

  it('a link lost while its watch is on the way is tried again later, not at once', async () => {
    const { state, deps, stream, fail } = harness();
    stream.start();
    const old = state.link;
    state.link = new FakeLink();
    old.lose();
    await fail(linkLost(), 0);
    expect(deps.watch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(deps.watch).toHaveBeenCalledTimes(2);
  });

  it('only a desktop too old to know watches (400) stays on polls, until a new link is dialled', async () => {
    const { state, deps, stream, fail } = harness();
    stream.start();
    await fail(new ApiError('Invalid request. Check the values and try again.', 400));
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS * 2);
    expect(deps.watch).toHaveBeenCalledOnce();
    expect(deps.live).not.toHaveBeenCalled();
    stream.stop();
    const again = new ChatStream(deps);
    again.start();
    expect(deps.watch).toHaveBeenCalledOnce();
    const old = state.link;
    state.link = new FakeLink();
    old.lose();
    expect(deps.watch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a passing refusal', new ApiError('Live updates need an open connection. Try again.', 409)],
    ['too many requests', new ApiError('Too many requests. Try again in a moment.', 429)],
    ['a fault', new ApiError('Frink could not complete this request. Try again.', 500)],
    ['a timeout', unreachable()],
    ['a lost link', linkLost()],
  ])('tries a watch that failed with %s again after the retry spacing', async (_, error) => {
    const { deps, stream, fail } = harness();
    stream.start();
    await fail(error);
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS - 1);
    expect(deps.watch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.watch).toHaveBeenCalledTimes(2);
  });

  it('a link closed on purpose ends the stream, whether its watch was live or on its way', async () => {
    const live = harness();
    live.stream.start();
    await live.answer('one');
    live.state.link.lose(true);
    const asking = harness();
    asking.stream.start();
    asking.state.link.lose(true);
    await asking.answer('late');
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    for (const { deps } of [live, asking]) {
      expect(deps.watch).toHaveBeenCalledOnce();
      expect(deps.unwatch).not.toHaveBeenCalled();
    }
    expect(live.deps.live).toHaveBeenLastCalledWith(false);
    expect(asking.deps.live).not.toHaveBeenCalled();
  });

  it('does not unwatch a late watch whose link was lost: that channel already dropped it', async () => {
    const { state, deps, stream, answer } = harness();
    stream.start();
    const old = state.link;
    state.link = new FakeLink();
    old.lose();
    await answer('late', 0);
    expect(deps.unwatch).not.toHaveBeenCalled();
    expect(old.handlers.size).toBe(0);
  });

  it('unwatches a watch answered after its screen left, and ignores its errors', async () => {
    const { deps, stream, answer } = harness();
    stream.start();
    stream.stop();
    await answer('late');
    expect(deps.unwatch).toHaveBeenCalledWith('late');
    expect(deps.live).not.toHaveBeenCalled();
  });

  it('ignores an error from a watch that a newer one replaced', async () => {
    const { state, deps, stream, answer, fail } = harness();
    stream.start();
    const old = state.link;
    state.link = new FakeLink();
    old.lose();
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(deps.watch).toHaveBeenCalledTimes(2);
    await fail(new ApiError('Live updates need an open connection. Try again.', 409), 0);
    await answer('two', 1);
    expect(state.link.handlers.has('two')).toBe(true);
    expect(deps.live).toHaveBeenLastCalledWith(true);
  });

  it('a second screen of a watched chat waits, even through the first one’s resyncs and fresh copies', async () => {
    const first = harness('same');
    const second = harness('same');
    second.state.link = first.state.link;
    first.stream.start();
    await first.answer('one');
    second.stream.start();
    first.state.link.emit('one', 1, resync);
    await first.answer('two');
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(first.deps.watch).toHaveBeenCalledTimes(3);
    expect(second.deps.watch).not.toHaveBeenCalled();
    expect(second.deps.live).not.toHaveBeenCalled();
    first.stream.stop();
    second.stream.stop();
  });

  it('the waiting screen watches once the first one stops, live or still asking', async () => {
    const asking = [harness('asking'), harness('asking')];
    const live = [harness('live'), harness('live')];
    for (const [first] of [asking, live]) first.stream.start();
    await live[0].answer('one');
    for (const [first, second] of [asking, live]) {
      second.stream.start();
      first.stream.stop();
      expect(second.deps.watch).toHaveBeenCalledOnce();
      second.stream.stop();
    }
  });
});
