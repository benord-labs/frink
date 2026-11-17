// @vitest-environment happy-dom
// Server schema changes apply only while the working copy has no unsaved edits, and never mark it edited.

import { renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { useBatchTriggerSchemaSync } from './useBatchTriggerSchemaSync';

const SERVER_SCHEMA = [{ key: 'ticketId', type: 'string' as const }];
const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

// ---------------------------------------------------------------------------
// Test 1 — apply-schema
// ---------------------------------------------------------------------------

describe('useBatchTriggerSchemaSync — apply-schema', () => {
  it('calls setGraph when hydrated, not dirty, and schemas differ', () => {
    const setGraph = vi.fn();

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    expect(setGraph).toHaveBeenCalledOnce();
  });

  it('updater writes serverBatchTriggerSchema into graph settings', () => {
    const setGraph = vi.fn();

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    const updater = setGraph.mock.calls[0][0] as (prev: FlowGraph) => FlowGraph;
    const updated = updater(EMPTY_GRAPH);
    expect(updated.settings?.batchTriggerSchema).toEqual(SERVER_SCHEMA);
  });

  it('does not call setGraph when schemas already match', () => {
    const setGraph = vi.fn();
    const graphWithSchema: FlowGraph = {
      nodes: [],
      edges: [],
      settings: { batchTriggerSchema: SERVER_SCHEMA },
    };

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: graphWithSchema,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    expect(setGraph).not.toHaveBeenCalled();
  });

  it('does not call setGraph when not yet hydrated', () => {
    const setGraph = vi.fn();

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: false,
        modified: false,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    expect(setGraph).not.toHaveBeenCalled();
  });

  it('EC-1: removes batchTriggerSchema from settings when server schema becomes empty array', () => {
    const setGraph = vi.fn();
    const graphWithSchema: FlowGraph = {
      nodes: [],
      edges: [],
      settings: { batchTriggerSchema: SERVER_SCHEMA },
    };

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: graphWithSchema,
        setGraph,
        serverBatchTriggerSchema: [],
      }),
    );

    expect(setGraph).toHaveBeenCalledOnce();
    const updater = setGraph.mock.calls[0][0] as (prev: FlowGraph) => FlowGraph;
    const updated = updater(graphWithSchema);
    expect(updated.settings?.batchTriggerSchema).toBeUndefined();
  });

  it('EC-2: removes batchTriggerSchema from settings when server schema becomes undefined', () => {
    const setGraph = vi.fn();
    const graphWithSchema: FlowGraph = {
      nodes: [],
      edges: [],
      settings: { batchTriggerSchema: SERVER_SCHEMA },
    };

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: graphWithSchema,
        setGraph,
        serverBatchTriggerSchema: undefined,
      }),
    );

    expect(setGraph).toHaveBeenCalledOnce();
    const updater = setGraph.mock.calls[0][0] as (prev: FlowGraph) => FlowGraph;
    const updated = updater(graphWithSchema);
    expect(updated.settings?.batchTriggerSchema).toBeUndefined();
  });

  it('EC-3: re-applies when serverBatchTriggerSchema changes between renders (polling scenario)', () => {
    const setGraph = vi.fn();
    const schema2 = [{ key: 'workstreamId', type: 'string' as const }];
    const graphWithSchema1: FlowGraph = {
      nodes: [],
      edges: [],
      settings: { batchTriggerSchema: SERVER_SCHEMA },
    };

    const { rerender } = renderHook(
      ({ serverSchema }: { serverSchema: typeof SERVER_SCHEMA }) =>
        useBatchTriggerSchemaSync({
          hydrated: true,
          modified: false,
          graph: graphWithSchema1,
          setGraph,
          serverBatchTriggerSchema: serverSchema,
        }),
      { initialProps: { serverSchema: SERVER_SCHEMA } },
    );

    // Schemas match initially — no call
    expect(setGraph).not.toHaveBeenCalled();

    // Server returns a new schema (e.g. after 30s poll)
    rerender({ serverSchema: schema2 });

    expect(setGraph).toHaveBeenCalledOnce();
    const updater = setGraph.mock.calls[0][0] as (prev: FlowGraph) => FlowGraph;
    const updated = updater(graphWithSchema1);
    expect(updated.settings?.batchTriggerSchema).toEqual(schema2);
  });

  it('EC-4: preserves other FlowSettings fields when applying batchTriggerSchema', () => {
    const setGraph = vi.fn();
    const graphWithOtherSettings: FlowGraph = {
      nodes: [],
      edges: [],
      settings: { briefing: 'Use TypeScript', defaultModel: 'claude-sonnet-4-5' },
    };

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: graphWithOtherSettings,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    expect(setGraph).toHaveBeenCalledOnce();
    const updater = setGraph.mock.calls[0][0] as (prev: FlowGraph) => FlowGraph;
    const updated = updater(graphWithOtherSettings);
    expect(updated.settings?.batchTriggerSchema).toEqual(SERVER_SCHEMA);
    expect(updated.settings?.briefing).toBe('Use TypeScript');
    expect(updated.settings?.defaultModel).toBe('claude-sonnet-4-5');
  });

  it('EC-6: no-op when both local and server schemas are undefined (initial state)', () => {
    const setGraph = vi.fn();

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: false,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: undefined,
      }),
    );

    expect(setGraph).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — modified guard
// ---------------------------------------------------------------------------

describe('useBatchTriggerSchemaSync — modified guard', () => {
  it('does NOT call setGraph when modified=true even with mismatched schemas', () => {
    const setGraph = vi.fn();

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        modified: true,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    expect(setGraph).not.toHaveBeenCalled();
  });

  it('EC-5: fires when modified transitions true→false while schemas differ (save-then-sync)', () => {
    const setGraph = vi.fn();

    const { rerender } = renderHook(
      ({ modified }: { modified: boolean }) =>
        useBatchTriggerSchemaSync({
          hydrated: true,
          modified,
          graph: EMPTY_GRAPH,
          setGraph,
          serverBatchTriggerSchema: SERVER_SCHEMA,
        }),
      { initialProps: { modified: true } },
    );

    expect(setGraph).not.toHaveBeenCalled();

    rerender({ modified: false });

    expect(setGraph).toHaveBeenCalledOnce();
    const updater = setGraph.mock.calls[0][0] as (prev: FlowGraph) => FlowGraph;
    const updated = updater(EMPTY_GRAPH);
    expect(updated.settings?.batchTriggerSchema).toEqual(SERVER_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — no-dirty marking
// ---------------------------------------------------------------------------

describe('useBatchTriggerSchemaSync — no-dirty marking', () => {
  it('modified remains false after setGraph fires (hook uses raw setter, not updateGraph)', () => {
    function useHarness() {
      const [graph, setGraph] = useState<FlowGraph>(EMPTY_GRAPH);
      const [modified] = useState(false);

      useBatchTriggerSchemaSync({
        hydrated: true,
        modified,
        graph,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      });

      return { graph, modified };
    }

    const { result } = renderHook(() => useHarness());

    expect(result.current.graph.settings?.batchTriggerSchema).toEqual(SERVER_SCHEMA);
    expect(result.current.modified).toBe(false);
  });
});
