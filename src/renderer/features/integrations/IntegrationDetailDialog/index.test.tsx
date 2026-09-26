// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationDetailDialog } from './index';

const disconnectMutate = vi.fn();
let disconnectResult: { success: true; cleanupPending: boolean } = {
  success: true,
  cleanupPending: false,
};
const { toastSuccessMock, toastErrorMock, toastWarningMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    warning: toastWarningMock,
  },
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    triggerRules: {
      listByIntegration: { useQuery: vi.fn(() => ({ data: [], refetch: vi.fn() })) },
      getEventTypes: { useQuery: vi.fn(() => ({ data: [] })) },
      toggle: { useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })) },
      delete: { useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })) },
    },
    plugins: {
      list: {
        useQuery: vi.fn(() => ({ data: undefined, isLoading: false, isError: true })),
      },
    },
    integrations: {
      disconnectIntegration: {
        useMutation: vi.fn(
          (options?: {
            onSuccess?: (result: { success: true; cleanupPending: boolean }) => void;
          }) => ({
            mutate: (input: unknown) => {
              disconnectMutate(input);
              options?.onSuccess?.(disconnectResult);
            },
            isPending: false,
          }),
        ),
      },
    },
  },
}));

describe('IntegrationDetailDialog disconnect flow', () => {
  const integration = {
    id: 'integration-1',
    provider: 'shortcut',
    accountName: 'Old Name',
    accountIdentifier: 'acct-1',
  } as const;

  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
    disconnectMutate.mockReset();
    disconnectResult = { success: true, cleanupPending: false };
  });

  afterEach(() => {
    cleanup();
  });

  it('closes with pending-cleanup copy when provider cleanup is incomplete', () => {
    disconnectResult = { success: true, cleanupPending: true };
    const onOpenChange = vi.fn();
    const onDisconnected = vi.fn();
    render(
      <IntegrationDetailDialog
        integration={{ ...integration, provider: 'linear' }}
        open
        onOpenChange={onOpenChange}
        onDisconnected={onDisconnected}
        onRefetch={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Integration' }));
    fireEvent.click(screen.getByRole('button', { name: /^Disconnect$/ }));

    expect(disconnectMutate).toHaveBeenCalledWith({ integrationId: integration.id });
    expect(toastWarningMock).toHaveBeenCalledWith(
      'Disconnected locally. Provider connection cleanup is still pending.',
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDisconnected).toHaveBeenCalledOnce();
  });
});
