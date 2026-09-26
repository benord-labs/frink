import { hostname } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskResultRecord } from '../../db/repos/tasks';

const createTaskMock = vi.fn();
const getTasksWithProjectPaginatedMock = vi.fn();
const getTaskCountsMock = vi.fn();
const updateTaskStatusMock = vi.fn();
const cancelTaskDetailedMock = vi.fn();
const cancelAllPendingTasksMock = vi.fn();
const completeAllDoneTasksMock = vi.fn();
const completeDoneTasksForFlowRunMock = vi.fn();
const deleteTasksMatchingStatusesMock = vi.fn();
const reassignTaskDetailedMock = vi.fn();
const startExecutionFromReviewDetailedMock = vi.fn();
const deleteTaskDetailedMock = vi.fn();
const getTaskByIdMock = vi.fn();
const getLatestFlowTaskForSubChatMock = vi.fn();
const getFlowRunMock = vi.fn();
const getActiveFlowRunForSubChatMock = vi.fn();
const retryTaskDetailedMock = vi.fn();
const getSubChatByIdMock = vi.fn();
const getSubChatModeMock = vi.fn();
const carryOnFlowTaskMock = vi.fn();
const hasActiveFlowAdmissionMock = vi.fn();
class MockApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}
// zod v4 renamed `invalid_enum_value` → `invalid_value`; keep both so older zod versions still match.
const REMOVED_STATUS_ERROR_REGEX = /invalid_value|invalid_enum_value|approved/i;
const ONLY_REVIEWED_PLANS_REGEX = /Only reviewed plans/i;
const AMBIGUOUS_LIST_FILTER_ERROR_REGEX = /either status|cannot be combined/i;

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock') },
}));

vi.mock('../../db', () => ({
  getDatabase: vi.fn(() => ({}) as unknown),
}));


vi.mock('../../db/repos/tasks', () => ({
  deleteTaskDetailed: deleteTaskDetailedMock,
  createTask: createTaskMock,
  getFlowChatForNodeRun: vi.fn(),
  getLatestFlowTaskForSubChat: getLatestFlowTaskForSubChatMock,
  getPendingTaskIdsForMachine: vi.fn(),
  getTaskById: getTaskByIdMock,
  listTasksWithProjectPaginated: getTasksWithProjectPaginatedMock,
  getTaskCounts: getTaskCountsMock,
  startExecutionFromReviewDetailed: startExecutionFromReviewDetailedMock,
  updateTaskStatus: updateTaskStatusMock,
  cancelTaskDetailed: cancelTaskDetailedMock,
  cancelAllPendingTasks: cancelAllPendingTasksMock,
  completeAllDoneTasks: completeAllDoneTasksMock,
  completeDoneTasksForFlowRun: completeDoneTasksForFlowRunMock,
  deleteTasksMatchingStatuses: deleteTasksMatchingStatusesMock,
  reassignTaskDetailed: reassignTaskDetailedMock,
  retryTaskDetailed: retryTaskDetailedMock,
  parseResultRecord: (result: TaskResultRecord | null | undefined) => result ?? {},
}));

vi.mock('../../db/repos/sub-chats', () => ({
  getSubChatById: getSubChatByIdMock,
  getSubChatMode: getSubChatModeMock,
}));

vi.mock('../../db/repos/flow-runs', () => ({
  getFlowRun: getFlowRunMock,
  getActiveFlowRunForSubChat: getActiveFlowRunForSubChatMock,
}));

// The continue path delegates to carryOnFlowTask (session gate + task flip),
// covered end-to-end in flows/rerun/carry-on.test.ts. Mock it here so the router test stays isolated
// from that heavy import graph and only verifies result → message mapping.
vi.mock('../../flows/rerun', () => ({
  carryOnFlowTask: carryOnFlowTaskMock,
}));

vi.mock('../../flows/admission/runtime', () => ({
  hasActiveFlowAdmission: hasActiveFlowAdmissionMock,
}));

vi.mock('../../task-poller', () => ({
  getTaskPoller: () => ({
    isRunning: () => false,
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  }),
}));

describe('tasksRouter status schema', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    getTasksWithProjectPaginatedMock.mockReset();
    getTaskCountsMock.mockReset();
    updateTaskStatusMock.mockReset();
    cancelTaskDetailedMock.mockReset();
    cancelAllPendingTasksMock.mockReset();
    completeAllDoneTasksMock.mockReset();
    completeDoneTasksForFlowRunMock.mockReset();
    deleteTasksMatchingStatusesMock.mockReset();
    reassignTaskDetailedMock.mockReset();
    startExecutionFromReviewDetailedMock.mockReset();
    deleteTaskDetailedMock.mockReset();
    createTaskMock.mockResolvedValue({ id: 'task-1', source: 'manual' });
    getTasksWithProjectPaginatedMock.mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    getTaskCountsMock.mockResolvedValue({
      pending: 0,
      running: 0,
      planReady: 0,
      needsAttention: 0,
      done: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
    });
    updateTaskStatusMock.mockResolvedValue({ id: 'task-1', status: 'running' });
    cancelTaskDetailedMock.mockResolvedValue({ task: { id: 'task-1', status: 'failed' } });
    cancelAllPendingTasksMock.mockResolvedValue({ cancelledCount: 3 });
    completeAllDoneTasksMock.mockResolvedValue({ completedCount: 0 });
    deleteTasksMatchingStatusesMock.mockResolvedValue(0);
    reassignTaskDetailedMock.mockResolvedValue({
      task: { id: 'task-1', status: 'pending', projectId: 'project-2' },
    });
    startExecutionFromReviewDetailedMock.mockResolvedValue({
      task: { id: 'task-1', status: 'running', result: {} },
    });
    deleteTaskDetailedMock.mockResolvedValue({ success: true });
    getTaskByIdMock.mockReset();
    getLatestFlowTaskForSubChatMock.mockReset();
    getActiveFlowRunForSubChatMock.mockReset();
    getFlowRunMock.mockReset();
    retryTaskDetailedMock.mockReset();
    getSubChatByIdMock.mockReset();
    getSubChatModeMock.mockReset().mockResolvedValue(null);
    carryOnFlowTaskMock.mockReset();
    hasActiveFlowAdmissionMock.mockReset();
  });

  // The continue path delegates to carryOnFlowTask (its session and Flow-provenance gates live in
  // flows/rerun/carry-on.test.ts). Here we only verify the router maps its result → the right
  // surface: the carried-on task on success, or the matching message on each failure reason.
  describe('retry (Carry on) — result mapping', () => {
    it('returns the carried-on task on success', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      carryOnFlowTaskMock.mockResolvedValueOnce({
        ok: true,
        task: { id: 'task-3', status: 'pending' },
      });

      const result = await caller.retry({ taskId: 'task-3', mode: 'continue' });

      expect(carryOnFlowTaskMock).toHaveBeenCalledWith(expect.anything(), 'task-3');
      expect(result).toMatchObject({ id: 'task-3', status: 'pending' });
      expect(retryTaskDetailedMock).not.toHaveBeenCalled(); // continue routes through carryOnFlowTask
    });

    it('rejects with "Nothing to carry on" when there is no resumable session', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      carryOnFlowTaskMock.mockResolvedValueOnce({ ok: false, reason: 'no-session' });

      await expect(caller.retry({ taskId: 'task-1', mode: 'continue' })).rejects.toThrow(
        /Nothing to carry on/i,
      );
    });

    it('directs a released Flow carry-on to the Flow retry action', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      carryOnFlowTaskMock.mockResolvedValueOnce({ ok: false, reason: 'admission-required' });

      await expect(caller.retry({ taskId: 'task-flow', mode: 'continue' })).rejects.toThrow(
        /lost its place in the run queue/i,
      );
    });

    it('restart mode skips carryOnFlowTask entirely (fresh re-run needs no session)', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      retryTaskDetailedMock.mockResolvedValueOnce({ task: { id: 'task-4', status: 'pending' } });

      await caller.retry({ taskId: 'task-4', mode: 'restart' });

      expect(carryOnFlowTaskMock).not.toHaveBeenCalled();
      expect(retryTaskDetailedMock).toHaveBeenCalledWith(expect.anything(), 'task-4', 'restart');
    });
  });

  // getById carries the run OUTCOME so chat surfaces can gate accept affordances on the flow
  // actually completing — done ≠ completed (a cancelled/failed run must never offer completion).
  describe('getById flowRunStatus ride-along', () => {
    it('returns flowRunStatus for a flow-linked task', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getTaskByIdMock.mockResolvedValueOnce({
        id: 'task-flow',
        status: 'done',
        flowRunId: 'run-1',
      });
      getFlowRunMock.mockResolvedValueOnce({ id: 'run-1', status: 'completed' });

      const result = await caller.getById('task-flow');

      expect(getFlowRunMock).toHaveBeenCalledWith(expect.anything(), 'run-1');
      expect(result).toMatchObject({ id: 'task-flow', flowRunStatus: 'completed' });
    });

    it('returns the plain task for a non-flow task (no run lookup)', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getTaskByIdMock.mockResolvedValueOnce({ id: 'task-plain', status: 'done', flowRunId: null });

      const result = await caller.getById('task-plain');

      expect(getFlowRunMock).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'task-plain', status: 'done', flowRunId: null });
    });

    it('returns the task unchanged when the run row is missing', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getTaskByIdMock.mockResolvedValueOnce({
        id: 'task-gone',
        status: 'done',
        flowRunId: 'run-x',
      });
      getFlowRunMock.mockResolvedValueOnce(null);

      const result = await caller.getById('task-gone');

      expect(result).toEqual({ id: 'task-gone', status: 'done', flowRunId: 'run-x' });
    });
  });

  // The chat-level Retry/Carry-on row's task resolution. Sub-chats are REUSED across runs, so a
  // live run scopes the result (mirrors getDrivingTaskForSubChat): a previous run's terminal task
  // must never surface retry controls for a superseded run.
  describe('getActionableTaskForSubChat', () => {
    it('suppresses a stale prior-run task while a NEWER run drives the sub-chat', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'stale-failed',
        status: 'failed',
        flowRunId: 'run-old',
      });
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce({ id: 'run-new' });

      const result = await caller.getActionableTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned',
      });

      expect(result).toBeNull();
      expect(getTaskByIdMock).not.toHaveBeenCalled();
    });

    it('returns a failed member of the LIVE run itself, run-enriched', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'member-failed',
        status: 'failed',
        flowRunId: 'run-1',
      });
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce({ id: 'run-1' });
      getTaskByIdMock.mockResolvedValueOnce({
        id: 'member-failed',
        status: 'failed',
        flowRunId: 'run-1',
      });
      getFlowRunMock.mockResolvedValueOnce({ id: 'run-1', status: 'running', batchId: 'batch-1' });

      const result = await caller.getActionableTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: null,
      });

      expect(result).toMatchObject({
        id: 'member-failed',
        flowRunStatus: 'running',
      });
    });

    it('with NO live run, the newest terminal flow task is the retry target', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'last-failed',
        status: 'failed',
        flowRunId: 'run-done',
      });
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(null);
      getTaskByIdMock.mockResolvedValueOnce({
        id: 'last-failed',
        status: 'failed',
        flowRunId: 'run-done',
      });
      getFlowRunMock.mockResolvedValueOnce({ id: 'run-done', status: 'failed', batchId: null });

      const result = await caller.getActionableTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned',
      });

      expect(result).toMatchObject({ id: 'last-failed', flowRunStatus: 'failed' });
    });

    it('falls back to the pinned task only when the sub-chat has NO flow task (non-flow chat)', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(null);
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce(null);
      getTaskByIdMock.mockResolvedValueOnce({ id: 'pinned', status: 'failed', flowRunId: null });

      const result = await caller.getActionableTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned',
      });

      expect(result).toEqual({ id: 'pinned', status: 'failed', flowRunId: null });
    });
  });

  // getDrivingTaskForSubChat returns the PAIR the flow-chat bottom surface needs: the live `run`
  // (liveness, resolved run-side so it survives the taskless windows) and that run's newest `task`,
  // terminal ones INCLUDED (which surface) — never the chat's pinned taskId, which stays on the first
  // node (goes terminal) while a later node's task holds the awaiting_input signal + questions.
  describe('getDrivingTaskForSubChat', () => {
    const LIVE_RUN = { id: 'run-1' };

    it('returns the run’s newest task, not the pinned terminal fallback', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(LIVE_RUN);
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'driver-needs-attention',
        status: 'needs_attention',
        flowRunId: 'run-1',
      });
      const driving = {
        id: 'driver-needs-attention',
        status: 'needs_attention',
        result: { agentSignal: { state: 'awaiting_input', questions: [{ header: 'Next' }] } },
        triggerContext: null,
      };
      getTaskByIdMock.mockResolvedValueOnce(driving);

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned-done',
      });

      expect(getTaskByIdMock).toHaveBeenCalledWith(expect.anything(), 'driver-needs-attention');
      expect(result).toEqual({ run: LIVE_RUN, task: driving, subChatMode: null });
    });

    it('surfaces a CANCELLED task of the live run (restart-interrupted keeps its composer)', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      // A boot sweep cancels the TASK while its flow_run stays `paused`, and the run never advances
      // (finishNodeRun's CAS misses the already-cancelled node_run) — so this state is PERMANENT,
      // not a tick. Resolving the task via active-statuses-only would report `task: null` here and
      // derive the running strip forever, hiding the chat reply that flow-run-restart-recovery
      // rules IS the resume surface.
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(LIVE_RUN);
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'interrupted',
        status: 'cancelled',
        flowRunId: 'run-1',
      });
      const cancelled = {
        id: 'interrupted',
        status: 'cancelled',
        result: { error: 'restart' },
        triggerContext: null,
      };
      getTaskByIdMock.mockResolvedValueOnce(cancelled);

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned',
      });

      expect(result).toEqual({ run: LIVE_RUN, task: cancelled, subChatMode: null });
    });

    it('does NOT substitute the pinned task while a run is live (the taskless window)', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      // The run has no task at all yet. Substituting the pinned (first-node, terminal) task here
      // made "no driving task" indistinguishable from "terminal driving task" — the composer came
      // back mid-run. A live run + task:null must stay representable.
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(LIVE_RUN);
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce(null);

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned-done',
      });

      expect(result).toEqual({ run: LIVE_RUN, task: null, subChatMode: null });
      expect(getTaskByIdMock).not.toHaveBeenCalled();
    });

    it('ignores a task belonging to a PREVIOUS run on a reused flow chat', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      // Run #2 is live but has not created its first task; run #1's task still sits on the sub-chat.
      // Reporting it would let a stale terminal state pick the surface for a run it does not belong
      // to (chats.taskId is likewise pinned to run #1 — linkChatToTask is first-agent-wins).
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce({ id: 'run-2' });
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'run1-task',
        status: 'cancelled',
        flowRunId: 'run-1',
      });

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'run1-first-task',
      });

      expect(result).toEqual({
        run: { id: 'run-2' },
        task: null,
        subChatMode: null,
      });
      expect(getTaskByIdMock).not.toHaveBeenCalled();
    });

    it('falls back to the pinned task when NO run is live (standalone parked task)', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      // The fallback's one remaining job — guards against over-tightening the ternary above.
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(null);
      getTaskByIdMock.mockResolvedValueOnce({
        id: 'pinned',
        status: 'needs_attention',
        result: null,
        triggerContext: null,
      });

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned',
      });

      expect(getTaskByIdMock).toHaveBeenCalledWith(expect.anything(), 'pinned');
      expect(getLatestFlowTaskForSubChatMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ run: null, task: { id: 'pinned' } });
    });

    it('returns a null task when nothing drives the sub-chat and there is no pinned fallback', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(null);

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: null,
      });

      expect(result).toEqual({ run: null, task: null, subChatMode: null });
      expect(getTaskByIdMock).not.toHaveBeenCalled();
    });

    it('passes through a null row without crashing when the resolved task was deleted mid-request', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      // TOCTOU: the lookup sees the task, but it is deleted before getTaskById reads it. The resolver
      // must return the null row verbatim (not assume a resolved id always yields a live task).
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(LIVE_RUN);
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'driver-gone',
        status: 'running',
        flowRunId: 'run-1',
      });
      getTaskByIdMock.mockResolvedValueOnce(null);

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: 'pinned',
      });

      expect(getTaskByIdMock).toHaveBeenCalledWith(expect.anything(), 'driver-gone');
      expect(result).toEqual({ run: LIVE_RUN, task: null, subChatMode: null });
    });

    it('reports the chat’s LIVE mode alongside the task it was dispatched with', async () => {
      const { tasksRouter } = await import('./tasks');
      const caller = tasksRouter.createCaller({ getWindow: () => null });
      // The two disagree for a whole node whenever an auto-approved plan node starts implementing:
      // the executor flips the sub-chat to agent without rewriting the task's dispatch config, so a
      // surface reading only the task would show "Plan" for the rest of the run.
      getActiveFlowRunForSubChatMock.mockResolvedValueOnce(LIVE_RUN);
      getLatestFlowTaskForSubChatMock.mockResolvedValueOnce({
        id: 'plan-node',
        status: 'running',
        flowRunId: 'run-1',
      });
      const planTask = {
        id: 'plan-node',
        status: 'running',
        result: null,
        triggerContext: null,
      };
      getTaskByIdMock.mockResolvedValueOnce(planTask);
      getSubChatModeMock.mockResolvedValueOnce('agent');

      const result = await caller.getDrivingTaskForSubChat({
        subChatId: 'sub-1',
        fallbackTaskId: null,
      });

      expect(result).toEqual({ run: LIVE_RUN, task: planTask, subChatMode: 'agent' });
    });
  });

  it.each([
    'pending',
    'running',
    'plan_ready',
    'done',
    'needs_attention',
    'completed',
    'failed',
    'cancelled',
  ] as const)('accepts valid updateStatus value: %s', async (status) => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';

    await caller.updateStatus({
      taskId,
      status,
    });

    expect(updateTaskStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      taskId,
      status,
      expect.objectContaining({ executedBy: hostname() }),
    );
  });

  it('complete does not touch flow siblings for a non-flow task', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    updateTaskStatusMock.mockResolvedValueOnce({ id: taskId, status: 'completed' });

    await caller.complete({ taskId });

    expect(completeDoneTasksForFlowRunMock).not.toHaveBeenCalled();
  });

  it('complete on a flow task also accepts the run’s sibling done rows', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    updateTaskStatusMock.mockResolvedValueOnce({
      id: taskId,
      status: 'completed',
      flowRunId: 'run-1',
    });

    await caller.complete({ taskId });

    expect(completeDoneTasksForFlowRunMock).toHaveBeenCalledWith(expect.anything(), 'run-1');
  });

  it('fail transitions the task to failed with the given error', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    updateTaskStatusMock.mockResolvedValueOnce({ id: taskId, status: 'failed' });

    await caller.fail({ taskId, error: 'boom' });

    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), taskId, 'failed', {
      result: { error: 'boom' },
      executedBy: hostname(),
    });
  });

  it('markForReview transitions the task to plan_ready', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    updateTaskStatusMock.mockResolvedValueOnce({ id: taskId, status: 'plan_ready' });

    await caller.markForReview({ taskId });

    expect(updateTaskStatusMock).toHaveBeenCalledWith(expect.anything(), taskId, 'plan_ready', {
      result: {},
      executedBy: hostname(),
    });
  });

  it('rejects removed legacy statuses in updateStatus', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    await expect(
      caller.updateStatus({
        taskId: '11111111-1111-4111-8111-111111111111',
        status: 'approved' as unknown as 'pending',
      }),
    ).rejects.toThrow(REMOVED_STATUS_ERROR_REGEX);
  });

  it('starts execution only from plan_ready tasks', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';

    await caller.startExecution({ taskId });

    expect(startExecutionFromReviewDetailedMock).toHaveBeenCalledWith(
      expect.anything(),
      taskId,
      hostname(),
    );

    startExecutionFromReviewDetailedMock.mockResolvedValueOnce({
      task: null,
      reason: 'invalid_state',
    });
    await expect(caller.startExecution({ taskId })).rejects.toThrow(ONLY_REVIEWED_PLANS_REGEX);
  });

  it('rejects Flow plan execution before mutation when its admission is gone', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    getTaskByIdMock.mockResolvedValueOnce({ id: 'task-flow', flowRunId: 'run-1' });
    hasActiveFlowAdmissionMock.mockResolvedValueOnce(false);

    await expect(caller.startExecution({ taskId: 'task-flow' })).rejects.toThrow(
      /use Resume or Retry there/i,
    );
    expect(startExecutionFromReviewDetailedMock).not.toHaveBeenCalled();
  });

  it('returns success=true when backend delete succeeds', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';

    await expect(caller.delete(taskId)).resolves.toEqual({ success: true });
    expect(deleteTaskDetailedMock).toHaveBeenCalledWith(expect.anything(), taskId);
  });

  it('returns success=false when backend blocks delete (e.g. running task)', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    deleteTaskDetailedMock.mockResolvedValueOnce({ success: false, reason: 'invalid_state' });

    await expect(caller.delete(taskId)).resolves.toEqual({
      success: false,
      reason: 'invalid_state',
    });
    expect(deleteTaskDetailedMock).toHaveBeenCalledWith(expect.anything(), taskId);
  });

  it('throws when delete endpoint fails with 5xx', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    deleteTaskDetailedMock.mockRejectedValueOnce(new MockApiRequestError('server error', 500));

    await expect(caller.delete(taskId)).rejects.toThrow('server error');
  });

  it('throws when delete endpoint fails with raw transport error', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    deleteTaskDetailedMock.mockRejectedValueOnce(new Error('network down'));

    await expect(caller.delete(taskId)).rejects.toThrow('network down');
  });

  it('cancel throws when cloud helper reports task missing', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    cancelTaskDetailedMock.mockResolvedValueOnce({ task: null, reason: 'not_found' });

    await expect(caller.cancel(taskId)).rejects.toThrow('Task not found');
    expect(cancelTaskDetailedMock).toHaveBeenCalledWith(expect.anything(), taskId);
  });

  it('cancel throws when task cannot be cancelled in current status', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    cancelTaskDetailedMock.mockResolvedValueOnce({ task: null, reason: 'invalid_state' });

    await expect(caller.cancel(taskId)).rejects.toThrow('cannot be cancelled');
  });

  it('cancel rethrows non-5xx ApiRequestError', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const taskId = '11111111-1111-4111-8111-111111111111';
    cancelTaskDetailedMock.mockRejectedValueOnce(new MockApiRequestError('bad request', 400));

    await expect(caller.cancel(taskId)).rejects.toThrow('bad request');
  });

  it('reassign routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.reassign({
        taskId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toEqual({ id: 'task-1', status: 'pending', projectId: 'project-2' });
    expect(reassignTaskDetailedMock).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('reassign throws when target/task is not found', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    reassignTaskDetailedMock.mockResolvedValueOnce({ task: null, reason: 'not_found' });

    await expect(
      caller.reassign({
        taskId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow('not found');
  });

  it('reassign throws when task is not pending', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    reassignTaskDetailedMock.mockResolvedValueOnce({ task: null, reason: 'invalid_state' });

    await expect(
      caller.reassign({
        taskId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow('Only pending tasks can be reassigned');
  });

  it('reassign throws when task is flow-linked shell (not reassignable)', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    reassignTaskDetailedMock.mockResolvedValueOnce({
      task: null,
      reason: 'flow_shell_not_reassignable',
    });

    await expect(
      caller.reassign({
        taskId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow('This task is a flow-linked shell task and cannot be reassigned');
  });

  it('accepts text project id for create and routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });

    await caller.create({
      projectId: 'project/1',
      description: 'Run task',
      source: 'manual',
      requiresFilesystem: true,
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: 'project/1',
        description: 'Run task',
      }),
    );
  });

  it('createForRemoteChat routes through cloud helper with result payload', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });

    await caller.createForRemoteChat({
      projectId: '33333333-3333-4333-8333-333333333333',
      chatId: '11111111-1111-4111-8111-111111111111',
      subChatId: '22222222-2222-4222-8222-222222222222',
      message: 'Continue this work',
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: '33333333-3333-4333-8333-333333333333',
        source: 'chat-continuation',
        result: {
          chatId: '11111111-1111-4111-8111-111111111111',
          subChatId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    );
  });

  it('createForRemoteChat accepts text (cuid2) projectId', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });

    await caller.createForRemoteChat({
      projectId: 'project/legacy-text-id',
      chatId: '11111111-1111-4111-8111-111111111111',
      subChatId: '22222222-2222-4222-8222-222222222222',
      message: 'Continue',
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'project/legacy-text-id' }),
    );
  });

  it('listPaginated routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const cursor = { createdAt: '2026-03-09T00:00:00Z', id: 'task-1' };
    const rows = {
      items: [{ id: 'task-2', status: 'pending' }],
      hasMore: true,
      nextCursor: { createdAt: '2026-03-08T00:00:00Z', id: 'task-2' },
    };
    getTasksWithProjectPaginatedMock.mockResolvedValueOnce(rows);

    await expect(
      caller.listPaginated({ workQueueSection: 'inbox', limit: 10, cursor }),
    ).resolves.toEqual(rows);
    expect(getTasksWithProjectPaginatedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workQueueSection: 'inbox',
        limit: 10,
        cursor,
      }),
    );
  });

  it('listPaginated rejects ambiguous mixed filters', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });

    for (const input of [
      { status: 'pending', statuses: ['running'] },
      { status: 'pending', workQueueSection: 'inbox' },
    ]) {
      await expect(caller.listPaginated({ ...input, limit: 10 } as never)).rejects.toThrow(
        AMBIGUOUS_LIST_FILTER_ERROR_REGEX,
      );
    }
  });

  it('listPaginated reads the queue with nothing signed in', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    getTasksWithProjectPaginatedMock.mockResolvedValueOnce({
      items: [],
      hasMore: false,
      nextCursor: null,
    });

    await expect(caller.listPaginated({ limit: 10 })).resolves.toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(getTasksWithProjectPaginatedMock).toHaveBeenCalledTimes(1);
  });

  it('listCounts routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    const counts = {
      pending: 2,
      running: 1,
      planReady: 1,
      needsAttention: 2,
      done: 1,
      completed: 5,
      failed: 3,
      cancelled: 1,
      total: 14,
    };
    getTaskCountsMock.mockResolvedValueOnce(counts);

    await expect(caller.listCounts()).resolves.toEqual(counts);
    expect(getTaskCountsMock).toHaveBeenCalledTimes(1);
  });

  it('listCounts reads the counts with nothing signed in', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    getTaskCountsMock.mockResolvedValueOnce({ pending: 0, total: 0 });

    await expect(caller.listCounts()).resolves.toEqual({ pending: 0, total: 0 });
    expect(getTaskCountsMock).toHaveBeenCalledTimes(1);
  });

  it('cancelAllPending routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    cancelAllPendingTasksMock.mockResolvedValueOnce({ cancelledCount: 7 });

    await expect(caller.cancelAllPending()).resolves.toEqual({ cancelledCount: 7 });
    expect(cancelAllPendingTasksMock).toHaveBeenCalledTimes(1);
  });

  it('completeAllDone routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    completeAllDoneTasksMock.mockResolvedValueOnce({ completedCount: 5 });

    await expect(caller.completeAllDone()).resolves.toEqual({ completedCount: 5 });
    expect(completeAllDoneTasksMock).toHaveBeenCalledTimes(1);
  });

  it('deleteMatching routes through cloud helper', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });
    deleteTasksMatchingStatusesMock.mockResolvedValueOnce(12);

    await expect(caller.deleteMatching({ statuses: ['cancelled', 'failed'] })).resolves.toEqual({
      deletedCount: 12,
    });
    expect(deleteTasksMatchingStatusesMock).toHaveBeenCalledWith(expect.anything(), [
      'cancelled',
      'failed',
    ]);
  });

  it('deleteMatching rejects statuses that include running', async () => {
    const { tasksRouter } = await import('./tasks');
    const caller = tasksRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.deleteMatching({ statuses: ['cancelled', 'running'] } as never),
    ).rejects.toThrow();
    expect(deleteTasksMatchingStatusesMock).not.toHaveBeenCalled();
  });
});
