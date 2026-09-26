// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../shared/lib/validate-flow-graph';
import {
  deleteFlowDraft,
  type FlowGraphDraft,
  loadFlowDraft,
  loadFlowDraftIds,
  saveFlowDraft,
} from './flow-drafts';

const STORAGE_KEY = 'flow-graph-drafts';

function makeGraph(extra?: Record<string, unknown>): FlowGraph {
  return { nodes: [], edges: [], ...extra } as unknown as FlowGraph;
}

function makeDraft(overrides?: Partial<FlowGraphDraft>): FlowGraphDraft {
  return { graph: makeGraph(), baselineVersion: 1, updatedAt: 1000, ...overrides };
}

describe('flow-drafts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips graph + baselineVersion + updatedAt', () => {
    const draft = makeDraft({ baselineVersion: 7, updatedAt: 42 });
    saveFlowDraft('flow-a', draft);
    expect(loadFlowDraft('flow-a')).toEqual(draft);
  });

  it('returns null for an unknown flowId', () => {
    saveFlowDraft('flow-a', makeDraft());
    expect(loadFlowDraft('flow-b')).toBeNull();
  });

  it('returns null (no throw) for corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(() => loadFlowDraft('flow-a')).not.toThrow();
    expect(loadFlowDraft('flow-a')).toBeNull();
  });

  it('deletes only the target flowId, leaving others intact', () => {
    saveFlowDraft('flow-a', makeDraft({ baselineVersion: 1 }));
    saveFlowDraft('flow-b', makeDraft({ baselineVersion: 2 }));
    deleteFlowDraft('flow-a');
    expect(loadFlowDraft('flow-a')).toBeNull();
    expect(loadFlowDraft('flow-b')?.baselineVersion).toBe(2);
  });

  it('keeps multiple flowIds in the single-key map', () => {
    saveFlowDraft('flow-a', makeDraft({ baselineVersion: 1 }));
    saveFlowDraft('flow-b', makeDraft({ baselineVersion: 2 }));
    expect(loadFlowDraft('flow-a')?.baselineVersion).toBe(1);
    expect(loadFlowDraft('flow-b')?.baselineVersion).toBe(2);
  });

  it('loadFlowDraftIds returns the set of flowIds with drafts, and reflects deletes', () => {
    expect(loadFlowDraftIds()).toEqual(new Set());
    saveFlowDraft('flow-a', makeDraft());
    saveFlowDraft('flow-b', makeDraft());
    expect(loadFlowDraftIds()).toEqual(new Set(['flow-a', 'flow-b']));
    deleteFlowDraft('flow-a');
    expect(loadFlowDraftIds()).toEqual(new Set(['flow-b']));
  });

  it('rejects an over-limit write without corrupting the existing map', () => {
    const existing = makeDraft({ baselineVersion: 5 });
    saveFlowDraft('flow-a', existing);

    // > 2MB payload (UTF-16: ~1.5M chars ≈ 3MB) must be rejected silently.
    const huge = makeDraft({ graph: makeGraph({ filler: 'x'.repeat(1_500_000) }) });
    expect(() => saveFlowDraft('flow-b', huge)).not.toThrow();

    expect(loadFlowDraft('flow-b')).toBeNull();
    expect(loadFlowDraft('flow-a')).toEqual(existing); // untouched
  });

  it('overwrites the same flowId in place (autosave path) without accumulating entries', () => {
    saveFlowDraft('flow-a', makeDraft({ baselineVersion: 1, updatedAt: 100 }));
    saveFlowDraft('flow-a', makeDraft({ baselineVersion: 1, updatedAt: 200 }));
    saveFlowDraft('flow-a', makeDraft({ baselineVersion: 1, updatedAt: 300 }));

    expect(loadFlowDraft('flow-a')?.updatedAt).toBe(300);
    expect(Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))).toEqual(['flow-a']);
  });

  it('stays usable after an over-limit rejection: a later in-budget write still succeeds', () => {
    saveFlowDraft('flow-a', makeDraft({ baselineVersion: 1 }));
    saveFlowDraft('flow-b', makeDraft({ graph: makeGraph({ filler: 'x'.repeat(1_500_000) }) }));
    expect(loadFlowDraft('flow-b')).toBeNull(); // rejected

    saveFlowDraft('flow-c', makeDraft({ baselineVersion: 9 }));
    expect(loadFlowDraft('flow-c')?.baselineVersion).toBe(9);
    expect(loadFlowDraft('flow-a')?.baselineVersion).toBe(1);
  });
});
