import { describe, expect, it } from 'vitest';
import { isExecutionLevelFailure } from './execution-error-classification';

describe('isExecutionLevelFailure', () => {
  it('returns false for all transport/auth/transient excluded categories', () => {
    const excluded = [
      'AUTH_FAILED_SDK',
      'INVALID_API_KEY_SDK',
      'RATE_LIMIT_SDK',
      'OVERLOADED_SDK',
      'NETWORK_ERROR',
      'SOCKET_DISCONNECTED',
      'SOCKET_NOT_CONNECTED',
      'MESSAGE_TIMEOUT',
      'MACHINE_OFFLINE',
      'FLOW_RUN_ENDED',
      'LOGIN_REMOVED',
    ];

    for (const category of excluded) {
      expect(isExecutionLevelFailure('some failure', category)).toBe(false);
    }
  });

  it('returns false for known non-execution auth/billing text patterns', () => {
    const nonExecutionErrors = [
      'Your account has an unpaid invoice.',
      'Please pay your invoice to continue.',
      'Invalid API key provided.',
      'Not logged in to provider account.',
      'Authentication failed for this request.',
      'Account is not authenticated on this machine.',
    ];

    for (const error of nonExecutionErrors) {
      expect(isExecutionLevelFailure(error, 'UNKNOWN')).toBe(false);
    }
  });

  it('returns true for execution-level unknown errors', () => {
    expect(isExecutionLevelFailure('Tool execution crashed with exit code 1', 'UNKNOWN')).toBe(
      true,
    );
  });

  it('keeps RATE_LIMIT_SDK non-execution (retryable) by design', () => {
    expect(isExecutionLevelFailure('Rate limit exceeded', 'RATE_LIMIT_SDK')).toBe(false);
  });

  it('keeps FLOW_RUN_RESUMING non-execution — the persisted message IS the continuation payload', () => {
    expect(isExecutionLevelFailure('declined for re-admission', 'FLOW_RUN_RESUMING')).toBe(false);
  });

  it('keeps MESSAGE_NOT_DELIVERED non-execution: nothing ran, so the persisted message stays', () => {
    expect(
      isExecutionLevelFailure(
        'Claude execution failed. Please try again.',
        'MESSAGE_NOT_DELIVERED',
      ),
    ).toBe(false);
  });

  it('keeps FLOW_RUN_ENDED non-execution so the typed message is not rolled back', () => {
    // These are the provider-preflight decline messages stamped with the category in main
    // (flow-resource-cleanup.ts assertFlowProviderEligible); the server persisted the user's
    // message before preflight, so classifying them execution-level would roll back a message
    // the DB keeps.
    const declines = [
      'Flow task t1 is no longer execution-eligible',
      'Flow run r1 is no longer admitted for provider execution',
    ];
    for (const error of declines) {
      expect(isExecutionLevelFailure(error, 'FLOW_RUN_ENDED')).toBe(false);
    }
  });

  it('treats a tool-concurrency API 400 as an execution-level failure whatever the category', () => {
    expect(
      isExecutionLevelFailure(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_use ids were found without tool_result blocks immediately after: toolu_123"}}',
        'AUTH_FAILED_SDK',
      ),
    ).toBe(true);
  });
});
