/* eslint-disable max-lines */
/** Local SQLite tasks repository. Returns Drizzle camelCase rows directly. IDs are cuid2; heartbeat
 * columns are omitted because startup recovery owns orphaned running tasks in this process. */

import { and, desc, sql as drizzleSql, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { FLOW_DRIVING_STATUSES } from '../../../../shared/types/flow';
import { taskResultSchema, type TaskResultRecord } from '../../../../shared/types/task-result';
import type { getDatabase } from '../index';
import { flowRuns, type NewTask, projects, type Task, tasks } from '../schema';
import { cancelResultPatch } from './task-parking/cancel-marker';
import {
  effectiveStatusExpr,
  getWorkQueueSectionFilter,
  isFlowRepresentative,
  isWaitModeTask,
  type WorkQueueSection,
} from './task-queries';
import { drivingFlowTaskOnSubChat, pausedFlowRun } from './task-queries/run-liveness';

type Db = ReturnType<typeof getDatabase>;

export type TaskStatus = Task['status'];

/**
 * Terminal-final `tasks.status` values: the task's lifecycle is over and no follow-up message can
 * revive it. When a chat's only task link is terminal-final, the executor disarms the whole
 * task-signal apparatus (lifecycle prompt, stop hook, `frink_task_signal` tool) — the agent has
 * nothing left to signal and any signal would be dropped by `canApplyTaskSignalForStatus`.
 *
 * MUST NOT include `failed` or `needs_attention`: a follow-up message flips those back to `running`
 * (executor `resumeTaskOnFollowUpMessage`) so the agent's next signal applies — disarming them would
 * break the chat-reply resume surface (see decision `flow-agent-node-mode`).
 */
export const TERMINAL_FINAL_TASK_STATUSES = ['done', 'completed', 'cancelled'] as const;

/** True when the status is terminal-final (see `TERMINAL_FINAL_TASK_STATUSES`). */
export function isTerminalFinalTaskStatus(status: string): boolean {
  return (TERMINAL_FINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * The active flow task driving the given sub-chat (linked via `result.subChatId`): whether one
 * exists (`active`) and whether it is an auto-approve plan turn (`autoApprovePlan` =
 * `startMode === 'plan' && skipReview === true`).
 *
 * Keyed on `subChatId`, NOT the chat's pinned `taskId` — a flow chat's `taskId` stays linked to the
 * FIRST task (often an `execute` node) while later nodes (the plan node) drive the same sub-chat, so
 * the pinned task reports the wrong `startMode`. `active` drives the plan card's `flowDriven` flag;
 * `autoApprovePlan` lets the executor emit the card `approved` + auto-advance the flow.
 */
export type FlowDriveInfo = {
  active: boolean;
  autoApprovePlan: boolean;
  /**
   * The driving task's id — the DB source of truth for which flow task is on the sub-chat (the
   * newest non-terminal flow task on `result.subChatId`). The executor targets an agent's task
   * signal at THIS, not the chat's pinned `taskId` (which points at the FIRST node's, often
   * terminal, task — a later node's signal would land there and be dropped).
   */
  taskId: string | null;
};

export async function getFlowDriveInfoForSubChat(
  db: Db,
  subChatId: string,
): Promise<FlowDriveInfo> {
  if (!subChatId) return { active: false, autoApprovePlan: false, taskId: null };
  const rows = await db
    .select({ id: tasks.id, result: tasks.result })
    .from(tasks)
    .where(drivingFlowTaskOnSubChat(db, subChatId))
    // Most-recent driving task = the node currently on the chat. Without this, a lingering
    // non-terminal task from an earlier node (e.g. `execute`) could be read instead of the current
    // plan node, mis-reporting `startMode`/`skipReview`.
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  const r = rows[0]?.result;
  const record = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
  return {
    active: rows.length > 0,
    autoApprovePlan: record?.startMode === 'plan' && record?.skipReview === true,
    taskId: rows[0]?.id ?? null,
  };
}

/** Boolean view — true when a flow task drives the sub-chat (stamps the plan card's `flowDriven`). */
export async function isSubChatDrivenByActiveFlowTask(db: Db, subChatId: string): Promise<boolean> {
  return (await getFlowDriveInfoForSubChat(db, subChatId)).active;
}

/**
 * The newest flow task on a sub-chat REGARDLESS of status — including terminal ones. Unlike
 * `getFlowDriveInfoForSubChat` (active statuses only), this surfaces a `cancelled` driving task so
 * the chat-reply resume path can detect a restart-interrupted run and revive it. Returns the task's
 * id, status, and `flowRunId` (null for the active-only query's blind spot). `null` for a non-flow
 * sub-chat or one with no flow task.
 */
export async function getLatestFlowTaskForSubChat(
  db: Db,
  subChatId: string,
): Promise<{ id: string; status: string; flowRunId: string | null } | null> {
  if (!subChatId) return null;
  const rows = await db
    .select({ id: tasks.id, status: tasks.status, flowRunId: tasks.flowRunId })
    .from(tasks)
    .where(
      and(
        eq(tasks.source, 'flow'),
        drizzleSql`json_extract(${tasks.result}, '$.subChatId') = ${subChatId}`,
      ),
    )
    // rowid breaks createdAt ties: an upstream `done` node task and the later `cancelled` driving
    // task can share a millisecond, and the cancelled one (inserted last) must win.
    .orderBy(desc(tasks.createdAt), desc(drizzleSql`rowid`))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The newest flow task ON A FLOW RUN regardless of status — the driving task to resume for a batch
 * member Carry-on, keyed on `flowRunId` (the caller has the run, not the sub-chat). Same latest-wins
 * ordering as {@link getLatestFlowTaskForSubChat}: a run's later `failed`/`cancelled` driving task
 * outranks an upstream node's earlier `done`. `null` for a run with no flow task.
 */
export async function getLatestFlowTaskForRun(
  db: Db,
  flowRunId: string,
): Promise<{ id: string; status: string; flowRunId: string | null } | null> {
  if (!flowRunId) return null;
  const rows = await db
    .select({ id: tasks.id, status: tasks.status, flowRunId: tasks.flowRunId })
    .from(tasks)
    .where(and(eq(tasks.source, 'flow'), eq(tasks.flowRunId, flowRunId)))
    .orderBy(desc(tasks.createdAt), desc(drizzleSql`rowid`))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The chat behind a flow node_run — its task's `result.chatId` / `result.subChatId` (node_runs
 * carry no chat linkage of their own; dispatchAgent stamps both onto the task, and
 * `tasks.node_run_id` is unique so there is at most one). Powers the Runs-tab "Answer" jump to the
 * chat where the parked node's question is answerable. `null` when the node has no task or its
 * task carries no chatId (e.g. a non-agent block).
 */
export async function getFlowChatForNodeRun(
  db: Db,
  nodeRunId: string,
): Promise<{ chatId: string; subChatId: string | null } | null> {
  if (!nodeRunId) return null;
  const rows = await db
    .select({ result: tasks.result })
    .from(tasks)
    .where(and(eq(tasks.source, 'flow'), eq(tasks.nodeRunId, nodeRunId)))
    .limit(1);
  const record = parseResultRecord(rows[0]?.result);
  const chatId = typeof record.chatId === 'string' ? record.chatId : null;
  const subChatId = typeof record.subChatId === 'string' ? record.subChatId : null;
  return chatId ? { chatId, subChatId } : null;
}

/**
 * The Flow Briefing (shared PRD/spec/checklist) for a sub-chat, read from the NEWEST flow task's
 * `triggerContext._config.flowBriefing` — any status, so it survives a manual follow-up typed after
 * the flow has completed (CLAUDE.md-like: present for the chat's whole life). The executor injects
 * this once into the session system-prompt channel, never into the per-turn message. Returns '' for
 * an interactive (non-flow) sub-chat, a flow with no briefing, or an empty subChatId.
 */
export async function getFlowBriefingForSubChat(db: Db, subChatId: string): Promise<string> {
  if (!subChatId) return '';
  const rows = await db
    .select({
      briefing: drizzleSql<
        string | null
      >`json_extract(${tasks.triggerContext}, '$._config.flowBriefing')`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.source, 'flow'),
        drizzleSql`json_extract(${tasks.result}, '$.subChatId') = ${subChatId}`,
        // Only consider flow tasks that actually stash a briefing. Not every flow task does
        // (e.g. batch_message/CEO continuation turns), and those are created LATER — without this
        // filter a briefing-less task would win the newest-wins pick and shadow the shared session
        // briefing carried by the agent tasks. The briefing is flow-level, so the newest agent task
        // that carries it is the right source.
        drizzleSql`COALESCE(json_extract(${tasks.triggerContext}, '$._config.flowBriefing'), '') <> ''`,
      ),
    )
    // Same newest-wins tiebreak as getLatestFlowTaskForSubChat: an upstream node task and the driving
    // task can share a createdAt millisecond; the later-inserted (higher rowid) row wins.
    .orderBy(desc(tasks.createdAt), desc(drizzleSql`rowid`))
    .limit(1);
  const briefing = rows[0]?.briefing;
  return typeof briefing === 'string' ? briefing.trim() : '';
}

export type CreateTaskInput = {
  projectId?: string | null;
  title?: string | null;
  description: string;
  source: string;
  sourceId?: string | null;
  requiresFilesystem?: boolean;
  result?: unknown;
  triggerContext?: unknown;
  flowRunId?: string | null;
  nodeRunId?: string | null;
  executedBy?: string | null;
};

export { taskResultSchema, type TaskResultRecord };

export async function createTask(db: Db, input: CreateTaskInput): Promise<Task> {
  const row: NewTask = {
    ...input,
    projectId: input.projectId ?? null,
    title: input.title ?? null,
    sourceId: input.sourceId ?? null,
    requiresFilesystem: input.requiresFilesystem ?? true,
    result: input.result == null ? null : taskResultSchema.parse(input.result),
    triggerContext:
      input.triggerContext == null ? null : taskResultSchema.parse(input.triggerContext),
    flowRunId: input.flowRunId ?? null,
    nodeRunId: input.nodeRunId ?? null,
    executedBy: input.executedBy ?? null,
  };
  const [inserted] = await db.insert(tasks).values(row).returning();
  return inserted;
}

export async function getTaskById(db: Db, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}

export type UpdateTaskStatusOptions = {
  result?: unknown;
  executedBy?: string | null;
  /**
   * CAS guard: the write matches 0 rows (returns null) unless the task's current status is in
   * this list. Closes read-check-write races — e.g. a signal persist whose status check passed
   * before a concurrent user-pause park committed must NOT clobber the fresh park.
   */
  expectStatuses?: readonly TaskStatus[];
};

/**
 * Status transition. Side-effects:
 * - 'running' sets started_at when unset; result only updated if truthy (legacy parity).
 * - terminal statuses (completed / failed / cancelled / done / needs_attention)
 *   set completed_at + result.
 */
export async function updateTaskStatus(
  db: Db,
  taskId: string,
  status: TaskStatus,
  options: UpdateTaskStatusOptions = {},
): Promise<Task | null> {
  const patch: Partial<Task> = { status };
  const result = options.result == null ? options.result : taskResultSchema.parse(options.result);
  if (options.executedBy !== undefined) patch.executedBy = options.executedBy ?? null;
  const now = new Date();

  const terminal = ['completed', 'failed', 'cancelled', 'done', 'needs_attention'];
  if (status === 'running') {
    patch.startedAt = now;
    if (result) patch.result = result;
  } else if (terminal.includes(status)) {
    patch.completedAt = now;
    if (result !== undefined) patch.result = result;
  } else if (result !== undefined) {
    patch.result = result;
  }

  const [row] = await db.update(tasks).set(patch).where(casWhere(taskId, options)).returning();
  return row ?? null;
}

function casWhere(taskId: string, options: { expectStatuses?: readonly TaskStatus[] }) {
  return options.expectStatuses
    ? and(eq(tasks.id, taskId), inArray(tasks.status, [...options.expectStatuses]))
    : eq(tasks.id, taskId);
}

/**
 * Result-only write: updates `result` without touching `status`, `started_at`, or
 * `completed_at`. Used to record an agent signal mid-stream while the task stays `running`,
 * deferring the terminal transition (and flow node advance) to the agent's stream end.
 * `expectStatuses` is the same CAS guard as {@link updateTaskStatus}.
 */
export async function updateTaskResult(
  db: Db,
  taskId: string,
  result: unknown,
  options: { expectStatuses?: readonly TaskStatus[] } = {},
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ result: result == null ? null : taskResultSchema.parse(result) })
    .where(casWhere(taskId, options))
    .returning();
  return row ?? null;
}

/**
 * Bulk-delete by effective status. Every row in this database belongs to the one owner of this
 * userData directory, so `statuses` — caller-controlled — is the only narrowing predicate.
 */
export async function deleteTasksMatchingStatuses(db: Db, statuses: TaskStatus[]): Promise<number> {
  if (statuses.length === 0) return 0;
  // The work queue buckets/counts rows by EFFECTIVE status (per-flow collapse — see
  // effectiveStatusExpr), so a terminal FLOW surfaces under its own status while its task rows keep
  // their raw status (done/running/…). Deleting by raw status would miss them (a cancelled flow has
  // zero raw 'cancelled' rows). Match the SAME effective status the list/count paths use, via the
  // flow_runs join, so "delete all" clears exactly what the collapsed queue shows. Per-task matching
  // (not a flow-wide cascade) is deliberate: a terminal flow's siblings all share its effective
  // status so the whole flow clears, while a still-active flow's recoverable running/pending rows map
  // to 'running' (never a bulk-deletable status) and are preserved.
  const matched = db
    .select({ id: tasks.id })
    .from(tasks)
    .leftJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
    .where(
      drizzleSql`${effectiveStatusExpr} in (${drizzleSql.join(
        statuses.map((s) => drizzleSql`${s}`),
        drizzleSql`, `,
      )})`,
    );
  const rows = await db.delete(tasks).where(inArray(tasks.id, matched)).returning({ id: tasks.id });
  return rows.length;
}

/**
 * Claim a pending task for the executor: atomically flips pending → running with
 * executed_by + started_at. Returns the updated row, or null when the task isn't
 * found or no longer pending (raced with another claimant).
 */
export async function claimTask(db: Db, taskId: string, machineId: string): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status: 'running', executedBy: machineId, startedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')))
    .returning();
  return row ?? null;
}

/**
 * IDs of pending tasks the poller may claim; the caller fetches each full row via getTaskById.
 * No machine predicate — this process is the only executor for this database.
 */
export async function getPendingTaskIds(db: Db, limit = 25): Promise<{ id: string }[]> {
  // SQL-level wait-mode filter: rows whose triggerContext._config.startMode
  // is 'wait' must remain queued until manually started — they should not be
  // claimed by the poller. Cloud poller endpoint enforced the same filter.
  // Without it the executor claims a wait-mode task, throws
  // "Wait-mode tasks must remain queued", and leaves the row stuck `running`
  // until the next boot recovery sweep.
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), drizzleSql`NOT ${isWaitModeTask}`))
    .orderBy(tasks.createdAt)
    .limit(limit);
}

export type TaskCounts = {
  pending: number;
  running: number;
  planReady: number;
  needsAttention: number;
  done: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Restart-interrupted flow runs — derived, recoverable; see effectiveStatusExpr. */
  interrupted: number;
  total: number;
};

export async function getTaskCounts(
  db: Db,
  opts: { collapseByFlow?: boolean } = {},
): Promise<TaskCounts> {
  // Opt-in per-flow collapse mirrors listTasksWithProjectPaginated so the work-queue badges match
  // its cards. Off → raw GROUP BY tasks.status (sidebar/other callers keep per-task counts).
  const base = db
    .select({
      status: opts.collapseByFlow ? effectiveStatusExpr.as('status') : tasks.status,
      c: drizzleSql<number>`count(*)`.as('c'),
    })
    .from(tasks);
  const scoped = opts.collapseByFlow
    ? base
        .leftJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
        .where(isFlowRepresentative)
        .groupBy(effectiveStatusExpr)
    : base.groupBy(tasks.status);
  const rows = await scoped;

  const counts: TaskCounts = {
    pending: 0,
    running: 0,
    planReady: 0,
    needsAttention: 0,
    done: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    total: 0,
  };
  for (const r of rows) {
    const n = Number(r.c);
    counts.total += n;
    switch (r.status) {
      case 'pending':
        counts.pending = n;
        break;
      case 'running':
        counts.running = n;
        break;
      case 'plan_ready':
        counts.planReady = n;
        break;
      case 'needs_attention':
        counts.needsAttention = n;
        break;
      case 'done':
        counts.done = n;
        break;
      case 'completed':
        counts.completed = n;
        break;
      case 'failed':
        counts.failed = n;
        break;
      case 'cancelled':
        counts.cancelled = n;
        break;
      case 'interrupted':
        counts.interrupted = n;
        break;
    }
  }
  return counts;
}

export type TaskListCursor = { createdAt: string; id: string };

/** Derived (computed, never stored) statuses — the source for the filter-status union and runtime
 *  set just below, keeping those two co-located uses in lockstep. See task-queries/flow-collapse. */
const DERIVED_TASK_STATUS_LIST = ['interrupted'] as const;
/**
 * What a list/count query may FILTER on: persisted statuses plus the derived-only ones. Wider than
 * `TaskStatus` (the WRITABLE set) — the queue can ask for `interrupted`, nothing can persist it.
 */
export type TaskFilterStatus = TaskStatus | (typeof DERIVED_TASK_STATUS_LIST)[number];
const DERIVED_TASK_STATUSES: ReadonlySet<string> = new Set(DERIVED_TASK_STATUS_LIST);

export type ListTasksOptions = {
  status?: TaskFilterStatus;
  statuses?: TaskFilterStatus[];
  limit?: number;
  cursor?: TaskListCursor | null;
  /**
   * Work-queue per-flow collapse: keep ONE representative row per flow_run and filter by the flow's
   * EFFECTIVE status (see effectiveStatusExpr). Off by default — the sidebar and other callers keep
   * raw per-task rows (with flowRunStatus passthrough for their own reconciliation).
   */
  collapseByFlow?: boolean;
  workQueueSection?: WorkQueueSection;
};

export type TaskWithProjectRow = Task & {
  projectName: string | null;
  linkedChatId: string | null;
  flowRunStatus: string | null;
  /**
   * Per-flow-collapse display status (see effectiveStatusExpr): the flow's LIVE status for a flow
   * representative, else the task's own status. Renderer buckets/sorts/icons by this; mutations
   * still use raw `status`.
   */
  effectiveStatus: string;
};

/**
 * Paginated tasks + project metadata. `linkedChatId` = coalesce(anchor `chats.taskId`, per-task
 * `result->>'chatId'`); `flowRunStatus` joins flow_runs (sidebar suppresses stale `done`). */
/**
 * The status WHERE-clause for a list query, or undefined when no status filter was asked for.
 * Extracted from listTasksWithProjectPaginated to keep that function under its cognitive budget.
 *
 * Under collapseByFlow the filter is on the DERIVED effective status (so a running flow's `done`
 * anchor still buckets into Active); otherwise it is the raw task status. A derived-only status
 * (e.g. `interrupted`) is meaningless without collapseByFlow — the filter would degrade to
 * `tasks.status IN (<never-persisted value>)` and silently return zero rows — so we fail loud.
 */
function buildTaskStatusFilter(options: ListTasksOptions): SQL | undefined {
  const statusList = options.statuses?.length
    ? options.statuses
    : options.status
      ? [options.status]
      : undefined;
  if (!statusList?.length) return undefined;
  const derived = statusList.filter((s) => DERIVED_TASK_STATUSES.has(s));
  if (!options.collapseByFlow && derived.length > 0) {
    throw new Error(`Derived status filter (${derived.join(', ')}) requires collapseByFlow`);
  }
  return options.collapseByFlow
    ? drizzleSql`${effectiveStatusExpr} in (${drizzleSql.join(
        statusList.map((s) => drizzleSql`${s}`),
        drizzleSql`, `,
      )})`
    : inArray(tasks.status, statusList);
}
function buildStatusFilter(options: ListTasksOptions): SQL | undefined {
  if (!options.workQueueSection) return buildTaskStatusFilter(options);
  if (options.status || options.statuses?.length) {
    throw new Error('Work Queue section cannot be combined with status filters');
  }
  return getWorkQueueSectionFilter(options.workQueueSection);
}

export async function listTasksWithProjectPaginated(
  db: Db,
  options: ListTasksOptions,
): Promise<{ items: TaskWithProjectRow[]; hasMore: boolean; nextCursor: TaskListCursor | null }> {
  const { chats } = await import('../schema');
  const resultChat = alias(chats, 'result_chat');
  const limit = options.limit ?? 50;
  // Work-queue per-flow collapse (opt-in): keep only the flow representative, then filter on the
  // flow's EFFECTIVE status (so a running flow's `done` anchor still buckets into Active). Both
  // happen in WHERE — before limit/cursor — so pagination counts representatives, not raw rows.
  // Off → raw per-task behaviour (sidebar/other callers filter by the task's own status).
  const filters: SQL[] = [];
  if (options.collapseByFlow && !options.workQueueSection) filters.push(isFlowRepresentative);
  const statusFilter = buildStatusFilter(options);
  if (statusFilter) filters.push(statusFilter);
  if (options.cursor) {
    const cursorDate = new Date(options.cursor.createdAt);
    const cursorFilter = or(
      lt(tasks.createdAt, cursorDate),
      and(eq(tasks.createdAt, cursorDate), lt(tasks.id, options.cursor.id)),
    );
    if (cursorFilter) filters.push(cursorFilter);
  }

  const rows = await db
    .select({
      task: tasks,
      projectName: projects.name,
      linkedChatId: drizzleSql<string | null>`coalesce(${chats.id}, ${resultChat.id})`,
      flowRunStatus: flowRuns.status,
      effectiveStatus: effectiveStatusExpr.as('effective_status'),
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .leftJoin(chats, eq(chats.taskId, tasks.id))
    .leftJoin(resultChat, eq(resultChat.id, drizzleSql`json_extract(${tasks.result}, '$.chatId')`))
    .leftJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
    .where(and(...filters))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const items: TaskWithProjectRow[] = visible.map((r) => ({
    ...r.task,
    projectName: r.projectName ?? null,
    linkedChatId: r.linkedChatId ?? null,
    flowRunStatus: r.flowRunStatus ?? null,
    effectiveStatus: String(r.effectiveStatus ?? r.task.status),
  }));
  const last = items[items.length - 1];
  const nextCursor: TaskListCursor | null =
    hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null;
  return { items, hasMore, nextCursor };
}

export type TaskMutationFailureReason =
  | 'not_found'
  | 'invalid_state'
  | 'flow_shell_not_reassignable';

export type TaskMutationResult = {
  task: Task | null;
  reason?: TaskMutationFailureReason;
};

const CANCELLABLE_STATUSES: TaskStatus[] = ['pending', 'running', 'plan_ready', 'needs_attention'];
const DELETABLE_STATUSES: TaskStatus[] = [
  'pending',
  'plan_ready',
  'needs_attention',
  'done',
  'completed',
  'failed',
  'cancelled',
];

export async function cancelTaskDetailed(db: Db, taskId: string): Promise<TaskMutationResult> {
  // Atomic guard: WHERE includes the status predicate so a concurrent
  // recovery sweep / poller transitioning the task between read and write
  // is rejected by the UPDATE not matching, instead of silently overwriting.
  const updated = await db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date(), result: { cancelled: true } })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, CANCELLABLE_STATUSES)))
    .returning();
  if (updated.length > 0) return { task: updated[0] };
  const existing = await getTaskById(db, taskId);
  if (!existing) return { task: null, reason: 'not_found' };
  return { task: null, reason: 'invalid_state' };
}

export async function cancelAllPendingTasks(db: Db): Promise<{ cancelledCount: number }> {
  const rows = await db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date(), result: { cancelled: true } })
    .where(eq(tasks.status, 'pending'))
    .returning({ id: tasks.id });
  return { cancelledCount: rows.length };
}

/** Cancel a run's in-flight tasks; permanent deletion also sweeps parked work. */
export async function cancelFlowLinkedTasks(
  db: Db,
  flowRunId: string,
  includeParked = false,
): Promise<number> {
  const statuses = includeParked ? FLOW_DRIVING_STATUSES : (['pending', 'running'] as const);
  const rows = await db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date(), result: cancelResultPatch(false) })
    .where(and(eq(tasks.flowRunId, flowRunId), inArray(tasks.status, [...statuses])))
    .returning({ id: tasks.id });
  return rows.length;
}

/**
 * Accept a finished flow: flip the run's `done` rows to `completed`. Accepting only the queue's
 * representative row would leave a `done` sibling as the new representative (flowTaskRank ranks
 * done > completed), so the flow would never read `completed` — one accept covers the whole run.
 */
export async function completeDoneTasksForFlowRun(db: Db, flowRunId: string): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ status: 'completed', completedAt: new Date() })
    .where(and(eq(tasks.flowRunId, flowRunId), eq(tasks.status, 'done')))
    .returning({ id: tasks.id });
  return rows.length;
}

export async function completeAllDoneTasks(db: Db): Promise<{ completedCount: number }> {
  // Manual done tasks, plus done rows of run-COMPLETED flows (they surface as effective `done` /
  // Ready for review — see effectiveStatusExpr). Done rows under active/failed/cancelled runs stay
  // untouched: those flows don't surface as reviewable, so "Accept all" must not finalize them.
  const completedRunIds = db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(eq(flowRuns.status, 'completed'));
  const rows = await db
    .update(tasks)
    .set({ status: 'completed', completedAt: new Date() })
    .where(
      and(
        eq(tasks.status, 'done'),
        or(isNull(tasks.flowRunId), inArray(tasks.flowRunId, completedRunIds)),
      ),
    )
    .returning({ id: tasks.id });
  return { completedCount: rows.length };
}

type DeleteTaskFailureReason = 'not_found' | 'invalid_state';
export type DeleteTaskResult = { success: boolean; reason?: DeleteTaskFailureReason };

export async function deleteTaskDetailed(db: Db, taskId: string): Promise<DeleteTaskResult> {
  // Atomic guard against poller racing the user. If status changes between
  // the read and the delete, the WHERE no longer matches and we fall through
  // to the existence check.
  const removed = await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, DELETABLE_STATUSES)))
    .returning({ id: tasks.id });
  if (removed.length > 0) return { success: true };
  const existing = await getTaskById(db, taskId);
  if (!existing) return { success: false, reason: 'not_found' };
  return { success: false, reason: 'invalid_state' };
}

/**
 * Reassign a pending task to a different project. Flow-shell tasks (those
 * created by start_task / fan_out body chain dispatch — `triggerContext._config.executionMode === 'shell'` with `flow_run_id` set) cannot
 * be reassigned: the worktree provisioning is project-bound. Mirrors the
 * cloud guardrail.
 */
export async function reassignTaskDetailed(
  db: Db,
  taskId: string,
  targetProjectId: string,
): Promise<TaskMutationResult> {
  const existing = await getTaskById(db, taskId);
  if (!existing) return { task: null, reason: 'not_found' };
  if (existing.status !== 'pending') return { task: null, reason: 'invalid_state' };

  const tc = (existing.triggerContext as Record<string, unknown> | null) ?? null;
  const config =
    tc && typeof tc._config === 'object' && tc._config !== null
      ? (tc._config as Record<string, unknown>)
      : null;
  const isFlowShell = existing.flowRunId !== null && config?.executionMode === 'shell';
  if (isFlowShell) return { task: null, reason: 'flow_shell_not_reassignable' };

  // Atomic guard: WHERE pins status='pending' so the poller can't claim
  // the task between our read and the projectId UPDATE.
  const [updated] = await db
    .update(tasks)
    .set({ projectId: targetProjectId })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')))
    .returning();
  if (!updated) return { task: null, reason: 'invalid_state' };
  return { task: updated };
}

/**
 * plan_ready → running guarded transition. Returns invalid_state when the task
 * isn't in plan_ready (already running, completed, etc.).
 */
export async function startExecutionFromReviewDetailed(
  db: Db,
  taskId: string,
  machineId: string | null,
): Promise<TaskMutationResult> {
  // Atomic plan_ready → running: WHERE pins source status to prevent racing
  // the poller / a concurrent cancel.
  const updated = await db
    .update(tasks)
    .set({ status: 'running', startedAt: new Date(), executedBy: machineId ?? null })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'plan_ready')))
    .returning();
  if (updated.length > 0) return { task: updated[0] };
  const existing = await getTaskById(db, taskId);
  if (!existing) return { task: null, reason: 'not_found' };
  return { task: null, reason: 'invalid_state' };
}

export type RetryMode = 'continue' | 'restart';
const RETRYABLE_TASK_STATUSES = ['failed', 'needs_attention'] as const;

/** Canonical object reader shared by retry, park, claim, and signal consumers. */
export function parseResultRecord(result: Task['result']): TaskResultRecord {
  const parsed = taskResultSchema.safeParse(result);
  return parsed.success ? parsed.data : {};
}

/** Failure metadata cleared on retry so the next attempt cannot inherit stale failure state. */
const RETRY_STALE_RESULT_KEYS = [
  'error',
  'errorAction',
  'dispatchAttempts',
  'failureCode',
  'agentSignal',
  'staleExecution',
  'staleDetectedAt',
  'usageLimit',
  'apiError',
  'userPause',
  'cancelled',
  'retryPriorError',
] as const;

/**
 * Flip a failed/parked task to `pending`. The source-status CAS prevents a concurrent retry; an
 * optional Flow guard makes the same update conditional on its run remaining paused.
 * Scrubs stale failure metadata and records `retryMode` for the claim path:
 * 'continue' keeps the chat linkage so the executor resumes the persisted Claude session in the
 * same worktree; 'restart' drops `chatId`/`subChatId` so a fresh chat + worktree is provisioned.
 * The prior error text is preserved (truncated) as `retryPriorError` for the continuation prompt.
 */
export async function retryTaskDetailed(
  db: Db,
  taskId: string,
  mode: RetryMode,
  requirePausedFlowRunId?: string,
): Promise<TaskMutationResult> {
  const existing = await getTaskById(db, taskId);
  if (!existing) return { task: null, reason: 'not_found' };
  if (existing.status !== 'failed' && existing.status !== 'needs_attention') {
    return { task: null, reason: 'invalid_state' };
  }
  // Flow tasks restart via flows.restartRunFromBeginning (re-dispatches the run at start_task);
  // stripping this task's chat linkage alone would not restart the chain.
  if (mode === 'restart' && existing.flowRunId) {
    return { task: null, reason: 'invalid_state' };
  }

  const prior = parseResultRecord(existing.result);
  // The stop reason lives under `error` for failed tasks, but under `apiError`/`usageLimit` for
  // parked (needs_attention) ones — the continuation nudge needs whichever is present.
  const priorApiError = (prior.apiError as { message?: unknown } | undefined)?.message;
  const priorUsageLimit = (prior.usageLimit as { message?: unknown } | undefined)?.message;
  const priorErrorRaw = [prior.error, priorApiError, priorUsageLimit].find(
    (v): v is string => typeof v === 'string',
  );
  const priorError = priorErrorRaw ? priorErrorRaw.slice(0, 200) : null;
  const scrubbed: Record<string, unknown> = { ...prior };
  for (const key of RETRY_STALE_RESULT_KEYS) delete scrubbed[key];
  if (mode === 'restart') {
    delete scrubbed.chatId;
    delete scrubbed.subChatId;
  }

  const guard = pausedFlowRun(requirePausedFlowRunId);

  const [updated] = await db
    .update(tasks)
    .set({
      status: 'pending',
      startedAt: null,
      completedAt: null,
      result: {
        ...scrubbed,
        retryMode: mode,
        retryRequestedAt: new Date().toISOString(),
        ...(priorError ? { retryPriorError: priorError } : {}),
      },
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, RETRYABLE_TASK_STATUSES), guard))
    .returning();
  if (!updated) return { task: null, reason: 'invalid_state' };
  return { task: updated };
}

/** Boot sweep: tasks still 'running' from a prior process become cancelled + the restart marker (not an
 * error); `status='running'` is the sole signal — a stale completed_at from a lease re-claim never exempts a row. */
export type RecoveredOrphanedTask = Pick<Task, 'id' | 'flowRunId' | 'nodeRunId' | 'result'>;
export async function recoverOrphanedTasks(
  db: Db,
  cutoff: Date = new Date(),
): Promise<RecoveredOrphanedTask[]> {
  return db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date(), result: cancelResultPatch(true) })
    .where(
      and(eq(tasks.status, 'running'), or(isNull(tasks.startedAt), lt(tasks.startedAt, cutoff))),
    )
    .returning({
      id: tasks.id,
      flowRunId: tasks.flowRunId,
      nodeRunId: tasks.nodeRunId,
      result: tasks.result,
    });
}

/**
 * Finalize a run's still-active flow-linked tasks (pending/running) when the flow_run goes
 * terminal. Mirrors the cloud engine's cancelFlowLinkedTasks — without it a task re-dispatched
 * right as its run cancels can outlive the run as a stuck 'running' row (sidebar/work-queue
 * divergence). Called from advanceFlowRun's failed/cancelled branches alongside the node-run sweep.
 */
export async function cancelFlowLinkedTasksForRun(db: Db, flowRunId: string): Promise<number> {
  const rows = await db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(tasks.flowRunId, flowRunId), inArray(tasks.status, ['pending', 'running'])))
    .returning({ id: tasks.id });
  return rows.length;
}

/**
 * Terminalize the flow task driving a sub-chat when its execution is torn down *while the app keeps
 * running* (renderer reload/crash, or a manual Stop) — the boot sweep (`recoverOrphanedTasks`) only
 * fires on a fresh process, so without this a torn-down flow stays stranded `running`/`paused` until
 * the next restart. Cancelling the task lets the task-completion-watcher advance the flow at once.
 *
 * `interrupted` controls recoverability: an *interrupted* teardown (reload/crash) stamps
 * RESTART_INTERRUPTION_REASON so the run panel offers "Re-run from previous node"; a deliberate Stop
 * (`interrupted: false`) omits the marker so re-run is correctly NOT offered. No-op for an interactive
 * (non-flow) chat — `getFlowDriveInfoForSubChat` returns no task. The status CAS in the WHERE avoids
 * clobbering a task that raced to terminal between the read and the write. Returns the cancelled id.
 */
export async function cancelFlowTaskForSubChat(
  db: Db,
  subChatId: string,
  opts: { interrupted: boolean },
): Promise<string | null> {
  const { taskId } = await getFlowDriveInfoForSubChat(db, subChatId);
  if (!taskId) return null;
  const rows = await db
    .update(tasks)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      result: cancelResultPatch(opts.interrupted),
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, [...FLOW_DRIVING_STATUSES])))
    .returning({ id: tasks.id });
  return rows[0]?.id ?? null;
}
