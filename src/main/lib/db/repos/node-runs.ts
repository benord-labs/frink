import {
  and,
  asc,
  desc,
  sql as drizzleSql,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import type { FlowResumeSnapshot } from '../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../index';
import { flowRuns, type NewNodeRun, type NodeRun, nodeRuns, tasks } from '../schema';
import { transcriptUnchanged } from './sub-chat-messages';
import { latestFlowTaskForSubChatId } from './task-queries/subchat-driver';

type Db = ReturnType<typeof getDatabase>;

const TERMINAL_NODE_STATUSES = ['completed', 'failed', 'cancelled', 'skipped'] as const;

export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_input'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export async function createNodeRun(db: Db, input: NewNodeRun): Promise<NodeRun> {
  const [row] = await db.insert(nodeRuns).values(input).returning();
  return row;
}

export async function getNodeRun(db: Db, id: string): Promise<NodeRun | null> {
  const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).limit(1);
  return row ?? null;
}

export async function listNodeRunsForFlowRun(db: Db, flowRunId: string): Promise<NodeRun[]> {
  return db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.flowRunId, flowRunId))
    .orderBy(asc(nodeRuns.createdAt), asc(drizzleSql`rowid`));
}

/**
 * Resolves a flow run's originating start_task context for a downstream agent.
 * Every local agent runs `continue_chat` in the start_task's chat and reuses its
 * worktree, so {projectId,chatId,subChatId,worktree,startMode} are invariant down
 * the chain and live on the start_task's persisted node_output — one query resolves
 * them, so condition/agent nodes in between (which drop context) are transparent.
 * Latest-completed handles a flow retry that re-runs the start_task.
 * (≥2 completed start_tasks — CEO-DAG converging merge — picks the latest; correct
 * per-branch disambiguation is out of scope, tracked with the converging-merge work.)
 */
export async function findLatestCompletedStartTaskRun(
  db: Db,
  flowRunId: string,
  scope?:
    | { nodeIds: string[]; laneIndex: number; parentFanOutNodeRunId: string }
    | { nodeIds: string[]; outsideFanOut: true },
): Promise<NodeRun | null> {
  if (scope && scope.nodeIds.length === 0) return null;
  const filters = [
    eq(nodeRuns.flowRunId, flowRunId),
    eq(nodeRuns.blockType, 'start_task'),
    eq(nodeRuns.status, 'completed'),
  ];
  if (scope) {
    filters.push(inArray(nodeRuns.nodeId, scope.nodeIds));
    if ('outsideFanOut' in scope) {
      filters.push(isNull(nodeRuns.laneIndex), isNull(nodeRuns.parentFanOutNodeRunId));
    } else {
      filters.push(
        eq(nodeRuns.laneIndex, scope.laneIndex),
        eq(nodeRuns.parentFanOutNodeRunId, scope.parentFanOutNodeRunId),
      );
    }
  }
  const [row] = await db
    .select()
    .from(nodeRuns)
    .where(and(...filters))
    .orderBy(desc(nodeRuns.completedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Latest start_task node_run per flow_run, regardless of status. A converging-merge
 * conflict parks the start_task at `awaiting_input` with `completed_at` NULL, which
 * findLatestCompletedStartTaskRun deliberately skips — so read-path consumers that
 * must surface the parked state (BatchMonitor run rows) resolve through this instead.
 * Newest attempt (retry / re-run) wins per flow_run: created_at is second-precision,
 * so attempt_number then rowid (insert order) break same-second ties deterministically.
 */
export async function listLatestStartTaskRunsByFlowRunIds(
  db: Db,
  flowRunIds: string[],
): Promise<Map<string, NodeRun>> {
  if (flowRunIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(inArray(nodeRuns.flowRunId, flowRunIds), eq(nodeRuns.blockType, 'start_task')))
    .orderBy(desc(nodeRuns.createdAt), desc(nodeRuns.attemptNumber), desc(drizzleSql`rowid`));
  const latest = new Map<string, NodeRun>();
  for (const row of rows) {
    if (!latest.has(row.flowRunId)) latest.set(row.flowRunId, row);
  }
  return latest;
}

/** Latest COMPLETED start_task per flow_run outside fan-out lanes: an indexed light-column read, then a
 * PK read of only the winners' output. Newer attempt wins; attempt_number/rowid break ties. */
export async function listLatestCompletedTopLevelStartTaskRuns(
  db: Db,
  flowRunIds: string[],
): Promise<Map<string, Pick<NodeRun, 'nodeOutput'>>> {
  if (flowRunIds.length === 0) return new Map();
  const completed = await db
    .select({
      id: nodeRuns.id,
      flowRunId: nodeRuns.flowRunId,
      completedAt: nodeRuns.completedAt,
      attemptNumber: nodeRuns.attemptNumber,
      seq: drizzleSql<number>`rowid`,
    })
    .from(nodeRuns)
    .where(
      and(
        inArray(nodeRuns.flowRunId, flowRunIds),
        eq(nodeRuns.status, 'completed'),
        eq(nodeRuns.blockType, 'start_task'),
        isNull(nodeRuns.laneIndex),
        isNull(nodeRuns.parentFanOutNodeRunId),
      ),
    );
  const winners = new Map<string, (typeof completed)[number]>();
  for (const row of completed) {
    const best = winners.get(row.flowRunId);
    if (!best || compareAttempts(row, best) > 0) winners.set(row.flowRunId, row);
  }
  if (winners.size === 0) return new Map();
  const outputs = await db
    .select({ id: nodeRuns.id, nodeOutput: nodeRuns.nodeOutput })
    .from(nodeRuns)
    .where(
      inArray(
        nodeRuns.id,
        [...winners.values()].map((w) => w.id),
      ),
    );
  const outputById = new Map(outputs.map((o) => [o.id, o.nodeOutput]));
  return new Map(
    [...winners].map(([flowRunId, w]) => [flowRunId, { nodeOutput: outputById.get(w.id) ?? null }]),
  );
}

type AttemptOrder = { completedAt: Date | null; attemptNumber: number; seq: number };

function compareAttempts(a: AttemptOrder, b: AttemptOrder): number {
  const at = (r: AttemptOrder) => r.completedAt?.getTime() ?? -1;
  return at(a) - at(b) || a.attemptNumber - b.attemptNumber || a.seq - b.seq;
}

/**
 * The prior completed attempt at this exact (flowRunId, nodeId, lane) — a retry creates a fresh
 * node_run row, so a no-worktree start_task resolves its earlier chat through this.
 */
export async function findLatestCompletedRunForNode(
  db: Db,
  flowRunId: string,
  nodeId: string,
  lane: { laneIndex: number | null; parentFanOutNodeRunId: string | null },
): Promise<NodeRun | null> {
  const filters = [
    eq(nodeRuns.flowRunId, flowRunId),
    eq(nodeRuns.nodeId, nodeId),
    eq(nodeRuns.status, 'completed'),
  ];
  // Scoped like findLatestCompletedStartTaskRun — else a fan-out's distinct items collapse.
  filters.push(
    lane.laneIndex !== null && lane.parentFanOutNodeRunId !== null
      ? and(
          eq(nodeRuns.laneIndex, lane.laneIndex),
          eq(nodeRuns.parentFanOutNodeRunId, lane.parentFanOutNodeRunId),
        )!
      : and(isNull(nodeRuns.laneIndex), isNull(nodeRuns.parentFanOutNodeRunId))!,
  );
  const [row] = await db
    .select()
    .from(nodeRuns)
    .where(and(...filters))
    .orderBy(desc(nodeRuns.completedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The identity context a start_task surfaces into its node_output for the rest of
 * the flow — invariant down the chain (agents/run_command/chat_reply all reuse the
 * start_task's chat + worktree). Resolved by every downstream block that needs it.
 */
export type StartTaskContext = {
  projectId?: string;
  chatId?: string;
  subChatId?: string;
  taskId?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  /** 'plan' | 'execute' — gates the downstream agent task. */
  startMode?: string;
  /** Start_task's model (PICKER id, e.g. `opus-4.8`); a downstream agent inherits it when it has no own override. */
  model?: string;
  /** Resolved task title (from start_task's Task title field, templates rendered); a downstream agent names its task row from this. */
  label?: string;
};

/**
 * Resolves the flow's originating start_task context (see findLatestCompletedStartTaskRun)
 * for a downstream block, parsing its persisted node_output.outputs. Returns null when no
 * start_task has completed / the output has no outputs object. Used by agent / run_command /
 * chat_reply so condition/agent nodes in between are transparent (sc-801 / sc-802).
 * A lane node resolves its own lane, then outer start_tasks; any other node sees only upstream
 * start_tasks outside every Fan Out lane (sc-3836).
 */
export async function resolveUpstreamStartTaskContext(
  db: Db,
  flowRunId: string,
  options?: { nodeRunId: string; upstreamNodeIds: string[] },
): Promise<StartTaskContext | null> {
  const current = options ? await getNodeRun(db, options.nodeRunId) : null;
  const laneScope =
    options && current?.laneIndex !== null && current?.parentFanOutNodeRunId
      ? {
          nodeIds: options.upstreamNodeIds,
          laneIndex: current.laneIndex,
          parentFanOutNodeRunId: current.parentFanOutNodeRunId,
        }
      : undefined;
  // Outside a lane, only start_tasks outside every Fan Out count — a continuation's upstream
  // walk passes through the lane bodies, and the newest lane start_task must not win (sc-3836).
  const outsideScope = options
    ? { nodeIds: options.upstreamNodeIds, outsideFanOut: true as const }
    : undefined;
  const run =
    (laneScope && (await findLatestCompletedStartTaskRun(db, flowRunId, laneScope))) ||
    (await findLatestCompletedStartTaskRun(db, flowRunId, outsideScope));
  if (!run || run.nodeOutput === null || typeof run.nodeOutput !== 'object') return null;
  const outputs = (run.nodeOutput as { outputs?: unknown }).outputs;
  if (outputs === null || typeof outputs !== 'object') return null;
  return outputs as StartTaskContext;
}

export function setNodeRunStatus(
  db: Db,
  id: string,
  status: NodeRunStatus,
  patch: {
    nodeOutput?: unknown;
    startedAt?: Date | null;
    completedAt?: Date | null;
    /**
     * Optimistic-concurrency guard: only flip when the current status is one of these.
     * Mirrors the cloud engine's `WHERE … AND status IN (…)` CAS so advancement is
     * idempotent across process restarts — a re-advance of an already-terminal node
     * matches 0 rows and returns null (caller bails before re-walking edges). Omit for
     * the unconditional behaviour every other caller relies on.
     */
    expectStatuses?: readonly NodeRunStatus[];
    /** Same-statement guard: write only while the DRIVING task is still the exact row the caller
     * read (status + result JSON) — a resumed or re-parked task never gets a stale node. */
    expectDrivingTask?: { id: string; status: string; result: unknown };
    expectResumeSnapshot?: FlowResumeSnapshot;
    expectFlowRunId?: string;
  } = {},
): NodeRun | null {
  const update: Partial<NodeRun> = { status };
  if (patch.nodeOutput !== undefined) update.nodeOutput = patch.nodeOutput;
  if (patch.startedAt !== undefined) update.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) update.completedAt = patch.completedAt;
  const guards = [eq(nodeRuns.id, id)];
  if (patch.expectStatuses) {
    guards.push(inArray(nodeRuns.status, [...patch.expectStatuses]));
  }
  if (patch.expectFlowRunId) guards.push(eq(nodeRuns.flowRunId, patch.expectFlowRunId));
  if (patch.expectResumeSnapshot)
    guards.push(resumeSnapshotGuard(db, id, patch.expectResumeSnapshot));
  if (patch.expectDrivingTask) {
    const { id: taskId, status: taskStatus, result } = patch.expectDrivingTask;
    const sameRow = and(
      eq(tasks.id, taskId),
      eq(tasks.status, taskStatus),
      drizzleSql`json(${tasks.result}) IS json(${JSON.stringify(result ?? null)})`,
    );
    guards.push(
      exists(
        db
          .select({ one: drizzleSql`1` })
          .from(tasks)
          .where(sameRow),
      ),
    );
  }
  return (
    db
      .update(nodeRuns)
      .set(update)
      .where(and(...guards))
      .returning()
      .get() ?? null
  );
}

/** A resume is valid only for the exact park and latest attempt that the user reviewed. */
function resumeSnapshotGuard(db: Db, id: string, snapshot: FlowResumeSnapshot) {
  const attempt = alias(nodeRuns, 'resume_attempt');
  const guards = [
    drizzleSql`${id} = ${snapshot.attemptIds.at(-1) ?? null}`,
    eq(nodeRuns.status, snapshot.status),
    drizzleSql`json(coalesce(${nodeRuns.nodeOutput}, 'null')) IS json(${JSON.stringify(snapshot.nodeOutput ?? null)})`,
    drizzleSql`${nodeRuns.startedAt} IS ${snapshot.startedAt ? Date.parse(snapshot.startedAt) / 1000 : null}`,
    drizzleSql`${nodeRuns.completedAt} IS ${snapshot.completedAt ? Date.parse(snapshot.completedAt) / 1000 : null}`,
    notExists(
      db
        .select({ one: drizzleSql`1` })
        .from(attempt)
        .where(
          and(
            eq(attempt.flowRunId, nodeRuns.flowRunId),
            eq(attempt.nodeId, nodeRuns.nodeId),
            drizzleSql`${attempt.laneIndex} IS ${nodeRuns.laneIndex}`,
            drizzleSql`${attempt.parentFanOutNodeRunId} IS ${nodeRuns.parentFanOutNodeRunId}`,
            notInArray(attempt.id, snapshot.attemptIds),
          ),
        ),
    ),
  ];
  if (snapshot.drivingTask) {
    const task = snapshot.drivingTask;
    guards.push(
      exists(
        db
          .select({ one: drizzleSql`1` })
          .from(tasks)
          .where(
            and(
              eq(tasks.id, task.id),
              eq(tasks.nodeRunId, id),
              eq(tasks.status, task.status),
              snapshot.plan
                ? eq(tasks.id, latestFlowTaskForSubChatId(db, snapshot.plan.subChatId))
                : undefined,
              drizzleSql`json(coalesce(${tasks.result}, 'null')) IS json(${JSON.stringify(task.result ?? null)})`,
            ),
          ),
      ),
    );
  }
  if (snapshot.plan)
    guards.push(transcriptUnchanged(db, snapshot.plan.subChatId, snapshot.plan.messages));
  return and(...guards)!;
}

export function nodeMatchesResumeSnapshot(
  db: Db,
  id: string,
  snapshot: FlowResumeSnapshot,
): boolean {
  return Boolean(
    db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.id, id), resumeSnapshotGuard(db, id, snapshot)))
      .get(),
  );
}

/**
 * Recovery sweep: mark 'running' node_runs that started before `cutoff` as cancelled —
 * a restart interruption is not a flow error. Stamps RESTART_INTERRUPTION_REASON onto
 * node_output.error so the run reads neutral and the run panel can offer a re-run
 * (covers the non-agent running-node case; the agent case is terminalized via the
 * task sweep + watcher → mapTaskToNodeOutput). The cutoff guard prevents the sweep
 * from killing runs legitimately started after this process booted.
 */
export async function recoverOrphanedNodeRuns(db: Db, cutoff: Date = new Date()): Promise<number> {
  const rows = await db
    .update(nodeRuns)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
    })
    .where(
      and(
        eq(nodeRuns.status, 'running'),
        or(isNull(nodeRuns.startedAt), lt(nodeRuns.startedAt, cutoff)),
      ),
    )
    .returning({ id: nodeRuns.id });
  return rows.length;
}

/**
 * Cancel a run's still-active node_runs (pending/running/awaiting_input/blocked). Call when a
 * flow_run goes terminal so no node_run is stranded mid-state. Cancelling is a plain bulk update:
 * execution is single-process, so there is no per-row cancel event to emit to anyone.
 */
export async function cancelRemainingNodeRunsForRun(db: Db, flowRunId: string): Promise<number> {
  const rows = await db
    .update(nodeRuns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        eq(nodeRuns.flowRunId, flowRunId),
        notInArray(nodeRuns.status, [...TERMINAL_NODE_STATUSES]),
      ),
    )
    .returning({ id: nodeRuns.id });
  return rows.length;
}

/**
 * Boot backstop: terminalize non-terminal node_runs that belong to an ALREADY-terminal flow_run —
 * residue a crash/restart leaves (recoverOrphanedFlowRuns fails a 'running' run but its
 * awaiting_input node is never swept). Scoped to terminal flow_runs, so a legitimately
 * awaiting_input node on an active/paused run is never touched. Run AFTER recoverOrphanedFlowRuns.
 */
export async function cleanupNodeRunsForTerminalFlows(db: Db): Promise<number> {
  const rows = await db
    .update(nodeRuns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        inArray(
          nodeRuns.flowRunId,
          db
            .select({ id: flowRuns.id })
            .from(flowRuns)
            .where(inArray(flowRuns.status, ['failed', 'cancelled', 'completed'])),
        ),
        notInArray(nodeRuns.status, [...TERMINAL_NODE_STATUSES]),
      ),
    )
    .returning({ id: nodeRuns.id });
  return rows.length;
}

/** Runs whose parked node (`awaiting_input`/`blocked`) has no live task — someone must act. A healthy
 * agent hand-off parks its node too but keeps a `running` task; run status is `paused` either way. */
export async function listHumanWaitFlowRunIds(db: Db, flowRunIds: string[]): Promise<Set<string>> {
  if (flowRunIds.length === 0) return new Set();
  const liveTaskOnNode = db
    .select({ one: drizzleSql`1` })
    .from(tasks)
    .where(and(eq(tasks.nodeRunId, nodeRuns.id), inArray(tasks.status, ['pending', 'running'])));
  const rows = await db
    .selectDistinct({ flowRunId: nodeRuns.flowRunId })
    .from(nodeRuns)
    .where(
      and(
        inArray(nodeRuns.flowRunId, flowRunIds),
        inArray(nodeRuns.status, ['awaiting_input', 'blocked']),
        notExists(liveTaskOnNode),
      ),
    );
  return new Set(rows.map((r) => r.flowRunId));
}
