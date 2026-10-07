/**
 * Shared test factories for the batch-dispatch suites
 * (batch-dispatch.test.ts, batch-dispatch-edge-cases.test.ts).
 *
 * Both suites run real in-memory SQLite (freshDb) with startFlowRun mocked;
 * the factories seed flows/stages and provide the mock's flow_run insert.
 */

import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { createBatchStageRun, setStageRunStatusIf } from '../db/repos/batch-stage-runs';
import { createBatchStage } from '../db/repos/batch-stages';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { type BatchStage, flowRuns } from '../db/schema';
import type { TestDb } from '../db/test-utils/fresh-db';

export async function seedBatchFlow(
  db: TestDb,
  settings: Record<string, unknown> = {},
): Promise<{ flowId: string; versionId: string }> {
  const flow = await createFlow(db, {
    name: 'F',
    description: null,
    projectId: null,
  });
  const version = await createFlowVersion(db, {
    flowId: flow.id,
    graph: { nodes: [], edges: [], settings },
  });
  return { flowId: flow.id, versionId: version.id };
}

export async function seedBatchStage(
  db: TestDb,
  batchId: string,
  input: {
    stageNumber: number;
    runCount: number;
    dependsOnStageIds?: string[];
    failureThreshold?: number;
    triggerContext?: Record<string, unknown>;
  },
): Promise<BatchStage> {
  const stage = await createBatchStage(db, {
    batchId,
    stageNumber: input.stageNumber,
    name: `s${input.stageNumber}`,
    status: 'pending',
    failureThreshold: input.failureThreshold ?? 0,
    dependsOnStageIds: input.dependsOnStageIds ?? [],
  });
  for (let i = 0; i < input.runCount; i += 1) {
    await createBatchStageRun(db, {
      stageId: stage.id,
      triggerContext: input.triggerContext ?? { label: `run-${i}` },
      status: 'pending',
    });
  }
  return stage;
}

type StartFlowRunMockInput = {
  flowVersionId?: string | null;
  triggerContext?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  batchId?: string | null;
  batchStageRunId?: string | null;
};

/** startFlowRun stand-in: inserts the flow_run row, skips the node engine. */
export function makeStartFlowRunMock(db: TestDb, currentVersionId: () => string) {
  return async (input: StartFlowRunMockInput) => {
    const [run] = await db
      .insert(flowRuns)
      .values({
        flowVersionId: input.flowVersionId ?? currentVersionId(),
        status: 'running',
        triggerContext: input.triggerContext ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        batchId: input.batchId ?? null,
        startedAt: new Date(),
      })
      .returning();
    if (input.batchStageRunId) {
      await setStageRunStatusIf(
        db,
        input.batchStageRunId,
        ['pending', 'queued'],
        'dispatched',
        run.id,
      );
    }
    return { run, version: undefined, isReplay: false };
  };
}

export async function setRunStatus(
  db: TestDb,
  flowRunId: string,
  status: 'completed' | 'failed' | 'cancelled' | 'paused',
): Promise<void> {
  await db.update(flowRuns).set({ status }).where(eq(flowRuns.id, flowRunId));
}

/** Dispatched BSRs always carry a flowRunId; fail loudly if a test seeds one without. */
export function runId(bsr: { flowRunId: string | null | undefined } | undefined): string {
  if (!bsr?.flowRunId) throw new Error('BSR missing flowRunId');
  return bsr.flowRunId;
}

export type PreparedStatement = { sql: string; inTransaction: boolean };

/** Logs each statement prepared from here on with whether a transaction was open. The sync session
 * prepares at execution, so that is the state the statement ran under. Used by the list-reader suites. */
export function recordPrepares(db: TestDb): PreparedStatement[] {
  const log: PreparedStatement[] = [];
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  vi.spyOn(client, 'prepare').mockImplementation((sql: string) => {
    log.push({ sql, inTransaction: client.inTransaction });
    return prepare(sql);
  });
  return log;
}

/** The page (`limit ?`) and total (`count(*)`) statements of a paginated list read. */
export function pageAndCountStatements(log: PreparedStatement[]): PreparedStatement[] {
  return log.filter((s) => /count\(\*\)|\blimit \?/i.test(s.sql));
}
