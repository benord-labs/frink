import { z } from 'zod';

/** Internal resume precondition; mobile callers receive only its opaque action token. */
const flowResumeSnapshotSchema = z.object({
  status: z.string(),
  nodeOutput: z.unknown(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  attemptIds: z.array(z.string()).min(1),
  drivingTask: z.object({ id: z.string(), status: z.string(), result: z.unknown() }).optional(),
  plan: z.object({ subChatId: z.string(), messages: z.array(z.unknown()) }).optional(),
});

export type FlowResumeSnapshot = z.infer<typeof flowResumeSnapshotSchema>;

/**
 * How a stopped step recovers: `continue` resumes the agent session that already answered the
 * step (nothing is redone); `retry` runs the step again from its instructions.
 */
export const recoveryKindSchema = z.enum(['continue', 'retry']);
export type RecoveryKind = z.infer<typeof recoveryKindSchema>;

/** One step's resume as a surface sends it; a Retry carries the recovery its button showed, refused
 * once the step no longer recovers that way. */
const resumeStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry'), nodeRunId: z.string().min(1), kind: recoveryKindSchema }),
  z.object({ action: z.enum(['approve', 'skip']), nodeRunId: z.string().min(1) }),
]);
export type ResumeStepRequest = z.infer<typeof resumeStepSchema>;

/** flows.resumeRun input. */
export const resumeRunInputSchema = z.intersection(
  z.object({ runId: z.string().min(1), expectedSnapshot: flowResumeSnapshotSchema.optional() }),
  resumeStepSchema,
);

/** A run's recovery for step `nodeRunId`; `confirmSideEffects` when a started non-agent step would
 * repeat what it did if run again. */
export type RunRecovery = { nodeRunId: string; kind: RecoveryKind; confirmSideEffects: boolean };

/** What a recovery did: ran now, waits behind the concurrency cap, or merged into a resume that was
 * already queued for the same step. */
export type RecoverOutcome = 'resumed' | 'queued' | 'already-queued';

/** One run's result in a bulk recovery. `needs-confirmation`: a started non-agent step that is
 * never re-run without its own confirm; `refused` carries why. */
export type BulkRecoverOutcome = RecoverOutcome | 'refused' | 'needs-confirmation';

export const recoverInterruptedInputSchema = z.object({
  items: z
    .array(
      z.object({
        taskId: z.string().min(1),
        kind: recoveryKindSchema,
        recoveryNodeRunId: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export type BulkRecoverResult = {
  taskId: string;
  flowRunId: string | null;
  outcome: BulkRecoverOutcome;
  reason?: string;
};
