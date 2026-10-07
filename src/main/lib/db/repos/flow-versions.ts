import { desc, eq } from 'drizzle-orm';
import { type FlowGraph, flowGraphsEqual } from '../../../../shared/lib/validate-flow-graph';
import {
  applyCurrentBatchIdForBriefingTransition,
  type GraphWithSettings,
} from '../../flows/apply-current-batch-id';
import type { getDatabase } from '../index';
import { type FlowVersion, flowVersions, type NewFlowVersion } from '../schema';

type Db = ReturnType<typeof getDatabase>;

export class FlowVersionConflictError extends Error {
  constructor(
    public readonly flowId: string,
    public readonly expected: number | undefined,
    public readonly actual: number,
  ) {
    super(
      `Flow version conflict for flow ${flowId}: expected ${expected ?? 'next'} but latest is ${actual}`,
    );
    this.name = 'FlowVersionConflictError';
  }
}

/**
 * Append a new version. Optimistic concurrency: caller passes `expectedVersionNumber` as
 * the version they last loaded. We append `expected + 1`. If another writer beat us,
 * throws FlowVersionConflictError. When `expectedVersionNumber` is undefined, append after
 * whatever the current max is (initial save / no concurrency check).
 *
 * SELECT + INSERT run inside `BEGIN IMMEDIATE` so two concurrent saves serialize at the
 * lock boundary instead of both observing the same `latest` and racing to insert
 * version N+1, which would surface as an opaque SQLite UNIQUE constraint error rather
 * than a typed FlowVersionConflictError.
 */
/** Stale-client guard: a provided `expected` version must match the current latest. */
function assertExpectedVersion(flowId: string, expected: number | undefined, latest: number): void {
  if (expected !== undefined && latest !== expected) {
    throw new FlowVersionConflictError(flowId, expected, latest);
  }
}

/** True when the incoming graph is content-identical to the latest stored version. */
function isIdenticalToLatest(graph: unknown, latest: FlowVersion | undefined): boolean {
  return Boolean(latest) && flowGraphsEqual(graph as FlowGraph, latest?.graph as FlowGraph);
}

export type CreateFlowVersionResult = {
  row: FlowVersion;
  /** False when the graph matched the latest version and no row was appended. */
  inserted: boolean;
};

export async function createFlowVersion(
  db: Db,
  input: { flowId: string; graph: unknown; expectedVersionNumber?: number },
): Promise<FlowVersion> {
  return (await createFlowVersionWithResult(db, input)).row;
}

/** `createFlowVersion`, plus whether a row was actually appended. */
export async function createFlowVersionWithResult(
  db: Db,
  input: { flowId: string; graph: unknown; expectedVersionNumber?: number },
): Promise<CreateFlowVersionResult> {
  return db.transaction(
    (tx) => {
      const latestRow = tx
        .select()
        .from(flowVersions)
        .where(eq(flowVersions.flowId, input.flowId))
        .orderBy(desc(flowVersions.versionNumber))
        .limit(1)
        .all();
      const latest = latestRow[0]?.versionNumber ?? 0;
      assertExpectedVersion(input.flowId, input.expectedVersionNumber, latest);
      const prevSettings = (latestRow[0]?.graph as GraphWithSettings | undefined)?.settings;
      applyCurrentBatchIdForBriefingTransition(
        input.graph as GraphWithSettings,
        prevSettings?.briefing,
        prevSettings?.currentBatchId,
      );
      // No-op when the incoming graph matches the latest stored version: skip the insert and
      // return the existing row so identical saves don't append redundant immutable versions.
      // Checked after the conflict guard, so a stale client still gets a typed conflict.
      if (isIdenticalToLatest(input.graph, latestRow[0])) {
        return { row: latestRow[0], inserted: false };
      }
      const newRow: NewFlowVersion = {
        flowId: input.flowId,
        versionNumber: latest + 1,
        graph: input.graph,
      };
      const inserted = tx.insert(flowVersions).values(newRow).returning().all();
      return { row: inserted[0], inserted: true };
    },
    { behavior: 'immediate' },
  );
}

export async function getLatestVersion(db: Db, flowId: string): Promise<FlowVersion | null> {
  const [row] = await db
    .select()
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.versionNumber))
    .limit(1);
  return row ?? null;
}

export async function getVersion(db: Db, id: string): Promise<FlowVersion | null> {
  const [row] = await db.select().from(flowVersions).where(eq(flowVersions.id, id)).limit(1);
  return row ?? null;
}
