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

/** How git treats an env file: `none` when the folder is not in a repo. */
export type SecretGitState = 'ignored' | 'untracked' | 'tracked' | 'none';

/** A secret the agent asked the user to type into Frink's form. Never holds the value itself. */
export type SecretRequest = {
  id: string;
  /** The env variable name, e.g. `STRIPE_SECRET_KEY`. */
  name: string;
  /** The chat whose agent asked; its answer is sent there. */
  chatId: string;
  /** The env file, relative to `cwd`. */
  file: string;
  /** The chat folder the agent ran in when it asked. */
  cwd: string;
  reason: string;
  /** Whether the file already set `name` when the agent asked. */
  replaces: boolean;
  git: SecretGitState;
};

export type TaskSignalPayload = {
  state: TaskSignalState;
  summary: string;
  details?: string;
  verification?: Record<string, unknown>;
  /** Optional clickable choices for the user. Only honored when `state === 'awaiting_input'`. */
  questions?: AgentUserQuestion[];
  /** Set only by `frink_request_secret`, never by `frink_task_signal`: the park shows the secret form. */
  secretRequest?: SecretRequest;
  at?: string;
};
