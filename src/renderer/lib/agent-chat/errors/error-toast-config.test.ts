import { describe, expect, it, vi } from 'vitest';

vi.mock('../../trpc', () => ({ trpcClient: {} }));

import { ERROR_TOAST_CONFIG, shouldPersistChatRetry, toastDedupId } from './error-toast-config';

// The flow-run decline categories must stay registered together: a missing registration
// silently rolls the typed message back or stacks toasts (see execution-error-classification
// and task-execution-error-signal for the other registries).
describe('flow-run decline categories', () => {
  it.each(['FLOW_RUN_ENDED', 'FLOW_RUN_RESUMING'])('%s is toast-deduped', (category) => {
    const config = ERROR_TOAST_CONFIG[category];
    expect(config?.toastId).toBeTruthy();
    expect(toastDedupId(config, 'sub-1').id).toBe(`${config?.toastId}:sub-1`);
  });

  it.each(['FLOW_RUN_ENDED', 'FLOW_RUN_RESUMING'])('%s never persists a chat retry', (category) => {
    expect(shouldPersistChatRetry(category)).toBe(false);
  });

  it('unknown categories stay retryable', () => {
    expect(shouldPersistChatRetry('SOMETHING_ELSE')).toBe(true);
  });
});
