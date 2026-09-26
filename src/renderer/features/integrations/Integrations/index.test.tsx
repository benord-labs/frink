// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Integrations } from './index';

// Hoisted: `vi.mock` factories are lifted above plain const initialisers.
const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));
const installPluginMock = vi.fn();
const refetchIntegrationsMock = vi.fn<() => Promise<void>>();
const invalidatePluginsMock = vi.fn<() => Promise<void>>();
let listIntegrationsData: Array<Record<string, unknown>> = [];

const DIRECTORY_BUTTONS: Array<[string, string]> = [
  ['shortcut', 'Shortcut'],
  ['generic_webhook', 'Generic Webhook'],
  ['linear', 'Linear'],
];

// oxlint-disable-next-line anti-slop/no-module-mocking -- the connect path reports through toasts
vi.mock('sonner', () => ({ toast: { error: toastErrorMock, success: toastSuccessMock } }));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    // The directory reads its own query, so a connect must invalidate it too or
    // the just-connected row keeps offering Connect.
    useUtils: () => ({
      plugins: { list: { invalidate: invalidatePluginsMock } },
      customNodes: { list: { invalidate: vi.fn() } },
    }),
    plugins: {
      install: { useMutation: () => ({ mutateAsync: installPluginMock, isPending: false }) },
    },
    integrations: {
      list: {
        useQuery: () => ({
          data: listIntegrationsData,
          isLoading: false,
          refetch: refetchIntegrationsMock,
        }),
      },
    },
  },
}));

/**
 * Panel double: this suite owns the connect wiring and the account route, not
 * the browse surface or the plugin page (both have their own suites).
 */
vi.mock('../../plugins', () => ({
  PluginsPanel: ({
    accountDialogProvider,
    connectingProvider,
    onConnect,
    onSelectAccount,
  }: {
    accountDialogProvider: string | null;
    connectingProvider: string | null;
    onConnect: (id: string) => void;
    onSelectAccount: (connectionId: string) => void;
  }) => (
    <div>
      <div data-testid="account-dialog-provider">{accountDialogProvider ?? 'none'}</div>
      <div data-testid="connecting-provider">{connectingProvider ?? 'none'}</div>
      <button type="button" onClick={() => onSelectAccount('missing-account')}>
        Open missing account
      </button>
      <button type="button" onClick={() => onSelectAccount('shortcut-integration-1')}>
        Open known account
      </button>
      {DIRECTORY_BUTTONS.map(([id, label]) => (
        <button key={id} type="button" onClick={() => onConnect(id)}>
          {label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../IntegrationDetailDialog', () => ({
  IntegrationDetailDialog: ({
    integration,
    open,
  }: {
    integration: { id: string } | null;
    open: boolean;
  }) => <div data-testid="integration-detail-state">{open ? integration?.id : 'closed'}</div>,
}));

const SHORTCUT_ROW = {
  id: 'shortcut-integration-1',
  provider: 'shortcut',
  accountName: 'Workspace',
  accountIdentifier: 'Shortcut',
  isActive: true,
};

describe('Integrations', () => {
  afterEach(cleanup);

  beforeEach(() => {
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    installPluginMock.mockReset().mockResolvedValue({ installation: {} });
    refetchIntegrationsMock.mockReset().mockResolvedValue(undefined);
    invalidatePluginsMock.mockReset().mockResolvedValue(undefined);
    listIntegrationsData = [];
  });

  it('never asks the user to sign in to Frink before connecting a plugin', () => {
    render(<Integrations />);

    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign in to connect accounts/)).not.toBeInTheDocument();
  });

  it('creates the account and refreshes both queries on connect', async () => {
    render(<Integrations />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }));
    });

    expect(installPluginMock).toHaveBeenCalledExactlyOnceWith({ pluginId: 'shortcut' });
    await waitFor(() => expect(refetchIntegrationsMock).toHaveBeenCalled());
    expect(invalidatePluginsMock).toHaveBeenCalled();
    expect(screen.getByTestId('connecting-provider')).toHaveTextContent('none');
  });

  it('ignores repeat clicks while one connect is still running', async () => {
    let release!: () => void;
    installPluginMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ installation: {} });
        }),
    );

    render(<Integrations />);
    fireEvent.click(screen.getByRole('button', { name: 'Generic Webhook' }));
    await waitFor(() =>
      expect(screen.getByTestId('connecting-provider')).toHaveTextContent('generic_webhook'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generic Webhook' }));

    await act(async () => {
      release();
    });

    expect(installPluginMock).toHaveBeenCalledOnce();
  });

  it('reports a failed connect and leaves the row clickable again', async () => {
    installPluginMock.mockRejectedValueOnce(new Error('Endpoint limit reached'));

    render(<Integrations />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Linear' }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not finish connecting Linear',
      expect.objectContaining({ description: 'Endpoint limit reached' }),
    );
    expect(screen.getByTestId('connecting-provider')).toHaveTextContent('none');
  });

  it('reports a refresh failure as an already created connection', async () => {
    refetchIntegrationsMock.mockRejectedValueOnce(new Error('offline'));

    render(<Integrations />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Connection created, but the list could not refresh.',
      expect.objectContaining({ description: 'offline' }),
    );
  });

  it('names the provider whose account dialog opened, so a mismatched page can step aside', () => {
    listIntegrationsData = [SHORTCUT_ROW];
    render(<Integrations />);

    expect(screen.getByTestId('account-dialog-provider')).toHaveTextContent('none');
    fireEvent.click(screen.getByRole('button', { name: 'Open known account' }));

    expect(screen.getByTestId('account-dialog-provider')).toHaveTextContent('shortcut');
    expect(screen.getByTestId('integration-detail-state')).toHaveTextContent(
      'shortcut-integration-1',
    );
  });

  it('says so rather than doing nothing when an account id no longer resolves', async () => {
    listIntegrationsData = [SHORTCUT_ROW];
    render(<Integrations />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open missing account' }));
    });

    expect(refetchIntegrationsMock).toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'That account is no longer available',
      expect.objectContaining({ description: 'The list has been refreshed.' }),
    );
    expect(screen.getByTestId('integration-detail-state')).toHaveTextContent('closed');
  });
});
