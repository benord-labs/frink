import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc/node';
import { getRuntimeTopologySnapshot } from '../../diagnostics/provider-topology';
import type { CodexAppServerClient } from './app-server-client';
import {
  __resetCodexLiveTurnsForTest,
  clearCodexLiveTurn,
  emitCodexSteerMarker,
  getCodexLiveTurn,
  setCodexLiveTurn,
  steerCodexTurn,
} from './codex-live-turn';

const fakeClient = (
  sendRequest: (m: string, p?: unknown) => Promise<unknown>,
): CodexAppServerClient => ({ sendRequest }) as unknown as CodexAppServerClient;

describe('codex live-turn registry', () => {
  beforeEach(() => __resetCodexLiveTurnsForTest());

  it('clears only when the entry still describes the same turn', () => {
    const client = fakeClient(async () => ({}));
    setCodexLiveTurn('s1', {
      client,
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: () => {},
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });
    expect(getRuntimeTopologySnapshot().codexLiveTurnCount).toBe(1);
    // Turn 2 registered before turn 1 finished tearing down; turn 1's clear must not evict it.
    setCodexLiveTurn('s1', {
      client,
      threadId: 'th1',
      turnId: 'tn2',
      pushChunk: () => {},
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });

    clearCodexLiveTurn('s1', 'tn1');

    expect(getCodexLiveTurn('s1')?.turnId).toBe('tn2');
    clearCodexLiveTurn('s1', 'tn2');
    expect(getCodexLiveTurn('s1')).toBeUndefined();
    expect(getRuntimeTopologySnapshot().codexLiveTurnCount).toBe(0);
  });
});

describe('steerCodexTurn', () => {
  beforeEach(() => __resetCodexLiveTurnsForTest());

  it('sends turn/steer with expectedTurnId as the precondition', async () => {
    const sendRequest = vi.fn(async () => ({ turnId: 'tn1' }));
    setCodexLiveTurn('s1', {
      client: fakeClient(sendRequest),
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: () => {},
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });

    await expect(steerCodexTurn('s1', 'focus the failing tests')).resolves.toBe('delivered');

    expect(sendRequest).toHaveBeenCalledWith('turn/steer', {
      threadId: 'th1',
      expectedTurnId: 'tn1',
      input: [{ type: 'text', text: 'focus the failing tests' }],
    });
  });

  it('reports not-steerable when no turn is registered', async () => {
    await expect(steerCodexTurn('nobody', 'hi')).resolves.toBe('not-steerable');
  });

  it('treats method-not-found as unsupported and stops asking that client', async () => {
    // An older codex binary has no turn/steer. Probing once per client keeps the cost of a stale
    // install at one failed round trip for the session, not one per steer.
    const sendRequest = vi.fn(async () => {
      throw new ResponseError(-32601, 'Method not found');
    });
    const client = fakeClient(sendRequest);
    setCodexLiveTurn('s1', {
      client,
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: () => {},
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });

    await expect(steerCodexTurn('s1', 'a')).resolves.toBe('unsupported');
    await expect(steerCodexTurn('s1', 'b')).resolves.toBe('unsupported');
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('treats a refusal from a live turn as not-steerable, and keeps probing', async () => {
    // Review/compaction turns and turn-id mismatches refuse THIS steer without saying anything
    // about the binary — so the capability must not be poisoned by them.
    const sendRequest = vi.fn(async () => {
      throw new ResponseError(-32600, 'active turn is not steerable');
    });
    setCodexLiveTurn('s1', {
      client: fakeClient(sendRequest),
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: () => {},
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });

    await expect(steerCodexTurn('s1', 'a')).resolves.toBe('not-steerable');
    await expect(steerCodexTurn('s1', 'b')).resolves.toBe('not-steerable');
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('leaves a transcript marker in the turn it joined', async () => {
    const pushed: unknown[] = [];
    setCodexLiveTurn('s1', {
      client: fakeClient(async () => ({})),
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: (c) => pushed.push(c),
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });

    await expect(steerCodexTurn('s1', 'skip the tests')).resolves.toBe('delivered');
    emitCodexSteerMarker('s1', 'tn1', { type: 'tool-input-available' } as never);

    expect(pushed).toHaveLength(1);
  });

  // steerCodexTurn awaits an RPC round trip, so the accepting turn can finish and a successor
  // register before the caller emits. Crediting the successor would misreport what it was told.
  it('never pushes the marker to a SUCCESSOR turn', async () => {
    const pushedA: unknown[] = [];
    const pushedB: unknown[] = [];
    const client = fakeClient(async () => ({}));
    setCodexLiveTurn('s1', {
      client,
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: (c) => pushedA.push(c),
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });

    await expect(steerCodexTurn('s1', 'hi')).resolves.toBe('delivered');
    // turn tn1 ends, tn2 takes over on the same sub-chat
    setCodexLiveTurn('s1', {
      client,
      threadId: 'th1',
      turnId: 'tn2',
      pushChunk: (c) => pushedB.push(c),
      hasOpenApproval: () => false,
      commandOutputs: new Map(),
    });
    emitCodexSteerMarker('s1', 'tn1', { type: 'tool-input-available' } as never);

    expect(pushedA).toEqual([]);
    expect(pushedB).toEqual([]);
  });

  // turn/steer validates only expectedTurnId, so a turn parked on a human decision would accept and
  // buffer a steer nothing can read. Codex approvals never reach Claude's pendingToolApprovals, so
  // the entry carries the runner's own per-turn signal instead.
  it('refuses while the turn is parked on an approval prompt', async () => {
    const sendRequest = vi.fn(async () => ({}));
    let parked = true;
    setCodexLiveTurn('s1', {
      client: fakeClient(sendRequest),
      threadId: 'th1',
      turnId: 'tn1',
      pushChunk: () => {},
      hasOpenApproval: () => parked,
      commandOutputs: new Map(),
    });

    await expect(steerCodexTurn('s1', 'hi')).resolves.toBe('not-steerable');
    expect(sendRequest).not.toHaveBeenCalled();

    parked = false;
    await expect(steerCodexTurn('s1', 'hi')).resolves.toBe('delivered');
  });

  // The signal belongs to ONE turn's entry, so a turn that ended parked (aborted, or the connection
  // closed under it) cannot leave its successor on the same sub-chat wrongly refused.
  it('does not carry a parked approval state into the next turn', async () => {
    const sendRequest = vi.fn(async () => ({}));
    const base = {
      client: fakeClient(sendRequest),
      threadId: 'th1',
      pushChunk: () => {},
      commandOutputs: new Map(),
    };
    setCodexLiveTurn('s1', { ...base, turnId: 'tn1', hasOpenApproval: () => true });
    await expect(steerCodexTurn('s1', 'hi')).resolves.toBe('not-steerable');

    clearCodexLiveTurn('s1', 'tn1');
    setCodexLiveTurn('s1', { ...base, turnId: 'tn2', hasOpenApproval: () => false });
    await expect(steerCodexTurn('s1', 'hi')).resolves.toBe('delivered');
  });
});
