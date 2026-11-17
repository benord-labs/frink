import { describe, expect, it, vi } from 'vitest';
import {
  batchStartedMessage,
  dispatchFlowRun,
  editorRunBlocker,
  runStartedMessage,
  savedVersionRunBlocker,
} from './flow-run-dispatch';

function handlers() {
  return { startBatch: vi.fn(), runSingle: vi.fn() };
}

describe('dispatchFlowRun', () => {
  it('routes a current batch to startBatch (never a context-less single run)', () => {
    const h = handlers();
    dispatchFlowRun('batch-123', h);
    expect(h.startBatch).toHaveBeenCalledExactlyOnceWith('batch-123', false);
    expect(h.runSingle).not.toHaveBeenCalled();
  });

  it('routes a non-batch flow (null) to a single run', () => {
    const h = handlers();
    dispatchFlowRun(null, h);
    expect(h.runSingle).toHaveBeenCalledOnce();
    expect(h.startBatch).not.toHaveBeenCalled();
  });

  it('treats an empty-string batch id as no batch — single run, not startBatch("")', () => {
    const h = handlers();
    dispatchFlowRun('', h);
    expect(h.runSingle).toHaveBeenCalledOnce();
    expect(h.startBatch).not.toHaveBeenCalled();
  });

  it('treats undefined as no batch — single run', () => {
    const h = handlers();
    dispatchFlowRun(undefined, h);
    expect(h.runSingle).toHaveBeenCalledOnce();
    expect(h.startBatch).not.toHaveBeenCalled();
  });
});

describe('dispatchFlowRun — unsaved canvas edits', () => {
  it('forwards the dirty flag to a single run', () => {
    const h = handlers();
    dispatchFlowRun(null, h, true);
    expect(h.runSingle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('forwards the dirty flag to a batch start', () => {
    const h = handlers();
    dispatchFlowRun('batch-1', h, true);
    expect(h.startBatch).toHaveBeenCalledExactlyOnceWith('batch-1', true);
  });

  it('defaults to a clean canvas when no flag is given', () => {
    const h = handlers();
    dispatchFlowRun(null, h);
    expect(h.runSingle).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe('batchStartedMessage', () => {
  it('keeps the plain copy for a clean editor', () => {
    expect(batchStartedMessage(false)).toBe('Batch started');
  });

  it('says the unsaved edits are not included when dirty', () => {
    expect(batchStartedMessage(true)).toBe(
      "Batch started on the saved version — your unsaved edits aren't included",
    );
  });
});

describe('runStartedMessage', () => {
  it('keeps the plain copy for a clean editor (no new friction on the common path)', () => {
    expect(
      runStartedMessage({ status: 'running', versionNumber: 5, hadUnsavedChanges: false }),
    ).toBe('Run started');
    expect(
      runStartedMessage({ status: 'pending', versionNumber: 5, hadUnsavedChanges: false }),
    ).toBe('Run queued');
  });

  it('names the executed saved version when the canvas had unsaved edits', () => {
    expect(
      runStartedMessage({ status: 'running', versionNumber: 5, hadUnsavedChanges: true }),
    ).toBe("Run started on saved v5 — your unsaved edits aren't included");
    expect(
      runStartedMessage({ status: 'pending', versionNumber: 2, hadUnsavedChanges: true }),
    ).toBe("Run queued on saved v2 — your unsaved edits aren't included");
  });

  it('still warns about unsaved edits when the version number is unknown', () => {
    expect(
      runStartedMessage({ status: 'running', versionNumber: undefined, hadUnsavedChanges: true }),
    ).toBe("Run started on the saved version — your unsaved edits aren't included");
  });
});

describe('savedVersionRunBlocker', () => {
  const predicate = { field: 'exitCode', operator: 'eq', value: 0 };
  const loopGraph = (closed: boolean) => ({
    nodes: [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'c1', blockType: 'condition', label: 'First', config: { predicate } },
      { id: 'c2', blockType: 'condition', label: 'Second', config: { predicate } },
      { id: 'x', blockType: 'run_command', config: { projectId: 'p1', command: 'echo x' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'c2', sourceHandle: 'false' },
      ...(closed ? [{ id: 'e3', source: 'c2', target: 'c1', sourceHandle: 'false' }] : []),
      { id: 'e4', source: 'c1', target: 'x', sourceHandle: 'true' },
      { id: 'e5', source: 'c2', target: 'x', sourceHandle: 'true' },
    ],
  });

  // Run executes the saved version, so the saved graph — not the draft — decides the block.
  it('blocks when the saved version has a condition-only loop', () => {
    expect(savedVersionRunBlocker(loopGraph(true))).toBe(
      'Condition-only loop "First" → "Second" has no step inside it, so it can loop forever — add a step inside the loop',
    );
  });

  it('allows a saved version without one', () => {
    expect(savedVersionRunBlocker(loopGraph(false))).toBeNull();
  });

  // The editor passes [graph it just saved, server graph]: either may be the version Run executes
  // (our save lands before the refetch; an MCP save elsewhere is not adopted over local edits).
  it.each([
    ['our just-saved graph', [loopGraph(true), loopGraph(false)]],
    ['the server graph', [loopGraph(false), loopGraph(true)]],
  ])('blocks when only %s has the loop', (_label, candidates) => {
    expect(savedVersionRunBlocker(...candidates)).toContain('Condition-only loop');
  });

  it.each([
    ['not loaded yet', undefined],
    ['malformed', { nodes: 'nope' }],
    ['holding a null node', { nodes: [{ id: 't', blockType: 'manual_trigger' }, null], edges: [] }],
    ['holding a null edge', { nodes: [{ id: 't', blockType: 'manual_trigger' }], edges: [null] }],
  ])('does not block when the saved graph is %s, leaving the server to decide', (_label, raw) => {
    expect(savedVersionRunBlocker(raw)).toBeNull();
  });
});

describe('editorRunBlocker', () => {
  const ready = { hasManualTrigger: true, baselineVersion: 3, flowEnabled: true, savedGraphs: [] };
  const stuckSaved = {
    nodes: [
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'c',
        blockType: 'condition',
        label: 'Check',
        config: { predicate: { field: 'ok', operator: 'truthy' } },
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'c' },
      { id: 'e2', source: 'c', target: 'c', sourceHandle: 'false' },
    ],
  };

  it('lets a saved, enabled, manually triggered flow run', () => {
    expect(editorRunBlocker(ready)).toBeNull();
  });

  // Preserves the toasts the Run button showed before the checks moved here.
  it.each([
    [
      { hasManualTrigger: false },
      'Run is only available for flows that start with a manual trigger.',
    ],
    [{ baselineVersion: 0 }, 'Save your flow before running.'],
    [
      { flowEnabled: false },
      'This flow is paused. Enable it in Flow settings or the flows list to run.',
    ],
  ])('blocks %o with its existing message', (override, message) => {
    expect(editorRunBlocker({ ...ready, ...override })).toBe(message);
  });

  it('blocks a saved version that holds a stuck condition loop', () => {
    expect(editorRunBlocker({ ...ready, savedGraphs: [stuckSaved] })).toContain(
      'Condition "Check" loops back to itself',
    );
  });

  it('names the missing save before the stuck loop, since there is no saved version yet', () => {
    expect(editorRunBlocker({ ...ready, baselineVersion: 0, savedGraphs: [stuckSaved] })).toBe(
      'Save your flow before running.',
    );
  });
});
