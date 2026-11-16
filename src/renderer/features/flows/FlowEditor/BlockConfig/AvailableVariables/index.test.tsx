// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '../../../../../lib/trpc';
import { AvailableVariables } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

/** Answers the custom-node list (the only query the panel makes) with no custom nodes. */
const client = trpc.createClient({
  links: [
    () => () =>
      observable((observer) => {
        observer.next({ result: { data: [] } });
        observer.complete();
      }),
  ],
});

function renderPanel(triggerBlockType: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AvailableVariables triggerBlockType={triggerBlockType} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

afterEach(cleanup);

// Catches every trigger field reading as always present, so a post-task step that uses
// {{trigger.branch}} is not warned that a task without a worktree leaves it out.
describe('AvailableVariables trigger fields', () => {
  it('marks only the post-task fields some runs leave out as not always present', async () => {
    renderPanel('post_task_trigger');
    await userEvent.click(screen.getByRole('button', { name: 'Available variables' }));

    await userEvent.hover(screen.getByRole('button', { name: /Copy \{\{trigger\.branch\}\}/ }));
    expect(
      (await screen.findAllByText('Git branch the task ran on (not always present)')).length,
    ).toBeGreaterThan(0);

    await userEvent.hover(screen.getByRole('button', { name: /Copy \{\{trigger\.taskId\}\}/ }));
    expect((await screen.findAllByText('UUID of the completed task')).length).toBeGreaterThan(0);
  });
});
