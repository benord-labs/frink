// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { wakeHeldAtomFamily } from '../../../lib/stores/active-transport-registry';
import type { WakeHoldItem } from '../../../../shared/types/wake-hold';
import { RunStatusRows } from './index';

const sendStopMutate = vi.fn();
let sendStopPending = false;
let capturedOnSuccess: ((result: { success: boolean; reason?: string }) => void) | undefined;
let capturedOnError: ((error: { message: string }) => void) | undefined;

type StopTaskResult =
  | { ok: true }
  | { ok: false; reason: 'ended' | 'last' | 'timeout' }
  | { ok: false; reason: 'failed'; message: string };
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

const renderRows = (opts?: { chatId?: string | null; flowSurfaceOwnsStop?: boolean }) =>
  render(
    <RunStatusRows
      subChatId="sc1"
      pinnedTaskId={null}
      chatId={opts?.chatId === undefined ? 'c1' : opts.chatId}
      guardedSend={() => true}
      isTurnActive={false}
      flowSurfaceOwnsStop={opts?.flowSurfaceOwnsStop ?? false}
    />,
  );

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

    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('Stop all ends everything still running.')).toBeInTheDocument();
  });

  // Main never ends a wait from a per-item stop, so the last item points at the stop that does.
  it('leaves the last item to the session Stop, or to the flow’s in a Flow chat', () => {
    hold('Command');
    renderRows({ flowSurfaceOwnsStop: true });
    openList();

    expect(within(screen.getByRole('list')).queryByRole('button')).toBeNull();
    expect(screen.getByText('The flow’s Stop ends everything still running.')).toBeInTheDocument();
  });

  it('shows a row stop in flight', () => {
    stopTaskPending = true;
    holdItems(item('Command', 's1'), item('Agent', 'a1'));
    renderRows();
    openList();

    for (const button of within(screen.getByRole('list')).getAllByRole('button')) {
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
});
