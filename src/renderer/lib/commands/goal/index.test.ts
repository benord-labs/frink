// @vitest-environment happy-dom
import { atom, createStore } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { describe, expect, it } from 'vitest';
import type { GoalPartData } from '../../../../shared/types/goal';
import { activeGoal, activeGoalAtom, type GoalMessage } from './index';

type Message = GoalMessage & { id: string };
type Metadata = GoalMessage['metadata'];

const ENDED: Metadata = { resultSubtype: 'success', outputTokens: 120 };
const STATUS_ONLY: Metadata = { resultSubtype: 'success', outputTokens: 0 };
let seq = 0;

function reply(goal?: GoalPartData, metadata?: Metadata, extra: string[] = []): Message {
  const parts = [
    ...(goal ? [{ type: 'data-goal', data: goal }] : []),
    ...extra.map((type) => ({ type })),
  ];
  return { id: `a${seq++}`, role: 'assistant', parts, metadata };
}

const ask: Message = { id: 'u', role: 'user', parts: [{ type: 'text' }] };
const set: GoalPartData = { state: 'active', objective: 'tests pass' };
/** Oldest first, as the chat stores them. */
const goalOf = (chat: Message[]) => activeGoal([...chat].reverse());

describe('activeGoal', () => {
  it('keeps a goal the user stopped, so the next message is explained', () => {
    expect(goalOf([ask, reply(set)])).toEqual({ objective: 'tests pass' });
  });

  it('ends a goal when its turn finishes cleanly, since Claude only stops once it is met', () => {
    expect(goalOf([ask, reply(set, ENDED)])).toBeNull();
  });

  it('keeps a goal after a status check that ran no model turn', () => {
    expect(goalOf([reply(set), ask, reply(set, STATUS_ONLY)])).toEqual({
      objective: 'tests pass',
    });
  });

  it('drops a cleared goal', () => {
    expect(goalOf([reply(set), ask, reply({ state: 'cleared' }, STATUS_ONLY)])).toBeNull();
  });

  it("shows a resumed goal's latest failed check", () => {
    const check: GoalPartData = { state: 'checked', objective: 'tests pass', lastCheck: '2 fail' };
    expect(goalOf([reply(set), ask, reply(check)])).toEqual({
      objective: 'tests pass',
      lastCheck: '2 fail',
    });
  });

  it("takes a resumed goal's own check over another hook's newer one", () => {
    const own: GoalPartData = { state: 'checked', objective: 'tests pass', lastCheck: '2 fail' };
    const lint: GoalPartData = { state: 'checked', objective: 'lint', lastCheck: 'errors' };
    const turn: Message = {
      id: 'resumed',
      role: 'assistant',
      parts: [
        { type: 'data-goal', data: own },
        { type: 'data-goal', data: lint },
      ],
    };
    expect(goalOf([reply(set), ask, turn])).toEqual({
      objective: 'tests pass',
      lastCheck: '2 fail',
    });
  });

  it('ends a resumed goal when a later turn finishes cleanly', () => {
    expect(goalOf([reply(set), ask, reply(undefined, ENDED)])).toBeNull();
  });

  it("ignores another hook's check when no goal was set", () => {
    const check: GoalPartData = { state: 'checked', objective: 'lint', lastCheck: 'errors' };
    expect(goalOf([ask, reply(check)])).toBeNull();
  });

  it('keeps the goal through a compaction', () => {
    expect(goalOf([reply(set), ask, reply(undefined, ENDED, ['data-compact'])])).toEqual({
      objective: 'tests pass',
    });
  });
});

describe('activeGoal with background work', () => {
  type Part = NonNullable<GoalMessage['parts']>[number];
  const step: Part = { type: 'step-start' };
  const goalPart: Part = { type: 'data-goal', data: set };
  const stop = (deferred: boolean): Part => ({
    type: 'data-goal',
    data: { state: 'stopped', deferred },
  });
  /** A turn whose wake bursts have appended to it; the metadata stays the turn's own. */
  const turn = (...parts: Part[]): Message => ({
    id: `a${seq++}`,
    role: 'assistant',
    parts,
    metadata: ENDED,
  });

  it('keeps a goal whose turn stopped while background work still ran', () => {
    expect(goalOf([ask, turn(step, goalPart, stop(true))])).toEqual({ objective: 'tests pass' });
  });

  it('keeps the goal while a wake burst works on it', () => {
    const waking = turn(step, goalPart, stop(true), step, { type: 'text' });
    expect(goalOf([ask, waking])).toEqual({ objective: 'tests pass' });
  });

  it('ends the goal once a burst stops with nothing left running', () => {
    expect(goalOf([ask, turn(step, goalPart, stop(true), step, stop(false))])).toBeNull();
  });

  it('keeps the goal through a message sent during the wait', () => {
    expect(goalOf([turn(step, goalPart, stop(true)), ask, turn(step, stop(true))])).toEqual({
      objective: 'tests pass',
    });
  });

  it('does not bring back a met goal when a later turn waits on background work', () => {
    expect(goalOf([turn(step, goalPart, stop(false)), ask, turn(step, stop(true))])).toBeNull();
  });

  it('does not bring back a met goal while a scheduled wake runs on that turn', () => {
    const waking = turn(step, goalPart, stop(false), step, { type: 'text' });
    expect(goalOf([ask, waking])).toBeNull();
  });
});

describe('activeGoalAtom', () => {
  it('reads the chat from its message atoms and keeps its value while the goal is unchanged', () => {
    const store = createStore();
    const messages = atomFamily((_id: string) => atom<Message | null>(null));
    const chat = [reply(set), ask, reply()];
    for (const message of chat) store.set(messages(message.id), message);
    const goalAtom = activeGoalAtom(atom(chat.map((message) => message.id)), messages);

    const first = store.get(goalAtom);
    expect(first).toEqual({ objective: 'tests pass' });

    const streaming = chat[2];
    store.set(messages(streaming.id), { ...streaming, parts: [{ type: 'text' }] });
    expect(store.get(goalAtom)).toBe(first);

    store.set(messages(streaming.id), { ...streaming, metadata: ENDED });
    expect(store.get(goalAtom)).toBeNull();
  });
});
