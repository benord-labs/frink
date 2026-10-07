// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let runData: {
  runId: string;
  resumable: boolean;
  resumeMode: 'continue' | 'retry' | 'queued';
  confirmSideEffects?: boolean;
  nodeRunId?: string | null;
} | null = null;
let rerunPending = false;
// Captured so tests can fire the mutation callbacks (cache-invalidation clear / error toast).
let capturedOnSettled: (() => Promise<void>) | undefined;
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
      retryRunFromLastNode: {
        useMutation: (opts?: {
          onSettled?: () => Promise<void>;
          onError?: (error: { message?: string }) => void;
        }) => {
          capturedOnSettled = opts?.onSettled;
          capturedOnError = opts?.onError;
          return { mutate: rerunMutate, isPending: rerunPending };
        },
      },
    },
  },
}));

const CONTINUE_NAME = 'Continue the interrupted flow run';
const RETRY_NAME = 'Retry the interrupted step';

const renderRow = (chatId = 'c1') =>
  render(<InterruptedRunControls chatId={chatId} subChatId="sc1" />);

describe('InterruptedRunControls', () => {
  beforeEach(() => {
    runData = null;
    rerunPending = false;
    capturedOnSettled = undefined;
    capturedOnError = undefined;
    rerunMutate.mockReset();
    invalidateInterrupted.mockReset();
    invalidateIncomplete.mockReset();
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
    runData = { runId: 'r1', resumable: false, resumeMode: 'retry' };
    const { container } = renderRow();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a waiting row with no button while a resume ticket is queued for a slot', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'queued' };
    renderRow();
    expect(screen.getByText(/Queued to resume/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // The step's session answered it: the one Continue button re-admits the run, which continues that
  // session rather than re-sending the step's instructions. Never a hidden in-place wake.
  it('continues an answered step through the run re-admit', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'continue' };
    renderRow();

    const button = screen.getByRole('button', { name: CONTINUE_NAME });
    expect(button).toHaveTextContent('Continue');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(button);

    expect(rerunMutate).toHaveBeenCalledWith({ runId: 'r-restart', kind: 'continue' });
  });

  it('re-admits once when Continue is double-clicked, until the request settles', async () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'continue' };
    renderRow();

    const button = screen.getByRole('button', { name: CONTINUE_NAME });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(rerunMutate).toHaveBeenCalledTimes(1);
  });

  // Nothing of the step reached a session: the one button says Retry, and an agent step that never
  // started has nothing to repeat, so it dispatches without a confirm.
  it('labels a never-answered step Retry and dispatches it without a confirm', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    renderRow();

    const button = screen.getByRole('button', { name: RETRY_NAME });
    expect(button).toHaveTextContent('Retry');
    fireEvent.click(button);

    expect(rerunMutate).toHaveBeenCalledWith({ runId: 'r-restart', kind: 'retry' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // The mocked `isPending` never flips, like a second click landing before it renders.
  it('re-admits once when Retry is double-clicked, until the request settles', async () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    renderRow();

    const button = screen.getByRole('button', { name: RETRY_NAME });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(rerunMutate).toHaveBeenCalledTimes(1);

    await act(() => capturedOnSettled?.());
    fireEvent.click(button);
    expect(rerunMutate).toHaveBeenCalledTimes(2);
  });

  it('confirms once before retrying a started step that may repeat its side effects', () => {
    runData = {
      runId: 'r-restart',
      resumable: true,
      resumeMode: 'retry',
      confirmSideEffects: true,
    };
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));
    expect(rerunMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This step was interrupted partway through. Running it again may repeat actions it already took.',
    );

    fireEvent.click(screen.getByRole('button', { name: /Retry anyway/ }));
    expect(rerunMutate).toHaveBeenCalledWith({ runId: 'r-restart', kind: 'retry' });

    // Settling closes it, so a second click cannot resubmit before the row refetches.
    act(() => void capturedOnSettled?.());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['another run', { runId: 'r-b' }],
    ['another step of the same run', { nodeRunId: 'nr-b' }],
    ['the step now continuable', { resumeMode: 'continue' as const }],
  ])('drops an open confirmation once the row shows %s, even after returning', (_case, change) => {
    const run = {
      runId: 'r-a',
      resumable: true,
      resumeMode: 'retry' as const,
      confirmSideEffects: true,
      nodeRunId: 'nr-a',
    };
    runData = run;
    const { rerender } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // A fresh chatId stands in for the query re-render past memo(); the confirm is not keyed on it.
    let renders = 0;
    const show = (next: typeof runData) => {
      runData = next;
      rerender(<InterruptedRunControls chatId={`c1-${++renders}`} subChatId="sc1" />);
    };
    show({ ...run, ...change });
    expect(screen.queryByRole('button', { name: /Retry anyway/ })).not.toBeInTheDocument();
    show(run);
    expect(screen.queryByRole('button', { name: /Retry anyway/ })).not.toBeInTheDocument();
    expect(rerunMutate).not.toHaveBeenCalled();
  });

  // The row mounts asynchronously (poll surfaces the cancelled run) — it must be a live region.
  it('announces itself via a status live region with the interruption label', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'continue' };
    renderRow();

    expect(screen.getByRole('status')).toHaveTextContent('Flow run interrupted');
  });

  it('shows a pending, disabled button while the retry is in flight', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    rerunPending = true;
    renderRow();

    const button = screen.getByRole('button', { name: RETRY_NAME });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Retrying');
  });

  it('shows a pending, disabled button while a continue is in flight', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'continue' };
    rerunPending = true;
    renderRow();

    const button = screen.getByRole('button', { name: CONTINUE_NAME });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Continuing');
  });

  // The toast is the only error surface — no global mutationCache.onError exists, so a server
  // precondition throw (e.g. another pane already resumed the run) would otherwise vanish.
  it('surfaces a failed recovery via toast', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    renderRow();

    capturedOnError?.({ message: 'Flow run was already resumed.' });

    expect(toastError).toHaveBeenCalledWith('Could not recover the step', {
      description: 'Flow run was already resumed.',
    });
  });

  // A latched send failure (e.g. FLOW_RUN_ENDED after typing into the interrupted run) is cleared
  // on the recovery click itself — ambient stream chunks deliberately never clear it, so without
  // this the composer would read as failed forever after recovering via this row.
  it('clears a latched task-execution error on either recovery click', () => {
    for (const resumeMode of ['continue', 'retry'] as const) {
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
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    const view = renderRow();
    appStore.set(taskExecutionErrorAtomFamily('sc1'), {
      message: 'Flow task t1 is no longer execution-eligible',
      category: 'FLOW_RUN_ENDED',
      timestamp: Date.now(),
    } as never);

    runData = { runId: 'r-restart', resumable: false, resumeMode: 'retry' };
    // chatId changes to defeat the memo — the mocked query has no subscription, so only a prop
    // change re-renders; in the app the query observer itself triggers the re-render.
    view.rerender(<InterruptedRunControls chatId="c1-refetched" subChatId="sc1" />);

    expect(appStore.get(taskExecutionErrorAtomFamily('sc1'))).toBeNull();
  });

  // The component instance survives a sub-chat switch (no key= on the row): X's resumable=true
  // observation must not read as Y's recovery and wipe Y's own latched signal.
  it('does not clear another sub-chat’s latch when the panel switches sub-chats', () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    const view = renderRow();

    const yLatch = {
      error: 'Flow task t2 is no longer execution-eligible',
      category: 'FLOW_RUN_ENDED',
      timestamp: Date.now(),
    };
    appStore.set(taskExecutionErrorAtomFamily('sc2'), yLatch as never);
    runData = null;
    view.rerender(<InterruptedRunControls chatId="c1" subChatId="sc2" />);

    expect(appStore.get(taskExecutionErrorAtomFamily('sc2'))).toEqual(yLatch);
  });

  // Settling (a re-admit, or a refusal of a stale label) refetches both run-state queries.
  it('invalidates the run-state queries once the re-admit settles', async () => {
    runData = { runId: 'r-restart', resumable: true, resumeMode: 'retry' };
    renderRow('c-success');

    await act(() => capturedOnSettled?.());

    expect(invalidateInterrupted).toHaveBeenCalledWith({ chatId: 'c-success' });
    expect(invalidateIncomplete).toHaveBeenCalledWith({ chatId: 'c-success' });
  });
});
