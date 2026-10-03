// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import {
  backgroundRosterAtomFamily,
  wakeHeldAtomFamily,
} from '../../../lib/stores/active-transport-registry';
import type { WakeHoldItem } from '../../../../shared/types/wake-hold';
import type { BackgroundRosterTask } from '../../../../shared/types/wake-hold/subagent-task';
import { RunStatusRows } from './index';

const sendStopMutate = vi.fn();
let sendStopPending = false;
let capturedOnSuccess: ((result: { success: boolean; reason?: string }) => void) | undefined;
let capturedOnError: ((error: { message: string }) => void) | undefined;

type StopTaskResult =
  | { ok: true }
  | { ok: false; reason: 'ended' | 'last' | 'timeout' }
  | { ok: false; reason: 'failed'; message: string };
const workflowProgressQuery = vi.fn((_input: unknown) => ({ data: null }));
const commandOutputQuery = vi.fn(
  (_input: unknown): { data: { runningForMs: number | null; text: string | null } | null } => ({
    data: { runningForMs: 192_000, text: 'PASS a.test\nPASS b.test' },
  }),
);
const stopTaskMutate = vi.fn();
let stopTaskPending = false;
let stopTaskOnSuccess: ((result: StopTaskResult) => void) | undefined;

const { toastError, toastInfo } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, info: toastInfo } }));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    socket: {
      sendStop: {
        useMutation: (opts?: {
          onSuccess?: (result: { success: boolean; reason?: string }) => void;
          onError?: (error: { message: string }) => void;
        }) => {
          capturedOnSuccess = opts?.onSuccess;
          capturedOnError = opts?.onError;
          return { mutate: sendStopMutate, isPending: sendStopPending };
        },
      },
      getWorkflowProgress: { useQuery: (input: unknown) => workflowProgressQuery(input) },
      getCommandOutput: {
        useQuery: (input: unknown, _opts?: unknown) => commandOutputQuery(input),
      },
      stopBackgroundTask: {
        useMutation: (opts?: { onSuccess?: (result: StopTaskResult) => void }) => {
          stopTaskOnSuccess = opts?.onSuccess;
          return { mutate: stopTaskMutate, isPending: stopTaskPending };
        },
      },
    },
  },
}));

// The three end-of-run rows each own a tRPC/query surface of their own; this suite is about WHICH
// row renders, so they stand in as markers.
vi.mock('../main/active-chat/components', () => ({
  TaskAcceptBar: () => <div data-testid="accept-bar" />,
  TaskControls: () => <div data-testid="task-controls" />,
}));
vi.mock('../InterruptedRunControls', () => ({
  InterruptedRunControls: () => <div data-testid="interrupted-controls" />,
}));

let store: ReturnType<typeof createStore>;
const Wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>
    <TooltipProvider>{children}</TooltipProvider>
  </Provider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: Wrapper });

type RowOpts = { chatId?: string | null; flowSurfaceOwnsStop?: boolean; isTurnActive?: boolean };
const rows = (opts?: RowOpts) => (
  <RunStatusRows
    subChatId="sc1"
    pinnedTaskId={null}
    chatId={opts?.chatId === undefined ? 'c1' : opts.chatId}
    guardedSend={() => true}
    isTurnActive={opts?.isTurnActive ?? false}
    flowSurfaceOwnsStop={opts?.flowSurfaceOwnsStop ?? false}
  />
);
const renderRows = (opts?: RowOpts) => render(rows(opts));

const item = (label: string, id = label, extra: Partial<WakeHoldItem> = {}): WakeHoldItem => ({
  id,
  label,
  description: `${label} work`,
  stoppable: label !== 'Scheduled wake',
  ...extra,
});
const holdItems = (...waitingOn: WakeHoldItem[]) =>
  store.set(wakeHeldAtomFamily('sc1'), { waitingOn });
const hold = (...labels: string[]) => holdItems(...labels.map((label, i) => item(label, `t${i}`)));
const task = (id: string, type: string, description: string, ambient = false) =>
  ({ id, type, description, ambient }) satisfies BackgroundRosterTask;
const setRoster = (...tasks: BackgroundRosterTask[]) =>
  store.set(backgroundRosterAtomFamily('sc1'), tasks);
const openList = () =>
  fireEvent.click(screen.getByRole('button', { name: /Working in the background/ }));

describe('RunStatusRows', () => {
  beforeEach(() => {
    store = createStore();
    sendStopPending = false;
    capturedOnSuccess = undefined;
    capturedOnError = undefined;
    sendStopMutate.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
    stopTaskMutate.mockReset();
    stopTaskPending = false;
    stopTaskOnSuccess = undefined;
    workflowProgressQuery.mockClear();
    commandOutputQuery.mockClear();
  });
  afterEach(cleanup);

  it('renders the three end-of-run rows when no wake hold is held', () => {
    renderRows();

    expect(screen.getByTestId('accept-bar')).toBeInTheDocument();
    expect(screen.getByTestId('task-controls')).toBeInTheDocument();
    expect(screen.getByTestId('interrupted-controls')).toBeInTheDocument();
    expect(screen.queryByText(/Working in the background/)).not.toBeInTheDocument();
  });

  it('replaces every end-of-run row with the wait while held', () => {
    hold('Monitor');
    renderRows();

    expect(screen.getByText(/Working in the background/)).toBeInTheDocument();
    // Accepting or retrying a run that is about to write more would act on a half-finished state.
    expect(screen.queryByTestId('accept-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('interrupted-controls')).not.toBeInTheDocument();
  });

  // A Monitor relaying events wakes the session every few seconds; hiding the row per burst made it
  // blink, and a row that vanishes while the agent speaks reads as "the work ended".
  it('stays on screen through a wake burst, handing its Stops to the composer', () => {
    hold('Command', 'Command');
    const { rerender } = renderRows({ isTurnActive: true });

    expect(screen.getByText('Working in the background — 2 Commands')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop all background work' })).toBeNull();
    openList();
    expect(within(screen.getByRole('list')).queryByRole('button', { name: /^Stop / })).toBeNull();
    // Still held, so the end-of-run rows stay away too.
    expect(screen.queryByTestId('accept-bar')).not.toBeInTheDocument();

    rerender(rows());
    expect(screen.getByRole('button', { name: 'Stop all background work' })).toBeInTheDocument();
  });

  it('drops a finished item the moment the live roster does, ahead of the next snapshot', () => {
    holdItems(item('Command', 't0', { description: 'Ship the PR' }), item('Monitor', 'm1'));
    setRoster(task('m1', 'local_bash', 'Monitor work'));
    renderRows();

    expect(screen.getByText('Working in the background — Monitor work')).toBeInTheDocument();
  });

  it('lists work started since the last snapshot, with no row Stop main could not honour', () => {
    hold('Command', 'Command');
    setRoster(
      task('t0', 'local_bash', 'a'),
      task('t1', 'local_bash', 'b'),
      task('n1', 'local_bash', 'Re-ship'),
    );
    renderRows();
    openList();

    const list = within(screen.getByRole('list'));
    expect(list.getByText('Re-ship')).toBeInTheDocument();
    expect(list.getAllByRole('button', { name: /^Stop / })).toHaveLength(2);
  });

  it('never lists an ambient task on its own', () => {
    setRoster(task('w1', 'local_bash', 'live-update watcher', true));
    renderRows({ isTurnActive: true });

    expect(screen.queryByText(/Working in the background/)).not.toBeInTheDocument();
  });

  // A follow-up adopts the hold (main retracts it), yet the Workflow it was waiting on is still live.
  it('keeps live work on screen through a turn that is not held', () => {
    setRoster(task('w1', 'local_workflow', 'Code reduction'));
    const { rerender } = renderRows({ isTurnActive: true });

    expect(screen.getByText('Working in the background — Code reduction')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
    // Not held, so the end-of-run rows stay mounted: the Resume row's lock tracks this turn.
    expect(screen.getByTestId('interrupted-controls')).toBeInTheDocument();

    // Idle and not held is a finished turn: its end-of-run rows, not a row nobody can stop.
    rerender(rows());
    expect(screen.queryByText(/Working in the background/)).not.toBeInTheDocument();
    expect(screen.getByTestId('accept-bar')).toBeInTheDocument();
  });

  // The settling wake has not run yet: the Stop must stay, but the finished task must not be listed.
  it('keeps a held, idle row and its Stop after the roster emptied, without listing finished work', () => {
    hold('Command');
    setRoster();
    renderRows();

    expect(screen.getByText('Working in the background — Finishing up')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Stop waiting on background work' }),
    ).toBeInTheDocument();
  });

  it('names a single item by what it is doing, so a new command never reads as the old one', () => {
    holdItems(item('Command', 't0', { description: 'Ship the QA rig PR' }));
    renderRows();

    expect(screen.getByText('Working in the background — Ship the QA rig PR')).toBeInTheDocument();
  });

  it('names what the wait is blocked on, aggregated by kind', () => {
    hold('Monitor', 'Monitor', 'Command');
    renderRows();

    // Not "Monitor, Monitor, Command" — a wait on five shell commands must not print one word five
    // times, and the count is what tells the user whether anything has finished since.
    expect(
      screen.getByText('Working in the background — 2 Monitors, 1 Command'),
    ).toBeInTheDocument();
  });

  // With several items each row has its own Stop, so the banner's one ends them all.
  it('names the banner Stop for what it ends', () => {
    hold('Monitor');
    const { unmount } = renderRows();
    expect(
      screen.getByRole('button', { name: 'Stop waiting on background work' }),
    ).toHaveTextContent(/^Stop$/);
    unmount();

    // The accessible name says the same as the label: this ends every item, not one.
    hold('Command', 'Command');
    renderRows();
    expect(screen.getByRole('button', { name: 'Stop all background work' })).toHaveTextContent(
      'Stop all',
    );
  });

  it('offers Stop as the wait’s only exit, addressed to the chat', () => {
    hold('Monitor');
    renderRows();

    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting on background work' }));

    expect(sendStopMutate).toHaveBeenCalledWith({ chatId: 'c1', subChatId: 'sc1' });
  });

  // A raw stop in a flow chat aborts without cancelRun and strands the run, so the flow surface
  // keeps sole ownership of the terminal verb (decision flow-run-chat-surface).
  it('withholds Stop while a flow surface owns the terminal verb', () => {
    hold('Monitor');
    renderRows({ flowSurfaceOwnsStop: true });

    expect(screen.getByText(/Working in the background/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop waiting on background work' })).toBeNull();
  });

  it('withholds Stop when there is no chat id to address it to', () => {
    hold('Monitor');
    renderRows({ chatId: null });

    expect(screen.queryByRole('button', { name: 'Stop waiting on background work' })).toBeNull();
  });

  it('reports a refused stop, which sendStop returns in its payload rather than throwing', () => {
    hold('Monitor');
    renderRows();

    capturedOnSuccess?.({ success: false, reason: 'Socket not connected' });

    expect(toastError).toHaveBeenCalledWith('Could not stop the background work', {
      description: 'Socket not connected',
    });
  });

  it('reports a failed stop', () => {
    hold('Monitor');
    renderRows();

    capturedOnError?.({ message: 'boom' });

    expect(toastError).toHaveBeenCalledWith('Could not stop the background work', {
      description: 'boom',
    });
  });

  it('disables Stop while the stop is in flight so a second click cannot re-fire it', () => {
    sendStopPending = true;
    hold('Monitor');
    renderRows();

    expect(screen.getByRole('button', { name: 'Stop waiting on background work' })).toBeDisabled();
    expect(screen.getByText('Stopping…')).toBeInTheDocument();
  });
  it('opens the list of every item from the label', () => {
    holdItems(
      item('Command', 's1', { description: 'Run the tests', command: 'bun test' }),
      item('Workflow', 'w1', { description: 'review-pr' }),
      item('Scheduled wake', 'c1', { description: 'Check CI' }),
    );
    renderRows();

    openList();

    expect(screen.getByText('Background work')).toBeInTheDocument();
    expect(screen.getByText('Run the tests')).toBeInTheDocument();
    expect(screen.getByText('bun test')).toBeInTheDocument();
    expect(screen.getByText('review-pr')).toBeInTheDocument();
    expect(screen.getByText('Check CI')).toBeInTheDocument();
  });

  it('stops one item, addressed by its task id', () => {
    holdItems(
      item('Command', 's1', { description: 'Run the tests' }),
      item('Command', 's2', { description: 'Build the app' }),
    );
    renderRows();
    openList();

    fireEvent.click(screen.getByRole('button', { name: 'Stop Command: Run the tests' }));

    expect(stopTaskMutate).toHaveBeenCalledWith({ subChatId: 'sc1', taskId: 's1' });
  });

  it('offers no row Stop for a scheduled wake or an unverified kind', () => {
    holdItems(
      item('Command', 's1'),
      item('Scheduled wake', 'c1'),
      item('Monitor', 'm1', { stoppable: false }),
    );
    renderRows();
    openList();

    expect(
      within(screen.getByRole('list')).getAllByRole('button', { name: /^Stop / }),
    ).toHaveLength(1);
    expect(screen.getByText('Stop all ends everything still running.')).toBeInTheDocument();
  });

  // Main never ends a wait from a per-item stop, so the last item points at the stop that does.
  it('leaves the last item to the session Stop, or to the flow’s in a Flow chat', () => {
    hold('Command');
    renderRows({ flowSurfaceOwnsStop: true });
    openList();

    expect(within(screen.getByRole('list')).queryByRole('button', { name: /^Stop / })).toBeNull();
    expect(screen.getByText('The flow’s Stop ends everything still running.')).toBeInTheDocument();
  });

  it('shows a row stop in flight', () => {
    stopTaskPending = true;
    holdItems(item('Command', 's1'), item('Agent', 'a1'));
    renderRows();
    openList();

    for (const button of within(screen.getByRole('list')).getAllByRole('button', {
      name: /^Stop /,
    })) {
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).toBeDisabled();
    }
  });

  it('reports a refused or slow row stop, and stays quiet when the wait already moved on', () => {
    holdItems(item('Command', 's1'), item('Agent', 'a1'));
    renderRows();
    openList();

    stopTaskOnSuccess?.({ ok: false, reason: 'ended' });
    stopTaskOnSuccess?.({ ok: false, reason: 'last' });
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();

    stopTaskOnSuccess?.({ ok: false, reason: 'failed', message: 'not running' });
    expect(toastError).toHaveBeenCalledWith('Couldn’t stop it', { description: 'not running' });
    stopTaskOnSuccess?.({ ok: false, reason: 'timeout' });
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });
  it('pulls a workflow’s live progress only while the list is open', () => {
    holdItems(item('Workflow', 'w1'), item('Command', 's1'));
    renderRows();
    expect(workflowProgressQuery).not.toHaveBeenCalled();

    openList();

    expect(workflowProgressQuery).toHaveBeenCalledWith({ subChatId: 'sc1', taskId: 'w1' });
  });

  it('shows a Command’s runtime and latest output once its row is opened, one row at a time', () => {
    holdItems(
      item('Command', 's1', { description: 'Run the tests' }),
      item('Command', 's2', { description: 'Build the app' }),
    );
    renderRows();
    openList();
    expect(commandOutputQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Run the tests/ }));

    expect(commandOutputQuery).toHaveBeenCalledWith({ subChatId: 'sc1', commandId: 's1' });
    expect(screen.getByText('Running for 3m 12s')).toBeInTheDocument();
    expect(screen.getByText(/PASS b\.test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Build the app/ }));

    expect(screen.getByRole('button', { name: /^Run the tests/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(commandOutputQuery).toHaveBeenLastCalledWith({ subChatId: 'sc1', commandId: 's2' });
  });

  it('says so when a Command’s output cannot be read', () => {
    commandOutputQuery.mockReturnValue({ data: { runningForMs: null, text: null } });
    holdItems(item('Command', 's1', { description: 'Run the tests' }), item('Workflow', 'w1'));
    renderRows();
    openList();

    fireEvent.click(screen.getByRole('button', { name: /^Run the tests/ }));

    expect(screen.getByText('Its output isn’t available.')).toBeInTheDocument();
    // Only a shell has output to open.
    expect(screen.queryByRole('button', { name: /^Workflow work/ })).not.toBeInTheDocument();
  });
});
