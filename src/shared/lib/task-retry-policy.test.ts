import { describe, expect, it } from 'vitest';
import {
  assessTaskRetry,
  getTaskFailureContext,
  isRetryableParkedResult,
} from './task-retry-policy';

describe('task-retry-policy', () => {
  it('allows retry for usage-limit and api-error parked needs_attention tasks', () => {
    expect(
      assessTaskRetry({ status: 'needs_attention', result: { usageLimit: { message: 'limit' } } }),
    ).toEqual({ canRetry: true, remediation: null });
    expect(
      assessTaskRetry({
        status: 'needs_attention',
        result: { apiError: { message: 'API Error: 401', status: 401 } },
      }),
    ).toEqual({ canRetry: true, remediation: null });
  });

  it('blocks retry for input-waiting needs_attention parks — a blind retry would skip the question', () => {
    for (const result of [undefined, {}, { agentSignal: { summary: 'need a decision' } }]) {
      const assessment = assessTaskRetry({ status: 'needs_attention', result });
      expect(assessment.canRetry).toBe(false);
      expect(assessment.remediation).toContain('waiting for your input');
    }
  });

  it('isRetryableParkedResult distinguishes park kinds', () => {
    expect(isRetryableParkedResult({ usageLimit: { message: 'x' } })).toBe(true);
    expect(isRetryableParkedResult({ apiError: { message: 'x', status: 529 } })).toBe(true);
    expect(isRetryableParkedResult({ agentSignal: {} })).toBe(false);
    expect(isRetryableParkedResult(null)).toBe(false);
  });

  it('returns non-retryable for non-failed task statuses', () => {
    expect(assessTaskRetry({ status: 'completed' })).toEqual({
      canRetry: false,
      remediation: null,
    });
    expect(assessTaskRetry({ status: 'pending' })).toEqual({
      canRetry: false,
      remediation: null,
    });
  });

  it('returns non-retryable safely for null/undefined tasks', () => {
    expect(assessTaskRetry(null)).toEqual({
      canRetry: false,
      remediation: null,
    });
    expect(assessTaskRetry(undefined)).toEqual({
      canRetry: false,
      remediation: null,
    });
  });

  it('allows retry when failed result payload is missing', () => {
    expect(assessTaskRetry({ status: 'failed' })).toEqual({
      canRetry: true,
      remediation: null,
    });
    expect(assessTaskRetry({ status: 'failed', result: null })).toEqual({
      canRetry: true,
      remediation: null,
    });
  });

  it('allows retry for generic failed tasks', () => {
    expect(assessTaskRetry({ status: 'failed', result: { error: 'timeout' } })).toEqual({
      canRetry: true,
      remediation: null,
    });
  });

  it('blocks retry for credential dispatch failures', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'MISSING_PAT',
          dispatchErrorRemediation: 'Add a PAT in settings.',
        },
      }),
    ).toEqual({
      canRetry: false,
      remediation: 'Add a PAT in settings.',
    });
  });

  it('blocks retry for credential alias dispatch failures', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'INVALID_GITHUB_CREDENTIAL',
          dispatchErrorRemediation: 'Reconnect GitHub in Settings > AI providers.',
        },
      }),
    ).toEqual({
      canRetry: false,
      remediation: 'Reconnect GitHub in Settings > AI providers.',
    });
  });

  it('blocks retry for known dispatch errors and falls back to remediation when missing', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'MISSING_PAT',
        },
      }),
    ).toEqual({
      canRetry: false,
      remediation: 'Retry blocked until credentials are fixed in Settings > AI providers.',
    });
  });

  it('returns remediation-preferred failure context', () => {
    expect(
      getTaskFailureContext({
        status: 'failed',
        result: {
          dispatchError: 'Raw failure',
          dispatchErrorRemediation: 'Do this first',
        },
      }),
    ).toBe('Do this first');
  });

  it('treats unknown dispatch error code as retryable and falls back context to dispatchError', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'SOMETHING_NEW',
          dispatchError: 'Unknown but retryable',
        },
      }),
    ).toEqual({
      canRetry: true,
      remediation: null,
    });

    expect(
      getTaskFailureContext({
        status: 'failed',
        result: {
          dispatchErrorCode: 'SOMETHING_NEW',
          dispatchError: 'Unknown but retryable',
        },
      }),
    ).toBe('Unknown but retryable');

    expect(
      getTaskFailureContext({
        status: 'failed',
        result: {
          dispatchErrorCode: 'SOMETHING_NEW',
        },
      }),
    ).toBeNull();
  });

  it('blocks retry for invalid model dispatch failures', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'INVALID_MODEL',
          dispatchErrorRemediation: 'Select a valid model (haiku, sonnet, or opus).',
        },
      }),
    ).toEqual({
      canRetry: false,
      remediation: 'Select a valid model (haiku, sonnet, or opus).',
    });
  });

  it('blocks retry for missing Claude credential dispatch failures', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'NO_CLAUDE_CREDENTIAL',
          dispatchErrorRemediation: 'Connect Claude in Settings > AI providers.',
        },
      }),
    ).toEqual({
      canRetry: false,
      remediation: 'Connect Claude in Settings > AI providers.',
    });
  });

  it('keeps provider transport failures retryable when no dispatch code is present', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          category: 'SOCKET_DISCONNECTED',
          error: 'Socket disconnected',
        },
      }),
    ).toEqual({
      canRetry: true,
      remediation: null,
    });
  });

  it('does not block retry when dispatchErrorCode is present but not a non-retryable known code', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          dispatchErrorCode: 'AUTH_FAILED_SDK',
          dispatchError: 'Provider auth failed',
        },
      }),
    ).toEqual({
      canRetry: true,
      remediation: null,
    });
  });

  it('keeps execution lease expiry failures retryable', () => {
    expect(
      assessTaskRetry({
        status: 'failed',
        result: {
          failureCode: 'EXECUTION_LEASE_EXPIRED',
          error: 'Execution lease expired (no heartbeat)',
        },
      }),
    ).toEqual({
      canRetry: true,
      remediation: null,
    });
  });
});
