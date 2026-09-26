// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskAcceptBar } from './TaskAcceptBar';

const completeMutate = vi.fn();

let taskData: {
  id: string;
  status: string;
  flowRunId?: string | null;
  flowRunStatus?: string;
} | null = null;

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: vi.fn() },
        listCounts: { invalidate: vi.fn() },
        getById: { invalidate: vi.fn() },
      },
    }),
    tasks: {
      getActionableTaskForSubChat: {
        useQuery: () => ({ data: taskData }),
      },
      complete: {
        useMutation: () => ({ mutate: completeMutate, isPending: false }),
      },
    },
  },
}));

describe('TaskAcceptBar', () => {
  beforeEach(() => {
    taskData = null;
    completeMutate.mockReset();
  });

  afterEach(cleanup);

  it('shows for a done non-flow task and accepts via tasks.complete', () => {
    taskData = { id: 'task-1', status: 'done', flowRunId: null };
    render(<TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-1'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark task complete' }));

    expect(completeMutate).toHaveBeenCalledWith({ taskId: 'task-1' });
  });

  it('shows for a done flow task once its run COMPLETED', () => {
    taskData = { id: 'task-2', status: 'done', flowRunId: 'run-1', flowRunStatus: 'completed' };
    render(<TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-2'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark task complete' }));

    expect(completeMutate).toHaveBeenCalledWith({ taskId: 'task-2' });
  });

  // Complete & Archive: one click accepts the result then asks the sidebar to archive the chat,
  // so closing out a finished run never needs a second trip through the sidebar dropdown.
  it('completes then dispatches a sidebar archive event on Complete & Archive', () => {
    taskData = { id: 'task-6', status: 'done', flowRunId: null };
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-6'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark task complete and archive chat' }));

    expect(completeMutate).toHaveBeenCalledWith(
      { taskId: 'task-6' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Archive is deferred until the task is confirmed completed — fire the success callback.
    const options = completeMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    options.onSuccess();

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sidebar:archive-chat', detail: { chatId: 'chat-6' } }),
    );
    dispatchSpy.mockRestore();
  });

  // The two buttons are distinct: the secondary "Mark complete" keeps the chat open, so it must
  // never emit the archive event — otherwise the bar would silently close chats users wanted kept.
  it('Mark complete (secondary) accepts the task without archiving', () => {
    taskData = { id: 'task-7', status: 'done', flowRunId: null };
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-7'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark task complete' }));

    expect(completeMutate).toHaveBeenCalledWith({ taskId: 'task-7' });
    expect(
      dispatchSpy.mock.calls.some(([event]) => (event as Event).type === 'sidebar:archive-chat'),
    ).toBe(false);
    dispatchSpy.mockRestore();
  });

  // Input-shape edge: no top-level chatId to archive (e.g. an unsaved chat). Acceptance must still
  // go through — losing the completion because archiving is impossible would be the worse failure.
  it('Complete & Archive still accepts the task but skips archiving when chatId is absent', () => {
    taskData = { id: 'task-8', status: 'done', flowRunId: null };
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark task complete and archive chat' }));

    expect(completeMutate).toHaveBeenCalledWith(
      { taskId: 'task-8' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    const options = completeMutate.mock.calls[0]?.[1] as { onSuccess: () => void };
    options.onSuccess();

    expect(
      dispatchSpy.mock.calls.some(([event]) => (event as Event).type === 'sidebar:archive-chat'),
    ).toBe(false);
    dispatchSpy.mockRestore();
  });

  // done ≠ completed: a run that died early never offers completion, however reviewable
  // the partial output is — the work was not finished.
  it.each(['running', 'paused', 'cancelled', 'failed'])(
    'hides for a done flow task whose run is %s',
    (flowRunStatus) => {
      taskData = { id: 'task-3', status: 'done', flowRunId: 'run-1', flowRunStatus };
      const { queryByRole } = render(
        <TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-3'} />,
      );

      expect(queryByRole('button', { name: 'Mark task complete' })).toBeNull();
    },
  );

  it('hides for a done flow task while the run status is still loading (no premature flash)', () => {
    taskData = { id: 'task-4', status: 'done', flowRunId: 'run-1' }; // flowRunStatus absent
    const { queryByRole } = render(
      <TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-4'} />,
    );

    expect(queryByRole('button', { name: 'Mark task complete' })).toBeNull();
  });

  it('hides once the task is completed and when there is no task', () => {
    taskData = { id: 'task-5', status: 'completed' };
    const { queryByRole } = render(
      <TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={'chat-5'} />,
    );
    expect(queryByRole('button', { name: 'Mark task complete' })).toBeNull();

    taskData = null;
    const { queryByRole: queryNoTask } = render(
      <TaskAcceptBar subChatId="sub-1" pinnedTaskId={null} chatId={null} />,
    );
    expect(queryNoTask('button', { name: 'Mark task complete' })).toBeNull();
  });
});
