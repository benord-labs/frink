import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { CODEX_SUBAGENT_TOOL_NAME } from '../../../shared/subagent-parts';
import { mapNotificationToChunks } from '../agent-runner/codex/codex-events';
import type { UIMessageChunk } from '../claude/types';
import {
  adoptHeldExecution,
  applyChunkToParts,
  type ClaudeTurnExecution,
  createClaudeTurnContext,
  createPartsState,
  createWakeBurstTurn,
  notePreplanSignal,
  partsSnapshot,
  sessionIdFromFrame,
} from './claude-turn-context';

/** Drive a whole codex notification through the mapper into the reducer, as the runner does. */
function applyNotification(
  state: ReturnType<typeof createPartsState>,
  method: string,
  params: Record<string, unknown>,
): void {
  for (const chunk of mapNotificationToChunks(method, params)) applyChunkToParts(state, chunk);
}

/**
 * The chunk -> MessagePart reducer, tested at the sink rather than through the executor.
 *
 * These pin the open/close contract every producer depends on. The codex mapper in particular
 * must emit an opening chunk pair even on a completion, because some codex ThreadItem variants
 * are emitted upstream only as item/completed — and an output for a card that was never opened is
 * dropped here, silently.
 */
describe('applyChunkToParts tool-card lifecycle', () => {
  it('drops an output whose tool card was never opened', () => {
    // The reason a producer must open a card before closing it. Codex emits some items ONLY as
    // item/completed (subAgentActivity), so an output-only mapping would render nothing at all —
    // this is the sink that silently swallows it.
    const state = createPartsState();
    applyChunkToParts(state, {
      type: 'tool-output-available',
      toolCallId: 'never-opened',
      output: { ok: true },
    } as UIMessageChunk);
    expect(partsSnapshot(state)).toEqual([]);
  });

  it('renders one settled card when an opening triple and its output arrive together', () => {
    // The completed-only path: input-start + input-available + output-available in one burst must
    // produce exactly one card in a terminal state, not a duplicate and not a stuck pending one.
    const state = createPartsState();
    for (const chunk of [
      { type: 'tool-input-start', toolCallId: 's1', toolName: 'CodexSubagent' },
      {
        type: 'tool-input-available',
        toolCallId: 's1',
        toolName: 'CodexSubagent',
        input: { a: 1 },
      },
      { type: 'tool-output-available', toolCallId: 's1', output: { ok: true } },
    ] as UIMessageChunk[]) {
      applyChunkToParts(state, chunk);
    }
    const toolParts = partsSnapshot(state).filter((p) => p.type === 'tool-CodexSubagent');
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toMatchObject({ state: 'output-available', input: { a: 1 } });
  });

  it('does not downgrade a settled card when its input chunk is replayed', () => {
    // A normally-started item gets its input re-sent on completion. That must update the open card
    // rather than reopening it, or every codex tool card would flicker back to pending at the end.
    const state = createPartsState();
    for (const chunk of [
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
      { type: 'tool-output-available', toolCallId: 'c1', output: { exitCode: 0 } },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    ] as UIMessageChunk[]) {
      applyChunkToParts(state, chunk);
    }
    const toolParts = partsSnapshot(state).filter((p) => p.type === 'tool-Bash');
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].state).toBe('output-available');
  });
});

/**
 * The mapper and the reducer wired together, which is where a writer/reader mismatch actually bites:
 * each side can be individually correct while the part that reaches the renderer is not what the
 * card expects. The renderer half of each contract is pinned in agent-tool-registry.test.ts against
 * the same shared constant, so the two halves cannot drift apart silently.
 */
describe('codex notifications through to rendered parts', () => {
  it('produces a subagent-shaped part a collab job card will claim', () => {
    const state = createPartsState();
    applyNotification(state, 'item/started', {
      startedAtMs: 1_700_000_000_000,
      item: {
        type: 'collabAgentToolCall',
        id: 'c1',
        tool: 'wait',
        status: 'inProgress',
        receiverThreadIds: ['a', 'b'],
      },
    });

    const [part] = partsSnapshot(state).filter((p) => p.toolCallId === 'c1');
    // The part type is what routes it to the subagent card rather than the generic one.
    expect(part.type).toBe(`tool-${CODEX_SUBAGENT_TOOL_NAME}`);
    expect(part.state).toBe('input-available');
    // description feeds the card's subtitle, startedAt feeds its elapsed timer.
    expect(part.input).toMatchObject({
      description: 'Waiting on agents (2)',
      startedAt: 1_700_000_000_000,
    });
  });

  it('lands a failed collab job in the error state the card reads', () => {
    // The defect this pins: signalling failure inside the output payload left the part in `result`
    // with no errorText, so a failed subagent job rendered as a completed one.
    const state = createPartsState();
    applyNotification(state, 'item/started', {
      startedAtMs: 1_700_000_000_000,
      item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'inProgress' },
    });
    applyNotification(state, 'item/completed', {
      completedAtMs: 1_700_000_005_000,
      item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'failed' },
    });

    const parts = partsSnapshot(state).filter((p) => p.toolCallId === 'c1');
    expect(parts).toHaveLength(1);
    expect(parts[0].state).toBe('output-error');
    expect(parts[0].errorText).toBe('Spawning agent failed');
  });

  it('renders a completed-only subagent marker that never had a start event', () => {
    // subAgentActivity arrives upstream as item/completed alone. End to end, that must still leave
    // a part behind — the reducer drops an output for a card it never opened.
    const state = createPartsState();
    applyNotification(state, 'item/completed', {
      completedAtMs: 1_700_000_000_000,
      item: { type: 'subAgentActivity', id: 's1', kind: 'started', agentPath: '.codex/design.md' },
    });

    const [part] = partsSnapshot(state).filter((p) => p.toolCallId === 's1');
    expect(part).toBeDefined();
    expect(part.type).toBe('tool-SubagentStarted');
    expect(part.state).toBe('output-available');
  });

  it('keeps concurrent jobs apart when their events interleave', () => {
    // A codex turn runs several jobs at once and their notifications arrive interleaved. Cards are
    // keyed by item id, so an out-of-order completion must settle its own card and no other.
    const state = createPartsState();
    const imageItem = { type: 'imageGeneration', id: 'img', status: 'inProgress' };
    const collabItem = { type: 'collabAgentToolCall', id: 'col', tool: 'wait' };

    applyNotification(state, 'item/started', { startedAtMs: 1_000, item: imageItem });
    applyNotification(state, 'item/started', { startedAtMs: 2_000, item: collabItem });
    // Second job finishes first.
    applyNotification(state, 'item/completed', {
      completedAtMs: 3_000,
      item: { ...collabItem, status: 'completed' },
    });

    const byId = Object.fromEntries(
      partsSnapshot(state)
        .filter((p) => p.toolCallId)
        .map((p) => [p.toolCallId, p]),
    );
    expect(Object.keys(byId).sort()).toEqual(['col', 'img']);
    expect(byId.col.state).toBe('output-available');
    // The still-running job must NOT have been settled by its neighbour's completion.
    expect(byId.img.state).toBe('input-available');

    applyNotification(state, 'item/completed', {
      completedAtMs: 4_000,
      item: { ...imageItem, status: 'completed', savedPath: '/tmp/a.png' },
    });
    expect(partsSnapshot(state).find((p) => p.toolCallId === 'img')?.state).toBe(
      'output-available',
    );
  });
});

describe('createWakeBurstTurn', () => {
  const armingTurn = () => {
    let halted = false;
    const arming = createClaudeTurnContext();
    arming.planSubmissionHalt = () => halted;
    arming.setPlanSubmissionHalt = () => {
      halted = true;
    };
    return arming;
  };
  const burstOf = (arming: ReturnType<typeof armingTurn>) =>
    createWakeBurstTurn(arming, {
      msgId: 'msg-1',
      chunks: [],
      nextMessageIndex: () => 1,
      autoReviewTools: false,
      waitForExecutionSettlement: async () => {},
    });

  it('reads the halt live, so a burst created before the plan was carded still sees it', () => {
    // A snapshot boolean here would let the burst after a submission run tools unapproved.
    const arming = armingTurn();
    const burst = burstOf(arming);
    expect(burst.planSubmissionHalt()).toBe(false);

    arming.setPlanSubmissionHalt();

    expect(burst.planSubmissionHalt()).toBe(true);
  });

  it('raises the halt on the arming turn, so it outlives the burst that carded the plan', () => {
    const arming = armingTurn();
    const burst = burstOf(arming);

    burst.setPlanSubmissionHalt();

    expect(arming.planSubmissionHalt()).toBe(true);
    expect(burstOf(arming).planSubmissionHalt()).toBe(true);
  });

  it('carries the plan locks and marks itself a burst', () => {
    const arming = armingTurn();
    arming.planTerminalsLocked = true;
    arming.planAutoReview = true;

    const burst = burstOf(arming);

    expect(burst.planTerminalsLocked).toBe(true);
    expect(burst.planAutoReview).toBe(true);
    expect(burst.isWakeBurst).toBe(true);
    // Its own map: hook denials from THIS burst are what the burst-end backfill and the plan
    // submission detector read.
    expect(burst.deniedToolIdsWithMessages).not.toBe(arming.deniedToolIdsWithMessages);
  });

  it('carries the pre-plan park, so a burst after the plan still refuses only that stale signal', () => {
    // Without it, a post-plan burst would either settle on the drafting park or chase a genuine
    // fresh one.
    const arming = armingTurn();
    const park = { state: 'awaiting_input' as const, summary: 'Which API?', at: 'now' };
    notePreplanSignal(arming, park);
    arming.planSubmitted = true;

    const burst = burstOf(arming);

    expect(burst.planSubmitted).toBe(true);
    expect(burst.preplanSignal).toBe(park);
  });

  it("runs under the arming turn's execution, so a burst's signal and questions stay its own", () => {
    const arming = armingTurn();
    expect(burstOf(arming).execution).toBe(arming.execution);
  });
});

describe('notePreplanSignal', () => {
  it('keeps the drafting park on record as ExitPlanMode is requested', () => {
    const turn = createClaudeTurnContext();
    expect(turn.preplanSignal).toBeNull();
    const park = { state: 'awaiting_input' as const, summary: 'q', at: 'now' };

    notePreplanSignal(turn, park);

    expect(turn.preplanSignal).toBe(park);
  });

  it('never snapshots a terminal: only a drafting park can be stale', () => {
    // An agent-mode `done` before a mid-turn EnterPlanMode is finished work; snapshotting it would
    // make the Stop hook chase it.
    const turn = createClaudeTurnContext();
    notePreplanSignal(turn, { state: 'done', summary: 'shipped', at: 'now' });
    expect(turn.preplanSignal).toBeNull();
  });

  it('a repeated request replaces the snapshot, so it tracks the submission that landed', () => {
    // Keeping the first park would let the second, equally stale, park settle the turn.
    const turn = createClaudeTurnContext();
    notePreplanSignal(turn, { state: 'awaiting_input', summary: 'first', at: 'now' });
    const second = { state: 'awaiting_input' as const, summary: 'second', at: 'now' };
    notePreplanSignal(turn, second);
    expect(turn.preplanSignal).toBe(second);
    notePreplanSignal(turn, undefined);
    expect(turn.preplanSignal).toBeNull();
  });
});

describe('adoptHeldExecution', () => {
  const execution = (over: Partial<ClaudeTurnExecution>): ClaudeTurnExecution => ({
    ...createClaudeTurnContext().execution,
    ...over,
  });

  it('keeps every binding of its own execute, its MCP context included', () => {
    const own = execution({
      executionContextId: 'ctx-own',
      signalTaskId: 'task-own',
      isFlowTurn: true,
      isPlanMode: true,
      flowPlanAutoApprove: true,
    });
    const held = execution({ executionContextId: 'ctx-held', signalTaskId: 'task-held' });

    expect(adoptHeldExecution(own, held)).toEqual(own);
  });

  it.each([true, false])("takes the held session's signal-tool mount, not its own (%s)", (on) => {
    const [own, held] = [!on, on].map((taskSignalReady) => execution({ taskSignalReady }));
    expect(adoptHeldExecution(own, held).taskSignalReady).toBe(on);
  });
});

describe('sessionIdFromFrame', () => {
  // SAFETY: the helper reads only `session_id`; no other SDKMessage field is touched.
  const frame = (sessionId: string) => ({ type: 'system', session_id: sessionId }) as SDKMessage;
  // SAFETY: a start chunk carrying message metadata is a member of the UIMessageChunk union.
  const chunk = { type: 'start', messageMetadata: { sessionId: 'from-chunk' } } as UIMessageChunk;

  it('prefers the raw frame session_id over the chunk metadata', () => {
    expect(sessionIdFromFrame(frame('from-frame'), chunk)).toBe('from-frame');
  });

  it('falls back to the chunk when the frame id is empty, and to null with no id anywhere', () => {
    expect(sessionIdFromFrame(frame(''), chunk)).toBe('from-chunk');
    // SAFETY: a bare start chunk is a member of the UIMessageChunk union.
    expect(sessionIdFromFrame(frame(''), { type: 'start' } as UIMessageChunk)).toBeNull();
  });
});
