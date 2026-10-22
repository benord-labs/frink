// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type Operation, TRPCClientError } from '@trpc/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { observable } from '@trpc/server/observable';
import { toast, Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlowFile } from '../../../../../shared/lib/flows/flow-file';
import { trpc } from '../../../../lib/trpc';
import { FlowRowMenu } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const SAVED_FLOW = {
  id: 'flow-1',
  name: 'Release',
  description: 'Ships it',
  graph: {
    nodes: [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'build', blockType: 'run_command', config: { projectId: 'api-a' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'build' }],
    settings: { currentBatchId: 'batch-1' },
  },
};
const PROJECTS = [{ id: 'api-a', name: 'api' }];

const downloads: { name: string; blob: Blob }[] = [];

beforeEach(() => {
  let blob = new Blob();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    if (value instanceof Blob) blob = value;
    return 'blob:flow';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, blob });
  });
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  downloads.length = 0;
  vi.restoreAllMocks();
});

type MenuOptions = {
  nodeCount?: number | null;
  hasDraft?: boolean;
  enabled?: boolean;
  /** The flow row's latest run, which decides whether the menu offers Stop run. */
  latestRunStatus?: string;
  /** The one call the fake main process fails. */
  failPath?: string;
};

/** The fake main process answers the saved flow and project lookups; `failPath` fails one call. */
function renderMenu({
  nodeCount = 2,
  hasDraft = false,
  enabled = false,
  latestRunStatus,
  failPath,
}: MenuOptions = {}) {
  const calls: Operation[] = [];
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            calls.push(op);
            if (op.path === failPath) {
              return observer.error(TRPCClientError.from(new Error('read failed')));
            }
            observer.next({ result: { data: op.path === 'flows.get' ? SAVED_FLOW : PROJECTS } });
            observer.complete();
          }),
    ],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <FlowRowMenu
          flow={{
            id: 'flow-1',
            name: 'Release',
            node_count: nodeCount,
            latest_run_id: latestRunStatus ? 'run-1' : null,
            latest_run_status: latestRunStatus,
          }}
          enabled={enabled}
          hasDraft={hasDraft}
          onDelete={vi.fn()}
        />
        <Toaster />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { calls };
}

async function openMenu() {
  await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for Release' }));
}

describe('FlowRowMenu export', () => {
  it('downloads the saved flow as a file another computer can import', async () => {
    renderMenu();
    await openMenu();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Export file' }));

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe('Release.json');
    const parsed = parseFlowFile(await downloads[0].blob.text());
    expect(parsed).toMatchObject({
      ok: true,
      file: {
        name: 'Release',
        description: 'Ships it',
        graph: { settings: {} },
        projects: { 'api-a': 'api' },
      },
    });
  });

  it('says unsaved changes stay behind when the flow has a draft', async () => {
    renderMenu({ hasDraft: true });
    await openMenu();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Export file' }));

    expect(
      await screen.findByText(
        'Exported the latest saved version; unsaved changes were not included.',
      ),
    ).toBeInTheDocument();
  });

  it('tells the user when the flow could not be read', async () => {
    renderMenu({ failPath: 'flows.get' });
    await openMenu();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Export file' }));

    expect(await screen.findByText('Could not export flow')).toBeInTheDocument();
    expect(downloads).toEqual([]);
  });

  it('offers no export for a flow that was never saved', async () => {
    renderMenu({ nodeCount: null });
    await openMenu();

    expect(screen.queryByRole('menuitem', { name: 'Export file' })).not.toBeInTheDocument();
  });
});

describe('FlowRowMenu run and on/off actions', () => {
  it('stops the running run', async () => {
    const { calls } = renderMenu({ latestRunStatus: 'running' });
    await openMenu();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Stop run' }));

    expect(await screen.findByText('Run stopped')).toBeInTheDocument();
    expect(calls.find((op) => op.path === 'flows.cancelRun')?.input).toEqual({ runId: 'run-1' });
  });

  it('says so when the run could not be stopped', async () => {
    renderMenu({ latestRunStatus: 'running', failPath: 'flows.cancelRun' });
    await openMenu();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Stop run' }));

    expect(await screen.findByText('read failed')).toBeInTheDocument();
  });

  it('turns an enabled flow off, noting that a live run still finishes', async () => {
    const { calls } = renderMenu({ enabled: true, latestRunStatus: 'running' });
    await openMenu();
    const item = screen.getByRole('menuitem', { name: /Disable flow/ });
    expect(item).toHaveTextContent("The run in progress still finishes. New runs won't start.");
    await userEvent.setup().click(item);

    await waitFor(() =>
      expect(calls.find((op) => op.path === 'flows.update')?.input).toEqual({
        id: 'flow-1',
        is_enabled: false,
      }),
    );
  });

  it('tells the user when the flow could not be turned on', async () => {
    renderMenu({ failPath: 'flows.update' });
    await openMenu();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Enable flow' }));

    expect(await screen.findByText('read failed')).toBeInTheDocument();
  });
});
