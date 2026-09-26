// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import { TaskControls } from './TaskControls';

const tasksRetryMutate = vi.fn();
const retryNodeMutate = vi.fn();

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
  flowRunStatus?: string;
} | null = null;

// Captured so tests can assert the sub-chat resolution inputs (latest flow task vs fallback
// selection itself is server-side — see tasks-subchat.ts).
let capturedQueryInput: { subChatId: string; fallbackTaskId: string | null } | undefined;

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: vi.fn() },
        listCounts: { invalidate: vi.fn() },
        getById: { invalidate: vi.fn() },
        getDrivingTaskForSubChat: { invalidate: vi.fn() },
        getActionableTaskForSubChat: { invalidate: vi.fn() },
      },
    }),
    tasks: {
      getActionableTaskForSubChat: {
        useQuery: (input: { subChatId: string; fallbackTaskId: string | null }) => {
          capturedQueryInput = input;
          return { data: taskData };
        },
      },
      retry: {
        useMutation: () => ({ mutate: tasksRetryMutate, isPending: false }),
      },
    },
    flows: {
      retryRunFromLastNode: {
        useMutation: () => ({ mutate: retryNodeMutate, isPending: false }),
      },
    },
    chats: {
      get: {
        useQuery: () => ({ data: undefined }),
      },
    },
  },
}));

const CARRY_ON_NAME = /Carry on task/;
const RETRY_NAME = /Retry task/;

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
    tasksRetryMutate.mockReset();
    retryNodeMutate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('resolves its acting task per SUB-CHAT (with the pinned task as fallback), not per chat', () => {
    taskData = { id: 'task-3', status: 'failed', result: { error: 'boom' } };
    renderControls('pinned-task');

    expect(capturedQueryInput).toEqual({ subChatId: 'sub-1', fallbackTaskId: 'pinned-task' });
  });

  it('hides the controls while the task is not failed', () => {
    taskData = { id: 'task-3', status: 'running', result: { skipReview: false } };
    const { queryByRole } = renderControls();

    expect(queryByRole('button', { name: CARRY_ON_NAME })).toBeNull();
    expect(queryByRole('button', { name: RETRY_NAME })).toBeNull();
  });

  it('hides the controls immediately when the task resumes from failed to running', () => {
    taskData = { id: 'task-resume-1', status: 'failed', result: { error: 'Transient failure' } };
    const { queryByRole, unmount } = renderControls();

    expect(queryByRole('button', { name: CARRY_ON_NAME })).toBeInTheDocument();

    taskData = {
      id: 'task-resume-1',
      status: 'running',
      result: { resumedBy: 'follow_up_message' },
    };
    unmount();
    const { queryByRole: queryAfterResume } = renderControls();

    expect(queryAfterResume('button', { name: CARRY_ON_NAME })).toBeNull();
  });

  it('renders as a status row with the failure label (chat-level grammar)', () => {
    taskData = { id: 'task-row', status: 'failed', result: { error: 'boom' } };
    renderControls();

    expect(screen.getByRole('status')).toHaveTextContent('Task failed');
  });

  it('Carry on is the primary action — resumes the session via tasks.retry continue', () => {
    taskData = { id: 'task-4', status: 'failed', result: { error: 'Transient failure' } };
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: CARRY_ON_NAME }));

    expect(tasksRetryMutate).toHaveBeenCalledWith({ taskId: 'task-4', mode: 'continue' });
  });

  it('enables Carry on for a batch member whose run is paused — same rule as any Flow run', () => {
    taskData = {
      id: 'task-batch',
      status: 'failed',
      result: { error: 'boom' },
      flowRunId: 'run-1',
      flowRunStatus: 'paused',
    };
    renderControls();

    const carryOn = screen.getByRole('button', { name: CARRY_ON_NAME });
    expect(carryOn).toBeEnabled();
    fireEvent.click(carryOn);
    expect(tasksRetryMutate).toHaveBeenCalledWith({ taskId: 'task-batch', mode: 'continue' });
  });

  it('Retry on a flow task re-runs from the last invoked node', () => {
    taskData = { id: 'task-flow', status: 'failed', result: { error: 'boom' }, flowRunId: 'run-9' };
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));

    expect(retryNodeMutate).toHaveBeenCalledWith({ runId: 'run-9' });
    expect(tasksRetryMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: CARRY_ON_NAME })).toBeDisabled();
  });

  it('enables Retry on a batch member whose run has settled to failed', () => {
    taskData = {
      id: 'task-batch-retry',
      status: 'failed',
      result: { error: 'boom' },
      flowRunId: 'run-1',
      flowRunStatus: 'failed',
    };
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));

    expect(retryNodeMutate).toHaveBeenCalledWith({ runId: 'run-1' });
  });

  it('keeps Retry disabled for a batch member whose run is paused — the run is not settled', () => {
    taskData = {
      id: 'task-batch-paused',
      status: 'needs_attention',
      result: { apiError: { message: 'API Error: 529', status: 529 } },
      flowRunId: 'run-1',
      flowRunStatus: 'paused',
    };
    renderControls();

    expect(screen.getByRole('button', { name: RETRY_NAME })).toBeDisabled();
    expect(retryNodeMutate).not.toHaveBeenCalled();
  });

  it('Retry on a NON-flow task confirms first (fresh re-run abandons the failed attempt)', () => {
    taskData = { id: 'task-nonflow', status: 'failed', result: { error: 'boom' } };
    renderControls();

    fireEvent.click(screen.getByRole('button', { name: RETRY_NAME }));
    // Two-step confirm: nothing dispatched until the explicit confirm.
    expect(tasksRetryMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm re-run/ }));
    expect(tasksRetryMutate).toHaveBeenCalledWith({ taskId: 'task-nonflow', mode: 'restart' });
  });

  it('keeps Carry on enabled for lease-expired failures', () => {
    taskData = {
      id: 'task-lease-expired',
      status: 'failed',
      result: {
        failureCode: 'EXECUTION_LEASE_EXPIRED',
        error: 'Execution lease expired (no heartbeat)',
      },
    };
    renderControls();

    const carryOnButton = screen.getByRole('button', { name: CARRY_ON_NAME });
    expect(carryOnButton).toBeEnabled();
    fireEvent.click(carryOnButton);

    expect(tasksRetryMutate).toHaveBeenCalledWith({
      taskId: 'task-lease-expired',
      mode: 'continue',
    });
  });

  it('disables both controls for blocked credential failures', () => {
    taskData = {
      id: 'task-5',
      status: 'failed',
      result: {
        dispatchErrorCode: 'MISSING_PAT',
        dispatchErrorRemediation: 'Add PAT',
      },
    };
    renderControls();

    expect(screen.getByRole('button', { name: CARRY_ON_NAME })).toBeDisabled();
    expect(screen.getByRole('button', { name: RETRY_NAME })).toBeDisabled();
    expect(tasksRetryMutate).not.toHaveBeenCalled();
  });

  it('E2E: shows controls disabled for invalid model with remediation tooltip', () => {
    taskData = {
      id: 'task-6',
      status: 'failed',
      result: {
        dispatchErrorCode: 'INVALID_MODEL',
        dispatchErrorRemediation: 'Select a valid model (haiku, sonnet, or opus).',
      },
    };
    renderControls();

    expect(screen.getByRole('button', { name: CARRY_ON_NAME })).toBeDisabled();
  });

  it('shows controls for an api-error/usage-limit park, not for other needs_attention parks', () => {
    taskData = {
      id: 'task-parked',
      status: 'needs_attention',
      result: { apiError: { message: 'API Error: 401', status: 401 } },
    };
    const { unmount } = renderControls();
    expect(screen.getByRole('button', { name: CARRY_ON_NAME })).toBeInTheDocument();
    unmount();

    // An AskUserQuestion-style park expects an answer, not a retry.
    taskData = { id: 'task-parked-2', status: 'needs_attention', result: { awaitingInput: true } };
    const { queryByRole } = renderControls();
    expect(queryByRole('button', { name: CARRY_ON_NAME })).toBeNull();
  });

  it('keeps Carry on available while a non-batch paused Flow retains admission', () => {
    // A usage-limit/api-error park pauses the run; redispatching a paused run would be refused.
    taskData = {
      id: 'task-paused',
      status: 'needs_attention',
      result: { apiError: { message: 'API Error: 529', status: 529 } },
      flowRunId: 'run-paused',
      flowRunStatus: 'paused',
    };
    renderControls();

    const carryOn = screen.getByRole('button', { name: CARRY_ON_NAME });
    expect(carryOn).toBeEnabled();
    fireEvent.click(carryOn);
    expect(tasksRetryMutate).toHaveBeenCalledWith({ taskId: 'task-paused', mode: 'continue' });
    expect(screen.getByRole('button', { name: RETRY_NAME })).toBeDisabled();
  });
});
