import { describe, expect, it } from 'vitest';
import type { WorkQueueTaskStatus } from '../../../renderer/features/work-queue/WorkQueue/types';
import type { TaskStatus } from '../../../shared/types/task-status';

/** Statuses that are PERSISTED in tasks.status — shared and queue must agree on these. */
const EXPECTED_TASK_STATUSES = [
  'pending',
  'running',
  'plan_ready',
  'needs_attention',
  'done',
  'completed',
  'failed',
  'cancelled',
] as const;

/**
 * Display-only statuses the repository DERIVES (repos/tasks.ts effectiveStatusExpr) and the work
 * queue renders, but which are never written to tasks.status. They belong to WorkQueueTaskStatus
 * alone — adding one to the cloud or shared enum would be the bug this split exists to catch.
 */
const EXPECTED_DERIVED_STATUSES = ['interrupted'] as const;

describe('task status parity', () => {
  it('keeps shared and work-queue status definitions in sync', () => {
    // The important parity check here is compile-time: these Record<...> declarations fail if any
    // source type adds/removes a status. The runtime expect(...) checks below are tautological and
    // only keep this file visible to test runners.
    const sharedStatusRecord: Record<TaskStatus, true> = {
      pending: true,
      running: true,
      plan_ready: true,
      needs_attention: true,
      done: true,
      completed: true,
      failed: true,
      cancelled: true,
    };
    // The queue renders the persisted statuses PLUS the derived ones — so it is the one record that
    // legitimately differs, and only by EXPECTED_DERIVED_STATUSES.
    const queueStatusRecord: Record<WorkQueueTaskStatus, true> = {
      pending: true,
      running: true,
      plan_ready: true,
      needs_attention: true,
      done: true,
      completed: true,
      failed: true,
      cancelled: true,
      interrupted: true,
    };

    expect(Object.keys(sharedStatusRecord).sort()).toEqual([...EXPECTED_TASK_STATUSES].sort());
    expect(Object.keys(queueStatusRecord).sort()).toEqual(
      [...EXPECTED_TASK_STATUSES, ...EXPECTED_DERIVED_STATUSES].sort(),
    );
  });
});
