/**
 * Shared types used across main process and renderer
 */

import type { FlowAdmissionState } from '../lib/flow-admission';

export * from './chat-mode';
export * from './execution';
export * from './flow';
export * from './plan';
export * from './task-status';
export * from './trigger-context';

/** Admission-related fields exposed by the Flow list query for its live run indicator. */
export type FlowRunAdmissionSummary = {
  latest_run_status?: string | null;
  latest_run_active_task_status?: string | null;
  latest_run_admission_state?: FlowAdmissionState | null;
  latest_run_queue_position?: number | null;
  latest_run_admission_requested_at?: string | null;
};
