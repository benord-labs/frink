// Durable activation states shared by main-process admission and later renderer contracts.
export const FLOW_ADMISSION_STATES = [
  'queued',
  'claimed',
  'active',
  'releasing',
  'released',
  'failed',
  'cancelled',
] as const;

export type FlowAdmissionState = (typeof FLOW_ADMISSION_STATES)[number];

export const FLOW_ADMISSION_LIVE_STATES = [
  'queued',
  'claimed',
  'active',
  'releasing',
] as const satisfies readonly FlowAdmissionState[];

export type FlowAdmissionPriorityClass = 'start' | 'resume';

/**
 * Reference-only activation intent. Canonical message, trigger, task, and node data stay in their
 * owning tables; admission records only retain stable identifiers needed to rehydrate an action.
 */
export type FlowAdmissionIntentV1 = {
  version: 1;
  action: 'start' | 'resume';
  flow_run_id: string;
  node_run_id?: string;
  task_id?: string;
  sub_chat_id?: string;
  message_id?: string;
  batch_stage_run_id?: string;
  /**
   * A resume that should CONTINUE the driving sub-chat's surviving session (hidden
   * continuation nudge, live mode) instead of re-dispatching the node's instructions.
   * Only user-Retry mints it; the deliberate re-run surfaces never do.
   */
  continuation?: true;
};

const INTENT_V1_KEYS = new Set([
  'version',
  'action',
  'flow_run_id',
  'node_run_id',
  'task_id',
  'sub_chat_id',
  'message_id',
  'batch_stage_run_id',
  'continuation',
]);

const isOptionalId = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length > 0);

function hasIntentHeader(candidate: Record<string, unknown>): boolean {
  return (
    candidate.version === 1 &&
    (candidate.action === 'start' || candidate.action === 'resume') &&
    typeof candidate.flow_run_id === 'string' &&
    candidate.flow_run_id.length > 0
  );
}

function hasValidOptionalIds(candidate: Record<string, unknown>): boolean {
  return [
    candidate.node_run_id,
    candidate.task_id,
    candidate.sub_chat_id,
    candidate.message_id,
    candidate.batch_stage_run_id,
  ].every(isOptionalId);
}

function hasValidReferences(candidate: Record<string, unknown>): boolean {
  if (candidate.message_id !== undefined && candidate.sub_chat_id === undefined) return false;
  if (candidate.sub_chat_id !== undefined && candidate.task_id === undefined) return false;
  return (
    candidate.action === 'start' ||
    candidate.node_run_id !== undefined ||
    candidate.task_id !== undefined ||
    candidate.batch_stage_run_id !== undefined
  );
}

export function isFlowAdmissionIntentV1(value: unknown): value is FlowAdmissionIntentV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !INTENT_V1_KEYS.has(key))) return false;
  if (candidate.continuation !== undefined && candidate.continuation !== true) return false;
  return (
    hasIntentHeader(candidate) && hasValidOptionalIds(candidate) && hasValidReferences(candidate)
  );
}
