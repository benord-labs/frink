import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTaskByIdMock, abortMock, warnMock, dispatchedMock, activeMock } = vi.hoisted(() => ({
  activeMock: vi.fn((): { streamEpoch: string } | undefined => ({ streamEpoch: 'e1' })),
  dispatchedMock: vi.fn((): string | null => 's1'),
  getTaskByIdMock: vi.fn(),
  abortMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('electron-log', () => ({ default: { warn: warnMock, info: vi.fn(), error: vi.fn() } }));
vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../db/repos/tasks', () => ({ getTaskById: getTaskByIdMock }));
vi.mock('../socket/executor', () => ({ abortActiveExecutionsForSubChats: abortMock }));
vi.mock('../socket/streaming/execution-registry', () => ({ getActiveExecution: activeMock }));
vi.mock('../task-executor/dispatch-registry', () => ({
  getDispatchedSubChatForTask: dispatchedMock,
}));

import { abortIfTaskNoLongerRunning } from './dispatch-cancel-fence';

describe('abortIfTaskNoLongerRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchedMock.mockReturnValue('s1');
    activeMock.mockReturnValue({ streamEpoch: 'e1' });
  });

  it('leaves a still-running task’s turn alone', async () => {
    getTaskByIdMock.mockResolvedValue({ id: 't1', status: 'running' });
    await abortIfTaskNoLongerRunning('t1', 's1');
    expect(abortMock).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'failed', 'done'])(
    'aborts the just-registered turn when the task is already %s',
    async (status) => {
      getTaskByIdMock.mockResolvedValue({ id: 't1', status });
      await abortIfTaskNoLongerRunning('t1', 's1');
      expect(abortMock).toHaveBeenCalledWith(['s1'], 'task cancelled');
    },
  );

  it('aborts when the task row is gone', async () => {
    getTaskByIdMock.mockResolvedValue(null);
    await abortIfTaskNoLongerRunning('t1', 's1');
    expect(abortMock).toHaveBeenCalledWith(['s1'], 'task cancelled');
  });

  it.each([
    ['a different sub-chat', 's-other'],
    ['no dispatch record', null],
  ])('ignores ids that differ from the executor’s binding (%s)', async (_l, bound) => {
    // Forged/stale dispatchTaskId: never abort a session this task was not dispatched into.
    dispatchedMock.mockReturnValue(bound);
    getTaskByIdMock.mockResolvedValue({ id: 't1', status: 'cancelled' });
    await abortIfTaskNoLongerRunning('t1', 's1');
    expect(abortMock).not.toHaveBeenCalled();
    expect(getTaskByIdMock).not.toHaveBeenCalled();
  });

  it('spares an execution that replaced the pinned one mid-await', async () => {
    // A retry re-registers the sub-chat between the status read and the abort.
    activeMock.mockReturnValueOnce({ streamEpoch: 'e1' }).mockReturnValue({ streamEpoch: 'e2' });
    getTaskByIdMock.mockResolvedValue({ id: 't1', status: 'cancelled' });
    await abortIfTaskNoLongerRunning('t1', 's1');
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('does nothing when no execution is registered (the turn already ended)', async () => {
    activeMock.mockReturnValue(undefined);
    getTaskByIdMock.mockResolvedValue({ id: 't1', status: 'cancelled' });
    await abortIfTaskNoLongerRunning('t1', 's1');
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed status read (never breaks the send)', async () => {
    getTaskByIdMock.mockRejectedValue(new Error('SQLITE_BUSY'));
    await expect(abortIfTaskNoLongerRunning('t1', 's1')).resolves.toBeUndefined();
    expect(abortMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });
});
