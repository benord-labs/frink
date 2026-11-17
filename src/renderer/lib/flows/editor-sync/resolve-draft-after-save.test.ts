// @vitest-environment happy-dom
// SaveMutation.onSuccess deleted the draft unconditionally, dropping mid-save edits.

import { afterEach, describe, expect, it } from 'vitest';
import { loadFlowDraft } from '../../flow-drafts';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { persistDraftAfterSave, resolveDraftAfterSave } from './resolve-draft-after-save';

const graph = (instructions: string): FlowGraph => ({
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

describe('resolveDraftAfterSave', () => {
  it('drops the draft when the working copy is what was saved', () => {
    expect(
      resolveDraftAfterSave({
        currentGraph: graph('saved'),
        currentGraphToSave: graph('saved'),
        savedGraph: graph('saved'),
        savedVersion: 6,
        now: 1000,
      }),
    ).toBeNull();
  });

  it('compares in save form: a raw working copy that only lacks saved layout is not an edit', () => {
    const raw: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'agent', config: { instructions: 'saved' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };

    expect(
      resolveDraftAfterSave({
        currentGraph: raw,
        currentGraphToSave: graph('saved'),
        savedGraph: graph('saved'),
        savedVersion: 6,
        now: 1000,
      }),
    ).toBeNull();
  });

  it('keeps edits typed during the save, rebased onto the version the save produced', () => {
    const typedDuringSave = graph('typed while saving');

    expect(
      resolveDraftAfterSave({
        currentGraph: typedDuringSave,
        currentGraphToSave: typedDuringSave,
        savedGraph: graph('saved'),
        savedVersion: 6,
        now: 1000,
      }),
    ).toEqual({ graph: typedDuringSave, baselineVersion: 6, updatedAt: 1000 });
  });
});

describe('persistDraftAfterSave', () => {
  afterEach(() => localStorage.clear());

  it('stores the kept draft, and drops it once the working copy matches the save', () => {
    const typed = graph('typed while saving');
    const input = {
      currentGraphToSave: typed,
      savedGraph: graph('saved'),
      savedVersion: 6,
      now: 1000,
    };

    expect(persistDraftAfterSave('flow-1', { ...input, currentGraph: typed })).toBe(true);
    expect(loadFlowDraft('flow-1')).toEqual({ graph: typed, baselineVersion: 6, updatedAt: 1000 });

    expect(
      persistDraftAfterSave('flow-1', { ...input, currentGraph: typed, savedGraph: typed }),
    ).toBe(false);
    expect(loadFlowDraft('flow-1')).toBeNull();
  });
});
