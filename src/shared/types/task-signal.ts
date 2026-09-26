/**
 * Shared task signal contract.
 *
 * These definitions are mirrored between:
 * - `src/shared/types/task-signal.ts`
 * so serverless handlers do not depend on Electron/client module paths.
 * Sync is enforced by `task-signal.sync.test.ts`.
 */
export const TASK_SIGNAL_STATES = [
  'done',
  'completed',
  'awaiting_input',
  'blocked',
  'partial',
  'failed',
  'manual_confirmation',
  'missing_completion_signal',
] as const;

export type TaskSignalState = (typeof TASK_SIGNAL_STATES)[number];

/**
 * A structured question an agent can attach to an `awaiting_input` signal so the parked task
 * renders clickable choices instead of prose. Identical to the shape the host SDK `AskUserQuestion`
 * tool uses, so the renderer reuses one question component for both surfaces.
 */
export type AgentUserQuestion = {
  /** The question shown to the user as the main question line; also the key the chosen answer is mapped back under. */
  question: string;
  /** Short display heading for the question. */
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
};

export type TaskSignalPayload = {
  state: TaskSignalState;
  summary: string;
  details?: string;
  verification?: Record<string, unknown>;
  /** Optional clickable choices for the user. Only honored when `state === 'awaiting_input'`. */
  questions?: AgentUserQuestion[];
  at?: string;
};
