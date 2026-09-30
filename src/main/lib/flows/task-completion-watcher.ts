/**
 * Polls flow-linked tasks every 2s and advances their owning flow run when
 * the task reaches a terminal status.
 *
 * In-memory `advancedTaskIds` is a PERF HINT only — it skips the no-op SQL UPDATE
 * for tasks already processed this process. It is NOT a correctness guard: it is
 * wiped on restart, so idempotency relies on `advanceFlowRun`'s node_run CAS
 * (status-IN guard) — a re-advance of an already-terminal node matches 0 rows and
 * bails before re-walking edges. Do not re-trust this set for dedup.
 *
 * Replaces the cloud queue's `flow/advance` job for single-machine local mode.
 */

import { and, sql as drizzleSql, eq, inArray, isNotNull } from 'drizzle-orm';
import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../db';
import { getTaskById, parseResultRecord } from '../db/repos/tasks';
import type { Task } from '../db/schema';
import { tasks } from '../db/schema';
import { captureMainException } from '../sentry/init';
import { resolveTaskSignalTransition } from '../trpc/routers/frink-task-signal';
import { advanceFlowRun } from './advance';
import { isTerminalTaskStatus, mapTaskToNodeOutput } from './signal-bridge';

const POLL_INTERVAL_MS = 2_000;

/** Quiet turn-end (`result.quietEndedAt`) → park ceiling. Must exceed the longest legitimate silent
 * wait (45+ min suites); a park that does fire is undone by activity (resumeQuietIdleParkOnBurst). */
export const QUIET_IDLE_PARK_CEILING_MS = 45 * 60_000;

const QUIET_IDLE_PARK_SUMMARY = `Run went quiet without a completion signal and showed no further activity for ${QUIET_IDLE_PARK_CEILING_MS / 60_000} minutes — the agent may have been waiting on background work that never completed. Reply to resume the agent, or stop the run.`;
const TERMINAL_STATUSES = [
  'completed',
  'done',
  'failed',
  'cancelled',
  'plan_ready',
  'needs_attention',
];

const advancedTaskIds = new Set<string>();
/** Tasks already reported as dispatched-but-never-executed this process (warn once each). */
const reportedNeverExecuted = new Set<string>();
/** Tasks already reported as terminal-but-unadvanced (node still active) this process. */
const reportedStranded = new Set<string>();
const ACTIVE_NODE_RUN_STATUSES = new Set(['running', 'awaiting_input', 'blocked']);

let interval: NodeJS.Timeout | null = null;

/** Evict a task from the advanced-set so the watcher advances it AGAIN on its next terminal status:
 * a node resumed in place would otherwise have the agent's later `done` deduped away. */
export function forgetAdvancedTask(taskId: string): void {
  advancedTaskIds.delete(taskId);
}

/**
 * Re-open the flow side after a LATE WAKE SIGNAL superseded a quiet-idle park
 * (persistLinkedTaskSignal): the park advanced the node to awaiting_input and paused the run, so
 * the watcher must be allowed to advance this task again (forget) and the run must leave `paused`
 * (CAS — only a still-paused run re-opens; anything else means another writer owns it). The node
 * stays `awaiting_input`: advanceFlowRun's status-IN CAS admits it, so the next poll advances it
 * straight to the signal's terminal output.
 */
export async function unparkQuietIdleFlowRun(
  db: ReturnType<typeof getDatabase>,
  taskId: string,
  flowRunId: string,
): Promise<void> {
  forgetAdvancedTask(taskId);
  const { setFlowRunStatus } = await import('../db/repos/flow-runs');
  await setFlowRunStatus(db, flowRunId, 'running', {}, 'paused');
}

/**
 * Parks tasks that quiet-ended (stream over, no signal, no abort) and then showed no further
 * activity for the idle ceiling. `quietEndedAt` older than `startedAt` is a stale marker from a
 * previous run of a since-resumed task and is ignored — the resume flip refreshes `startedAt`,
 * so a resumed task always gets the full ceiling again. Covers flow-linked AND plain task chats:
 * both defer their quiet parking here (executor writes the marker, renderer policy stands down).
 */
async function sweepQuietIdleTasks(db: ReturnType<typeof getDatabase>): Promise<void> {
  const running: Task[] = await db.select().from(tasks).where(eq(tasks.status, 'running'));
  const now = Date.now();
  for (const task of running) {
    await reportDispatchedButNeverExecuted(task, now);
    const marker = expiredQuietMarker(task, now);
    if (!marker) continue;
    if (await waitIsAttended(task, now)) continue;
    try {
      await parkQuietIdleTask(db, task, marker);
    } catch (err) {
      log.warn('[FlowsWatcher] quiet-idle park failed', { taskId: task.id, err });
      const { captureMainMessage } = await import('../sentry/init');
      captureMainMessage('Quiet-idle park failed', 'warning', { taskId: task.id });
    }
  }
}

/** The task's quiet-end marker when its idle ceiling has expired — null when the task is not
 * quiet-idle: a recorded signal means the turn is completing (the post-stream terminal flip owns
 * it); a marker older than `startedAt` is stale from a previous run of a since-resumed task. */
function expiredQuietMarker(task: Task, now: number): string | null {
  const result = parseResultRecord(task.result);
  if (result.agentSignal) return null;
  const quietEndedAtRaw = result.quietEndedAt;
  if (typeof quietEndedAtRaw !== 'string') return null;
  const quietEndedAt = Date.parse(quietEndedAtRaw);
  if (Number.isNaN(quietEndedAt)) return null;
  if (task.startedAt && quietEndedAt < task.startedAt.getTime()) return null;
  return now - quietEndedAt >= QUIET_IDLE_PARK_CEILING_MS ? quietEndedAtRaw : null;
}

/** The sub-chat of a flow task past the ceiling with no turn recorded: no signal and no quiet-end
 * marker from THIS run (a marker older than `startedAt` is a retry's leftover, like expiredQuietMarker). */
function unrecordedFlowTurnSubChat(task: Task, now: number): string | undefined {
  const startedAt = task.startedAt?.getTime() ?? now;
  if (!task.flowRunId || now - startedAt < QUIET_IDLE_PARK_CEILING_MS) return undefined;
  const result = parseResultRecord(task.result);
  const quietEndedAt = Date.parse(z.string().safeParse(result.quietEndedAt).data ?? '');
  if (result.agentSignal || quietEndedAt >= startedAt) return undefined;
  return z.string().safeParse(result.subChatId).data;
}

/** Telemetry only: such a task with neither a busy session nor an execution was dispatched
 * (task:chat-ready) but never sent — name it once in main.log + Sentry; recovery is not main's. */
async function reportDispatchedButNeverExecuted(task: Task, now: number): Promise<void> {
  const subChatId = reportedNeverExecuted.has(task.id)
    ? undefined
    : unrecordedFlowTurnSubChat(task, now);
  if (!subChatId) return;
  reportedNeverExecuted.add(task.id); // claim before awaiting: overlapping ticks must not double-report
  const [{ getSession }, { getActiveExecution }] = await Promise.all([
    import('../socket/claude-session-registry'),
    import('../socket/streaming/execution-registry'),
  ]);
  if (getSession(subChatId)?.busy || getActiveExecution(subChatId)) {
    reportedNeverExecuted.delete(task.id);
    return;
  }
  const flowRunId = task.flowRunId;
  log.warn('[FlowsWatcher] flow task dispatched but never executed', {
    taskId: task.id,
    subChatId,
    flowRunId,
  });
  captureMainException(new Error('Flow dispatch never executed'), {
    surface: 'flow-task-completion-watcher',
    stage: 'dispatch-never-executed',
  });
}

/** True while a live Claude session on the task's chat (turn in flight, or the between-turn wake
 * pump armed for pending background work) shows RECENT activity — the harness can still wake the
 * agent, so parking would convert a real wait into a false needs_attention. Recency matters: a
 * dead-but-armed pump (the wake never arrives) stays `busy` forever and would otherwise block the
 * ceiling whose whole purpose is catching a dead wake pipeline; healthy pumps refresh
 * `lastActiveAt` on every burst, so a silent one stops counting as attended after the same
 * ceiling. Dynamic import mirrors broadcastQuietParkUpdate's cycle-breaking (flows → socket). */
async function waitIsAttended(task: Task, now: number): Promise<boolean> {
  const result = parseResultRecord(task.result);
  const subChatId = typeof result.subChatId === 'string' ? result.subChatId : null;
  if (!subChatId) return false;
  const { getSession } = await import('../socket/claude-session-registry');
  const session = getSession(subChatId);
  return !!session?.busy && now - session.lastActiveAt < QUIET_IDLE_PARK_CEILING_MS;
}

/**
 * Parks one ceiling-expired quiet task. Every write is ATOMIC on the observed marker: the WHERE
 * requires the exact `quietEndedAt` the sweep snapshot saw, so a concurrent turn-start clear (or a
 * signal write — both remove the marker) makes the park match 0 rows instead of parking a live turn.
 */
async function parkQuietIdleTask(
  db: ReturnType<typeof getDatabase>,
  task: Task,
  quietEndedAtRaw: string,
): Promise<void> {
  const markerStillPresent = drizzleSql`json_extract(${tasks.result}, '$.quietEndedAt') = ${quietEndedAtRaw}`;
  const transition = resolveTaskSignalTransition(task, {
    state: 'missing_completion_signal',
    summary: QUIET_IDLE_PARK_SUMMARY,
    at: new Date().toISOString(),
  });
  const [updated] = await db
    .update(tasks)
    .set({ status: transition.status, completedAt: new Date(), result: transition.result })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, 'running'), markerStillPresent))
    .returning({ id: tasks.id });
  if (updated) await broadcastQuietParkUpdate(task, transition.status);
}

/** The broadcast persistLinkedTaskSignal would send (task-list self-heal), once the quiet park lands.
 * Dynamic import on purpose — socket/client → executor → flows is a static cycle. */
async function broadcastQuietParkUpdate(task: Task, status: string): Promise<void> {
  // fallow-ignore-next-line circular-dependency
  const { broadcastTaskSignalPersisted } = await import('../socket/client');
  broadcastTaskSignalPersisted({
    taskId: task.id,
    status,
    isFlowLinked: Boolean(task.flowRunId),
  });
}

/** Exported for tests; production drives it via the interval in startTaskCompletionWatcher. */
export async function tick(): Promise<void> {
  const db = getDatabase();
  await sweepQuietIdleTasks(db);
  const rows: Task[] = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.flowRunId),
        isNotNull(tasks.nodeRunId),
        inArray(tasks.status, TERMINAL_STATUSES),
      ),
    );

  for (const task of rows) {
    if (advancedTaskIds.has(task.id) || !isTerminalTaskStatus(task.status)) continue;
    advancedTaskIds.add(task.id);
    await advanceTerminalTask(db, task);
  }
}

/** Advance one terminal task's node under the row guard; evict the dedup entry when the row moved
 * under the snapshot (resumed mid-park) so its next terminal row advances afresh. */
async function advanceTerminalTask(db: ReturnType<typeof getDatabase>, task: Task): Promise<void> {
  const flowRunId = task.flowRunId;
  const nodeRunId = task.nodeRunId;
  if (!flowRunId || !nodeRunId) return;
  try {
    const output = mapTaskToNodeOutput(task);
    const { withFlowResourceCleanup } = await import('./admission/activity');
    const guard = { id: task.id, status: task.status, result: task.result };
    const advanced = await withFlowResourceCleanup(flowRunId, () =>
      advanceFlowRun(flowRunId, nodeRunId, output, guard),
    );
    if (advanced) return;
    // An identical row means the NODE was already terminal instead — keep the dedup entry.
    const fresh = await getTaskById(db, task.id);
    if (fresh && !sameTaskRow(fresh, task)) advancedTaskIds.delete(task.id);
    else await reportIfNodeStranded(db, task, nodeRunId);
  } catch (err) {
    captureMainException(err, { surface: 'flow-task-completion-watcher', stage: 'advance' });
    log.warn('[FlowsWatcher] advanceFlowRun threw', { taskId: task.id, flowRunId, nodeRunId, err });
    advancedTaskIds.delete(task.id);
  }
}

/**
 * The dedup entry is kept on the premise that the node is already terminal. When it is NOT, the
 * task will never be retried and its run stalls with no error — say so, once per task.
 */
async function reportIfNodeStranded(
  db: ReturnType<typeof getDatabase>,
  task: Task,
  nodeRunId: string,
): Promise<void> {
  if (reportedStranded.has(task.id)) return;
  const { getNodeRun } = await import('../db/repos/node-runs');
  const node = await getNodeRun(db, nodeRunId);
  if (!node || !ACTIVE_NODE_RUN_STATUSES.has(node.status)) return;
  reportedStranded.add(task.id);
  const context = {
    taskId: task.id,
    taskStatus: task.status,
    flowRunId: task.flowRunId ?? 'unknown',
    nodeRunId,
    nodeStatus: node.status,
  };
  log.warn('[FlowsWatcher] terminal task did not advance its still-active node', context);
  const { captureMainMessage } = await import('../sentry/init');
  captureMainMessage('Flow node stranded behind a terminal task', 'warning', context);
}

function sameTaskRow(a: Task, b: Task): boolean {
  return a.status === b.status && JSON.stringify(a.result) === JSON.stringify(b.result);
}

export function startTaskCompletionWatcher(): void {
  if (interval) return;
  interval = setInterval(() => {
    tick().catch((err) => log.warn('[FlowsWatcher] tick failed', { err }));
  }, POLL_INTERVAL_MS);
}

export function stopTaskCompletionWatcher(): void {
  if (interval) clearInterval(interval);
  interval = null;
  advancedTaskIds.clear();
  reportedNeverExecuted.clear();
  reportedStranded.clear();
}
