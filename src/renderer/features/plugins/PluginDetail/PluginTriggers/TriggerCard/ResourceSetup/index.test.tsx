// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc';
import { getProviderById } from '../../../../../../../shared/integrations/selectors';
import { ResourceSetup } from './index';

vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});
type Options = { selection: 'one' | 'many'; options: { id: string; label: string }[] };
const OPTIONS: Options = {
  selection: 'many',
  options: [
    { id: 'account:health', label: 'Production · API health' },
    { id: 'account:certificate', label: 'Production · Certificate' },
  ],
};
const options = vi.fn<() => Promise<Options>>();
type ConfigureInput = { integrationId: string; webhookId: string; selection: string[] };
const configure = vi.fn<(input: ConfigureInput) => Promise<null>>();
const clients: QueryClient[] = [];

function renderSetup(provider?: string) {
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
              op.path === 'triggerSetup.options'
                ? options()
                : op.path === 'triggerSetup.configure'
                  ? // SAFETY: the fake link forwards the input the component sent to this path.
                    configure(op.input as ConfigureInput)
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
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ResourceSetup
          integrationId="integration"
          webhookId="endpoint"
          provider={provider ? getProviderById(provider) : undefined}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
beforeEach(() => {
  options.mockReset().mockResolvedValue(OPTIONS);
  configure.mockReset().mockResolvedValue(null);
});

it('names every alert checkbox and submits only the selected alerts', async () => {
  renderSetup();
  const submit = screen.getByRole('button', { name: 'Use these alerts' });
  expect(submit).toBeDisabled();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Production · API health' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Production · Certificate' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Production · API health' }));
  fireEvent.click(submit);
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      selection: ['account:certificate'],
    }),
  );
});
it('replaces the selection when a provider permits only one resource', async () => {
  options.mockResolvedValue({ ...OPTIONS, selection: 'one' });
  renderSetup();
  const health = await screen.findByRole('checkbox', { name: 'Production · API health' });
  const certificate = screen.getByRole('checkbox', { name: 'Production · Certificate' });
  fireEvent.click(health);
  fireEvent.click(certificate);
  expect(health).not.toBeChecked();
  expect(certificate).toBeChecked();
});
it('announces vendor errors and lets the user refresh choices', async () => {
  options.mockRejectedValueOnce(
    new Error('Create an alert in Cloudflare Notifications, then try again.'),
  );
  renderSetup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Create an alert');
  expect(screen.queryByText('Choose alerts')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use these alerts' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(options).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByRole('checkbox', { name: 'Production · API health' }),
  ).toBeInTheDocument();
});
it('announces the loading state while choices are unresolved', () => {
  options.mockImplementation(() => new Promise(() => undefined));
  renderSetup();
  expect(screen.getByRole('status')).toHaveTextContent('Loading alerts');
});
it('announces a refused configuration without losing the selected choices', async () => {
  configure.mockRejectedValue(new Error('Choose alerts from one Cloudflare account.'));
  renderSetup();
  const health = await screen.findByRole('checkbox', { name: 'Production · API health' });
  fireEvent.click(health);
  fireEvent.click(screen.getByRole('button', { name: 'Use these alerts' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('one Cloudflare account');
  expect(health).toBeChecked();
  expect(screen.getByText('Choose alerts')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use these alerts' })).toBeEnabled();
});

it('sets up Hugging Face with the connected account and explicit watched resource, without a token field', async () => {
  options.mockResolvedValue({ options: [], selection: 'many' });
  renderSetup('huggingface');
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
  expect(screen.getAllByText('What to watch')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Set up automatically' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Resource type'), { target: { value: 'model' } });
  fireEvent.change(screen.getByLabelText('Resource name'), { target: { value: 'owner/model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      selection: ['model:owner/model'],
    }),
  );
});
