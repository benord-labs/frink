/**
 * Syncs the server-authoritative batchTriggerSchema into local graph state when
 * the working copy has no unsaved edits. The effect calls the raw `setGraph` setter (not
 * `updateGraph`) so it never marks the flow as dirty.
 */

import { type Dispatch, type SetStateAction, useEffect } from 'react';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowSettings } from '../../../../../shared/types/flow';

type UseBatchTriggerSchemaSyncParams = {
  hydrated: boolean;
  /** Working copy differs from its baseline graph. Not the shared nav-guard atom, which sibling surfaces clear. */
  modified: boolean;
  graph: FlowGraph;
  setGraph: Dispatch<SetStateAction<FlowGraph>>;
  serverBatchTriggerSchema: FlowSettings['batchTriggerSchema'];
};

export function useBatchTriggerSchemaSync({
  hydrated,
  modified,
  graph,
  setGraph,
  serverBatchTriggerSchema,
}: UseBatchTriggerSchemaSyncParams): void {
  useEffect(() => {
    if (!hydrated || modified) return;
    const localSchema = graph.settings?.batchTriggerSchema;
    if (JSON.stringify(localSchema ?? null) === JSON.stringify(serverBatchTriggerSchema ?? null)) {
      return;
    }
    setGraph((prev) => {
      const nextSettings: FlowSettings = { ...(prev.settings ?? {}) };
      if (serverBatchTriggerSchema && serverBatchTriggerSchema.length > 0) {
        nextSettings.batchTriggerSchema = serverBatchTriggerSchema;
      } else {
        delete nextSettings.batchTriggerSchema;
      }
      return { ...prev, settings: nextSettings };
    });
  }, [graph.settings?.batchTriggerSchema, hydrated, modified, serverBatchTriggerSchema, setGraph]);
}
