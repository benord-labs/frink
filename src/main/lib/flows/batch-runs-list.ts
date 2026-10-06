/**
 * listBatchRuns read query — flow_runs filtered by batchId, optionally further
 * narrowed by status / stageId. A run belongs to a stage through batch_stage_runs.
 *
 * Returns { runs, total, statusCounts } where BatchRunRow = DbFlowRun + chat_id. statusCounts
 * covers every run in the batch, whatever the filters and the page.
 */

import { and, desc, sql as drizzleSql, eq, exists, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { BatchRunRow } from '../cloud/flows';
import { getDatabase } from '../db';
import { listLatestCompletedTopLevelStartTaskRuns } from '../db/repos/node-runs';
import { type BatchStageRun, batchStageRuns, chats, type FlowRun, flowRuns } from '../db/schema';
import { toDbFlowRun } from './adapters';

type Db = ReturnType<typeof getDatabase>;

/** A JSON record carrying a chat id: start_task outputs, or a trigger context a caller put one in. */
const chatCarrier = z.object({ chatId: z.string().min(1) });
const startTaskOutput = z.object({ outputs: chatCarrier });

type ChatSource = {
  flowRunId: string | null;
  triggerContext: FlowRun['triggerContext'] | BatchStageRun['triggerContext'];
};

/**
 * Chat id per row, in row order: the chat the run's start_task created, else one its trigger context
 * carries. Null when the row has neither, or when that chat has since been deleted.
 */
export async function resolveBatchRunChatIds(
  db: Db,
  rows: ChatSource[],
): Promise<Array<string | null>> {
  const startTasks = await listLatestCompletedTopLevelStartTaskRuns(
    db,
    rows.flatMap((r) => (r.flowRunId ? [r.flowRunId] : [])),
  );
  const named = rows.map((r) => {
    const started = startTaskOutput.safeParse(startTasks.get(r.flowRunId ?? '')?.nodeOutput);
    if (started.success) return started.data.outputs.chatId;
    return chatCarrier.safeParse(r.triggerContext).data?.chatId ?? null;
  });
  const candidates = named.flatMap((id) => (id ? [id] : []));
  if (candidates.length === 0) return named;
  const existing = new Set(
    db
      .select({ id: chats.id })
      .from(chats)
      .where(inArray(chats.id, candidates))
      .all()
      .map((c) => c.id),
  );
  return named.map((id) => (id && existing.has(id) ? id : null));
}

export type ListBatchRunsOptions = {
  status?: string;
  stageId?: string;
  limit?: number;
  offset?: number;
};

export async function listBatchRunsForBatch(
  batchId: string,
  opts: ListBatchRunsOptions = {},
  db: Db = getDatabase(),
): Promise<{ runs: BatchRunRow[]; total: number; statusCounts: Record<string, number> }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const filters = [eq(flowRuns.batchId, batchId), isNotNull(flowRuns.batchId)];
  if (opts.status) filters.push(eq(flowRuns.status, opts.status));
  // EXISTS, not a join: flow_run_id is not unique on batch_stage_runs, and a join would repeat the run.
  if (opts.stageId) {
    filters.push(
      exists(
        db
          .select({ one: drizzleSql`1` })
          .from(batchStageRuns)
          .where(
            and(
              eq(batchStageRuns.flowRunId, flowRuns.id),
              eq(batchStageRuns.stageId, opts.stageId),
            ),
          ),
      ),
    );
  }
  const where = and(...filters);

  // One transaction, one snapshot: a run inserted or re-statused between the reads cannot leave
  // the total or the status counts disagreeing with the page.
  const { rows, total, statusRows } = db.transaction((tx) => ({
    rows: tx
      .select()
      .from(flowRuns)
      .where(where)
      // created_at is second-precision; rowid (insert order) breaks ties so OFFSET pages never
      // repeat or skip a row.
      .orderBy(desc(flowRuns.createdAt), desc(drizzleSql`${flowRuns}.rowid`))
      .limit(limit)
      .offset(offset)
      .all(),
    total: Number(
      tx
        .select({ c: drizzleSql<number>`count(*)`.as('c') })
        .from(flowRuns)
        .where(where)
        .get()?.c ?? 0,
    ),
    statusRows: tx
      .select({ status: flowRuns.status, c: drizzleSql<number>`count(*)`.as('c') })
      .from(flowRuns)
      .where(eq(flowRuns.batchId, batchId))
      .groupBy(flowRuns.status)
      .all(),
  }));
  const statusCounts = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.c)]));

  const chatIds = await resolveBatchRunChatIds(
    db,
    rows.map((r) => ({ flowRunId: r.id, triggerContext: r.triggerContext })),
  );
  const runs: BatchRunRow[] = rows.map((r, i) => ({ ...toDbFlowRun(r), chat_id: chatIds[i] }));
  return { runs, total, statusCounts };
}
