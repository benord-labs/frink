// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { getQueryKey } from '@trpc/react-query';
import type { PropsWithChildren } from 'react';
import { trpc } from '@/lib/trpc';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TriggerEndpoint } from '@/lib/plugins/triggers/delivery-state';
import { NotionSetup } from './index';

// The production tRPC module constructs its IPC client during import.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});
type NotionMutationInput = {
  integrationId: string;
  webhookId: string;
  generation: string;
  candidate: string;
};
const confirm = vi.fn<(input: NotionMutationInput) => Promise<null>>();
const restart = vi.fn<(input: NotionMutationInput) => Promise<null>>();
const clients: QueryClient[] = [];

function renderSetup(endpoint: TriggerEndpoint) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  clients.push(queryClient);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const run =
              op.path === 'triggerSetup.confirmNotion'
                ? confirm
                : op.path === 'triggerSetup.restartNotion'
                  ? restart
                  : undefined;
            if (!run) throw new Error(`Unexpected operation: ${op.path}`);
            // SAFETY: the fake link forwards the input the component sent to this path.
            void run(op.input as NotionMutationInput).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error: Error) => observer.error(TRPCClientError.from(error)),
            );
          }),
    ],
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
  return {
    ...render(<NotionSetup integrationId="integration" endpoint={endpoint} />, { wrapper }),
    invalidate,
  };
}
const ENDPOINT: TriggerEndpoint = {
  id: 'endpoint',
  webhookUrl: 'https://frink.test/api/triggers/notion/path',
  webhookPathToken: 'path',
  webhookSecret: 'secret_verification_code',
  vendorRef: 'notion:pending:candidate',
  isActive: true,
  lastError: null,
  lastReceivedAt: null,
};
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
beforeEach(() => {
  confirm.mockReset().mockResolvedValue(null);
  restart.mockReset().mockResolvedValue(null);
});

it('masks the verification code and confirms the exact displayed candidate and URL generation', async () => {
  renderSetup(ENDPOINT);
  expect(screen.getByRole('textbox', { name: 'Verification code, hidden' })).not.toHaveValue(
    ENDPOINT.webhookSecret,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
  expect(screen.getByRole('textbox', { name: 'Verification code' })).toHaveValue(
    ENDPOINT.webhookSecret,
  );
  fireEvent.click(screen.getByRole('button', { name: 'I’ve verified in Notion' }));
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      generation: 'path',
      candidate: 'notion:pending:candidate',
    }),
  );
});
it('explains the required Notion setup before a challenge arrives and supports refreshing it', async () => {
  const { invalidate } = renderSetup({ ...ENDPOINT, vendorRef: null });
  expect(screen.getByRole('status')).toHaveTextContent('No verification code received yet');
  expect(screen.getByRole('list')).toHaveTextContent('Create a subscription');
  expect(screen.getByRole('status')).toHaveTextContent('Resend token');
  expect(screen.queryByRole('button', { name: 'I’ve verified in Notion' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check for verification code' }));
  await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
  expect(invalidate.mock.calls[0]?.[0]?.queryKey).toEqual(
    getQueryKey(trpc.integrations.listWebhookEndpoints, { integrationId: 'integration' }),
  );
});
it('restarts using the refreshed generation and candidate instead of stale values', async () => {
  const { rerender } = renderSetup(ENDPOINT);
  rerender(
    <NotionSetup
      integrationId="integration"
      endpoint={{
        ...ENDPOINT,
        webhookPathToken: 'new-path',
        vendorRef: 'notion:pending:new-candidate',
      }}
    />,
  );
  fireEvent.click(screen.getByText('Restart setup'));
  fireEvent.click(screen.getByRole('button', { name: 'Create a new address' }));
  await waitFor(() =>
    expect(restart).toHaveBeenCalledWith({
      integrationId: 'integration',
      webhookId: 'endpoint',
      generation: 'new-path',
      candidate: 'notion:pending:new-candidate',
    }),
  );
});
it('announces confirmation errors without hiding the code', async () => {
  confirm.mockRejectedValue(new Error('Verification changed. Refresh and try again.'));
  renderSetup(ENDPOINT);
  fireEvent.click(screen.getByRole('button', { name: 'I’ve verified in Notion' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Verification changed');
  expect(screen.getByRole('textbox', { name: 'Verification code, hidden' })).toBeInTheDocument();
});
it('does not call a verified subscription a real received event', () => {
  renderSetup({ ...ENDPOINT, vendorRef: 'notion:verified:candidate' });
  expect(screen.queryByText(/last event/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('textbox', { name: 'Verification code, hidden' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'I’ve verified in Notion' })).not.toBeInTheDocument();
});

it('keeps the verified signing secret masked and available in Advanced', () => {
  renderSetup({ ...ENDPOINT, vendorRef: 'notion:verified:candidate' });
  expect(screen.getByRole('textbox', { name: 'Signing secret, hidden' })).not.toHaveValue(
    ENDPOINT.webhookSecret,
  );
  expect(screen.getByText(/Notion provided this secret during verification/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
  expect(screen.getByRole('textbox', { name: 'Signing secret' })).toHaveValue(
    ENDPOINT.webhookSecret,
  );
});
