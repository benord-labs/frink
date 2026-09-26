// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import superjson from 'superjson';
import { ipcLink } from 'trpc-electron/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc';
import { CreateBranchDialog } from './create-branch-dialog';

// A tRPC transport that never answers, set before lib/trpc builds its client on import: opening
// the picker sends no request.
vi.hoisted(() => {
  vi.stubGlobal('electronTRPC', { sendMessage: () => {}, onMessage: () => () => {} });
});

afterEach(cleanup);

describe('CreateBranchDialog', () => {
  it('portals the base-branch picker out of the frosted dialog, so its blur reaches the page', () => {
    const queryClient = new QueryClient();
    const client = trpc.createClient({ links: [ipcLink({ transformer: superjson })] });
    render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <CreateBranchDialog
            open
            onOpenChange={() => {}}
            projectPath="/repo"
            branches={[{ name: 'main', isDefault: true, committedAt: null }]}
            defaultBranch="main"
            onBranchCreated={() => {}}
          />
        </QueryClientProvider>
      </trpc.Provider>,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'main' }));

    expect(dialog).not.toContainElement(screen.getByPlaceholderText('Search branches...'));
  });
});
