import { normalizeErrorTextPrefix } from '../../../../../../shared/utils/error-prefixes';

const NON_EXECUTION_ERROR_CATEGORIES = new Set([
  'AUTH_FAILED_SDK',
  'INVALID_API_KEY_SDK',
  // Intentionally non-execution: rate limiting is transient and should not mark
  // a task as failed; task should remain retryable via existing retry flow.
  'RATE_LIMIT_SDK',
  'OVERLOADED_SDK',
  'NETWORK_ERROR',
  'SOCKET_DISCONNECTED',
  'SOCKET_NOT_CONNECTED',
  'MESSAGE_TIMEOUT',
  'MACHINE_OFFLINE',
  // The turn never started (the prompt did not reach the agent), so nothing ran to fail: keep the
  // persisted message and let Retry deliver it.
  'MESSAGE_NOT_DELIVERED',
  // Blocked before the turn started, like a usage limit: keep the message for Retry with a login.
  'LOGIN_REMOVED',
  // Expected declines: a send into a flow run whose task/admission already settled (stamped by
  // main's provider preflight). The server persisted the message before preflight, so rolling it
  // back would diverge UI from DB — surface the toast and keep the transcript intact. RESUMING is
  // the decline-and-convert variant: the persisted message IS the continuation payload, so a
  // rollback here would delete what the re-admitted run is about to deliver.
  'FLOW_RUN_ENDED',
  'FLOW_RUN_RESUMING',
  // Declined by main's archived admission check: the chat was archived, the run never started.
  'CHAT_ARCHIVED',
]);

function normalizeErrorText(raw: string): string {
  return normalizeErrorTextPrefix(raw, { stripRetriablePrefix: true });
}

function isToolConcurrency400Error(normalizedError: string): boolean {
  return (
    normalizedError.includes('api error: 400') &&
    (normalizedError.includes('tool_use') || normalizedError.includes('tool use')) &&
    normalizedError.includes('tool_result')
  );
}

export function isExecutionLevelFailure(rawError: string, category: string): boolean {
  const normalized = normalizeErrorText(rawError).toLowerCase();
  if (isToolConcurrency400Error(normalized)) {
    return true;
  }

  if (NON_EXECUTION_ERROR_CATEGORIES.has(category)) {
    return false;
  }

  if (
    normalized.includes('unpaid invoice') ||
    normalized.includes('pay your invoice') ||
    normalized.includes('invalid api key') ||
    normalized.includes('not logged in') ||
    normalized.includes('authentication failed') ||
    normalized.includes('not authenticated on this machine')
  ) {
    return false;
  }

  return true;
}
