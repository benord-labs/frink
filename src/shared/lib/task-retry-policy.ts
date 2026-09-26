import type { GithubCredentialErrorCode } from './github-credential-errors';

type DispatchErrorCode =
  | GithubCredentialErrorCode
  | 'NO_CLAUDE_CREDENTIAL'
  | 'INVALID_MODEL'
  | 'WORKTREE_UNAVAILABLE';

type RetryTask =
  | {
      status?: string;
      result?: unknown;
    }
  | null
  | undefined;

type RetryAssessment = {
  canRetry: boolean;
  remediation: string | null;
};

const RETRYABLE_FAILURE_CODES: ReadonlySet<string> = new Set(['EXECUTION_LEASE_EXPIRED']);

const NON_RETRYABLE_DISPATCH_ERROR_CODES: ReadonlySet<DispatchErrorCode> = new Set([
  'MISSING_PAT',
  'MISSING_GITHUB_CREDENTIAL',
  'INVALID_PAT',
  'INVALID_GITHUB_CREDENTIAL',
  'INSUFFICIENT_SCOPE',
  'PROJECT_OVERRIDE_NOT_FOUND',
  'NO_EFFECTIVE_GITHUB_CREDENTIAL',
  'NO_CLAUDE_CREDENTIAL',
  'INVALID_MODEL',
  'WORKTREE_UNAVAILABLE',
]);

function getResultRecord(result: unknown): Record<string, unknown> | null {
  if (typeof result !== 'object' || result == null) {
    return null;
  }
  return result as Record<string, unknown>;
}

function getStringValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getNonRetryableDispatchErrorCode(
  record: Record<string, unknown> | null,
): DispatchErrorCode | null {
  const code = getStringValue(record, 'dispatchErrorCode');
  if (!code) return null;
  return NON_RETRYABLE_DISPATCH_ERROR_CODES.has(code as DispatchErrorCode)
    ? (code as DispatchErrorCode)
    : null;
}

export function getTaskFailureContext(task: RetryTask): string | null {
  const result = getResultRecord(task?.result);
  return (
    getStringValue(result, 'dispatchErrorRemediation') ?? getStringValue(result, 'dispatchError')
  );
}

/**
 * True when a needs_attention park is retryable (usage limit / transient API error) — every
 * other park kind (AskUserQuestion, agent attention signal, manual completion) is waiting for
 * the USER's input, and a blind retry would nudge the agent past it.
 */
export function isRetryableParkedResult(result: unknown): boolean {
  const record = getResultRecord(result);
  return Boolean(record?.usageLimit || record?.apiError);
}

export function assessTaskRetry(task: RetryTask): RetryAssessment {
  if (task?.status === 'needs_attention') {
    if (isRetryableParkedResult(task.result)) {
      return { canRetry: true, remediation: null };
    }
    return {
      canRetry: false,
      remediation: 'This task is waiting for your input — open its chat to respond.',
    };
  }

  if (task?.status !== 'failed') {
    return { canRetry: false, remediation: null };
  }

  const result = getResultRecord(task.result);
  const failureCode = getStringValue(result, 'failureCode');
  if (failureCode && RETRYABLE_FAILURE_CODES.has(failureCode)) {
    return { canRetry: true, remediation: null };
  }
  const dispatchErrorCode = getNonRetryableDispatchErrorCode(result);
  if (!dispatchErrorCode) {
    return { canRetry: true, remediation: null };
  }

  return {
    canRetry: false,
    remediation:
      getStringValue(result, 'dispatchErrorRemediation') ??
      'Retry blocked until credentials are fixed in Settings > AI providers.',
  };
}
