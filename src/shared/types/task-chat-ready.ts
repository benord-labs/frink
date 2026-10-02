import { type CodexSpeed, isCodexSpeed } from './execution';
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
  /** Flow-level Codex speed for this dispatch. Omitted outside flows, which leaves the chat's own
   *  speed alone; absent never means a paid speed. */
  codexSpeed?: CodexSpeed;
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
  /** Which dispatch attempt this is (the claim's `result.dispatchedAt`). Echoed back on the send so
   * main can tell this attempt's turn from an earlier attempt's of the same task (sc-2775). */
  dispatchGeneration?: string;
};

const requiredStringFields = ['chatId', 'subChatId', 'taskId', 'prompt'] as const;
const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.length > 0;
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
    (candidate.codexSpeed === undefined || isCodexSpeed(candidate.codexSpeed)) &&
    isOptionalString(candidate.model) &&
    isOptionalString(candidate.executionLeaseId) &&
    isOptionalBoolean(candidate.isRetry) &&
    (candidate.dispatchGeneration === undefined || isNonEmptyString(candidate.dispatchGeneration))
  );
}

export function isTaskChatReadyData(value: unknown): value is TaskChatReadyData {
  if (typeof value !== 'object' || value == null) return false;
  const candidate = value as Record<string, unknown>;
  return hasRequiredTaskChatReadyFields(candidate) && hasOptionalTaskChatReadyFields(candidate);
}
