// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import { trpc } from '../../../../../lib/trpc';
import { StartTaskConfig } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

/** Every query this form makes answers empty; the mode menu needs no server data. */
function createTestClient() {
  return trpc.createClient({
    links: [
      () => () =>
        observable((observer) => {
          observer.next({ result: { data: null } });
          observer.complete();
        }),
    ],
  });
}

function renderStartTask(config: FlowNode['config'], onConfigPatch = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: FlowNode = { id: 'st', blockType: 'start_task', config };
  render(
    <trpc.Provider client={createTestClient()} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <StartTaskConfig node={node} onPatchLabel={vi.fn()} onConfigPatch={onConfigPatch} />
        </TooltipProvider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return onConfigPatch;
}

afterEach(cleanup);

describe('StartTaskConfig start mode', () => {
  it('offers Execute and Plan only', async () => {
    renderStartTask({ startMode: 'plan' });

    await userEvent.click(screen.getByRole('combobox', { name: 'Start mode' }));

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Execute',
      'Plan',
    ]);
  });

  it('lets a Start Task saved with wait pick Execute to clear it', async () => {
    const onConfigPatch = renderStartTask({ startMode: 'wait' });

    await userEvent.click(screen.getByRole('combobox', { name: 'Start mode' }));
    await userEvent.click(screen.getByRole('option', { name: 'Execute' }));

    expect(onConfigPatch).toHaveBeenCalledWith({ startMode: 'execute' });
  });
});
