import type { BatchStageRunRow } from '../../../../../../shared/types/flow';

/** Derive a human-readable label from trigger_context with fallbacks. */
export function deriveRunLabel(
  triggerContext: Record<string, unknown> | null,
  index: number,
): string {
  const ctx = triggerContext ?? {};
  return (
    (typeof ctx.label === 'string' && ctx.label) ||
    (typeof ctx.ticketId === 'string' && ctx.ticketId) ||
    (typeof ctx.title === 'string' && ctx.title) ||
    `Run ${index + 1}`
  );
}

/**
 * Keys with dedicated UI in RunDetailPanel (header label, instructions/attachments
 * sections, Branch section) — excluded from the dynamic trigger context rows so
 * they are not duplicated.
 */
export const SYSTEM_TRIGGER_KEYS = new Set([
  'label',
  'customInstructions',
  'attachments',
  'baseBranch',
  'baseBranches',
  'mergeStrategy',
]);

export type RunBranchInfo = {
  /** Dependency branch names this run's worktree was created from (most-recent first). */
  branches: string[];
  /** Set only when 2+ branches were merged (engine injects 'most-recent'). */
  mergeStrategy: string | null;
};

/** Branch context the engine injected into a dependent-stage run's trigger_context. */
export function deriveRunBranches(triggerContext: Record<string, unknown> | null): RunBranchInfo {
  const ctx = triggerContext ?? {};
  const fromArray = Array.isArray(ctx.baseBranches)
    ? ctx.baseBranches.filter((b): b is string => typeof b === 'string' && b.length > 0)
    : [];
  const single =
    typeof ctx.baseBranch === 'string' && ctx.baseBranch.length > 0 ? [ctx.baseBranch] : [];
  return {
    branches: fromArray.length > 0 ? fromArray : single,
    mergeStrategy:
      fromArray.length > 1 && typeof ctx.mergeStrategy === 'string' ? ctx.mergeStrategy : null,
  };
}

/**
 * A converging-merge conflict parks the start_task at awaiting_input while the
 * batch_stage_run status stays 'dispatched'. Gate on the LIVE start_task status —
 * not the persisted flag alone — so the indicator clears as soon as the run resumes.
 */
export function isRunMergeConflict(
  run: Pick<BatchStageRunRow, 'merge_conflict' | 'start_task_status'>,
): boolean {
  return run.merge_conflict === true && run.start_task_status === 'awaiting_input';
}

/** Map BSR status to a display status for the icon. */
function toIconStatus(bsrStatus: string): string {
  if (bsrStatus === 'dispatched') return 'running';
  return bsrStatus;
}

/** Status for the run row and detail header. A park leaves the BSR 'dispatched', so without this both
 * read as running; the merge-conflict branch stays first because it can name the reason. */
export function runDisplayStatus(run: BatchStageRunRow) {
  if (isRunMergeConflict(run)) {
    return { icon: 'awaiting_input', label: 'merge conflict — needs input', warn: true };
  }
  if (run.needs_input) return { icon: 'awaiting_input', label: 'needs input', warn: true };
  return { icon: toIconStatus(run.status), label: run.status, warn: false };
}

const CAMEL_SPLIT_RE = /([A-Z])/g;
const FIRST_CHAR_RE = /^./;

/** Insert spaces before capitals, then title-case the first char (e.g. "workstreamId" → "Workstream Id"). */
export function formatTriggerKey(key: string): string {
  return key
    .replace(CAMEL_SPLIT_RE, ' $1')
    .replace(FIRST_CHAR_RE, (s) => s.toUpperCase())
    .trim();
}

/** Render any trigger context value as a readable string. */
export function formatTriggerValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}
