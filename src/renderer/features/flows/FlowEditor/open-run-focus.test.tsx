// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { Provider as JotaiProvider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { flowsFocusRunAtom } from '../../../lib/atoms';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import { FlowEditor } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const flow = {
  id: 'flow-1',
  project_id: null,
  name: 'Nightly release',
  description: null,
  is_active: true,
  is_enabled: true,
  agent_invocable: false,
  created_at: '2026-10-14T07:00:00.000Z',
  updated_at: '2026-10-14T07:00:00.000Z',
  node_count: null,
  trigger_type: null,
  latest_version_id: null,
  version_number: null,
  graph: null,
  version_created_at: null,
};

/** Version 1 is past the earlier tests' draft baseline, so the editor shows this saved graph. */
const flowWithSteps = {
  ...flow,
  version_number: 1,
  graph: {
    nodes: [
      { id: 't', blockType: 'manual_trigger', config: {} },
      { id: 's', blockType: 'start_task', config: { projectId: 'gone' } },
    ],
    edges: [{ source: 't', target: 's' }],
  },
};

/** A saved Flow with no runs; every other read answers empty. */
function createTestClient(saved: typeof flow | typeof flowWithSteps = flow) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            observer.next({ result: { data: op.path === 'flows.get' ? saved : [] } });
            observer.complete();
          }),
    ],
  });
}

function renderEditor(saved?: typeof flowWithSteps) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <JotaiProvider store={appStore}>
      <trpc.Provider client={createTestClient(saved)} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <FlowEditor flowId="flow-1" onBack={() => undefined} />
          </TooltipProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </JotaiProvider>,
  );
}

afterEach(() => {
  cleanup();
  appStore.set(flowsFocusRunAtom, null);
});

describe('FlowEditor opened on a run', () => {
  it('opens on the Runs tab when a run of this Flow was requested', async () => {
    appStore.set(flowsFocusRunAtom, { flowId: 'flow-1', runId: 'run-1' });
    renderEditor();

    expect(await screen.findByRole('button', { name: 'Runs', pressed: true })).toBeInTheDocument();
  });

  it("opens on the Editor tab for another Flow's request", async () => {
    appStore.set(flowsFocusRunAtom, { flowId: 'flow-2', runId: 'run-9' });
    renderEditor();

    expect(
      await screen.findByRole('button', { name: 'Editor', pressed: true }),
    ).toBeInTheDocument();
  });
});

describe('FlowEditor on another computer', () => {
  it("flags a step whose project isn't on this computer", async () => {
    renderEditor(flowWithSteps);

    expect(await screen.findByText("Project “gone” isn't on this computer")).toBeInTheDocument();
  });
});
