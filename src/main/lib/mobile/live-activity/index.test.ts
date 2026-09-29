import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileAgentCounts } from '../../../../shared/types/remote/mobile';

const fixture = vi.hoisted(() => ({ counts: vi.fn() }));
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }));
vi.mock('./counts', () => ({ readAgentCounts: fixture.counts }));
import {
  LIVE_ACTIVITY_URL,
  postToForwarder,
  startMobileLiveActivity,
  type LiveActivityPush,
} from './index';

const token = 'a'.repeat(64);
let recipients: Array<{ id: string; token: string }>;
let counts: MobileAgentCounts;
let result: 'ok' | 'gone' | 'retry';
const send = vi.fn(async (_push: LiveActivityPush, _timeoutMs?: number) => result);
const store = {
  liveActivityRecipients: () => recipients,
  liveActivityGone: vi.fn(async (id: string, gone: string) => {
    recipients = recipients.filter((entry) => entry.id !== id || entry.token !== gone);
  }),
};
let sampler: ReturnType<typeof startMobileLiveActivity>;

const pushes = () => send.mock.calls.map(([push]) => push);
const set = (running: number, needsYou: number) => {
  counts = { running, needsYou };
};
/** Advances whole five-second ticks and lets each tick's promises settle. */
const ticks = (count = 1) => vi.advanceTimersByTimeAsync(count * 5_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  recipients = [{ id: 'phone', token }];
  set(1, 0);
  result = 'ok';
  fixture.counts.mockImplementation(async () => counts);
  sampler = startMobileLiveActivity(store, send);
});
afterEach(() => {
  sampler.stop();
  vi.useRealTimers();
});

describe('Live Activity sampler', () => {
  it('never reads counts while no phone has a card', async () => {
    recipients = [];
    await ticks(3);
    expect(fixture.counts).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a new token the current value at once', async () => {
    await ticks();
    expect(pushes()).toEqual([{ token, event: 'update', running: 1, needsYou: 0, urgent: false }]);
  });

  it('skips a one-tick blip and sends a value that holds for two ticks', async () => {
    await ticks(3);
    set(2, 0);
    await ticks();
    set(1, 0);
    await ticks(2);
    expect(send).toHaveBeenCalledTimes(1);
    set(2, 0);
    await ticks(2);
    expect(pushes()[1]).toMatchObject({ event: 'update', running: 2, urgent: false });
  });

  it('sends a held value on the next tick even when the first read was slow', async () => {
    await ticks();
    set(2, 0);
    fixture.counts.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(counts), 300)),
    );
    await ticks(2);
    expect(pushes()[1]).toMatchObject({ event: 'update', running: 2 });
  });

  it('marks an update urgent only when more chats need you', async () => {
    await ticks(3);
    set(1, 1);
    await ticks(2);
    set(0, 1);
    await ticks(2);
    expect(pushes().slice(1)).toEqual([
      expect.objectContaining({ running: 1, needsYou: 1, urgent: true }),
      expect.objectContaining({ running: 0, needsYou: 1, urgent: false }),
    ]);
  });

  it('holds a ten-second floor, doubles the back-off on failure and resets it on success', async () => {
    await ticks();
    set(2, 0);
    // Held for two ticks at 10 s, and the floor from the 5 s send has passed.
    result = 'retry';
    await ticks(2);
    expect(send).toHaveBeenCalledTimes(2);
    // The retry waits 20 s, then 40 s.
    await ticks(3);
    expect(send).toHaveBeenCalledTimes(2);
    await ticks();
    expect(send).toHaveBeenCalledTimes(3);
    await ticks(7);
    expect(send).toHaveBeenCalledTimes(3);
    result = 'ok';
    await ticks();
    expect(send).toHaveBeenCalledTimes(4);
    set(3, 0);
    await ticks(2);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('forgets a token the forwarder reports gone', async () => {
    result = 'gone';
    await ticks();
    expect(store.liveActivityGone).toHaveBeenCalledWith('phone', token);
    await ticks(3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ends the card once nothing has run or waited for a minute, then clears the token', async () => {
    await ticks();
    set(0, 0);
    // First seen at 10 s, so 65 s is still inside the minute and 70 s is past it.
    await ticks(12);
    expect(pushes().map((push) => push.event)).toEqual(['update', 'update']);
    await ticks();
    expect(pushes().at(-1)).toEqual({
      token,
      event: 'end',
      running: 0,
      needsYou: 0,
      urgent: false,
    });
    expect(store.liveActivityGone).toHaveBeenCalledWith('phone', token);
  });

  it('re-sends an unchanged value every fifteen minutes to keep the card fresh', async () => {
    await ticks();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 5_000);
    expect(send).toHaveBeenCalledTimes(1);
    await ticks();
    expect(pushes()[1]).toMatchObject({ event: 'update', running: 1, urgent: false });
  });

  it('lets a change due with the keep-alive go through the change rule instead', async () => {
    await ticks();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 5_000);
    set(1, 1);
    await ticks();
    expect(send).toHaveBeenCalledTimes(1);
    await ticks();
    expect(pushes()[1]).toMatchObject({ event: 'update', needsYou: 1, urgent: true });
  });

  it('sends nothing but the end to a card ended while counts were being read', async () => {
    await ticks();
    let release!: (value: MobileAgentCounts) => void;
    fixture.counts.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await ticks();
    send.mockClear();
    sampler.endDevice('phone');
    release({ running: 1, needsYou: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pushes().map((push) => push.event)).toEqual(['end']);
  });

  it('ends cards on stop and on a single device without waiting for the network', async () => {
    recipients = [
      { id: 'phone', token },
      { id: 'tablet', token: 'b'.repeat(64) },
    ];
    await ticks();
    send.mockClear();
    send.mockImplementation(() => new Promise(() => {}));
    sampler.endDevice('phone');
    expect(pushes()).toEqual([{ token, event: 'end', running: 0, needsYou: 0, urgent: false }]);
    expect(send.mock.calls[0][1]).toBe(1_000);
    sampler.stop();
    expect(pushes().map((push) => [push.token, push.event])).toEqual([
      [token, 'end'],
      ['b'.repeat(64), 'end'],
    ]);
  });
});

describe('postToForwarder', () => {
  it('posts exactly the counts contract and maps only 200 and 410', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const push = { token, event: 'update', running: 2, needsYou: 1, urgent: true } as const;
    for (const [status, expected] of [
      [200, 'ok'],
      [410, 'gone'],
      [429, 'retry'],
      [502, 'retry'],
    ] as const) {
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      expect(await postToForwarder({ ...push, extra: 1 } as LiveActivityPush)).toBe(expected);
    }
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await postToForwarder(push)).toBe('retry');
    expect(fetch).toHaveBeenCalledWith(
      LIVE_ACTIVITY_URL,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify(push),
      }),
    );
    vi.unstubAllGlobals();
  });
});
