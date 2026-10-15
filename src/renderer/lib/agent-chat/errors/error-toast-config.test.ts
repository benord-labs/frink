// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../trpc', () => ({ trpcClient: {} }));

import { pendingAccountAuthAtom } from '../../atoms';
import { appStore } from '../../jotai-store';
import { trpcClient } from '../../trpc';
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

// sc-3666: main fails a turn whose prompt never reached the agent with this category. It must
// read as its own toast (not a generic failure) and keep Retry, which is the user's only way to
// deliver the message they can still see in the transcript.
describe('MESSAGE_NOT_DELIVERED', () => {
  it('has its own toast copy and stays retryable', () => {
    expect(ERROR_TOAST_CONFIG.MESSAGE_NOT_DELIVERED?.title).toBe('Message not delivered');
    expect(shouldPersistChatRetry('MESSAGE_NOT_DELIVERED')).toBe(true);
  });
});

describe('CURSOR_SIGNED_OUT', () => {
  it("opens Cursor's connect page on its stored name, and keeps Retry", async () => {
    const accounts = [
      { type: 'codex', label: 'Codex' },
      { type: 'cursor', label: 'Work' },
    ];
    Object.assign(trpcClient, { claudeCode: { listAccounts: { query: async () => accounts } } });
    const config = ERROR_TOAST_CONFIG.CURSOR_SIGNED_OUT;
    expect(config).toMatchObject({ title: "Cursor isn't signed in", action: { label: 'Sign in' } });

    config?.action?.onClick();

    await vi.waitFor(() => expect(appStore.get(pendingAccountAuthAtom)).not.toBeNull());
    expect(appStore.get(pendingAccountAuthAtom)).toEqual({
      mode: 'reauth',
      accountLabel: 'Work',
      returnToSettings: false,
      provider: 'cursor',
    });
    expect(shouldPersistChatRetry('CURSOR_SIGNED_OUT')).toBe(true);
  });

  it("still opens Cursor's connect page when the account list can't be read", async () => {
    appStore.set(pendingAccountAuthAtom, null);
    const query = async () => Promise.reject(new Error('database busy'));
    Object.assign(trpcClient, { claudeCode: { listAccounts: { query } } });

    ERROR_TOAST_CONFIG.CURSOR_SIGNED_OUT?.action?.onClick();

    await vi.waitFor(() => expect(appStore.get(pendingAccountAuthAtom)).not.toBeNull());
    expect(appStore.get(pendingAccountAuthAtom)).toMatchObject({
      accountLabel: '',
      provider: 'cursor',
    });
  });
});
