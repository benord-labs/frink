// @vitest-environment happy-dom

import { focusManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  type PendingAccountAuthState,
  pendingAccountAuthAtom,
} from '../../lib/atoms';
import { DETECTION_QUERY_OPTIONS, useConnectAccountFlow } from '.';

const listAccountsInvalidate = vi.fn();
const getResolvedAccountInvalidate = vi.fn();
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      claudeCode: {
        listAccounts: { invalidate: listAccountsInvalidate },
        getResolvedAccount: { invalidate: getResolvedAccountInvalidate },
      },
    }),
  },
}));

vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Renders the hook against a real jotai store seeded with `pending`. The provider-specific
 * params are stubbed — this suite exercises the shared flow (return-to-Settings handoff,
 * reauth propagation, pending clear + invalidations), not any one provider's wiring.
 */
function renderFlow(pending: PendingAccountAuthState | null) {
  const store = createStore();
  store.set(pendingAccountAuthAtom, pending);

  const mutateAsync = vi.fn().mockResolvedValue(undefined);
  const buildConnectInput = vi.fn((label: string, ctx: { isReauthFlow: boolean }) => ({
    accountLabel: label,
    reauth: ctx.isReauthFlow,
  }));
  const successMessage = vi.fn((isReauth: boolean) =>
    isReauth ? 'Account reconnected' : 'Account connected',
  );
  const refetch = vi.fn().mockResolvedValue({ data: { available: true } });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  const view = renderHook(
    () =>
      useConnectAccountFlow({
        detectionQuery: { data: { available: true }, isLoading: false, refetch },
        connectMutation: { mutateAsync },
        buildConnectInput,
        deriveLabel: () => null,
        successMessage,
      }),
    { wrapper },
  );

  return { store, mutateAsync, buildConnectInput, successMessage, refetch, ...view };
}

describe('useConnectAccountFlow', () => {
  it('reauth + returnToSettings: submits with reauth:true, clears pending, invalidates, returns to Settings > Models', async () => {
    const { store, mutateAsync, buildConnectInput, successMessage, result } = renderFlow({
      accountId: 'acc-1',
      accountLabel: 'Work Claude',
      mode: 'reauth',
      returnToSettings: true,
    });

    expect(result.current.isReauthFlow).toBe(true);
    expect(result.current.accountLabel).toBe('Work Claude');

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(buildConnectInput).toHaveBeenCalledWith('Work Claude', {
      detection: { available: true },
      isReauthFlow: true,
    });
    expect(mutateAsync).toHaveBeenCalledWith({ accountLabel: 'Work Claude', reauth: true });
    expect(listAccountsInvalidate).toHaveBeenCalled();
    expect(getResolvedAccountInvalidate).toHaveBeenCalled();
    expect(store.get(pendingAccountAuthAtom)).toBeNull();
    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(true);
    expect(successMessage).toHaveBeenCalledWith(true);
    expect(toastSuccess).toHaveBeenCalledWith('Account reconnected');
  });

  it('add-mode success without returnToSettings: connects but leaves the Settings dialog shut', async () => {
    const { store, buildConnectInput, successMessage, result } = renderFlow({
      accountLabel: 'Personal',
      mode: 'add',
    });

    expect(result.current.isReauthFlow).toBe(false);

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(buildConnectInput).toHaveBeenCalledWith('Personal', {
      detection: { available: true },
      isReauthFlow: false,
    });
    expect(store.get(pendingAccountAuthAtom)).toBeNull();
    expect(listAccountsInvalidate).toHaveBeenCalled();
    expect(successMessage).toHaveBeenCalledWith(false);
    // No return-to-Settings requested: the dialog stays closed on its default tab.
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(false);
    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('preferences');
  });

  it('handleBack with returnToSettings: clears pending and returns to Settings > Models', () => {
    const { store, result } = renderFlow({
      accountId: 'acc-1',
      accountLabel: 'Work Claude',
      mode: 'reauth',
      returnToSettings: true,
    });

    act(() => {
      result.current.handleBack();
    });

    expect(store.get(pendingAccountAuthAtom)).toBeNull();
    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(true);
  });

  it('handleBack without returnToSettings: clears pending but does not open Settings', () => {
    const { store, result } = renderFlow({ accountLabel: 'Personal', mode: 'add' });

    act(() => {
      result.current.handleBack();
    });

    expect(store.get(pendingAccountAuthAtom)).toBeNull();
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(false);
  });

  it('failed connect surfaces the error and performs none of the success side-effects', async () => {
    const pending: PendingAccountAuthState = {
      accountId: 'acc-1',
      accountLabel: 'Work Claude',
      mode: 'reauth',
      returnToSettings: true,
    };
    const { store, mutateAsync, result } = renderFlow(pending);
    mutateAsync.mockRejectedValueOnce(new Error('keychain locked'));

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(result.current.flowState).toBe('error');
    expect(result.current.errorMessage).toBe('keychain locked');
    // A failed reconnect must not strand the user: pending stays, Settings stays shut,
    // nothing is invalidated and no success toast fires.
    expect(store.get(pendingAccountAuthAtom)).toEqual(pending);
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(false);
    expect(listAccountsInvalidate).not.toHaveBeenCalled();
    expect(getResolvedAccountInvalidate).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the rejection is not an Error', async () => {
    const { mutateAsync, result } = renderFlow({ accountLabel: 'Work', mode: 'add' });
    mutateAsync.mockRejectedValueOnce('socket hung up');

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(result.current.flowState).toBe('error');
    expect(result.current.errorMessage).toBe('Failed to connect account');
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects a %s label without calling the mutation', async (_name, label) => {
    const { store, mutateAsync, result } = renderFlow({ accountLabel: label, mode: 'add' });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(result.current.flowState).toBe('error');
    expect(result.current.errorMessage).toBe('Please enter an account label.');
    expect(store.get(pendingAccountAuthAtom)).not.toBeNull();
  });

  it('trims surrounding whitespace before submitting the label', async () => {
    const { mutateAsync, buildConnectInput, result } = renderFlow({
      accountLabel: '  Work Claude  ',
      mode: 'add',
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(buildConnectInput).toHaveBeenCalledWith('Work Claude', expect.anything());
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ accountLabel: 'Work Claude' }),
    );
  });

  it('refresh clears a prior error and refetches detection', async () => {
    const { mutateAsync, refetch, result } = renderFlow({ accountLabel: 'Work', mode: 'add' });
    mutateAsync.mockRejectedValueOnce(new Error('boom'));

    await act(async () => {
      await result.current.handleConnect();
    });
    expect(result.current.flowState).toBe('error');

    await act(async () => {
      await result.current.handleRefresh();
    });

    expect(refetch).toHaveBeenCalled();
    expect(result.current.flowState).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.isRefreshing).toBe(false);
  });
});

describe('DETECTION_QUERY_OPTIONS.refetchOnWindowFocus', () => {
  const shouldRefetch = (data?: { available: boolean }) =>
    DETECTION_QUERY_OPTIONS.refetchOnWindowFocus({ state: { data } });

  it('stops refetching on focus once a login is detected', () => {
    expect(shouldRefetch({ available: true })).toBe(false);
  });

  it('keeps refetching on focus while no login is detected', () => {
    expect(shouldRefetch({ available: false })).toBe(true);
  });

  it('keeps refetching on focus before the first result lands (or after an IPC error with no data)', () => {
    expect(shouldRefetch(undefined)).toBe(true);
  });
});

/**
 * Wiring check against a real QueryClient + react-query's focusManager, so a react-query upgrade
 * that stops honouring the function form (or a caller that spreads the options wrongly) fails here
 * rather than silently reverting to a keychain read on every window return.
 */
describe('DETECTION_QUERY_OPTIONS with a real QueryClient', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  function renderDetection(queryFn: () => Promise<{ available: boolean }>) {
    // staleTime 0 isolates the focus policy from the app's global 5s staleTime; 'all' disables
    // tracked-prop render skipping so assertions read the latest state.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, notifyOnChangeProps: 'all' } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(
      () => useQuery({ queryKey: ['detect'], queryFn, ...DETECTION_QUERY_OPTIONS }),
      { wrapper },
    );
  }

  // Async act flushes the microtask in which react-query would start a refetch, so a
  // "not called" assertion right after can't pass just because the fetch hadn't begun yet.
  const returnToWindow = async () => {
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });
  };

  it('does not re-run detection on window return once a login is detected', async () => {
    const queryFn = vi.fn().mockResolvedValue({ available: true });
    const { result } = renderDetection(queryFn);
    await waitFor(() => expect(result.current.data).toEqual({ available: true }));

    await returnToWindow();
    await returnToWindow();

    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('re-runs detection on window return while no login is detected, then stops once one appears', async () => {
    // Models `claude auth login` in Terminal: first probe finds nothing, the next finds the login.
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ available: false })
      .mockResolvedValue({ available: true });
    const { result } = renderDetection(queryFn);
    await waitFor(() => expect(result.current.data).toEqual({ available: false }));

    await returnToWindow();
    await waitFor(() => expect(result.current.data).toEqual({ available: true }));
    expect(queryFn).toHaveBeenCalledTimes(2);

    await returnToWindow();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('resumes refetching on window return after a manual refresh finds the login gone (sign-out)', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ available: true })
      .mockResolvedValueOnce({ available: false })
      .mockResolvedValue({ available: true });
    const { result } = renderDetection(queryFn);
    await waitFor(() => expect(result.current.data).toEqual({ available: true }));

    // "Check for Login" → explicit refetch bypasses the focus policy.
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toEqual({ available: false }));

    await returnToWindow();
    await waitFor(() => expect(result.current.data).toEqual({ available: true }));
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('keeps the last detected login (and stops focus refetch) when a later manual refresh errors', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ available: true })
      .mockRejectedValueOnce(new Error('ipc down'));
    const { result } = renderDetection(queryFn);
    await waitFor(() => expect(result.current.data).toEqual({ available: true }));

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toEqual({ available: true });

    await returnToWindow();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
