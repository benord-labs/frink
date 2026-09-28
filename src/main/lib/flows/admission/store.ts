import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  FLOW_ADMISSION_STATES,
  type FlowAdmissionIntentV1,
  type FlowAdmissionState,
  isFlowAdmissionIntentV1,
} from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import {
  batchStageRuns,
  flowRunAdmissions,
  flowRuns,
  nodeRuns,
  subChats,
  tasks,
} from '../../db/schema';
import { batchMemberPromotionError, promoteStageRunToDispatched } from './batch-promotion';
import type { FlowAdmissionConfig } from './config';
import { FLOW_ADMISSION_QUEUE_ORDER_BY } from './queue-order';
import {
  promoteTerminalResumeRun,
  type TerminalResumeValidation,
  validateTerminalResumeAdmission,
} from './terminal-resume/resume-store';

type Db = ReturnType<typeof getDatabase>;
export type FlowRunAdmission = typeof flowRunAdmissions.$inferSelect;
const MAX_ERROR_LENGTH = 2_000;
const MAX_CLAIMS_PER_TRANSACTION = 20;
const MAX_CANDIDATES_PER_TRANSACTION = 100;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const QUEUED_ADMISSION_SQL = sql`${flowRunAdmissions.state} = 'queued'`;
const LIVE_ADMISSION_SQL = sql`${flowRunAdmissions.state} IN ('queued', 'claimed', 'active', 'releasing')`;
const OCCUPIED_ADMISSION_SQL = sql`${flowRunAdmissions.state} IN ('claimed', 'active', 'releasing')`;
const SETTLED_ADMISSION_SQL = sql`${flowRunAdmissions.state} IN ('released', 'failed', 'cancelled') AND ${flowRunAdmissions.settledAt} IS NOT NULL`;
export type EnqueueFlowAdmissionInput = {
  intent: FlowAdmissionIntentV1;
  requestedAt?: Date;
};
export type EnqueueFlowAdmissionResult = {
  admission: FlowRunAdmission;
  created: boolean;
};
export type ClaimEligibleAdmissionsResult = {
  admissions: FlowRunAdmission[];
  failed: FlowRunAdmission[];
  hasMore: boolean;
  candidatesProcessed: number;
};
const errorText = (message: string): string => message.slice(0, MAX_ERROR_LENGTH);
export function liveAdmissionForRun(db: Db, flowRunId: string): FlowRunAdmission | null {
  return (
    db
      .select()
      .from(flowRunAdmissions)
      .where(and(eq(flowRunAdmissions.flowRunId, flowRunId), LIVE_ADMISSION_SQL))
      .limit(1)
      .get() ?? null
  );
}
/** Synchronous so callers can compose it inside their own BEGIN IMMEDIATE transaction. */
export function enqueueFlowAdmission(
  db: Db,
  input: EnqueueFlowAdmissionInput,
): EnqueueFlowAdmissionResult {
  if (!isFlowAdmissionIntentV1(input.intent)) {
    throw new TypeError('Flow admission intent must be a supported reference-only v1 intent');
  }
  const existing = liveAdmissionForRun(db, input.intent.flow_run_id);
  if (existing) return { admission: existing, created: false };

  const admission = db
    .insert(flowRunAdmissions)
    .values({
      flowRunId: input.intent.flow_run_id,
      state: 'queued',
      priorityClass: input.intent.action === 'resume' ? 'resume' : 'start',
      intentVersion: input.intent.version,
      intentJson: input.intent,
      requestedAt: input.requestedAt ?? new Date(),
    })
    .returning()
    .get();
  return { admission, created: true };
}
function jsonObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function missingNodeRun(db: Db, intent: FlowAdmissionIntentV1): string | null {
  if (!intent.node_run_id) return null;
  const row = db
    .select({ flowRunId: nodeRuns.flowRunId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, intent.node_run_id))
    .get();
  return row?.flowRunId === intent.flow_run_id ? null : `Missing node run ${intent.node_run_id}`;
}

function missingTask(db: Db, intent: FlowAdmissionIntentV1): string | null {
  if (!intent.task_id) return null;
  const row = db
    .select({ flowRunId: tasks.flowRunId })
    .from(tasks)
    .where(eq(tasks.id, intent.task_id))
    .get();
  return row?.flowRunId === intent.flow_run_id ? null : `Missing task ${intent.task_id}`;
}

// fallow-ignore-next-line code-duplication -- distinct typed tables require parallel FK checks.
function missingBatchRun(db: Db, intent: FlowAdmissionIntentV1): string | null {
  if (!intent.batch_stage_run_id) return null;
  const row = db
    .select({ flowRunId: batchStageRuns.flowRunId })
    .from(batchStageRuns)
    .where(eq(batchStageRuns.id, intent.batch_stage_run_id))
    .get();
  return row?.flowRunId === intent.flow_run_id
    ? null
    : `Missing batch stage run ${intent.batch_stage_run_id}`;
}

function missingMessage(messagesJson: string, intent: FlowAdmissionIntentV1): string | null {
  if (!intent.message_id) return null;
  let messages: unknown;
  try {
    messages = JSON.parse(messagesJson);
  } catch {
    return `Invalid messages for sub-chat ${intent.sub_chat_id}`;
  }
  const found =
    Array.isArray(messages) &&
    messages.some((message) => jsonObject(message)?.id === intent.message_id);
  if (!found) return `Missing message ${intent.message_id} in sub-chat ${intent.sub_chat_id}`;
  return null;
}

function missingSubChatReference(db: Db, intent: FlowAdmissionIntentV1): string | null {
  if (!intent.sub_chat_id) return null;
  if (!intent.task_id) return `Sub-chat ${intent.sub_chat_id} has no owning task reference`;
  const task = db
    .select({ result: tasks.result })
    .from(tasks)
    .where(eq(tasks.id, intent.task_id))
    .get();
  if (jsonObject(task?.result)?.subChatId !== intent.sub_chat_id) {
    return `Sub-chat ${intent.sub_chat_id} is not owned by task ${intent.task_id}`;
  }
  const row = db
    .select({ messages: subChats.messages })
    .from(subChats)
    .where(eq(subChats.id, intent.sub_chat_id))
    .get();
  return row ? missingMessage(row.messages, intent) : `Missing sub-chat ${intent.sub_chat_id}`;
}

function missingReference(db: Db, intent: FlowAdmissionIntentV1): string | null {
  return (
    missingNodeRun(db, intent) ??
    missingTask(db, intent) ??
    missingBatchRun(db, intent) ??
    missingSubChatReference(db, intent)
  );
}

function unstartableStartReason(db: Db, row: FlowRunAdmission): string | null {
  if (!isFlowAdmissionIntentV1(row.intentJson) || row.intentJson.action !== 'start') return null;
  const run = db
    .select({ status: flowRuns.status, startedAt: flowRuns.startedAt })
    .from(flowRuns)
    .where(eq(flowRuns.id, row.flowRunId))
    .get();
  return run?.status === 'pending' && run.startedAt === null
    ? null
    : `Flow run ${row.flowRunId} is not an unstarted pending run`;
}

function invalidAdmissionReason(
  db: Db,
  row: FlowRunAdmission,
  resume: { validation?: TerminalResumeValidation },
): string | null {
  if (row.intentVersion !== 1 || !isFlowAdmissionIntentV1(row.intentJson)) {
    return `Unsupported flow admission intent version ${row.intentVersion}`;
  }
  if (row.intentJson.flow_run_id !== row.flowRunId) {
    return 'Admission intent flow_run_id does not match its owning row';
  }
  const expectedPriority = row.intentJson.action === 'resume' ? 'resume' : 'start';
  if (row.priorityClass !== expectedPriority) {
    return 'Admission priority does not match its activation action';
  }
  const missing = missingReference(db, row.intentJson);
  if (missing) return missing;
  if (row.intentJson.action === 'start') return unstartableStartReason(db, row);
  const validation = validateTerminalResumeAdmission(db, row);
  resume.validation = validation;
  return validation.ok ? null : validation.error;
}
function terminalizeUnstartedRun(db: Db, row: FlowRunAdmission, now: Date, promoted = false): void {
  if (row.priorityClass !== 'start') return;
  db.update(flowRuns)
    .set({
      status: 'failed',
      completedAt: now,
      ...(promoted ? { startedAt: null } : {}),
    })
    .where(
      and(
        eq(flowRuns.id, row.flowRunId),
        eq(flowRuns.status, promoted ? 'running' : 'pending'),
        promoted ? eq(flowRuns.startedAt, now) : sql`${flowRuns.startedAt} IS NULL`,
      ),
    )
    .run();
  db.update(batchStageRuns)
    .set({ status: 'failed' })
    .where(
      and(
        eq(batchStageRuns.flowRunId, row.flowRunId),
        inArray(batchStageRuns.status, promoted ? ['queued', 'dispatched'] : ['queued']),
      ),
    )
    .run();
}
function failAdmission(
  db: Db,
  row: FlowRunAdmission,
  from: readonly FlowAdmissionState[],
  reason: string,
  now: Date,
  promoted = false,
): FlowRunAdmission | null {
  terminalizeUnstartedRun(db, row, now, promoted);
  const error = errorText(reason);
  return transitionAdmission(db, row.ticket, from, { state: 'failed', error, settledAt: now });
}
export function claimEligibleAdmissions(
  db: Db,
  config: FlowAdmissionConfig,
  now = new Date(),
): ClaimEligibleAdmissionsResult {
  const hasQueued = () =>
    Boolean(
      db
        .select({ ticket: flowRunAdmissions.ticket })
        .from(flowRunAdmissions)
        .where(QUEUED_ADMISSION_SQL)
        .limit(1)
        .get(),
    );
  const occupied =
    db
      .select({ count: sql<number>`count(*)` })
      .from(flowRunAdmissions)
      .where(OCCUPIED_ADMISSION_SQL)
      .get()?.count ?? 0;
  const capacity = config.concurrencyLimitEnabled
    ? Math.max(0, config.maxConcurrentRuns - occupied)
    : Number.POSITIVE_INFINITY;
  if (config.queuePaused || capacity === 0)
    return { admissions: [], failed: [], hasMore: hasQueued(), candidatesProcessed: 0 };

  const claimLimit = Math.min(MAX_CLAIMS_PER_TRANSACTION, capacity);
  const claimed: FlowRunAdmission[] = [];
  const failed: FlowRunAdmission[] = [];
  let candidatesProcessed = 0;
  const queued = db
    .select()
    .from(flowRunAdmissions)
    .where(QUEUED_ADMISSION_SQL)
    // Resumes stay ahead of starts; explicit user order falls back to immutable ticket FIFO.
    .orderBy(...FLOW_ADMISSION_QUEUE_ORDER_BY)
    .limit(MAX_CANDIDATES_PER_TRANSACTION)
    .all();
  for (const candidate of queued) {
    if (claimed.length >= claimLimit) break;
    candidatesProcessed += 1;
    const invalid = invalidAdmissionReason(db, candidate, {});
    if (invalid) {
      const row = failAdmission(db, candidate, ['queued'], invalid, now);
      if (row) failed.push(row);
      continue;
    }
    const row = db
      .update(flowRunAdmissions)
      .set({ state: 'claimed', claimedAt: now, error: null })
      .where(
        and(eq(flowRunAdmissions.ticket, candidate.ticket), eq(flowRunAdmissions.state, 'queued')),
      )
      .returning()
      .get();
    if (row) claimed.push(row);
  }
  return { admissions: claimed, failed, hasMore: hasQueued(), candidatesProcessed };
}

export function admissionByTicket(db: Db, ticket: number): FlowRunAdmission | null {
  return (
    db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).get() ?? null
  );
}
/** Fail a claimed admission and report the promotion as refused, in one expression. */
function failPromotion(
  db: Db,
  row: FlowRunAdmission,
  reason: string,
  now: Date,
  promoted = false,
): false {
  failAdmission(db, row, ['claimed'], reason, now, promoted);
  return false;
}

/** A start ticket dispatches the `queued` stage run its batch created for it. */
const QUEUED_BSR_STATUS: readonly string[] = ['queued'];

function promoteStartAdmission(db: Db, row: FlowRunAdmission, now: Date): boolean {
  if (!isFlowAdmissionIntentV1(row.intentJson) || row.intentJson.action !== 'start') return true;
  const batchStageRunId = row.intentJson.batch_stage_run_id;
  const flowRunId = row.flowRunId;
  const batchError = batchMemberPromotionError(db, flowRunId, batchStageRunId, QUEUED_BSR_STATUS);
  if (batchError) return failPromotion(db, row, batchError, now);
  const promoted = db
    .update(flowRuns)
    .set({ status: 'running', startedAt: now })
    .where(
      and(
        eq(flowRuns.id, flowRunId),
        eq(flowRuns.status, 'pending'),
        sql`${flowRuns.startedAt} IS NULL`,
      ),
    )
    .returning({ id: flowRuns.id })
    .get();
  if (!promoted)
    return failPromotion(db, row, `Flow run ${flowRunId} lost its pending start promotion`, now);
  if (!batchStageRunId) return true;
  return (
    promoteStageRunToDispatched(db, batchStageRunId, flowRunId, QUEUED_BSR_STATUS) ||
    failPromotion(
      db,
      row,
      `Batch stage run ${batchStageRunId} lost its queued dispatch promotion`,
      now,
      true,
    )
  );
}

export function beginAdmissionDispatch(db: Db, ticket: number, now: Date): FlowRunAdmission | null {
  const row = db
    .select()
    .from(flowRunAdmissions)
    .where(and(eq(flowRunAdmissions.ticket, ticket), eq(flowRunAdmissions.state, 'claimed')))
    .get();
  if (!row) return null;
  const resume: { validation?: TerminalResumeValidation } = {};
  const invalid = invalidAdmissionReason(db, row, resume);
  if (invalid) {
    failAdmission(db, row, ['claimed'], invalid, now);
    return null;
  }
  if (!promoteStartAdmission(db, row, now)) return null;
  if (resume.validation?.ok) {
    const { previousStatus, batchMember } = resume.validation;
    const promotionError = promoteTerminalResumeRun(db, row, previousStatus, batchMember);
    if (promotionError) {
      failAdmission(db, row, ['claimed'], promotionError, now);
      return null;
    }
  }
  const active = transitionAdmission(db, ticket, ['claimed'], {
    state: 'active',
    startedAt: now,
    error: null,
  });
  if (!active) {
    throw new Error(`Admission ${ticket} lost its dispatch claim`);
  }
  return active;
}

export function cancelAdmission(db: Db, ticket: number, now: Date): FlowRunAdmission | null {
  const row = db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).get();
  if (!row || !['queued', 'claimed', 'active'].includes(row.state)) return null;
  const isStart = row.priorityClass === 'start';
  if (isStart && row.state === 'queued') {
    const cancelled = db
      .update(flowRuns)
      .set({ status: 'cancelled', completedAt: now })
      .where(
        and(
          eq(flowRuns.id, row.flowRunId),
          eq(flowRuns.status, 'pending'),
          sql`${flowRuns.startedAt} IS NULL`,
        ),
      )
      .returning({ id: flowRuns.id })
      .get();
    if (!cancelled) return null;
  } else if (isStart) {
    const cancelled = db
      .update(flowRuns)
      .set({ status: 'cancelled', completedAt: now })
      .where(
        and(
          eq(flowRuns.id, row.flowRunId),
          inArray(flowRuns.status, row.state === 'claimed' ? ['pending'] : ['running', 'paused']),
        ),
      )
      .returning({ id: flowRuns.id })
      .get();
    if (!cancelled) return null;
  }
  if (isStart) {
    db.update(batchStageRuns)
      .set({ status: 'failed' })
      .where(
        and(
          eq(batchStageRuns.flowRunId, row.flowRunId),
          inArray(batchStageRuns.status, ['queued', 'dispatched']),
        ),
      )
      .run();
  }
  return row.state === 'active'
    ? transitionAdmission(db, ticket, ['active'], {
        state: 'releasing',
        error: null,
      })
    : transitionAdmission(db, ticket, ['queued', 'claimed'], {
        state: 'cancelled',
        settledAt: now,
      });
}

export function transitionAdmission(
  db: Db,
  ticket: number,
  from: readonly FlowAdmissionState[],
  update: Partial<FlowRunAdmission>,
): FlowRunAdmission | null {
  return (
    db
      .update(flowRunAdmissions)
      .set(update)
      .where(and(eq(flowRunAdmissions.ticket, ticket), inArray(flowRunAdmissions.state, from)))
      .returning()
      .get() ?? null
  );
}

export function admissionStateCounts(db: Db): Record<FlowAdmissionState, number> {
  const counts = Object.fromEntries(FLOW_ADMISSION_STATES.map((state) => [state, 0])) as Record<
    FlowAdmissionState,
    number
  >;
  const rows = db
    .select({ state: flowRunAdmissions.state, count: sql<number>`count(*)` })
    .from(flowRunAdmissions)
    .where(LIVE_ADMISSION_SQL)
    .groupBy(flowRunAdmissions.state)
    .all();
  for (const row of rows) counts[row.state] = row.count;
  return counts;
}

export function pruneSettledAdmissions(db: Db, before: Date, limit = DEFAULT_PAGE_SIZE): number {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
  const tickets = db
    .select({ ticket: flowRunAdmissions.ticket })
    .from(flowRunAdmissions)
    .where(and(SETTLED_ADMISSION_SQL, lt(flowRunAdmissions.settledAt, before)))
    .orderBy(asc(flowRunAdmissions.settledAt), asc(flowRunAdmissions.ticket))
    .limit(pageSize)
    .all()
    .map((row) => row.ticket);
  if (tickets.length === 0) return 0;
  return db.delete(flowRunAdmissions).where(inArray(flowRunAdmissions.ticket, tickets)).run()
    .changes;
}
