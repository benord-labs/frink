import { describe, expect, it } from 'vitest';
import type { MobileRequest } from '@frink/shared/types/remote/mobile';
import { ApiError } from '../relay/error';
import { deliver, type DeliverEnv } from './deliver';
import {
  STEER_REFUSED,
  addPending,
  changePending,
  readPending,
  type PendingEntry,
} from './pending';

type Answer = () => Promise<{ ok: true } | { outcome: 'delivered' | 'not-delivered' }>;
const ok: Answer = async () => ({ ok: true });
const steered =
  (outcome: 'delivered' | 'not-delivered'): Answer =>
  async () => ({ outcome });
const fail =
  (status: number, message = 'Failed'): Answer =>
  async () => {
    throw new ApiError(message, status);
  };

/** A computer that answers each send in turn and holds `saved` in its transcript. */
function computer(answers: Answer[], saved: string[] = []) {
  const sends: MobileRequest[] = [];
  let state = 'active';
  const listeners = new Set<(state: string) => void>();
  // SAFETY: the fake answers only the two request types deliver makes, with their real shapes.
  const request = (async (input: MobileRequest) => {
    if (input.type === 'chat') return { messages: saved.map((id) => ({ id, role: 'user' })) };
    sends.push(input);
    return answers[sends.length - 1]();
  }) as DeliverEnv['request'];
  const app: DeliverEnv['app'] = {
    get currentState() {
      return state;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
  };
  const become = (next: string) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  return { env: { request, app }, sends, become };
}

let next = 0;
function outbox(kind: PendingEntry['kind'] = 'send') {
  const key = `device\nchat\nsub-${++next}`;
  const entry: PendingEntry = {
    id: `request-${next}`,
    text: 'Fix the build',
    attachments: [],
    kind,
    state: 'sending',
  };
  changePending(key, (entries) => addPending(entries, entry));
  return { target: { key, chatId: 'chat', subChatId: `sub-${next}` }, entry };
}

describe('deliver', () => {
  it('resends an unreachable message once, under the same request id', async () => {
    const desktop = computer([fail(0), ok]);
    const { target, entry } = outbox();
    await deliver(desktop.env, target, entry);
    expect(desktop.sends.map((send) => send.type === 'sendMessage' && send.requestId)).toEqual([
      entry.id,
      entry.id,
    ]);
    expect(readPending(target.key)).toEqual([{ ...entry, state: 'sent' }]);
  });

  it('waits for the app to come back before resending', async () => {
    const desktop = computer([fail(0), ok]);
    const { target, entry } = outbox();
    desktop.become('background');
    const done = deliver(desktop.env, target, entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(desktop.sends).toHaveLength(1);
    desktop.become('active');
    await done;
    expect(desktop.sends).toHaveLength(2);
  });

  it('counts a refused repeat as delivered when the transcript holds it', async () => {
    const { target, entry } = outbox();
    const desktop = computer([fail(0), fail(409, 'Already sent.')], [entry.id]);
    await expect(deliver(desktop.env, target, entry)).resolves.toBe(true);
    expect(readPending(target.key)).toEqual([{ ...entry, state: 'sent' }]);
  });

  it('marks a refused send failed with the computer’s words', async () => {
    const desktop = computer([fail(409, 'Frink is busy. Try again.')]);
    const { target, entry } = outbox();
    await deliver(desktop.env, target, entry);
    expect(desktop.sends).toHaveLength(1);
    expect(readPending(target.key)).toEqual([
      { ...entry, state: 'failed', error: 'Frink is busy. Try again.' },
    ]);
  });

  it('gives up after one retry', async () => {
    const desktop = computer([fail(0), fail(0, 'Can’t reach your computer.')]);
    const { target, entry } = outbox();
    await deliver(desktop.env, target, entry);
    expect(desktop.sends).toHaveLength(2);
    expect(readPending(target.key)[0]).toMatchObject({ state: 'failed' });
  });

  it('asks again about an unreachable steer under its id, so a lost answer never becomes a turn', async () => {
    const desktop = computer([fail(0), steered('delivered')]);
    const { target, entry } = outbox('steer');
    await expect(deliver(desktop.env, target, entry)).resolves.toBe(true);
    expect(desktop.sends.map((send) => [send.type, 'requestId' in send && send.requestId])).toEqual(
      [
        ['steerMessage', entry.id],
        ['steerMessage', entry.id],
      ],
    );
    expect(readPending(target.key)).toEqual([{ ...entry, state: 'sent' }]);
  });

  it('marks a steer the turn refused failed, saying nothing was sent', async () => {
    const desktop = computer([steered('not-delivered')]);
    const { target, entry } = outbox('steer');
    await expect(deliver(desktop.env, target, entry)).resolves.toBe(false);
    expect(readPending(target.key)).toEqual([{ ...entry, state: 'failed', error: STEER_REFUSED }]);
  });
});
