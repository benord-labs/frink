import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { isTriggerBlockType } from '../../../../shared/lib/block-registry';
import {
  type FlowAdmissionIntentV1,
  isFlowAdmissionIntentV1,
} from '../../../../shared/lib/flow-admission';
import {
  priorityQueueMode,
  readyRunFirstRule,
  runFirstRuleMatches,
} from '../../../../shared/lib/flow-admission/run-first-rule';
import { runFirstRowSchema } from '../../../../shared/types/flow-settings-schema';
import type { getDatabase } from '../../db';
import { isHeldFlowRun } from '../../db/repos/flow-runs';
import {
  type BatchStageRun,
  batchStageRuns,
  batchStages,
  type FlowRun,
  type FlowVersion,
  flowRuns,
  flowVersions,
  type NewFlowRun,
} from '../../db/schema';
import { buildVariables } from '../block-context';
import { resolveScalarText } from '../template-utils';
import { assertStageHasSlot, StageRunMovedError } from './batch-promotion';
import { enqueueFlowAdmission, type FlowRunAdmission, liveAdmissionForRun } from './store';

type Db = ReturnType<typeof getDatabase>;

export type EnqueueFlowStartInput = Omit<NewFlowRun, 'status' | 'startedAt' | 'completedAt'> & {
  batchStageRunId?: string | null;
  /** The stage the dispatcher read the member from; admission refuses a member moved since. */
  batchStageId?: string | null;
  requestedAt?: Date;
};

export type EnqueueFlowStartResult = {
  run: FlowRun;
  isReplay: boolean;
  admission: FlowRunAdmission | null;
};

function existingRunForStart(db: Db, idempotencyKey: string | null | undefined): FlowRun | null {
  if (!idempotencyKey) return null;
  return (
    db.select().from(flowRuns).where(eq(flowRuns.idempotencyKey, idempotencyKey)).limit(1).get() ??
    null
  );
}

function createPendingRun(
  db: Db,
  input: Omit<EnqueueFlowStartInput, 'batchStageRunId' | 'batchStageId' | 'requestedAt'>,
): FlowRun {
  return db
    .insert(flowRuns)
    .values({
      ...input,
      status: 'pending',
      startedAt: null,
      completedAt: null,
    })
    .returning()
    .get();
}

function isProvenUnstarted(run: FlowRun): boolean {
  return run.status === 'pending' && run.startedAt === null;
}

const memberAttachmentsSchema = z.object({ attachments: z.array(z.unknown()) });
const runFirstGraphSchema = z.object({
  settings: z.object({
    runFirst: z.boolean().optional().catch(undefined),
    runFirstWhen: z.array(runFirstRowSchema).optional().catch(undefined),
  }),
});

/** Judged once, from the version the run is pinned to and the run's own saved trigger details. */
function startRunsFirst(db: Db, run: FlowRun): boolean {
  const version = db
    .select({ graph: flowVersions.graph })
    .from(flowVersions)
    .where(eq(flowVersions.id, run.flowVersionId))
    .get();
  const settings = runFirstGraphSchema.safeParse(version?.graph).data?.settings;
  const mode = priorityQueueMode(settings);
  const rule = mode === 'match' ? readyRunFirstRule(settings?.runFirstWhen ?? []) : null;
  if (!rule) return mode === 'every';
  const scope = buildVariables({ triggerContext: run.triggerContext, previousOutput: undefined });
  return runFirstRuleMatches(rule, (path) => resolveScalarText(scope, path));
}

/** Uploads append only while the member is pending, so this read is final for its run. */
function withMemberAttachments(
  db: Db,
  run: FlowRun,
  memberContext: BatchStageRun['triggerContext'],
): FlowRun {
  // Only a real list replaces the snapshot; a malformed value must not erase it.
  const member = memberAttachmentsSchema.safeParse(memberContext);
  if (!member.success) return run;
  const triggerContext = {
    ...run.triggerContext,
    attachments: member.data.attachments,
  };
  return db
    .update(flowRuns)
    .set({ triggerContext })
    .where(eq(flowRuns.id, run.id))
    .returning()
    .get();
}

/** A member moved since the dispatcher read it is its new stage's to admit, even on a replay. */
function assertStillInStage(
  db: Db,
  batchStageRunId: string | null | undefined,
  expectedStageId: string | null | undefined,
): void {
  if (!batchStageRunId || !expectedStageId) return;
  const member = db
    .select({ stageId: batchStageRuns.stageId })
    .from(batchStageRuns)
    .where(eq(batchStageRuns.id, batchStageRunId))
    .get();
  if (member && member.stageId !== expectedStageId) {
    throw new StageRunMovedError(batchStageRunId, expectedStageId);
  }
}

function queueBatchMember(db: Db, batchStageRunId: string, run: FlowRun): FlowRun {
  const current = db
    .select({
      status: batchStageRuns.status,
      flowRunId: batchStageRuns.flowRunId,
      stageId: batchStageRuns.stageId,
      batchId: batchStages.batchId,
      triggerContext: batchStageRuns.triggerContext,
    })
    .from(batchStageRuns)
    .innerJoin(batchStages, eq(batchStages.id, batchStageRuns.stageId))
    .where(eq(batchStageRuns.id, batchStageRunId))
    .get();
  if (
    current?.status === 'queued' &&
    current.flowRunId === run.id &&
    current.batchId === run.batchId
  ) {
    return run;
  }
  if (!run.batchId || current?.batchId !== run.batchId) {
    throw new Error(`Batch stage run ${batchStageRunId} is not eligible for admission`);
  }
  // Same transaction and mutex as a resume promotion's check, so the ceiling holds on both paths.
  assertStageHasSlot(db, current.stageId, run);
  const linked = db
    .update(batchStageRuns)
    .set({ status: 'queued', flowRunId: run.id })
    .where(
      and(
        eq(batchStageRuns.id, batchStageRunId),
        eq(batchStageRuns.stageId, current.stageId),
        eq(batchStageRuns.status, 'pending'),
        isNull(batchStageRuns.flowRunId),
      ),
    )
    .returning({ id: batchStageRuns.id })
    .get();
  if (!linked) {
    throw new Error(`Batch stage run ${batchStageRunId} is not eligible for admission`);
  }
  return withMemberAttachments(db, run, current.triggerContext);
}

/** Must run inside the controller's BEGIN IMMEDIATE transaction. */
export function enqueueFlowStart(db: Db, input: EnqueueFlowStartInput): EnqueueFlowStartResult {
  const { batchStageRunId, batchStageId, requestedAt, ...runInput } = input;
  assertStillInStage(db, batchStageRunId, batchStageId);
  const existing = existingRunForStart(db, input.idempotencyKey);
  const created = existing ?? createPendingRun(db, runInput);
  const isReplay = Boolean(existing);
  if (!isProvenUnstarted(created)) return { run: created, isReplay, admission: null };
  // A held run gets its ticket only from Start, so a replay of its trigger keeps it held.
  if (created.heldAt) return { run: created, isReplay, admission: null };

  const live = liveAdmissionForRun(db, created.id);
  if (
    live &&
    batchStageRunId &&
    (!isFlowAdmissionIntentV1(live.intentJson) ||
      live.intentJson.batch_stage_run_id !== batchStageRunId)
  ) {
    throw new Error(`Flow run ${created.id} already has a different live start admission`);
  }
  const run = batchStageRunId ? queueBatchMember(db, batchStageRunId, created) : created;
  if (live) return { run, isReplay, admission: live };

  const intent: FlowAdmissionIntentV1 = {
    version: 1,
    action: 'start',
    flow_run_id: run.id,
    ...(batchStageRunId ? { batch_stage_run_id: batchStageRunId } : {}),
  };
  const { admission } = enqueueFlowAdmission(db, {
    intent,
    requestedAt,
    runFirst: startRunsFirst(db, run),
  });
  return { run, isReplay, admission };
}

// A malformed node reads as no block type rather than failing the whole graph.
const graphNodesSchema = z.object({
  nodes: z.array(z.object({ blockType: z.string() }).catch({ blockType: '' })),
});

function triggerBlockType(version: FlowVersion): string | undefined {
  const nodes = graphNodesSchema.safeParse(version.graph).data?.nodes ?? [];
  return nodes.find((node) => isTriggerBlockType(node.blockType))?.blockType;
}

/** The version Start admits a held run on: the Flow's latest, unless its trigger type changed since,
 *  because the run's trigger details belong to the trigger it was held for. */
export function heldRunStartVersion(db: Db, pinnedVersionId: string) {
  const pinned = db.select().from(flowVersions).where(eq(flowVersions.id, pinnedVersionId)).get();
  const newest =
    pinned &&
    db
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, pinned.flowId))
      .orderBy(desc(flowVersions.versionNumber))
      .limit(1)
      .get();
  if (!pinned || !newest) return { versionId: pinnedVersionId, latest: true };
  const latest = triggerBlockType(newest) === triggerBlockType(pinned);
  return { versionId: latest ? newest.id : pinned.id, latest };
}

const isHeldRun = (flowRunId: string) => and(eq(flowRuns.id, flowRunId), isHeldFlowRun);

/** Start: moves a held run to the version Start admits and enqueues its start ticket, judging
 *  run-first from that version. False once started or dismissed. Must run inside a transition. */
export function releaseHeldFlowRun(db: Db, flowRunId: string): boolean {
  const pinned = db
    .select({ versionId: flowRuns.flowVersionId })
    .from(flowRuns)
    .where(eq(flowRuns.id, flowRunId))
    .get();
  if (!pinned) return false;
  const { versionId } = heldRunStartVersion(db, pinned.versionId);
  const run = db
    .update(flowRuns)
    .set({ heldAt: null, flowVersionId: versionId })
    .where(isHeldRun(flowRunId))
    .returning()
    .get();
  if (!run) return false;
  const intent: FlowAdmissionIntentV1 = { version: 1, action: 'start', flow_run_id: run.id };
  enqueueFlowAdmission(db, { intent, runFirst: startRunsFirst(db, run) });
  return true;
}

/** Dismiss: cancels a run only while it is still held. A held run has no ticket, step or task. */
export function cancelHeldFlowRun(db: Db, flowRunId: string, now = new Date()): boolean {
  const cancelled = db
    .update(flowRuns)
    .set({ status: 'cancelled', completedAt: now })
    .where(isHeldRun(flowRunId))
    .returning({ id: flowRuns.id })
    .get();
  return cancelled !== undefined;
}
