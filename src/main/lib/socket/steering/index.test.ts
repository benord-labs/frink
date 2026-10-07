import { createMessageProvenance } from '../execution/message-provenance';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCodexLiveTurnsForTest } from '../../agent-runner/codex/codex-live-turn';
import { pendingToolApprovals } from '../../claude/ask-user-question-approval';
import { __resetSessionsForTest, createSession, getSession } from '../claude-session-registry';
import { createClaudeTurnContext } from '../claude-turn-context';
import { runTurn } from '../execution/claude-session-loop';
import { steerActiveTurn } from './index';

const emitted: Array<{ msgId: string }> = [];
vi.mock('./emitter', () => ({
  emitSteerMarker: (turn: { msgId: string }) => emitted.push({ msgId: turn.msgId }),
}));
vi.mock('../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../db/repos/sub-chats', () => ({
  // Resolves on a later microtask, which is the window the race lives in.
  getSubChatById: async () => {
    await Promise.resolve();
    return { chatId: 'chat-1' };
  },
}));

const asQuery = (gen: AsyncGenerator<SDKMessage, void>): Query =>
  Object.assign(gen, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
  }) as unknown as Query;

/** A query that stays mid-turn until `finish()` — models an agent actively working. */
function heldQuery(): { query: Query; finish: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    yield { type: 'assistant' } as unknown as SDKMessage;
    await gate;
    yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
  }
  return { query: asQuery(gen()), finish: () => release() };
}

/** Start a turn and leave it in flight. Resolves once the session is actually busy. */
async function startBusyTurn(
  subChatId: string,
): Promise<{ finish: () => void; done: Promise<void> }> {
  const { query, finish } = heldQuery();
  const session = createSession(subChatId, () => query);
  const done = runTurn(session, {} as SDKUserMessage, () => {});
  // Let runTurn set `busy` and pull the first frame before the test steers.
  await vi.waitFor(() => expect(session.busy).toBe(true));
  return { finish, done };
}

describe('steerActiveTurn', () => {
  beforeEach(() => {
    __resetSessionsForTest();
    __resetCodexLiveTurnsForTest();
    pendingToolApprovals.clear();
  });
  afterEach(() => {
    pendingToolApprovals.clear();
  });

  it('registers a Flow steer separately and clears pending metadata when the turn ends', async () => {
    const { finish, done } = await startBusyTurn('flow-provenance');
    const live = getSession('flow-provenance')!;
    const turn = createClaudeTurnContext();
    turn.messageProvenance = createMessageProvenance({ source: 'flow', kind: 'message' });
    live.currentTurn = turn;
    expect(await steerActiveTurn('flow-provenance', { text: 'person note' })).toBe('delivered');
    expect(live.pendingDeliveries).toHaveLength(1);
    expect(live.pendingDeliveries[0]?.record).toMatchObject({ source: 'person', kind: 'steer' });
    expect(live.pendingDeliveries[0]?.record.delivery_id).not.toBe(
      turn.messageProvenance.delivery_id,
    );
    finish();
    await done;
    expect(live.pendingDeliveries).toEqual([]);
  });

  it('pushes into the live Claude session without starting a turn', async () => {
    const { finish, done } = await startBusyTurn('c1');
    const session = getSession('c1');
    if (!session) throw new Error('expected a live session for c1');
    const pushSpy = vi.spyOn(session.queue, 'push');

    await expect(steerActiveTurn('c1', { text: 'use the other file' })).resolves.toBe('delivered');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const pushed = pushSpy.mock.calls[0]?.[0] as SDKUserMessage & { priority?: string };
    // `priority: 'next'` is what makes the CLI splice this into the RUNNING turn rather than
    // interrupt it; `uuid` is the handle cancel_async_message needs to withdraw it.
    expect(pushed.priority).toBe('next');
    expect(pushed.uuid).toBeTruthy();
    expect(pushed.message.content).toBe('use the other file');

    // The turn it steered into is still the same one — steering must never end a turn.
    expect(session.busy).toBe(true);
    finish();
    await done;
  });

  it('marks the turn it joined as steered, so that turn’s CLI is not kept idle', async () => {
    const { finish, done } = await startBusyTurn('c7');
    const session = getSession('c7');
    if (!session) throw new Error('expected a live session for c7');
    const turn = createClaudeTurnContext();
    session.currentTurn = turn;

    await expect(steerActiveTurn('c7', { text: 'hi' })).resolves.toBe('delivered');

    expect(turn.steered).toBe(true);
    finish();
    await done;
  });

  it('refuses when the session is idle, so the caller queues instead', async () => {
    createSession('c2', () => asQuery((async function* () {})()));
    await expect(steerActiveTurn('c2', { text: 'hi' })).resolves.toBe('not-steerable');
  });

  it('refuses when no session exists at all', async () => {
    await expect(steerActiveTurn('ghost', { text: 'hi' })).resolves.toBe('not-steerable');
  });

  it('refuses while a permission prompt is open on that sub-chat', async () => {
    const { finish, done } = await startBusyTurn('c3');
    // A CLI blocked in canUseTool reaches no next model invocation, so a steer could never be read.
    pendingToolApprovals.set('tool-1', { subChatId: 'c3', resolve: () => {} });

    await expect(steerActiveTurn('c3', { text: 'hi' })).resolves.toBe('not-steerable');

    finish();
    await done;
  });

  it('an approval open on a DIFFERENT sub-chat does not block this one', async () => {
    const { finish, done } = await startBusyTurn('c4');
    pendingToolApprovals.set('tool-2', { subChatId: 'someone-else', resolve: () => {} });

    await expect(steerActiveTurn('c4', { text: 'hi' })).resolves.toBe('delivered');

    finish();
    await done;
  });

  // A dropped marker is cosmetic; one attached to a turn the user never steered misreports what the
  // agent was told. The chat lookup is async, so the turn must be pinned before that await.
  it('attributes the marker to the turn that was live when the steer was pushed', async () => {
    emitted.length = 0;
    const { finish, done } = await startBusyTurn('c6');
    const session = getSession('c6');
    if (!session) throw new Error('expected a live session');
    const steeredTurn = { msgId: 'turn-A' } as never;
    session.currentTurn = steeredTurn;

    await expect(steerActiveTurn('c6', { text: 'hi' })).resolves.toBe('delivered');

    expect(emitted).toEqual([{ msgId: 'turn-A' }]);
    finish();
    await done;
  });

  it('drops the marker when the steered turn is replaced during the chat lookup', async () => {
    emitted.length = 0;
    const { finish, done } = await startBusyTurn('c7');
    const session = getSession('c7');
    if (!session) throw new Error('expected a live session');
    session.currentTurn = { msgId: 'turn-A' } as never;

    const pending = steerActiveTurn('c7', { text: 'hi' });
    // The turn ends and the next one starts while the chat lookup is still resolving.
    session.currentTurn = { msgId: 'turn-B' } as never;
    await expect(pending).resolves.toBe('delivered');

    expect(emitted).toEqual([]);
    finish();
    await done;
  });

  // A turn's end clears `busy` but leaves `currentTurn` set, so an identity-only guard would
  // still match the turn that just ended and append the marker to a finalized message.
  it('drops the marker when the steered turn finished during the chat lookup', async () => {
    emitted.length = 0;
    const { finish, done } = await startBusyTurn('c8');
    const session = getSession('c8');
    if (!session) throw new Error('expected a live session');
    const steeredTurn = { msgId: 'turn-A' } as never;
    session.currentTurn = steeredTurn;

    const pending = steerActiveTurn('c8', { text: 'hi' });
    // Turn ends: busy clears, but currentTurn deliberately still points at it.
    session.busy = false;
    await expect(pending).resolves.toBe('delivered');

    expect(emitted).toEqual([]);
    finish();
    await done;
  });

  // A claimed idle session is busy while its permission-mode reconcile awaits, before its prompt is
  // pushed; a steer in that gap would reach the CLI ahead of the prompt it refers to.
  it('refuses while the turn it would join has not pushed its prompt yet', async () => {
    const { query, finish } = heldQuery();
    const session = createSession('c9', () => query);
    const pushSpy = vi.spyOn(session.queue, 'push');
    let reconcile!: (ok: boolean) => void;
    const reconciled = new Promise<boolean>((r) => {
      reconcile = r;
    });
    const prompt = {} as SDKUserMessage;
    const done = runTurn(
      session,
      prompt,
      () => {},
      () => reconciled,
    );

    expect(session.busy).toBe(true);
    await expect(steerActiveTurn('c9', { text: 'hi' })).resolves.toBe('not-steerable');

    reconcile(true);
    await vi.waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    expect(pushSpy.mock.calls[0]?.[0]).toBe(prompt);
    finish();
    await done;
  });
});
