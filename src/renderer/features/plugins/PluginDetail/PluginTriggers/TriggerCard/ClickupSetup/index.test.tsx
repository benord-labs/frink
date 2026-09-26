// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProviderById } from '../../../../../../../shared/integrations/selectors';
import { trpc } from '@/lib/trpc';
import { AdvancedPanel } from '../AdvancedPanel';
import { ApiTokenSetup } from '../ApiTokenSetup';

vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});
type ConfigureTokenInput = { integrationId: string; webhookId: string; apiKey?: string };
type ConfigureTokenResult = { success: boolean; options?: { id: string; label: string }[] };
type ImportWebhookInput = {
  integrationId: string;
  webhookId: string;
  vendorWebhookId: string;
  secret: string;
};
const configure = vi.fn<(input: ConfigureTokenInput) => Promise<ConfigureTokenResult>>();
const save = vi.fn<(input: ImportWebhookInput) => Promise<{ success: boolean }>>();
const clients: QueryClient[] = [];

function renderSetup(advanced = false, vendorRef?: string, providerId = 'clickup') {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  clients.push(queryClient);
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const result =
              op.path === 'triggerSetup.configureApiToken'
                ? // SAFETY: the fake link forwards the input the component sent to this path.
                  configure(op.input as ConfigureTokenInput)
                : op.path === 'triggerSetup.importClickupWebhook'
                  ? // SAFETY: the fake link forwards the input the component sent to this path.
                    save(op.input as ImportWebhookInput)
                  : undefined;
            if (!result) throw new Error(`Unexpected operation: ${op.path}`);
            void result.then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error: Error) => observer.error(TRPCClientError.from(error)),
            );
          }),
    ],
  });
  const provider = getProviderById(providerId);
  if (!provider) throw new Error('ClickUp provider is required');
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {advanced ? (
          <AdvancedPanel
            integrationId="integration"
            provider={provider}
            endpoint={{
              id: 'endpoint',
              webhookUrl: 'https://frink.example/clickup',
              webhookSecret: 'vendor-secret',
              vendorRef,
              isActive: true,
              lastReceivedAt: null,
              lastError: null,
            }}
            withManualSetup={!vendorRef}
            rotating={false}
            deactivating={false}
            onRotate={vi.fn()}
            onDeactivate={vi.fn()}
          />
        ) : (
          <ApiTokenSetup integrationId="integration" webhookId="endpoint" provider={provider} />
        )}
      </QueryClientProvider>
    </trpc.Provider>,
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
beforeEach(() => {
  configure.mockReset().mockResolvedValue({ success: true, options: [] });
  save.mockReset().mockResolvedValue({ success: true });
});

it('uses an API key only for automatic trigger setup and clears it after success', async () => {
  renderSetup();
  fireEvent.change(screen.getByLabelText('ClickUp API key'), {
    target: { value: '  pk-example  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      apiKey: 'pk-example',
    }),
  );
  await waitFor(() => expect(screen.getByLabelText('ClickUp API key')).toHaveValue(''));
});

it('keeps the API key until a returned workspace is chosen', async () => {
  configure.mockResolvedValueOnce({
    success: false,
    options: [
      { id: 'a', label: 'Personal' },
      { id: 'b', label: 'Work' },
    ],
  });
  renderSetup();
  fireEvent.change(screen.getByLabelText('ClickUp API key'), { target: { value: 'pk-example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'Work' }));
  expect(screen.getByLabelText('ClickUp API key')).toHaveValue('pk-example');
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  await waitFor(() =>
    expect(configure).toHaveBeenLastCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      selection: ['b'],
      apiKey: 'pk-example',
    }),
  );
});

it('reports a rejected key and lets the user correct it', async () => {
  configure.mockRejectedValueOnce(new Error('ClickUp rejected this API key.'));
  renderSetup();
  fireEvent.change(screen.getByLabelText('ClickUp API key'), { target: { value: 'bad-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('ClickUp rejected this API key.');
  expect(screen.getByLabelText('ClickUp API key')).toHaveValue('bad-key');
});

it('imports the vendor webhook and secret without showing a generated Frink secret', async () => {
  renderSetup(true);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(screen.getByRole('textbox', { name: 'Webhook address' })).toHaveValue(
    'https://frink.example/clickup',
  );
  expect(screen.queryByLabelText('Secret, hidden')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('ClickUp webhook ID'), { target: { value: 'hook-1' } });
  fireEvent.change(screen.getByLabelText('ClickUp signing secret'), {
    target: { value: 'clickup-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save ClickUp webhook' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      vendorWebhookId: 'hook-1',
      secret: 'clickup-secret',
    }),
  );
  await waitFor(() => expect(screen.getByLabelText('ClickUp signing secret')).toHaveValue(''));
});

it('updates a manual secret, requires vendor-side deletion, and never offers rotation', () => {
  renderSetup(true, 'manual:clickup:hook-1');
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(screen.getByLabelText('ClickUp webhook ID')).toHaveValue('hook-1');
  expect(screen.getByLabelText('ClickUp webhook ID')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Update signing secret' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
  expect(screen.getByText(/Delete the webhook in ClickUp yourself/)).toBeInTheDocument();
});

it('explains vendor-generated automatic secret rotation without offering manual import', () => {
  renderSetup(true, JSON.stringify({ workspaceId: 'workspace', webhookId: 'hook' }));
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(
    screen.getByText(
      'ClickUp generated this secret. Frink recreates the webhook in ClickUp when you rotate it.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();
  expect(screen.queryByLabelText('ClickUp webhook ID')).not.toBeInTheDocument();
});

it('reuses a saved API key when retrying with the field blank', async () => {
  renderSetup();
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith({ integrationId: 'integration', webhookId: 'endpoint' }),
  );
});

it('explains when a key has no available workspaces', async () => {
  configure.mockResolvedValue({ success: false, options: [] });
  renderSetup();
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'No resources are available for this credential.',
  );
});
