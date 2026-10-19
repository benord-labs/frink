// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import * as Sentry from '@sentry/electron/renderer';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

type UpdateErrorOpts = {
  onError: (err: Error, variables: { id: string }, context?: { prev?: object[] }) => void;
};
type CancelRunErrorOpts = { onError: (err: Error, variables: { runId: string }) => void };
type RecordedMutationOpts = { update?: UpdateErrorOpts; cancelRun?: CancelRunErrorOpts };

const snap = vi.hoisted(() => {
  const flow = {
    id: 'flow-1',
    name: 'Queue demo',
    description: null,
    is_enabled: true,
    node_count: 2,
    trigger_type: 'manual_trigger',
    updated_at: '2026-08-01T10:00:00.000Z',
    latest_run_id: 'run-1',
    latest_run_status: 'cancelled',
    latest_run_active_task_status: null,
    latest_run_admission_state: 'queued',
    latest_run_queue_position: 3,
    latest_run_admission_requested_at: '2026-08-01T10:01:00.000Z',
    batch_active_count: 0,
    batch_run_count: 0,
  };
  // Extra rows override any base field; a run field may be cleared to null.
  const extraFlows: { [K in keyof typeof flow]?: (typeof flow)[K] | null }[] = [];
  const mutationOpts: RecordedMutationOpts = {};
  return {
    cancelRun: vi.fn(),
    copyFlow: vi.fn(),
    openFlow: vi.fn(),
    updateFlow: vi.fn(),
    setListData: vi.fn(),
    mutationOpts,
    flow,
    extraFlows,
  };
});

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../../../components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogAction: () => null,
  AlertDialogCancel: () => null,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogFooter: () => null,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogTitle: () => null,
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    flows: {
      list: {
        useQuery: () => ({
          data: [snap.flow, ...snap.extraFlows],
          isLoading: false,
          isError: false,
        }),
      },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      copy: { useMutation: () => ({ mutateAsync: snap.copyFlow, isPending: false }) },
      update: {
        useMutation: (opts: UpdateErrorOpts) => {
          snap.mutationOpts.update = opts;
          return { mutate: snap.updateFlow, isPending: false };
        },
      },
      cancelRun: {
        useMutation: (opts: CancelRunErrorOpts) => {
          snap.mutationOpts.cancelRun = opts;
          return { mutate: snap.cancelRun, isPending: false, variables: undefined };
        },
      },
    },
    useUtils: () => ({
      flows: {
        list: {
          invalidate: vi.fn(),
          cancel: vi.fn(),
          getData: () => [snap.flow],
          setData: snap.setListData,
        },
        listRuns: { invalidate: vi.fn() },
        listBatches: { invalidate: vi.fn() },
        listBatchRuns: { invalidate: vi.fn() },
        listBatchStages: { invalidate: vi.fn() },
        get: { invalidate: vi.fn() },
        getRun: { invalidate: vi.fn() },
      },
    }),
  },
}));

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useSetAtom: () => snap.openFlow,
}));
vi.mock('../../../lib/flow-drafts', () => ({
  deleteFlowDraft: vi.fn(),
  loadFlowDraftIds: () => new Set(),
}));
vi.mock('../../../lib/utils/platform', () => ({ isDesktopApp: () => false }));
vi.mock('../../../lib/utils/format-time', () => ({ formatRelativeTime: () => '1m ago' }));
vi.mock('../FlowEditor/FlowBlockIcon', () => ({ FlowBlockIcon: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { FlowsList } = await import('./index');

afterEach(() => {
  cleanup();
  snap.cancelRun.mockReset();
  snap.openFlow.mockReset();
  snap.updateFlow.mockReset();
  snap.setListData.mockReset();
  snap.extraFlows = [];
});

describe('FlowsList queued admission', () => {
  it('shows queue metadata and keyboard-cancels without opening the Flow', async () => {
    const user = userEvent.setup();
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    expect(screen.getByText('Queued · #3 · 1m ago')).toBeInTheDocument();
    screen.getByRole('button', { name: 'More actions for Queue demo' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('menuitem', { name: 'Cancel queued run' }).focus();
    await user.keyboard('{Enter}');

    expect(snap.cancelRun).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(snap.openFlow).not.toHaveBeenCalled();
  });

  it('keyboard-activates row actions without opening the Flow', async () => {
    const user = userEvent.setup();
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    const menu = screen.getByRole('button', { name: 'More actions for Queue demo' });
    menu.focus();
    await user.keyboard('{Enter}');
    // The queued run keeps going after a disable, and the menu says so before the user commits.
    const disable = screen.getByRole('menuitem', { name: /^Disable flow/ });
    expect(disable).toHaveTextContent("New runs won't start.");
    disable.focus();
    await user.keyboard('{Enter}');

    expect(snap.updateFlow).toHaveBeenCalledWith({ id: 'flow-1', is_enabled: false });
    expect(snap.openFlow).not.toHaveBeenCalled();

    menu.focus();
    await user.keyboard('{Enter}');
    screen.getByRole('menuitem', { name: 'Delete flow' }).focus();
    await user.keyboard('{Enter}');

    expect(
      screen.getByText(/run history will be permanently deleted.*active run will be stopped/i),
    ).toBeInTheDocument();
    expect(snap.openFlow).not.toHaveBeenCalled();
  });
});

describe('FlowsList sections', () => {
  it('groups flows so human waits and failures lead, and disabled flows trail', () => {
    snap.extraFlows = [
      {
        ...snap.flow,
        id: 'flow-2',
        name: 'Broken',
        latest_run_status: 'failed',
        latest_run_admission_state: null,
      },
      {
        ...snap.flow,
        id: 'flow-3',
        name: 'Off',
        is_enabled: false,
        latest_run_status: null,
        latest_run_admission_state: null,
      },
    ];
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.firstChild?.textContent);
    expect(headings).toEqual(['Needs you', 'Enabled', 'Disabled']);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('focuses search on "/" and clears it on Escape', async () => {
    const user = userEvent.setup();
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    await user.keyboard('/');
    const search = screen.getByRole('searchbox', { name: 'Search flows' });
    expect(search).toHaveFocus();
    await user.type(search, 'queue');
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
  });
  it('moves between rows with ArrowUp and ArrowDown across sections', async () => {
    const user = userEvent.setup();
    snap.extraFlows = [
      {
        ...snap.flow,
        id: 'flow-2',
        name: 'Broken',
        latest_run_status: 'failed',
        latest_run_admission_state: null,
      },
    ];
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    screen.getByRole('button', { name: 'Broken' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Queue demo' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Broken' })).toHaveFocus();
  });

  it('sorts by name from the toolbar control', async () => {
    const user = userEvent.setup();
    snap.extraFlows = [
      { ...snap.flow, id: 'flow-2', name: 'Alpha', latest_run_admission_state: null },
    ];
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByRole('button', { name: 'Name' })).toHaveAttribute('aria-pressed', 'true');
    const names = Array.from(document.querySelectorAll('[data-flow-open]'), (b) => b.textContent);
    expect(names).toEqual(['Alpha', 'Queue demo']);
  });
});

describe('FlowsList duplicate', () => {
  it('duplicates a saved flow from the row menu', async () => {
    const user = userEvent.setup();
    snap.copyFlow.mockResolvedValue({ id: 'flow-copy' });
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'More actions for Queue demo' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(snap.copyFlow).toHaveBeenCalledWith({ id: 'flow-1' });
    expect(toast.success).toHaveBeenCalledWith('Copied “Queue demo”');
    expect(snap.openFlow).not.toHaveBeenCalled();
  });

  it('explains why a never-saved flow cannot be duplicated', async () => {
    const user = userEvent.setup();
    snap.extraFlows = [{ ...snap.flow, id: 'flow-2', name: 'Draft', node_count: null }];
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'More actions for Draft' }));
    const item = screen.getByRole('menuitem', { name: 'Save the flow to duplicate it' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps one copy in flight even when the menu is closed and reopened', async () => {
    const user = userEvent.setup();
    let finish: (value: { id: string }) => void = () => undefined;
    snap.copyFlow.mockReset();
    snap.copyFlow.mockReturnValue(
      new Promise<{ id: string }>((resolve) => {
        finish = resolve;
      }),
    );
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);
    const menu = screen.getByRole('button', { name: 'More actions for Queue demo' });

    await user.click(menu);
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await user.click(menu);
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(snap.copyFlow).toHaveBeenCalledTimes(1);
    finish({ id: 'flow-copy' });
  });
});

describe('FlowsList row menu error reporting', () => {
  const events: Sentry.ErrorEvent[] = [];

  function installSentryClient(): Sentry.BrowserClient {
    const client = new Sentry.BrowserClient({
      dsn: 'https://public@sentry.invalid/1',
      integrations: [],
      stackParser: Sentry.defaultStackParser,
      transport: (options) => Sentry.createTransport(options, async () => ({})),
      beforeSend: (event) => {
        events.push(event);
        return null;
      },
    });
    Sentry.setCurrentClient(client);
    client.init();
    return client;
  }

  afterEach(() => {
    Sentry.getCurrentScope().setClient(undefined);
    events.length = 0;
  });

  it('reports a failed enable/disable and still rolls back and toasts', async () => {
    const client = installSentryClient();
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);
    const prev = [snap.flow];

    act(() =>
      snap.mutationOpts.update?.onError(new Error('db locked'), { id: 'flow-1' }, { prev }),
    );
    await client.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toEqual({ source: 'FlowRowMenu', action: 'toggle-enabled' });
    expect(snap.setListData).toHaveBeenCalledWith(undefined, prev);
    expect(toast.error).toHaveBeenCalledWith('db locked');
  });

  it('reports a failed stop-run, including tRPC errors other than CONFLICT', async () => {
    const client = installSentryClient();
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);
    const notFound = TRPCClientError.from({
      error: { message: 'Flow run not found', code: -32004, data: { code: 'NOT_FOUND' } },
    });

    act(() => snap.mutationOpts.cancelRun?.onError(notFound, { runId: 'run-1' }));
    await client.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toEqual({ source: 'FlowRowMenu', action: 'stop-run' });
    expect(toast.error).toHaveBeenCalledWith('Flow run not found');
  });

  it('does not report a stop on a run that already finished', async () => {
    const client = installSentryClient();
    render(<FlowsList onCreateClick={vi.fn()} onOpenChat={vi.fn()} />);
    const conflict = TRPCClientError.from({
      error: { message: 'Run already finished', code: -32009, data: { code: 'CONFLICT' } },
    });

    act(() => snap.mutationOpts.cancelRun?.onError(conflict, { runId: 'run-1' }));
    await client.flush();

    expect(events).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledWith('Run already finished');
  });
});
