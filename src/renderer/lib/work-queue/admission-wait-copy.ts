import type { RecoverOutcome } from '../../../shared/types/flow-run/resume';
import { formatWaitingSince } from '../utils/format-time';

export type AdmissionGroup = 'resume' | 'priority' | 'start';

/** Top to bottom, in the order the queue starts them. */
export const ADMISSION_GROUPS: readonly AdmissionGroup[] = ['resume', 'priority', 'start'];

export const ADMISSION_GROUP_LABELS = {
  resume: 'Resuming',
  priority: 'Priority queue',
  start: 'Starting',
} as const satisfies Record<AdmissionGroup, string>;

const WAIT_COPY = {
  resume: { description: 'Waiting to resume', statusLabel: 'Queued to resume' },
  priority: { description: 'Waiting in the priority queue', statusLabel: 'Queued with priority' },
  start: { description: 'Waiting to start', statusLabel: 'Queued to start' },
} as const satisfies Record<AdmissionGroup, { description: string; statusLabel: string }>;

export function admissionGroup(row: {
  priorityClass: 'resume' | 'start';
  runFirst: boolean;
}): AdmissionGroup {
  if (row.priorityClass === 'resume') return 'resume';
  return row.runFirst ? 'priority' : 'start';
}

/** A paused queue holds every row, resumes included; `null` (setting unknown) claims neither state. */
export function admissionWaitCopy(
  group: AdmissionGroup,
  queuePaused: boolean | null,
): { description: string; statusLabel: string } {
  if (queuePaused) {
    return { description: 'On hold until you resume the queue', statusLabel: 'On hold' };
  }
  if (queuePaused === null) return { description: 'In the queue', statusLabel: 'Queued' };
  return WAIT_COPY[group];
}

/** Spells out what confirming actually destroys — the two priority classes differ sharply. */
export function admissionRemovalCopy(admission: {
  isBatchMember: boolean;
  priorityClass: 'resume' | 'start';
}): string {
  if (admission.priorityClass === 'resume') {
    return 'The finished run stays as it is. It returns to your attention list, where you can retry it.';
  }
  const base =
    "The queued run is cancelled. Its trigger details can't be replayed, so you'll need to run the flow again.";
  return admission.isBatchMember
    ? `${base} It also counts as one failed member of its batch stage, which can fail that stage and cancel the stages waiting on it.`
    : base;
}

export function oldestWaitingNote(rows: readonly { requestedAt: Date }[]): string | undefined {
  if (rows.length === 0) return undefined;
  // Manual moves break arrival order, so the oldest row is not necessarily the first one.
  const oldest = Math.min(...rows.map((row) => row.requestedAt.getTime()));
  return `Oldest waiting since ${formatWaitingSince(new Date(oldest))}`;
}

/** The toast for a recovery that waits for a slot; a repeat click says its first one still waits. */
export function recoveryWaitToast(outcome: RecoverOutcome): string | null {
  if (outcome === 'queued') return 'Queued to resume';
  return outcome === 'already-queued' ? 'Already queued to resume' : null;
}
