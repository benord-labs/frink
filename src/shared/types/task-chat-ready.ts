import { TRIGGER_START_MODES, type TriggerStartMode } from './trigger-context';

export type TaskChatImageAttachment = {
  base64Data: string;
  mediaType: string;
  filename?: string;
};

export type TaskChatReadyData = {
  chatId: string;
  subChatId: string;
  taskId: string;
  prompt: string;
  /** Routing project id for the WebSocket transport (empty/null => server executes locally). */
  projectId: string | null;
  projectPath: string | null;
  startMode: TriggerStartMode;
  skipReview: boolean;
  /**
   * True for flow-linked tasks: they execute headlessly (streamed via the global message queue)
   * and the renderer does NOT navigate to them — they are watched from the flow-run panel. Non-flow
   * work-queue tasks (headless=false) still pull focus to their chat as before.
   */
  headless: boolean;
  /**
   * Flow-level Auto Mode snapshot for this provider-backed dispatch. Omitted for manual and
   * non-provider task paths; omitted legacy Flow graphs are interpreted as on by the renderer.
   */
  autoReviewTools?: boolean;
  /**
   * Flow-level Codex Fast snapshot for this dispatch. Omitted for manual and non-flow paths; an
   * omitted value leaves the chat's own Fast state alone. Unlike `autoReviewTools` there is no
   * legacy-on reading — absent never means on, because the tier bills a credit multiplier.
   */
  codexFastMode?: boolean;
  model?: string;
  executionLeaseId?: string;
  /** Vision content blocks from trigger_context.attachments (type=image only). */
  images?: TaskChatImageAttachment[];
  /**
   * True when this dispatch is a user-requested retry of a failed/parked attempt. The renderer's
   * prompt dedup (a re-claimed task re-broadcasts the same prompt) must NOT swallow a retry —
   * the prompt already exists as a persisted user message from the failed attempt.
   */
  isRetry?: boolean;
};

const requiredStringFields = ['chatId', 'subChatId', 'taskId', 'prompt'] as const;
const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
const isOptionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';

function hasRequiredTaskChatReadyFields(candidate: Record<string, unknown>): boolean {
  return (
    requiredStringFields.every((field) => typeof candidate[field] === 'string') &&
    (typeof candidate.projectId === 'string' || candidate.projectId === null) &&
    (typeof candidate.projectPath === 'string' || candidate.projectPath === null) &&
    TRIGGER_START_MODES.includes(candidate.startMode as TriggerStartMode) &&
    typeof candidate.skipReview === 'boolean' &&
    typeof candidate.headless === 'boolean'
  );
}

function hasOptionalTaskChatReadyFields(candidate: Record<string, unknown>): boolean {
  return (
    isOptionalBoolean(candidate.autoReviewTools) &&
    isOptionalBoolean(candidate.codexFastMode) &&
    isOptionalString(candidate.model) &&
    isOptionalString(candidate.executionLeaseId) &&
    isOptionalBoolean(candidate.isRetry)
  );
}

export function isTaskChatReadyData(value: unknown): value is TaskChatReadyData {
  if (typeof value !== 'object' || value == null) return false;
  const candidate = value as Record<string, unknown>;
  return hasRequiredTaskChatReadyFields(candidate) && hasOptionalTaskChatReadyFields(candidate);
}
