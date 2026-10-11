// Version commits get their own bus: `flowEventBus` feeds run sound/badge listeners.

import type { getDatabase } from '../../db';
import { createFlowVersionWithResult } from '../../db/repos/flow-versions';
import type { FlowVersion } from '../../db/schema';

type Db = ReturnType<typeof getDatabase>;

/** Who wrote the version: an agent through the MCP flows tools, or the editor's own Save. */
export type FlowVersionSource = 'agent' | 'ui';

export type FlowVersionCommittedEvent = {
  flowId: string;
  versionNumber: number;
  source: FlowVersionSource;
};

/** Wire shape of `flows.onVersionCommitted`. */
export type FlowVersionCommittedDto = {
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  flow_id: string;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  version_number: number;
  source: FlowVersionSource;
};

type FlowVersionListener = (e: FlowVersionCommittedEvent) => void;

// One listener per open editor subscription.
const listeners = new Set<FlowVersionListener>();

export function subscribeFlowVersionCommitted(handler: FlowVersionListener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/** Each listener is isolated: one that throws must not cost the others the event, or fail the save. */
function announce(event: FlowVersionCommittedEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // The version is already durable; this window misses one push and its poll catches up.
    }
  }
}

/**
 * Append a flow version and announce it. Emits only after the transaction has committed and only
 * when a row was appended — an identical-graph save is a no-op and stays silent.
 */
export async function commitFlowVersion(
  db: Db,
  input: { flowId: string; graph: unknown; expectedVersionNumber?: number },
  source: FlowVersionSource,
): Promise<FlowVersion> {
  const { row, inserted } = await createFlowVersionWithResult(db, input);
  if (inserted) {
    announce({ flowId: row.flowId, versionNumber: row.versionNumber, source });
  }
  return row;
}
