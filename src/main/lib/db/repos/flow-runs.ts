import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, not, or, sql } from 'drizzle-orm';
import { union, unionAll } from 'drizzle-orm/sqlite-core';
import { FLOW_DRIVING_STATUSES, SIGNAL_DEAD_RUN_STATUSES } from '../../../../shared/types/flow';
import { fanOutItemChatRunIds, isPastFanOutLane } from '../../flows/fan-out/sql';
import type { getDatabase } from '../index';
import {
  type Chat,
  chats,
  type FlowRun,
  flowRuns,
  flowVersions,
  type NewFlowRun,
  nodeRuns,
  tasks,
} from '../schema';
import type { TaskStatus } from './tasks';
import { chatLinkId, linkedFlowRunIds } from './task-queries/linked-flow-runs';
import {
  activeFlowRunForSubChatId,
  newestFlowRunForSubChatId,
} from './task-queries/subchat-driver';

type Db = ReturnType<typeof getDatabase>;

export type FlowRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/**
 * True when the run is in a state where none of its tasks can still accept an agent signal — the
 * executor's cue to disarm the task-signal apparatus (see `SIGNAL_DEAD_RUN_STATUSES` for why
 * `failed`/`paused` are excluded). `false` for a null id: a task whose run row was deleted
 * (`flow_run_id` FK is `onDelete: 'set null'`) keeps whatever its own status implies.
 */
export async function isFlowRunSignalDead(db: Db, flowRunId: string | null): Promise<boolean> {
  if (!flowRunId) return false;
  const [row] = await db
    .select({ status: flowRuns.status })
    .from(flowRuns)
    .where(and(eq(flowRuns.id, flowRunId), inArray(flowRuns.status, [...SIGNAL_DEAD_RUN_STATUSES])))
    .limit(1);
  return Boolean(row);
}

/** The newest run linked to a sub-chat in ANY status, or null when none exists (never linked, or
 * deleted). {@link getActiveFlowRunForSubChat} without its status filter; same lookup and ordering. */
export async function getNewestFlowRunForSubChat(
  db: Db,
  subChatId: string,
): Promise<{ id: string; status: string } | null> {
  if (!subChatId) return null;
  const [row] = await newestFlowRunForSubChatId(db, subChatId);
  return row ?? null;
}

/** Display priority among active flow-driving statuses; highest wins when a run has several. */
const FLOW_DRIVING_PRIORITY: Record<string, number> = {
  needs_attention: 4,
  plan_ready: 3,
  running: 2,
  pending: 1,
};

/**
 * Highest-priority active flow-driving task status per flow_run. Lets the flow-runs UI relabel a
 * `paused` run that is actually working — the engine parks a run at `paused` on every
 * `awaiting_input` async agent hand-off, so `flow_run.status` alone reads "Paused" while an agent
 * runs. Absent for runs with no driving task (genuinely idle / awaiting approval with no task).
 */
export async function getActiveFlowDrivingStatusByRun(
  db: Db,
  flowRunIds: string[],
): Promise<Map<string, TaskStatus>> {
  if (flowRunIds.length === 0) return new Map();
  const rows = await db
    .select({ flowRunId: tasks.flowRunId, status: tasks.status })
    .from(tasks)
    .where(
      and(inArray(tasks.flowRunId, flowRunIds), inArray(tasks.status, [...FLOW_DRIVING_STATUSES])),
    );
  const map = new Map<string, TaskStatus>();
  for (const r of rows) {
    if (!r.flowRunId) continue;
    const current = map.get(r.flowRunId);
    if (
      !current ||
      (FLOW_DRIVING_PRIORITY[r.status] ?? 0) > (FLOW_DRIVING_PRIORITY[current] ?? 0)
    ) {
      map.set(r.flowRunId, r.status);
    }
  }
  return map;
}

/**
 * Atomic idempotency: returns the existing run if `idempotencyKey` already maps to one;
 * otherwise inserts and returns the new row. SELECT + INSERT run inside BEGIN IMMEDIATE
 * so two concurrent triggers with the same key serialize at the lock boundary.
 *
 * When `idempotencyKey` is null/undefined, falls back to a plain insert (no lookup).
 */
export async function getOrCreateFlowRunByIdempotencyKey(
  db: Db,
  input: NewFlowRun,
): Promise<{ run: FlowRun; isReplay: boolean }> {
  if (!input.idempotencyKey) {
    const [row] = await db.insert(flowRuns).values(input).returning();
    return { run: row, isReplay: false };
  }
  return db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(flowRuns)
        .where(eq(flowRuns.idempotencyKey, input.idempotencyKey as string))
        .limit(1)
        .all();
      if (existing[0]) return { run: existing[0], isReplay: true };
      const inserted = tx.insert(flowRuns).values(input).returning().all();
      return { run: inserted[0], isReplay: false };
    },
    { behavior: 'immediate' },
  );
}

export async function getFlowRun(db: Db, id: string): Promise<FlowRun | null> {
  const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, id)).limit(1);
  return row ?? null;
}

/** True if any flow_run for `flowId` is in an active status (pending/running/paused). */
export async function hasActiveRunForFlow(db: Db, flowId: string): Promise<boolean> {
  const { flowVersions } = await import('../schema');
  const rows = await db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .where(
      and(
        eq(flowVersions.flowId, flowId),
        or(
          eq(flowRuns.status, 'pending'),
          eq(flowRuns.status, 'running'),
          eq(flowRuns.status, 'paused'),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The chat-id projection for each of the THREE chat↔run JSON link sources (no FK). Centralised so the
 * readers that resolve a chat FROM a run (getBatchIdByChatId, listChatsByBatch) cannot drift on
 * which sources they cover. The third source is load-bearing: in a
 * multi-agent run, `linkChatToTask` is first-agent-wins, so a NON-anchor (branch) chat's only link is
 * `tasks.result.$.chatId`. Selecting these requires `leftJoin(nodeRuns)` + `leftJoin(tasks)` +
 * `selectDistinct` (to dedupe the fan-out).
 */
export const CHAT_LINK_SOURCES = {
  triggerChatId: chatLinkId(flowRuns.triggerContext, '$.chatId'),
  nodeChatId: chatLinkId(nodeRuns.nodeOutput, '$.outputs.chatId'),
  taskChatId: chatLinkId(tasks.result, '$.chatId'),
} as const;

/**
 * Active runs linked to a chat. Callers cancel these explicitly (no FK cascade); terminal-run residue
 * is cleaned at the task boundary instead.
 */
export async function listActiveFlowRunIdsForChat(db: Db, chatId: string): Promise<string[]> {
  const rows = await db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(
      and(
        inArray(flowRuns.status, ['pending', 'running', 'paused']),
        inArray(flowRuns.id, linkedFlowRunIds(db, 'chatId', chatId)),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Flow runs linked to a chat that have NOT fully completed (status != 'completed') — i.e. still
 * pending/running/paused OR terminally failed/cancelled. Used to suppress chat rollback until the
 * whole flow truly finishes: a mid-flow OR failed run leaves node_runs desynced, so rewinding only
 * the chat/code would strand the flow graph. Same JSON-only chat link as listActiveFlowRunIdsForChat.
 */
export async function listIncompleteFlowRunIdsForChat(db: Db, chatId: string): Promise<string[]> {
  const rows = await db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(
      and(
        ne(flowRuns.status, 'completed'),
        inArray(flowRuns.id, linkedFlowRunIds(db, 'chatId', chatId)),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * The newest flow_run linked to a chat REGARDLESS of status — including terminal (cancelled/failed)
 * runs that `listActiveFlowRunIdsForChat`/`listIncompleteFlowRunIdsForChat` filter out. Powers the
 * in-chat flow-state banner, which must surface a `cancelled` run to offer resume. Same JSON-only
 * chat link (trigger_context.$.chatId, node_output.$.outputs.chatId, or tasks.result.$.chatId);
 * newest by createdAt. `null` for a chat with no flow run.
 */
export async function getLatestFlowRunForChat(db: Db, chatId: string): Promise<FlowRun | null> {
  const [row] = await db
    .select()
    .from(flowRuns)
    .where(inArray(flowRuns.id, linkedFlowRunIds(db, 'chatId', chatId)))
    .orderBy(desc(flowRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * chatIds that have a NON-TERMINAL flow_run (pending/running/paused) — lets the
 * sidebar persist a 'Run' badge for the whole life of a flow, including taskless windows (before
 * the first agent task exists, or while a non-agent node runs) where no tracked task drives it.
 * Resolves the chat via every link source so a gap is covered: trigger_context.$.chatId,
 * node_output.$.outputs.chatId, AND tasks.result.$.chatId (a run's completed/done task still
 * carries it). A link made inside a Fan Out item the loop has moved past does not count.
 */
export async function listChatIdsWithActiveFlowRun(db: Db): Promise<string[]> {
  const live = inArray(flowRuns.status, ['pending', 'running', 'paused']);
  const rows = await union(
    db
      .select({ chatId: chatLinkId(flowRuns.triggerContext, '$.chatId') })
      .from(flowRuns)
      .where(live),
    db
      .select({ chatId: chatLinkId(nodeRuns.nodeOutput, '$.outputs.chatId') })
      .from(nodeRuns)
      .innerJoin(flowRuns, eq(flowRuns.id, nodeRuns.flowRunId))
      .where(and(live, not(isPastFanOutLane(nodeRuns.id)))),
    db
      .select({ chatId: chatLinkId(tasks.result, '$.chatId') })
      .from(tasks)
      .innerJoin(flowRuns, eq(flowRuns.id, tasks.flowRunId))
      .where(and(live, not(isPastFanOutLane(tasks.nodeRunId)))),
  );
  return rows.flatMap((row) => (row.chatId ? [row.chatId] : []));
}

/** The live run driving a sub-chat. */
export type ActiveFlowRunRef = { id: string };

/**
 * The newest NON-TERMINAL flow run driving a sub-chat. Resolved from the RUN side so it survives the
 * taskless windows no task row can represent: between two agent nodes (node N's task goes terminal
 * seconds before node N+1's is created, and `result.subChatId` is only stamped later, when the
 * executor claims it), while a non-agent node runs, and before the first task exists. The chat's
 * bottom surface takes LIVENESS from this and only picks WHICH surface from the driving task.
 *
 * Same three JSON link sources as `CHAT_LINK_SOURCES`, sub-chat-scoped: `node_output` spans the run's
 * whole life (every agent node hard-requires an upstream start_task that emits subChatId), and
 * `tasks.result` keeps this a SUPERSET of `getFlowDriveInfoForSubChat` — a narrower set would resolve
 * a driving task with no run and hand the composer back from the other side. A Fan Out item the loop
 * has moved past is no longer driven, so its chat gets the composer back. Newest by createdAt, so
 * a flow chat reused across runs reports the CURRENT run, never the previous one. Sub-chat-scoped,
 * not chat-scoped: a user-added sub-chat on a flow chat must keep its composer.
 */
export async function getActiveFlowRunForSubChat(
  db: Db,
  subChatId: string,
): Promise<ActiveFlowRunRef | null> {
  if (!subChatId) return null;
  const [row] = await activeFlowRunForSubChatId(db, subChatId);
  return row ?? null;
}

/** A group is keyed by its batch, or by the run itself when it is not batched. */
const GROUP_KEY = { groupId: sql<string>`coalesce(${flowRuns.batchId}, ${flowRuns.id})` };

/** Runs the sidebar folds into one group: batch members, and Fan Out runs that opened item chats.
 * UNION ALL + a Set: SQLite plans a UNION as a sorted merge that scans every node_run. */
async function listGroupedRunIds(db: Db): Promise<string[]> {
  const rows = await unionAll(
    db.select({ id: flowRuns.id }).from(flowRuns).where(isNotNull(flowRuns.batchId)),
    db.select({ id: sql<string>`flow_run_id` }).from(sql`(${fanOutItemChatRunIds})`),
  );
  return [...new Set(rows.map((row) => row.id))];
}

/** chatId → sidebar group key (`batchId`, or the id of a Fan Out run that opened item chats). A chat
 * linked to several grouped runs resolves to the NEWEST run's group, deterministic across refetches. */
export async function getBatchIdByChatId(db: Db): Promise<Map<string, string>> {
  const runIds = await listGroupedRunIds(db);
  if (runIds.length === 0) return new Map();
  const grouped = inArray(flowRuns.id, runIds);
  const run = { ...GROUP_KEY, createdAt: flowRuns.createdAt };
  const { triggerChatId, nodeChatId, taskChatId } = CHAT_LINK_SOURCES;
  const rows = await union(
    db
      .select({ chatId: triggerChatId, ...run })
      .from(flowRuns)
      .where(grouped),
    db
      .select({ chatId: nodeChatId, ...run })
      .from(flowRuns)
      .innerJoin(nodeRuns, eq(nodeRuns.flowRunId, flowRuns.id))
      .where(grouped),
    db
      .select({ chatId: taskChatId, ...run })
      .from(flowRuns)
      .innerJoin(tasks, eq(tasks.flowRunId, flowRuns.id))
      .where(grouped),
  );
  const best = new Map<string, { groupId: string; at: number }>();
  for (const { chatId, groupId, createdAt } of rows) {
    const at = createdAt?.getTime() ?? 0;
    const cur = chatId ? best.get(chatId) : undefined;
    if (chatId && (!cur || at > cur.at || (at === cur.at && groupId > cur.groupId)))
      best.set(chatId, { groupId, at });
  }
  return new Map([...best].map(([chatId, v]) => [chatId, v.groupId]));
}

/**
 * Non-archived chats in one sidebar group — the inverse of `getBatchIdByChatId`. A batch lists its
 * most recently active chats first; a Fan Out run lists its chats in the order the run opened them.
 */
export async function listChatsByBatch(db: Db, groupId: string): Promise<Chat[]> {
  const fanOutRun = await db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(and(eq(flowRuns.id, groupId), isNull(flowRuns.batchId)));
  const linkRows = await db
    .selectDistinct(CHAT_LINK_SOURCES)
    .from(flowRuns)
    .leftJoin(nodeRuns, eq(nodeRuns.flowRunId, flowRuns.id))
    .leftJoin(tasks, eq(tasks.flowRunId, flowRuns.id))
    .where(fanOutRun.length > 0 ? eq(flowRuns.id, groupId) : eq(flowRuns.batchId, groupId));
  const ids = new Set<string>();
  for (const r of linkRows) {
    if (r.triggerChatId) ids.add(r.triggerChatId);
    if (r.nodeChatId) ids.add(r.nodeChatId);
    if (r.taskChatId) ids.add(r.taskChatId);
  }
  if (ids.size === 0) return [];
  return db
    .select()
    .from(chats)
    .where(and(inArray(chats.id, Array.from(ids)), isNull(chats.archivedAt)))
    .orderBy(
      ...(fanOutRun.length > 0
        ? [asc(chats.createdAt), asc(sql`chats.rowid`)]
        : [desc(chats.updatedAt), desc(chats.id)]),
    );
}

/** Earliest run of a batch — pins the flow version the whole batch executes against. */
export async function getEarliestRunForBatch(db: Db, batchId: string): Promise<FlowRun | null> {
  const [row] = await db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.batchId, batchId))
    .orderBy(flowRuns.createdAt)
    .limit(1);
  return row ?? null;
}

/** Idempotency lookup: same key returns the existing run (cloud parity). */
export async function getFlowRunByIdempotencyKey(
  db: Db,
  idempotencyKey: string,
): Promise<FlowRun | null> {
  const [row] = await db
    .select()
    .from(flowRuns)
    .where(eq(flowRuns.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

/**
 * List runs across every version of a flow (cloud parity — `listFlowRuns(flowId)`).
 * Joins flow_versions so the renderer can show historical runs after the user
 * saves a new version of the same flow.
 */
export async function listFlowRunsForFlow(
  db: Db,
  flowId: string,
  limit: number,
): Promise<FlowRun[]> {
  return db
    .select({
      id: flowRuns.id,
      flowVersionId: flowRuns.flowVersionId,
      status: flowRuns.status,
      triggerContext: flowRuns.triggerContext,
      idempotencyKey: flowRuns.idempotencyKey,
      batchId: flowRuns.batchId,
      startedAt: flowRuns.startedAt,
      completedAt: flowRuns.completedAt,
      createdAt: flowRuns.createdAt,
    })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowRuns.createdAt), desc(flowRuns.id))
    .limit(limit);
}

/**
 * Newest ACTIVE run (running|paused|pending) per flow, batched to avoid an N+1 across the flows
 * list. Joins flow_versions (flow_runs has no flowId). SQLite has no DISTINCT ON, so fetch active
 * runs newest-first and keep the first row per flowId. Flows with no active run are absent.
 * Active = the renderer's "live" set; a newer completed run must not mask an older still-running
 * one (concurrent runs are possible — there is no single-active-run guard).
 *
 * `activeTaskStatus` carries the run's highest-priority active driving-task status so the dashboard
 * can relabel a `paused`-but-working run as "Running" via `flowRunDisplayStatus` — the engine parks
 * a run at `paused` on every async agent hand-off (same relabel the Run History panel applies).
 */
export async function getLatestRunsForFlows(
  db: Db,
  flowIds: string[],
): Promise<Map<string, { id: string; status: string; activeTaskStatus: string | null }>> {
  const map = new Map<string, { id: string; status: string; activeTaskStatus: string | null }>();
  if (flowIds.length === 0) return map;
  const { flowVersions } = await import('../schema');
  const rows = await db
    .select({ flowId: flowVersions.flowId, id: flowRuns.id, status: flowRuns.status })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .where(
      and(
        inArray(flowVersions.flowId, flowIds),
        inArray(flowRuns.status, ['running', 'paused', 'pending']),
      ),
    )
    .orderBy(desc(flowRuns.createdAt), desc(flowRuns.id));
  const latest = new Map<string, { id: string; status: string }>();
  for (const r of rows) {
    if (!latest.has(r.flowId)) latest.set(r.flowId, { id: r.id, status: r.status });
  }
  const activeByRun = await getActiveFlowDrivingStatusByRun(
    db,
    [...latest.values()].map((v) => v.id),
  );
  for (const [flowId, v] of latest) {
    map.set(flowId, { ...v, activeTaskStatus: activeByRun.get(v.id) ?? null });
  }
  return map;
}

export async function setFlowRunStatus(
  db: Db,
  id: string,
  status: FlowRunStatus,
  patch: { startedAt?: Date | null; completedAt?: Date | null } = {},
  /** CAS guard: only apply when the run currently has one of these statuses; null otherwise. */
  expectedStatus?: FlowRunStatus | readonly FlowRunStatus[],
): Promise<FlowRun | null> {
  const [row] = await db
    .update(flowRuns)
    .set({ status, ...patch })
    .where(
      expectedStatus
        ? and(eq(flowRuns.id, id), inArray(flowRuns.status, [expectedStatus].flat()))
        : eq(flowRuns.id, id),
    )
    .returning();
  return row ?? null;
}

/**
 * Recovery sweep: any flow_run still 'running' that started before the current
 * process boot gets marked cancelled — a restart interruption is not a flow error
 * (this is the non-agent running-node case; the dominant agent case stays 'paused'
 * here and is terminalized via the task sweep + watcher). The `startedAt < cutoff`
 * guard prevents the sweep from killing runs that were legitimately started after
 * boot but before this function awaited (defensive — recoverOrphans should be called
 * once pre-engine-boot, but the guard keeps the sweep safe if call ordering changes).
 */
export async function recoverOrphanedFlowRuns(db: Db, cutoff: Date = new Date()): Promise<number> {
  const rows = await db
    .update(flowRuns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        eq(flowRuns.status, 'running'),
        or(isNull(flowRuns.startedAt), lt(flowRuns.startedAt, cutoff)),
      ),
    )
    .returning({ id: flowRuns.id });
  return rows.length;
}
