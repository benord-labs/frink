// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import { TaskControls } from './TaskControls';

const recoverMutate = vi.fn();
let recoverOptions: { onError?: (error: { message?: string }) => void } | undefined;
const invalidateActionable = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

let taskData: {
  id: string;
  status:
    | 'pending'
    | 'running'
    | 'plan_ready'
    | 'needs_attention'
    | 'done'
    | 'completed'
    | 'failed'
    | 'cancelled';
  result?: Record<string, unknown>;
  flowRunId?: string | null;
  recoveryKind?: 'continue' | 'retry';
  confirmSideEffects?: boolean;
  flowRunStatus?: string;
  recoveryNodeRunId?: string;
} | null = null;

// Captured so tests can assert the sub-chat resolution inputs (latest flow task vs fallback
// selection itself is server-side — see tasks-subchat.ts).
let capturedQueryInput: { subChatId: string; fallbackTaskId: string | null } | undefined;
let resolvedAccount: { id: string; isBlocked: boolean } | null | undefined;

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: vi.fn() },
        listCounts: { invalidate: vi.fn() },
        getById: { invalidate: vi.fn() },
        getDrivingTaskForSubChat: { invalidate: vi.fn() },
        getActionableTaskForSubChat: { invalidate: invalidateActionable },
      },
    }),
    tasks: {
      getActionableTaskForSubChat: {
        useQuery: (input: { subChatId: string; fallbackTaskId: string | null }) => {
          capturedQueryInput = input;
          return { data: taskData };
        },
      },
      recover: {
        useMutation: (options: { onError?: (error: { message?: string }) => void }) => {
          recoverOptions = options;
          return { mutate: recoverMutate, isPending: false };
        },
      },
    },
    claudeCode: {
      getResolvedAccount: {
        useQuery: () => ({ data: resolvedAccount }),
      },
    },
  },
}));

const retryWithProps =
  vi.fn<(props: { chatId: string; usageLimited: boolean; onRetry: () => void }) => void>();

vi.mock('../../../ui/account-indicator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../ui/account-indicator')>()),
  ContinueAfterUsageLimit: (props: {
    chatId: string;
    usageLimited: boolean;
    onRetry: () => void;
  }) => {
    retryWithProps(props);
    return (
      <button type="button" onClick={props.onRetry}>
        Retry with Backup
      </button>
    );
  },
}));

const CONTINUE_NAME = 'Continue task';
const RETRY_NAME = 'Retry task';

function renderControls(pinnedTaskId: string | null = null) {
  return render(<TaskControls subChatId="sub-1" pinnedTaskId={pinnedTaskId} />, {
    wrapper: Wrapper,
  });
}

const Wrapper = ({ children }: { children: ReactNode }) =>
  createElement(TooltipProvider, null, children);

describe('TaskControls', () => {
  beforeEach(() => {
    taskData = null;
    capturedQueryInput = undefined;
    recoverMutate.mockReset();
    invalidateActionable.mockReset();
    toastError.mockReset();
    retryWithProps.mockReset();
    resolvedAccount = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it('resolves its acting task per SUB-CHAT (with the pinned task as fallback), not per chat', () => {
    taskData = { id: 'task-3', status: 'failed', result: { error: 'boom' }, recoveryKind: 'retry' };
    renderControls('pinned-task');

    expect(capturedQueryInput).toEqual({ subChatId: 'sub-1', fallbackTaskId: 'pinned-task' });
  });

  it('hides the controls while the task is not stopped', () => {
    taskData = { id: 'task-3', status: 'running', result: { skipReview: false } };
    const { queryByRole } = renderControls();

    expect(queryByRole('button')).toBeNull();
  });

  it('renders as a status row with the failure label (chat-level grammar)', () => {
    taskData = {
      id: 'task-row',
      status: 'failed',
      result: { error: 'boom' },
      recoveryKind: 'retry',
    };
    renderControls();

    expect(screen.getByRole('status')).toHaveTextContent('Task failed');
  });

  // Exactly one recovery button per kind, so the row never offers two verbs for one stopped task.
  it.each([
    ['continue', CONTINUE_NAME, RETRY_NAME],
    ['retry', RETRY_NAME, CONTINUE_NAME],
  ] as const)(
    'a %s task shows only its one button and recovers with that kind',
    (kind, shown, hidden) => {
      taskData = {
        id: 'task-4',
        status: 'failed',
        result: { error: 'boom' },
        flowRunId: 'run-1',
        recoveryKind: kind,
      };
      renderControls();

      expect(screen.queryByRole('button', { name: hidden })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: shown }));
      expect(recoverMutate).toHaveBeenCalledWith({ taskId: 'task-4', kind });
    },
  );

  // The newest agent task finished or was swept, so the run's stopped step is what recovers.
  it('offers the recovery of a failed run that stopped on a step other than its task', () => {
    taskData = {
      id: 'task-swept',
      status: 'cancelled',
      flowRunId: 'run-1',
      flowRunStatus: 'failed',
      recoveryKind: 'continue',
      recoveryNodeRunId: 'node-b',
    };
    renderControls();

    expect(screen.getByRole('status')).toHaveTextContent('Task failed');
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_NAME }));
    expect(recoverMutate).toHaveBeenCalledWith({
      taskId: 'task-swept',
      kind: 'continue',
      recoveryNodeRunId: 'node-b',
    });
  });

  it('retries a non-flow task straight away, with no confirm', () => {
    taskData = {
      id: 'task-nonflow',
      status: 'failed',
      result: { error: 'boom' },
      recoveryKind: 'retry',
    };
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));
    expect(recoverMutate).toHaveBeenCalledWith({ taskId: 'task-nonflow', kind: 'retry' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // The server refuses a kind that no longer holds; the toast explains and the refetch relabels.
  it('toasts a refused recovery and refetches the task so the label updates', () => {
    taskData = {
      id: 'task-flow',
      status: 'failed',
      result: { error: 'boom' },
      recoveryKind: 'continue',
    };
    renderControls();

    recoverOptions?.onError?.({ message: 'This step can no longer be continued' });

    expect(toastError).toHaveBeenCalledWith('Could not continue task', {
      description: 'This step can no longer be continued',
    });
    expect(invalidateActionable).toHaveBeenCalled();
  });

  it('disables the button for blocked credential failures', () => {
    taskData = {
      id: 'task-5',
      status: 'failed',
      result: {
        dispatchErrorCode: 'MISSING_PAT',
        dispatchErrorRemediation: 'Add PAT',
      },
      recoveryKind: 'continue',
    };
    renderControls();

    const button = screen.getByRole('button', { name: CONTINUE_NAME });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(recoverMutate).not.toHaveBeenCalled();
  });

  it('cools down after a click so a double-click recovers once', () => {
    taskData = { id: 'task-6', status: 'failed', result: { error: 'boom' }, recoveryKind: 'retry' };
    renderControls();

    const button = screen.getByRole('button', { name: RETRY_NAME });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(recoverMutate).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });

  // Two clicks in one tick both see the pre-click render, so only the submit-time lock holds.
  it('sends one request for two clicks in the same tick', () => {
    taskData = { id: 'task-6', status: 'failed', result: { error: 'boom' }, recoveryKind: 'retry' };
    renderControls();

    const button = screen.getByRole('button', { name: RETRY_NAME });
    act(() => {
      button.click();
      button.click();
    });
    expect(recoverMutate).toHaveBeenCalledTimes(1);
  });

  describe('Retry of a started non-agent step', () => {
    const clickSideEffectsRetry = () => {
      taskData = {
        id: 'task-cmd',
        status: 'failed',
        result: { error: 'boom' },
        flowRunId: 'run-1',
        recoveryKind: 'retry',
        confirmSideEffects: true,
        recoveryNodeRunId: 'cmd-1',
      };
      const view = renderControls();
      fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));
      return view;
    };

    it('asks to confirm before it sends anything', () => {
      clickSideEffectsRetry();
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        'may repeat actions it already took',
      );
      expect(recoverMutate).not.toHaveBeenCalled();
    });

    it('sends nothing when the confirm is cancelled', async () => {
      clickSideEffectsRetry();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(recoverMutate).not.toHaveBeenCalled();
    });

    it('discards an open confirm when a refetch changes the recovery', async () => {
      const view = clickSideEffectsRetry();
      taskData = { ...taskData, id: 'task-cmd', status: 'failed', recoveryKind: 'continue' };
      // A changed prop stands in for the refetch that re-renders past memo().
      view.rerender(<TaskControls subChatId="sub-1" pinnedTaskId="task-cmd" />);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(recoverMutate).not.toHaveBeenCalled();
    });

    // The step shown is sent with the confirm, so the server refuses it once the step moved on.
    it('retries once confirmed, pinned to the step it showed', async () => {
      clickSideEffectsRetry();
      fireEvent.click(screen.getByRole('button', { name: 'Retry anyway' }));
      await waitFor(() =>
        expect(recoverMutate).toHaveBeenCalledWith({
          taskId: 'task-cmd',
          kind: 'retry',
          recoveryNodeRunId: 'cmd-1',
        }),
      );
    });
  });

  it('shows controls for an api-error/usage-limit park, not for other needs_attention parks', () => {
    taskData = {
      id: 'task-parked',
      status: 'needs_attention',
      result: { apiError: { message: 'API Error: 401', status: 401 } },
      recoveryKind: 'continue',
    };
    const { unmount } = renderControls();
    expect(screen.getByRole('button', { name: CONTINUE_NAME })).toBeInTheDocument();
    unmount();

    // An AskUserQuestion-style park expects an answer, not a retry.
    taskData = {
      id: 'task-parked-2',
      status: 'needs_attention',
      result: { awaitingInput: true },
      recoveryKind: 'continue',
    };
    const { queryByRole } = renderControls();
    expect(queryByRole('button', { name: CONTINUE_NAME })).toBeNull();
  });

  it("offers Retry with another login on a parked run, then recovers with the task's kind", () => {
    taskData = {
      id: 'task-limit',
      status: 'needs_attention',
      result: { chatId: 'chat-1', usageLimit: { message: "You've hit your limit" } },
      flowRunId: 'run-paused',
      recoveryKind: 'continue',
    };
    renderControls();

    expect(retryWithProps).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', usageLimited: true }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry with Backup' }));
    expect(recoverMutate).toHaveBeenCalledWith({ taskId: 'task-limit', kind: 'continue' });
  });

  it('recovers with the kind current when a login switch lands, not the one at its click', () => {
    taskData = {
      id: 'task-limit',
      status: 'needs_attention',
      result: { chatId: 'chat-1', usageLimit: { message: "You've hit your limit" } },
      flowRunId: 'run-paused',
      recoveryKind: 'retry',
    };
    const view = renderControls();
    const landSwitch = retryWithProps.mock.calls[0]?.[0].onRetry;

    taskData = { ...taskData, recoveryKind: 'continue' };
    // A changed prop stands in for the refetch that re-renders past memo().
    view.rerender(<TaskControls subChatId="sub-1" pinnedTaskId="task-limit" />);
    landSwitch?.();
    expect(recoverMutate).toHaveBeenCalledWith({ taskId: 'task-limit', kind: 'continue' });
  });

  it('hides Retry with while the recovery it would trigger cannot run', () => {
    taskData = {
      id: 'task-limit',
      status: 'needs_attention',
      result: { chatId: 'chat-1', usageLimit: { message: "You've hit your limit" } },
      flowRunId: 'run-paused',
      recoveryKind: 'continue',
    };
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: CONTINUE_NAME }));
    expect(screen.queryByRole('button', { name: 'Retry with Backup' })).toBeNull();
  });

  it('names a removed login on its park and offers the login rows outside a usage limit', () => {
    resolvedAccount = { id: 'stand-in', isBlocked: true };
    taskData = {
      id: 'task-login',
      status: 'needs_attention',
      result: { chatId: 'chat-1', apiError: { message: "This chat's login was removed" } },
      flowRunId: 'run-paused',
      recoveryKind: 'continue',
    };
    renderControls();

    expect(screen.getByText("This chat's login was removed")).toBeInTheDocument();
    expect(retryWithProps).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', usageLimited: false }),
    );
  });

  // The server offers no recovery kind while the task's Flow run is still in flight.
  it('offers no button and no Retry with on a parked task without a recovery kind', () => {
    taskData = {
      id: 'task-limit',
      status: 'needs_attention',
      result: { chatId: 'chat-1', usageLimit: { message: "You've hit your limit" } },
      flowRunId: 'run-live',
    };
    renderControls();

    expect(screen.queryByRole('button')).toBeNull();
    expect(retryWithProps).not.toHaveBeenCalled();
  });

  it('offers no Retry with on a failed task', () => {
    taskData = {
      id: 'task-failed',
      status: 'failed',
      result: { chatId: 'chat-1', error: 'boom' },
      recoveryKind: 'retry',
    };
    renderControls();

    expect(screen.queryByRole('button', { name: 'Retry with Backup' })).toBeNull();
  });
});
