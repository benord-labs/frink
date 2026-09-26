// @vitest-environment happy-dom
/**
 * useBatchTriggerSchemaSync — three required behaviours (sc-660) + edge cases:
 *
 * 1. apply-schema   — when hydrated + not dirty + schemas differ → setGraph is called
 *                     and the updater writes batchTriggerSchema into settings.
 * 2. isDirty guard  — when isDirty=true, setGraph is NOT called even when schemas differ.
 * 3. no-dirty mark  — after the effect fires, isDirty remains false (the hook calls the
 *                     raw setGraph setter, not updateGraph, so setDirtyGlobal is never triggered).
 *
 * Edge cases (EC-1 … EC-6):
 *  EC-1  Server schema becomes []        → local batchTriggerSchema is deleted
 *  EC-2  Server schema becomes undefined → local batchTriggerSchema is deleted
 *  EC-3  serverBatchTriggerSchema changes between renders → effect re-fires (polling scenario)
 *  EC-4  Other FlowSettings fields are preserved when batchTriggerSchema is applied
 *  EC-5  isDirty transitions true→false while schemas differ → effect fires on transition
 *  EC-6  Both local and server are undefined (initial state) → no-op
 */

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
        isDirty: false,
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
        isDirty: false,
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
        isDirty: false,
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
        isDirty: false,
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
        isDirty: false,
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
        isDirty: false,
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
          isDirty: false,
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
        isDirty: false,
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
        isDirty: false,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: undefined,
      }),
    );

    expect(setGraph).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — isDirty guard
// ---------------------------------------------------------------------------

describe('useBatchTriggerSchemaSync — isDirty guard', () => {
  it('does NOT call setGraph when isDirty=true even with mismatched schemas', () => {
    const setGraph = vi.fn();

    renderHook(() =>
      useBatchTriggerSchemaSync({
        hydrated: true,
        isDirty: true,
        graph: EMPTY_GRAPH,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      }),
    );

    expect(setGraph).not.toHaveBeenCalled();
  });

  it('EC-5: fires when isDirty transitions true→false while schemas differ (save-then-sync)', () => {
    const setGraph = vi.fn();

    const { rerender } = renderHook(
      ({ isDirty }: { isDirty: boolean }) =>
        useBatchTriggerSchemaSync({
          hydrated: true,
          isDirty,
          graph: EMPTY_GRAPH,
          setGraph,
          serverBatchTriggerSchema: SERVER_SCHEMA,
        }),
      { initialProps: { isDirty: true } },
    );

    expect(setGraph).not.toHaveBeenCalled();

    rerender({ isDirty: false });

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
  it('isDirty remains false after setGraph fires (hook uses raw setter, not updateGraph)', () => {
    function useHarness() {
      const [graph, setGraph] = useState<FlowGraph>(EMPTY_GRAPH);
      const [isDirty] = useState(false);

      useBatchTriggerSchemaSync({
        hydrated: true,
        isDirty,
        graph,
        setGraph,
        serverBatchTriggerSchema: SERVER_SCHEMA,
      });

      return { graph, isDirty };
    }

    const { result } = renderHook(() => useHarness());

    expect(result.current.graph.settings?.batchTriggerSchema).toEqual(SERVER_SCHEMA);
    expect(result.current.isDirty).toBe(false);
  });
});
