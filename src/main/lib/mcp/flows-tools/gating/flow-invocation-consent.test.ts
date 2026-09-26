import { describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import {
  buildFlowConsentSummary,
  type FlowConsentDecision,
  isBatchAwaitingConsent,
  markBatchAwaitingConsent,
  readFlowConsentDecision,
  releaseBatchConsent,
  requestFlowConsentOnce,
} from './flow-invocation-consent';

function graph(blockTypes: string[]): FlowGraph {
  return {
    nodes: blockTypes.map((blockType, i) => ({ id: `n${i}`, blockType })),
    edges: [],
  } as unknown as FlowGraph;
}

describe('buildFlowConsentSummary', () => {
  it('reports an empty graph rather than throwing, so a card can still render', () => {
    expect(buildFlowConsentSummary(null)).toEqual({
      nodeCount: 0,
      blockTypes: [],
      unsandboxedBlockTypes: [],
    });
  });

  it('dedupes block types while keeping graph order', () => {
    const summary = buildFlowConsentSummary(
      graph(['manual_trigger', 'agent', 'agent', 'run_command', 'agent']),
    );
    expect(summary.blockTypes).toEqual(['manual_trigger', 'agent', 'run_command']);
    expect(summary.nodeCount).toBe(5);
  });

  it('flags first-party shell blocks as unsandboxed', () => {
    const summary = buildFlowConsentSummary(graph(['manual_trigger', 'run_command', 'start_task']));
    expect(summary.unsandboxedBlockTypes).toEqual(['run_command', 'start_task']);
  });

  it('flags an agent node, which runs a coding agent with tool access', () => {
    // A flow of trigger -> agent -> agent would otherwise show a card with no
    // warning at all, despite every action node being able to run commands.
    const summary = buildFlowConsentSummary(graph(['webhook_trigger', 'agent', 'agent']));
    expect(summary.unsandboxedBlockTypes).toEqual(['agent']);
  });

  it('flags an agent-authored custom node as unsandboxed too', () => {
    // A custom node is agent-written JS — the same informed-consent concern as
    // a shell block, and the case a name-only card would hide entirely.
    const summary = buildFlowConsentSummary(graph(['manual_trigger', 'check-new-prs']));
    expect(summary.unsandboxedBlockTypes).toEqual(['check-new-prs']);
  });

  it('leaves a graph with no executing blocks unflagged', () => {
    const summary = buildFlowConsentSummary(graph(['manual_trigger', 'condition', 'end']));
    expect(summary.unsandboxedBlockTypes).toEqual([]);
  });

  it('carries batch magnitude when one is supplied', () => {
    const summary = buildFlowConsentSummary(graph(['manual_trigger']), {
      stageCount: 3,
      pendingRunCount: 120,
    });
    expect(summary.batch).toEqual({ stageCount: 3, pendingRunCount: 120 });
  });

  it('omits the batch field entirely for a single run', () => {
    expect(buildFlowConsentSummary(graph(['manual_trigger']))).not.toHaveProperty('batch');
  });

  it('skips a node whose blockType is missing rather than listing "undefined"', () => {
    // Hand-edited or older graphs can carry such a node; the card is a consent
    // surface, so it must not render a literal "undefined" step.
    const malformed = { nodes: [{ id: 'n0' }, { id: 'n1', blockType: 'agent' }], edges: [] };
    const summary = buildFlowConsentSummary(malformed as unknown as FlowGraph);
    expect(summary.nodeCount).toBe(2);
    expect(summary.blockTypes).toEqual(['agent']);
  });
});

describe('readFlowConsentDecision', () => {
  it('reads an approval with no standing grant as a one-call consent', () => {
    expect(readFlowConsentDecision({ approved: true })).toBe('once');
  });

  it('reads an approval carrying flowGrant as the standing grant', () => {
    expect(readFlowConsentDecision({ approved: true, flowGrant: true })).toBe('always');
  });

  it('reads an explicit refusal as denied', () => {
    expect(readFlowConsentDecision({ approved: false })).toBe('denied');
  });

  it('reads a timed-out card as expired, never as a refusal', () => {
    // The transport settles system-driven cancellations as { approved: false,
    // timedOut: true }. Reading approval first would report a decision the
    // user never made.
    expect(readFlowConsentDecision({ approved: false, timedOut: true })).toBe('expired');
  });

  it('treats a timed-out card as expired even if it somehow carries approval', () => {
    expect(readFlowConsentDecision({ approved: true, timedOut: true })).toBe('expired');
  });
});

describe('requestFlowConsentOnce', () => {
  it('collapses concurrent requests for one flow onto a single card', async () => {
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'always');

    const [a, b] = await Promise.all([
      requestFlowConsentOnce('exec-1', 'flow-1', request),
      requestFlowConsentOnce('exec-1', 'flow-1', request),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(a.decision).toBe('always');
    expect(b.decision).toBe('always');
  });

  it('lets exactly one of the collapsed callers spend a one-call approval', async () => {
    // Two parallel tool calls share ONE card. If both could spend "once", a
    // single click would start two runs — the one-call contract broken by the
    // very dedup that keeps the card from stacking.
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'once');

    const answers = await Promise.all([
      requestFlowConsentOnce('exec-1', 'flow-once', request),
      requestFlowConsentOnce('exec-1', 'flow-once', request),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(answers.map((a) => a.claimOnce())).toEqual([true, false]);
  });

  it('does not spend the approval until a caller claims it', async () => {
    // A caller that discovers its turn went stale must be able to walk away
    // without burning the click.
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'once');

    const first = await requestFlowConsentOnce('exec-1', 'flow-unclaimed', request);
    expect(first.decision).toBe('once');
    // never claimed — a later caller on the same card can still spend it
    const second = await requestFlowConsentOnce('exec-1', 'flow-unclaimed', request);

    expect(second.claimOnce()).toBe(true);
  });

  it('lets every collapsed caller through on a standing grant', async () => {
    // "Always allow this Flow" is a durable right, not a single ticket — there
    // is nothing to ration between concurrent callers.
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'always');

    const answers = await Promise.all([
      requestFlowConsentOnce('exec-1', 'flow-always', request),
      requestFlowConsentOnce('exec-1', 'flow-always', request),
      requestFlowConsentOnce('exec-1', 'flow-always', request),
    ]);

    expect(answers.map((a) => a.decision)).toEqual(['always', 'always', 'always']);
  });

  it('gives every collapsed caller the same refusal', async () => {
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'denied');

    const answers = await Promise.all([
      requestFlowConsentOnce('exec-1', 'flow-denied', request),
      requestFlowConsentOnce('exec-1', 'flow-denied', request),
    ]);

    expect(answers.map((a) => a.decision)).toEqual(['denied', 'denied']);
  });

  it('keeps concurrent requests from different panes independent', async () => {
    // Two chats open on the same flow must each get their own decision —
    // collapsing them would let one pane's answer silently rule the other.
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'once');

    await Promise.all([
      requestFlowConsentOnce('exec-a', 'flow-shared', request),
      requestFlowConsentOnce('exec-b', 'flow-shared', request),
    ]);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent requests for different actions independent', async () => {
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'once');

    await Promise.all([
      requestFlowConsentOnce('exec-1', 'frink_flows_run flow-a', request),
      requestFlowConsentOnce('exec-1', 'frink_flows_start_batch flow-a batch-1', request),
    ]);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('asks again once the previous card has settled', async () => {
    const request = vi.fn(async (): Promise<FlowConsentDecision> => 'denied');

    await requestFlowConsentOnce('exec-1', 'flow-seq', request);
    await requestFlowConsentOnce('exec-1', 'flow-seq', request);

    // The in-flight entry must be released on settle, or a flow could never be
    // asked about twice in one execution.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight entry when the card rejects', async () => {
    const failing = vi.fn(async (): Promise<FlowConsentDecision> => {
      throw new Error('socket down');
    });

    await expect(requestFlowConsentOnce('exec-1', 'flow-err', failing)).rejects.toThrow(
      'socket down',
    );
    await expect(requestFlowConsentOnce('exec-1', 'flow-err', failing)).rejects.toThrow(
      'socket down',
    );

    // A failed card must not poison the key forever.
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('batch consent hold', () => {
  it('holds only the marked batch', () => {
    markBatchAwaitingConsent('batch-1');

    expect(isBatchAwaitingConsent('batch-1')).toBe(true);
    expect(isBatchAwaitingConsent('batch-other')).toBe(false);

    releaseBatchConsent('batch-1');
    expect(isBatchAwaitingConsent('batch-1')).toBe(false);
  });

  it('is independent of the card, so the hold can outlive the click', async () => {
    // Dispatch re-reads the pending stages AFTER the card settles, so tying
    // the hold to the card's lifetime would reopen the growth window.
    markBatchAwaitingConsent('batch-live');
    await requestFlowConsentOnce('exec-1', 'action', async () => 'once');

    expect(isBatchAwaitingConsent('batch-live')).toBe(true);
    releaseBatchConsent('batch-live');
  });

  it('stays held until every concurrent caller has released it', () => {
    // Two callers share one card. The one that loses the single-use claim must
    // not drop the hold while the winner is still dispatching.
    markBatchAwaitingConsent('batch-shared');
    markBatchAwaitingConsent('batch-shared');

    releaseBatchConsent('batch-shared');
    expect(isBatchAwaitingConsent('batch-shared')).toBe(true);

    releaseBatchConsent('batch-shared');
    expect(isBatchAwaitingConsent('batch-shared')).toBe(false);
  });

  it('does not go negative when released more than it was held', () => {
    markBatchAwaitingConsent('batch-x');
    releaseBatchConsent('batch-x');
    releaseBatchConsent('batch-x');
    markBatchAwaitingConsent('batch-x');

    expect(isBatchAwaitingConsent('batch-x')).toBe(true);
    releaseBatchConsent('batch-x');
    expect(isBatchAwaitingConsent('batch-x')).toBe(false);
  });

  it('releasing a batch that was never held is harmless', () => {
    releaseBatchConsent('never-held');
    expect(isBatchAwaitingConsent('never-held')).toBe(false);
  });
});
