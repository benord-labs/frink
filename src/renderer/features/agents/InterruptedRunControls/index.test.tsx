// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_WAKE_MARKER } from '../../../../shared/lib/message-markers/hidden-wake-marker';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { appStore } from '../../../lib/jotai-store';
import { taskExecutionErrorAtomFamily } from '../atoms';
import { InterruptedRunControls } from './index';

// Radix Tooltip requires a provider above every Tooltip.
const Wrapper = ({ children }: { children: ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: Wrapper });

const rerunMutate = vi.fn();
const invalidateInterrupted = vi.fn();
const invalidateIncomplete = vi.fn();
const guardedSend = vi.fn((_text: string) => true);
let runData: {
  runId: string;
  resumable: boolean;
  resumeMode: 'session' | 'redispatch' | 'queued';
} | null = null;
let rerunPending = false;
// Captured so tests can fire the mutation callbacks (cache-invalidation clear / error toast).
let capturedOnSuccess: (() => void) | undefined;
let capturedOnError: ((error: { message?: string }) => void) | undefined;

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      flows: {
        interruptedRunForChat: { invalidate: invalidateInterrupted },
        hasIncompleteRunForChat: { invalidate: invalidateIncomplete },
      },
    }),
    flows: {
      interruptedRunForChat: { useQuery: () => ({ data: runData }) },
      rerunRun: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: (error: { message?: string }) => void;
        }) => {
          capturedOnSuccess = opts?.onSuccess;
          capturedOnError = opts?.onError;
          return { mutate: rerunMutate, isPending: rerunPending };
        },
      },
    },
  },
}));

const renderRow = (chatId = 'c1', isTurnActive = false) =>
  render(
    <InterruptedRunControls
      chatId={chatId}
      subChatId="sc1"
      guardedSend={guardedSend}
      isTurnActive={isTurnActive}
    />,
  );

describe('InterruptedRunControls', () => {
  beforeEach(() => {
    runData = null;
    rerunPending = false;
    capturedOnSuccess = undefined;
    capturedOnError = undefined;
    rerunMutate.mockReset();
    invalidateInterrupted.mockReset();
    invalidateIncomplete.mockReset();
    guardedSend.mockReset();
    guardedSend.mockReturnValue(true);
    toastError.mockReset();
  });

  afterEach(cleanup);

  it('renders nothing when the chat has no cancelled run', () => {
    runData = null;
    const { container } = renderRow();
    expect(container).toBeEmptyDOMElement();
  });

  // A run the user stopped on purpose (no restart marker) is not resumable — never surface a CTA
  // that would only reject. The marker gate lives server-side; the row trusts `resumable`.
  it('renders nothing for a user-cancelled (non-resumable) run', () => {
    runData = { runId: 'r1', resumable: false, resumeMode: 'redispatch' };
    const { container } = renderRow();
    expect(container).toBeEmptyDOMElement();
  });

  // The bug this row was rebuilt for: re-dispatching re-sent the node's full instructions as a
  // visible bubble the transcript already held. A session-resumable run must wake via a HIDDEN
  // message and must not touch rerunRun at all.
  it('wakes a session-resumable run with a hidden message, never a re-dispatch', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'session' };
    renderRow();

    const button = screen.getByRole('button', { name: 'Resume interrupted flow run' });
    expect(button).toHaveTextContent('Resume');
    fireEvent.click(button);

    expect(guardedSend).toHaveBeenCalledTimes(1);
    expect(guardedSend.mock.calls[0]?.[0]).toMatch(new RegExp(`^${HIDDEN_WAKE_MARKER}`));
    expect(rerunMutate).not.toHaveBeenCalled();
  });

  // The lock's ref closes the same-tick window React state alone leaves open; a second send would
  // be treated as a supersede and abort the very turn the first click started.
  it('sends once when the resume button is double-clicked', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'session' };
    renderRow();

    const button = screen.getByRole('button', { name: 'Resume interrupted flow run' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(guardedSend).toHaveBeenCalledTimes(1);
  });

  // A refused send (socket down / account not ready) must release the lock so the user can retry.
  it('stays clickable when the guarded send refuses', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'session' };
    guardedSend.mockReturnValue(false);
    renderRow();

    const button = screen.getByRole('button', { name: 'Resume interrupted flow run' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(guardedSend).toHaveBeenCalledTimes(2);
  });

  // Nothing to wake (non-agent node, or no persisted session): the action re-runs the step from its
  // instructions, so it must SAY so rather than call itself Resume.
  it('shows a waiting row with no button while a resume ticket is queued for a slot', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'queued' };
    renderRow();
    expect(screen.getByText(/Waiting for a free slot/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('labels the non-resumable fallback as a re-run and dispatches it', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'redispatch' };
    renderRow();

    const button = screen.getByRole('button', {
      name: 'Re-run the interrupted step of this flow run',
    });
    expect(button).toHaveTextContent('Re-run step');
    fireEvent.click(button);

    expect(rerunMutate).toHaveBeenCalledWith({ runId: 'r-restart' });
    expect(guardedSend).not.toHaveBeenCalled();
  });

  // The row mounts asynchronously (poll surfaces the cancelled run) — it must be a live region.
  it('announces itself via a status live region with the interruption label', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'session' };
    renderRow();

    expect(screen.getByRole('status')).toHaveTextContent('Flow run interrupted');
  });

  it('shows a pending, disabled button while the re-run is in flight', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'redispatch' };
    rerunPending = true;
    renderRow();

    const button = screen.getByRole('button', {
      name: 'Re-run the interrupted step of this flow run',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Re-running');
  });

  it('shows a pending, disabled button while a wake is in flight', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'session' };
    renderRow();

    const button = screen.getByRole('button', { name: 'Resume interrupted flow run' });
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Resuming');
  });

  // The toast is the only error surface — no global mutationCache.onError exists, so a server
  // precondition throw (e.g. another pane already resumed the run) would otherwise vanish.
  it('surfaces a failed re-run via toast', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'redispatch' };
    renderRow();

    capturedOnError?.({ message: 'Flow run was already resumed.' });

    expect(toastError).toHaveBeenCalledWith('Could not re-run the step', {
      description: 'Flow run was already resumed.',
    });
  });

  // A latched send failure (e.g. FLOW_RUN_ENDED after typing into the interrupted run) is cleared
  // on the recovery click itself — ambient stream chunks deliberately never clear it, so without
  // this the composer would read as failed forever after recovering via this row.
  it('clears a latched task-execution error on either recovery click', () => {
    for (const resumeMode of ['session', 'redispatch'] as const) {
      runData = { runId: 'r-restart', resumable: true, resumeMode };
      appStore.set(taskExecutionErrorAtomFamily('sc1'), {
        message: 'Flow task t1 is no longer execution-eligible',
        category: 'FLOW_RUN_ENDED',
        timestamp: Date.now(),
      } as never);
      renderRow();

      fireEvent.click(screen.getByRole('button'));

      expect(appStore.get(taskExecutionErrorAtomFamily('sc1'))).toBeNull();
      cleanup();
    }
  });

  // Backstop for the click-time clear: a late-emitted execute:error from the declined send can
  // re-latch after the click. The run flipping off `resumable` is the authoritative recovery
  // signal, so that transition must clear the latch again.
  it('clears a re-latched error when the run stops being resumable', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'redispatch' };
    const view = renderRow();
    appStore.set(taskExecutionErrorAtomFamily('sc1'), {
      message: 'Flow task t1 is no longer execution-eligible',
      category: 'FLOW_RUN_ENDED',
      timestamp: Date.now(),
    } as never);

    runData = { runId: 'r-restart', resumable: false, resumeMode: 'redispatch' };
    // isTurnActive flips to defeat the memo — the mocked query has no subscription, so only a
    // prop change re-renders; in the app the query observer itself triggers the re-render.
    view.rerender(
      <InterruptedRunControls
        chatId="c1"
        subChatId="sc1"
        guardedSend={guardedSend}
        isTurnActive={true}
      />,
    );

    expect(appStore.get(taskExecutionErrorAtomFamily('sc1'))).toBeNull();
  });

  // The component instance survives a sub-chat switch (no key= on the row): X's resumable=true
  // observation must not read as Y's recovery and wipe Y's own latched signal.
  it('does not clear another sub-chat’s latch when the panel switches sub-chats', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'redispatch' };
    const view = renderRow();

    const yLatch = {
      error: 'Flow task t2 is no longer execution-eligible',
      category: 'FLOW_RUN_ENDED',
      timestamp: Date.now(),
    };
    appStore.set(taskExecutionErrorAtomFamily('sc2'), yLatch as never);
    runData = null;
    view.rerender(
      <InterruptedRunControls
        chatId="c1"
        subChatId="sc2"
        guardedSend={guardedSend}
        isTurnActive={false}
      />,
    );

    expect(appStore.get(taskExecutionErrorAtomFamily('sc2'))).toEqual(yLatch);
  });

  // On a successful re-run the row must invalidate both run-state queries so it clears itself.
  it('invalidates the run-state queries on a successful re-run', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'redispatch' };
    renderRow('c-success');

    capturedOnSuccess?.();

    expect(invalidateInterrupted).toHaveBeenCalledWith({
      chatId: 'c-success',
      subChatId: 'sc1',
    });
    expect(invalidateIncomplete).toHaveBeenCalledWith({ chatId: 'c-success' });
  });
});
