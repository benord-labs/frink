// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc';
import { getProviderById } from '../../../../../../../shared/integrations/selectors';
import { VendorSecretSetup } from './index';

vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});
type SaveSecretInput = { integrationId: string; webhookId: string; secret: string };
const save = vi.fn<(input: SaveSecretInput) => Promise<{ success: boolean }>>();
const clients: QueryClient[] = [];
function setup(providerId: string, vendorRef?: string) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(queryClient);
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'triggerSetup.importVendorWebhook')
              throw new Error(`Unexpected ${op.path}`);
            // SAFETY: the fake link forwards the input the component sent to this path.
            void save(op.input as SaveSecretInput).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error: Error) => observer.error(TRPCClientError.from(error)),
            );
          }),
    ],
  });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <VendorSecretSetup
          provider={getProviderById(providerId)!}
          integrationId="integration"
          webhookId="endpoint"
          vendorRef={vendorRef}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}
beforeEach(() => {
  save.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
it.each(['square', 'vercel', 'sentry'])(
  'imports the masked %s key and clears it only after a successful save',
  async (providerId) => {
    setup(providerId);
    const provider = getProviderById(providerId)!;
    const label = provider.webhook_setup!.secret!.label.toLowerCase();
    const input = screen.getByLabelText(`${provider.display_name} ${label}`);
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: `Save ${label}` })).toBeDisabled();
    fireEvent.change(input, { target: { value: ' square-example-key ' } });
    fireEvent.click(screen.getByRole('button', { name: `Save ${label}` }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        integrationId: 'integration',
        webhookId: 'endpoint',
        secret: 'square-example-key',
      }),
    );
    await waitFor(() => expect(input).toHaveValue(''));
  },
);
it.each(['square', 'vercel', 'sentry'])(
  'keeps a failed %s replacement editable and reports the error',
  async (providerId) => {
    save.mockRejectedValue(new Error('Unable to save signature key'));
    setup(providerId, `manual:${providerId}:https://frink.example/trigger`);
    const provider = getProviderById(providerId)!;
    const label = provider.webhook_setup!.secret!.label.toLowerCase();
    const input = screen.getByLabelText(`${provider.display_name} ${label}`);
    fireEvent.change(input, { target: { value: 'replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: `Update ${label}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save signature key');
    expect(input).toHaveValue('replacement-key');
  },
);
it('locks the field while the save is in flight, so the cleared value is the one that was sent', async () => {
  let settle: (result: { success: boolean }) => void = () => {};
  save.mockImplementation(
    () =>
      new Promise<{ success: boolean }>((resolve) => {
        settle = resolve;
      }),
  );
  setup('square');
  const input = screen.getByLabelText('Square signature key');
  fireEvent.change(input, { target: { value: 'first-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save signature key' }));
  // A field the user cannot edit while the request is out cannot hold an edit the clear would drop.
  await waitFor(() => expect(input).toBeDisabled());
  settle({ success: true });
  await waitFor(() => expect(input).toHaveValue(''));
});
