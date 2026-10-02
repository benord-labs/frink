/**
 * Work Queue Types
 */

import type { AgentUserQuestion, TaskSignalState } from '../../../shared/types/task-signal';
import type { TriggerContext, TriggerStartMode } from '../../../shared/types/trigger-context';

type TaskResult = {
  chatId?: string;
  subChatId?: string;
  startMode?: TriggerStartMode;
  skipReview?: boolean;
  summary?: string;
  error?: string;
  dispatchError?: string;
  dispatchErrorCode?:
    | 'MISSING_PAT'
    | 'INVALID_PAT'
    | 'INVALID_MODEL'
    | 'INSUFFICIENT_SCOPE'
    | 'PROJECT_OVERRIDE_NOT_FOUND'
    | 'NO_EFFECTIVE_GITHUB_CREDENTIAL'
    | 'NO_CLAUDE_CREDENTIAL';
  dispatchErrorRemediation?: string;
  /**
   * Optional action hint set by the main-process task-executor when the failure
   * has a specific recovery flow. Currently only `'open-connect-account'` —
   * surfaced when a triggered task can't run because its account isn't
   * authenticated on this machine. The Work Queue action menu renders a CTA when present.
   */
  errorAction?: 'open-connect-account';
  requestedModel?: string;
  activeModel?: string;
  modelFallbackReason?: string;
  cancelled?: boolean;
  promptInjectedFromQueue?: boolean;
  retryRequestedAt?: string;
  /** Set while the task is parked by the user's own chat Pause; cleared on resume. */
  userPause?: { at: string };
  agentSignal?: {
    state: TaskSignalState;
    summary: string;
    details?: string;
    verification?: Record<string, unknown>;
    questions?: AgentUserQuestion[];
    at?: string;
  };
};

export type Task = {
  id: string;
  title: string | null;
  description: string | null;
  status: string;
  source: string;
  result: TaskResult | null;
  createdAt: string | Date;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
  needsAttentionAt?: string | Date | null;
  projectName?: string | null;
  projectId?: string | null;
  linkedChatId?: string | null;
  flowRunId?: string | null;
  triggerContext?: TriggerContext | null;
};
