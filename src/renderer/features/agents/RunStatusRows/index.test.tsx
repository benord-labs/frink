// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { wakeHeldAtomFamily } from '../../../lib/stores/active-transport-registry';
import { RunStatusRows } from './index';

const sendStopMutate = vi.fn();
let sendStopPending = false;
let capturedOnSuccess: ((result: { success: boolean; reason?: string }) => void) | undefined;
let capturedOnError: ((error: { message: string }) => void) | undefined;

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

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

const hold = (...waitingOn: string[]) => store.set(wakeHeldAtomFamily('sc1'), { waitingOn });

describe('RunStatusRows', () => {
  beforeEach(() => {
    store = createStore();
    sendStopPending = false;
    capturedOnSuccess = undefined;
    capturedOnError = undefined;
    sendStopMutate.mockReset();
    toastError.mockReset();
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
});
