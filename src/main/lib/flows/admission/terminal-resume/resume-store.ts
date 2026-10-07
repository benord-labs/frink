import { and, eq } from 'drizzle-orm';
import {
  type FlowAdmissionIntentV1,
  isFlowAdmissionIntentV1,
} from '../../../../../shared/lib/flow-admission';
import type { FlowRunStatus } from '../../../../../shared/types/flow';
import type { RecoveryKind } from '../../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../../../db';
import { batchStageRuns, type flowRunAdmissions, flowRuns, nodeRuns } from '../../../db/schema';
import {
  type BatchMemberResumeTarget,
  batchMemberResumeError,
  promoteStageRunToDispatched,
  RESUMABLE_BSR_STATUSES,
  reopenFailedStage,
  stageConcurrencyLimit,
} from '../batch-promotion';
import { RESUME_CHAT_DELETED_MESSAGE, resumeChatDeleted } from './chat-gate';

type Db = ReturnType<typeof getDatabase>;
type FlowRunAdmission = typeof flowRunAdmissions.$inferSelect;
type TerminalResumeStatus = Extract<FlowRunStatus, 'completed' | 'failed' | 'cancelled'>;

const TERMINAL_RESUME_STATUSES = new Set<FlowRunStatus>(['completed', 'failed', 'cancelled']);

export type TerminalFlowResumeIntent = FlowAdmissionIntentV1 & {
  action: 'resume';
  node_run_id: string;
};

export type EnqueueTerminalFlowResumeInput = {
  flowRunId: string;
  nodeRunId: string;
  /** The recovery the user clicked, re-checked when the ticket is claimed. */
  kind?: RecoveryKind;
  /** Runs inside the enqueue transaction; false declines it (e.g. the run was cancelled meanwhile). */
  admit?: (db: Db) => boolean;
  requestedAt?: Date;
};

type ResumeTargetRefusal = (db: Db, intent: TerminalFlowResumeIntent) => string | null;
/** Registered by the dispatcher, which owns the resume resolvers, keeping this module acyclic. */
let resumeTargetRefusal: ResumeTargetRefusal = () => null;

export function registerResumeTargetRefusal(refusal: ResumeTargetRefusal): void {
  resumeTargetRefusal = refusal;
}

export class TerminalResumeAdmissionError extends Error {
  override name = 'TerminalResumeAdmissionError';
}

/** The run's start_task chat was deleted — the user abandoned the run (sc-3509); copy is user-facing. */
export class TerminalResumeChatDeletedError extends TerminalResumeAdmissionError {
  override name = 'TerminalResumeChatDeletedError';
  constructor() {
    super(RESUME_CHAT_DELETED_MESSAGE);
  }
}

/** Admission failures cross the ticket as strings; this restores the typed refusal the UI maps. */
export function terminalResumeAdmissionError(message: string): TerminalResumeAdmissionError {
  return message === RESUME_CHAT_DELETED_MESSAGE
    ? new TerminalResumeChatDeletedError()
    : new TerminalResumeAdmissionError(message);
}

/** The caller's own `admit` said no (e.g. the run was abandoned meanwhile) — expected, not a failure. */
export class ResumeAdmitDeclinedError extends TerminalResumeAdmissionError {
  override name = 'ResumeAdmitDeclinedError';
}

type EnqueueTerminalFlowResumeResult = {
  admission: FlowRunAdmission;
  created: boolean;
};

type AdmissionOps = {
  live: (db: Db, flowRunId: string) => FlowRunAdmission | null;
  enqueue: (
    db: Db,
    input: { intent: FlowAdmissionIntentV1; requestedAt?: Date },
  ) => EnqueueTerminalFlowResumeResult;
};

export type TerminalResumeValidation =
  | {
      ok: true;
      previousStatus: TerminalResumeStatus;
      /** Set for a batch member: the stage slot its promotion re-enters. */
      batchMember: BatchMemberResumeTarget | null;
    }
  | { ok: false; error: string };

export function terminalFlowResumeIntent(value: unknown): TerminalFlowResumeIntent | null {
  if (!isFlowAdmissionIntentV1(value) || value.action !== 'resume' || !value.node_run_id) {
    return null;
  }
  if (value.task_id || value.sub_chat_id || value.message_id || value.batch_stage_run_id) {
    return null;
  }
  return value as TerminalFlowResumeIntent;
}

export function isTerminalResumeStatus(status: string): status is TerminalResumeStatus {
  return TERMINAL_RESUME_STATUSES.has(status as FlowRunStatus);
}

function isSameResumeTarget(row: FlowRunAdmission, intent: TerminalFlowResumeIntent): boolean {
  const existing = terminalFlowResumeIntent(row.intentJson);
  return (
    row.state !== 'releasing' &&
    row.intentVersion === 1 &&
    row.priorityClass === 'resume' &&
    existing?.flow_run_id === intent.flow_run_id &&
    existing.node_run_id === intent.node_run_id &&
    // A ticket of the other kind is refused at claim, so it must not absorb this request.
    existing.recovery_kind === intent.recovery_kind
  );
}

function terminalResumeTarget(db: Db, flowRunId: string, nodeRunId: string) {
  return (
    db
      .select({
        runStatus: flowRuns.status,
        batchId: flowRuns.batchId,
        flowVersionId: flowRuns.flowVersionId,
        nodeFlowRunId: nodeRuns.flowRunId,
        blockType: nodeRuns.blockType,
        batchStageRunId: batchStageRuns.id,
        stageId: batchStageRuns.stageId,
      })
      .from(nodeRuns)
      .innerJoin(flowRuns, eq(flowRuns.id, nodeRuns.flowRunId))
      // Identity only (batch_stage_runs_flow_run_idx); every status this ticket turns on is re-read
      // where it is used, so one row here can never promote a sibling.
      .leftJoin(batchStageRuns, eq(batchStageRuns.flowRunId, flowRuns.id))
      .where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.flowRunId, flowRunId)))
      .get()
  );
}

/** The member's stage slot, sized by the ceiling its own pinned flow version declares. */
function batchMemberTarget(
  db: Db,
  target: NonNullable<ReturnType<typeof terminalResumeTarget>>,
): BatchMemberResumeTarget | null {
  if (!target.batchId || !target.batchStageRunId || !target.stageId) return null;
  const limit = stageConcurrencyLimit(db, target);
  if (limit === null) return null;
  return { batchStageRunId: target.batchStageRunId, stageId: target.stageId, limit };
}

/** One eligibility read, shared by the enqueue and by every later claim/promote pass. */
function resumeEligibility(db: Db, flowRunId: string, nodeRunId: string): TerminalResumeValidation {
  const target = terminalResumeTarget(db, flowRunId, nodeRunId);
  if (!target || target.nodeFlowRunId !== flowRunId) {
    return { ok: false, error: `Node run ${nodeRunId} does not belong to Flow run ${flowRunId}` };
  }
  if (!isTerminalResumeStatus(target.runStatus)) {
    return {
      ok: false,
      error: `Flow run ${flowRunId} is not eligible for terminal resume admission`,
    };
  }
  if (target.blockType === 'fan_out') {
    return { ok: false, error: 'Terminal resume admission does not support fan-out execution' };
  }
  // Read at enqueue AND at promotion: a chat deleted while the ticket queued is refused before the
  // run is promoted, so it keeps its terminal status instead of failing mid-dispatch.
  if (resumeChatDeleted(db, flowRunId, nodeRunId, target.flowVersionId)) {
    return { ok: false, error: RESUME_CHAT_DELETED_MESSAGE };
  }
  const batchMember = batchMemberTarget(db, target);
  // A batch member is an ordinary Flow run plus a stage slot: it re-enters through this same
  // ticket, and only its own stage can refuse it.
  const refused =
    target.batchId == null ? null : batchMemberResumeError(db, flowRunId, batchMember);
  if (refused) return { ok: false, error: refused };
  return { ok: true, previousStatus: target.runStatus, batchMember };
}

export function enqueueTerminalFlowResume(
  db: Db,
  input: EnqueueTerminalFlowResumeInput,
  ops: AdmissionOps,
): EnqueueTerminalFlowResumeResult {
  const intent: TerminalFlowResumeIntent = {
    version: 1,
    action: 'resume',
    flow_run_id: input.flowRunId,
    node_run_id: input.nodeRunId,
    recovery_kind: input.kind,
  };
  // Before coalescing too: a request joining a live ticket must still respect a Cancel since.
  if (input.admit && !input.admit(db)) {
    throw new ResumeAdmitDeclinedError(
      `Flow run ${input.flowRunId} declined its resume admit check`,
    );
  }
  const live = ops.live(db, input.flowRunId);
  if (live) {
    if (isSameResumeTarget(live, intent)) return { admission: live, created: false };
    throw new TerminalResumeAdmissionError(
      `Flow run ${input.flowRunId} already has a different live admission`,
    );
  }
  const eligibility = resumeEligibility(db, input.flowRunId, input.nodeRunId);
  if (!eligibility.ok) throw terminalResumeAdmissionError(eligibility.error);
  return ops.enqueue(db, { intent, requestedAt: input.requestedAt });
}

export function validateTerminalResumeAdmission(
  db: Db,
  row: FlowRunAdmission,
): TerminalResumeValidation {
  const intent = terminalFlowResumeIntent(row.intentJson);
  if (!intent) {
    return { ok: false, error: `Admission ${row.ticket} is not a terminal node resume intent` };
  }
  // Read in the promotion's transaction: a step that changed while queued keeps its terminal status.
  const refused = resumeTargetRefusal(db, intent);
  if (refused) return { ok: false, error: refused };
  return resumeEligibility(db, row.flowRunId, intent.node_run_id);
}

/** Run terminal→running, and a batch member back into its stage, in the caller's transaction (eligibility was
 * read in that same transaction). A later dispatch failure settles the stage via the batchId on run_failed. */
export function promoteTerminalResumeRun(
  db: Db,
  row: FlowRunAdmission,
  previousStatus: TerminalResumeStatus,
  batchMember: BatchMemberResumeTarget | null,
): string | null {
  const promoted = db
    .update(flowRuns)
    .set({ status: 'running' })
    .where(and(eq(flowRuns.id, row.flowRunId), eq(flowRuns.status, previousStatus)))
    .returning({ id: flowRuns.id })
    .get();
  if (!promoted) return `Flow run ${row.flowRunId} lost its terminal resume promotion`;
  if (!batchMember) return null;
  // Validation read this row in the same transaction, so the CAS cannot lose; if it ever does, the
  // run promotion is undone here so a failed ticket never commits a stranded `running` run.
  if (
    !promoteStageRunToDispatched(
      db,
      batchMember.batchStageRunId,
      row.flowRunId,
      RESUMABLE_BSR_STATUSES,
    )
  ) {
    db.update(flowRuns).set({ status: previousStatus }).where(eq(flowRuns.id, row.flowRunId)).run();
    return `Batch stage run ${batchMember.batchStageRunId} lost its resume dispatch promotion`;
  }
  reopenFailedStage(db, batchMember.stageId);
  return null;
}
