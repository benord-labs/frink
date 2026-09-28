import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../db/schema';

const {
  abortActiveExecutionsForSubChatsMock,
  cancelFlowRunMock,
  logWarnMock,
  getDispatchedSubChatForTaskMock,
} = vi.hoisted(() => ({
  getDispatchedSubChatForTaskMock: vi.fn((): string | null => null),
  abortActiveExecutionsForSubChatsMock: vi.fn(),
  cancelFlowRunMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: logWarnMock, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../socket/executor', () => ({
  abortActiveExecutionsForSubChats: abortActiveExecutionsForSubChatsMock,
}));
vi.mock('../flows/engine', () => ({ cancelFlowRun: cancelFlowRunMock }));
vi.mock('../task-executor/dispatch-registry', () => ({
  getDispatchedSubChatForTask: getDispatchedSubChatForTaskMock,
}));

import { resolveTaskSubChatIds, stopTaskSession } from './abort-task-session';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: null,
    title: null,
    description: 'Do it',
    source: 'manual',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: true,
    status: 'running',
    result: null,
    triggerContext: null,
    flowRunId: null,
    nodeRunId: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    executedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelFlowRunMock.mockResolvedValue({ status: 'cancelled' });
  getDispatchedSubChatForTaskMock.mockReturnValue(null);
});

describe('resolveTaskSubChatIds', () => {
  it('uses the sub-chat the executor stamped on result', () => {
    expect(
      resolveTaskSubChatIds(task({ result: { chatId: 'chat-1', subChatId: 'sub-1' } })),
    ).toEqual(['sub-1']);
  });

  it('uses the sub-chat a flow dispatch recorded on triggerContext', () => {
    const tc = { chatId: 'chat-1', subChatId: 'sub-flow' } as Task['triggerContext'];
    expect(resolveTaskSubChatIds(task({ triggerContext: tc }))).toEqual(['sub-flow']);
  });

  it('dedupes when result and triggerContext name the same sub-chat', () => {
    const t = task({
      result: { subChatId: 'sub-1' },
      triggerContext: { subChatId: 'sub-1' } as Task['triggerContext'],
    });
    expect(resolveTaskSubChatIds(t)).toEqual(['sub-1']);
  });

  it('keeps both when result and triggerContext name different sub-chats', () => {
    const t = task({
      result: { subChatId: 'sub-1' },
      triggerContext: { subChatId: 'sub-2' } as Task['triggerContext'],
    });
    expect(resolveTaskSubChatIds(t)).toEqual(['sub-1', 'sub-2']);
  });

  it.each([
    ['empty string', ''],
    ['spaces', '   '],
    ['tab/newline', '\t\n'],
    ['number', 42],
    ['null', null],
    ['object', { id: 'x' }],
  ])('treats a malformed subChatId (%s) as unstamped', (_label, value) => {
    const t = task({
      result: { subChatId: value } as unknown as Task['result'],
      triggerContext: { subChatId: value } as unknown as Task['triggerContext'],
    });
    expect(resolveTaskSubChatIds(t)).toEqual([]);
  });

  it('reaches a dispatched turn whose result stamp failed (dispatch registry)', () => {
    getDispatchedSubChatForTaskMock.mockReturnValue('sub-dispatched');
    expect(resolveTaskSubChatIds(task())).toEqual(['sub-dispatched']);
    expect(getDispatchedSubChatForTaskMock).toHaveBeenCalledWith('task-1');
  });

  it('dedupes the registry entry against the stamped id', () => {
    getDispatchedSubChatForTaskMock.mockReturnValue('sub-1');
    expect(resolveTaskSubChatIds(task({ result: { subChatId: 'sub-1' } }))).toEqual(['sub-1']);
  });

  it('tolerates non-object result / triggerContext shapes', () => {
    const t = task({
      result: 'garbage' as unknown as Task['result'],
      triggerContext: ['x'] as unknown as Task['triggerContext'],
    });
    expect(resolveTaskSubChatIds(t)).toEqual([]);
  });
});

describe('stopTaskSession', () => {
  it('aborts the running task session', async () => {
    await stopTaskSession(task({ result: { subChatId: 'sub-1' } }));
    expect(abortActiveExecutionsForSubChatsMock).toHaveBeenCalledWith(['sub-1'], 'task cancelled');
    expect(cancelFlowRunMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'plan_ready', 'needs_attention', 'done', 'completed', 'failed', 'cancelled'])(
    'does nothing when the replaced row was %s (user may be driving the sub-chat)',
    async (status) => {
      await stopTaskSession(task({ status, result: { subChatId: 'sub-1' }, flowRunId: 'run-1' }));
      expect(abortActiveExecutionsForSubChatsMock).not.toHaveBeenCalled();
      expect(cancelFlowRunMock).not.toHaveBeenCalled();
    },
  );

  it('skips the executor abort when no sub-chat was stamped', async () => {
    await stopTaskSession(task());
    expect(abortActiveExecutionsForSubChatsMock).not.toHaveBeenCalled();
  });

  it('flow-linked task: aborts the sub-chat and then cancels the flow run', async () => {
    const order: string[] = [];
    abortActiveExecutionsForSubChatsMock.mockImplementation(() => order.push('abort'));
    cancelFlowRunMock.mockImplementation(async () => {
      order.push('cancelRun');
      return { status: 'cancelled' };
    });
    await stopTaskSession(
      task({
        flowRunId: 'run-1',
        triggerContext: { subChatId: 'sub-flow' } as Task['triggerContext'],
      }),
    );
    expect(order).toEqual(['abort', 'cancelRun']);
    expect(cancelFlowRunMock).toHaveBeenCalledWith('run-1');
  });

  it('flow-linked task with no stamped sub-chat still cancels the run', async () => {
    await stopTaskSession(task({ flowRunId: 'run-1' }));
    expect(cancelFlowRunMock).toHaveBeenCalledWith('run-1');
  });

  it('swallows and logs an executor abort failure, still cancelling the flow run', async () => {
    abortActiveExecutionsForSubChatsMock.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(
      stopTaskSession(task({ flowRunId: 'run-1', result: { subChatId: 'sub-1' } })),
    ).resolves.toBeUndefined();
    expect(cancelFlowRunMock).toHaveBeenCalledWith('run-1');
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('swallows and logs a flow cancel rejection', async () => {
    cancelFlowRunMock.mockRejectedValue(new Error('db locked'));
    await expect(
      stopTaskSession(task({ flowRunId: 'run-1', result: { subChatId: 'sub-1' } })),
    ).resolves.toBeUndefined();
    expect(logWarnMock).toHaveBeenCalled();
  });
});
