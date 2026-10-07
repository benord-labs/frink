import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { getDatabase } from '../../db';
import { FlowVersionConflictError } from '../../db/repos/flow-versions';
import { FlowCopyNoSavedVersionError, FlowCopyNotFoundError } from '../../db/repos/flows';
import { freshDb } from '../../db/test-utils/fresh-db';
import {
  TerminalResumeAdmissionError,
  TerminalResumeChatDeletedError,
} from '../../flows/admission/terminal-resume';
import { flowsRouter } from './flows';

const createFlowVersionMock = vi.fn();
const copyFlowMock = vi.fn();
const createBriefingStashMock = vi.fn();
const listFlowsMock = vi.fn();
const getFlowByIdMock = vi.fn();
const getLatestVersionMock = vi.fn();
const getLatestRunsForFlowsMock = vi.fn();
const getFlowRunMock = vi.fn();
const listFlowRunsForFlowMock = vi.fn();
const getActiveFlowDrivingStatusByRunMock = vi.fn();
const flowRunAdmissionSnapshotsForRunsMock = vi.fn();
const queuedRunsForFlowsMock = vi.fn();
const queuedFlowAdmissionsMock = vi.fn();
const queuedAdmissionRunMock = vi.fn();
const cancelFlowRunMock = vi.fn();
const getFlowRunWithNodeRunsMock = vi.fn();
const startFlowRunMock = vi.fn();
const listNodeRunsForFlowRunMock = vi.fn();
const getVersionMock = vi.fn();
const createBatchPlanTemplateMock = vi.fn();
const updateStageRunLocalMock = vi.fn();
const uploadAttachmentToStageRunMock = vi.fn();
const resolveAttachmentToDataUrlMock = vi.fn();
const parkFlowTaskForSubChatMock = vi.fn();
const pauseActiveExecutionForSubChatMock = vi.fn();
const getFlowAdmissionSettingsMock = vi.fn();
const updateFlowAdmissionSettingsMock = vi.fn();
const moveQueuedFlowAdmissionMock = vi.fn();
const kickStalledFlowAdmissionDrainMock = vi.fn();
const retryTerminalFlowRunMock = vi.fn();
const resumeFlowRunMock = vi.fn();

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock') },
}));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    getDatabase: vi.fn(() => ({}) as unknown),
    // flows.get/saveVersion log getDatabasePath() in a debug line; stub it so the
    // real path resolver doesn't try to mkdir the mocked '/mock/data' userData dir.
    getDatabasePath: vi.fn(() => '/mock/agents.db'),
  };
});

vi.mock('../../db/repos/flow-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repos/flow-versions')>();
  return {
    ...actual,
    createFlowVersion: (...args: unknown[]) => createFlowVersionMock(...args),
    getLatestVersion: (...args: unknown[]) => getLatestVersionMock(...args),
    getVersion: (...args: unknown[]) => getVersionMock(...args),
  };
});

vi.mock('../../db/repos/flows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repos/flows')>();
  return {
    ...actual,
    copyFlow: (...args: unknown[]) => copyFlowMock(...args),
    listFlows: (...args: unknown[]) => listFlowsMock(...args),
    getFlowById: (...args: unknown[]) => getFlowByIdMock(...args),
    createFlow: vi.fn(),
    updateFlow: vi.fn(),
  };
});

vi.mock('../../db/repos/flow-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repos/flow-runs')>();
  return {
    ...actual,
    getFlowRun: (...args: unknown[]) => getFlowRunMock(...args),
    getLatestRunsForFlows: (...args: unknown[]) => getLatestRunsForFlowsMock(...args),
    listFlowRunsForFlow: (...args: unknown[]) => listFlowRunsForFlowMock(...args),
    getActiveFlowDrivingStatusByRun: (...args: unknown[]) =>
      getActiveFlowDrivingStatusByRunMock(...args),
  };
});

vi.mock('../../flows/admission/visibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../flows/admission/visibility')>();
  return {
    ...actual,
    flowRunAdmissionSnapshotsForRuns: (...args: unknown[]) =>
      flowRunAdmissionSnapshotsForRunsMock(...args),
    queuedRunsForFlows: (...args: unknown[]) => queuedRunsForFlowsMock(...args),
    queuedFlowAdmissions: (...args: unknown[]) => queuedFlowAdmissionsMock(...args),
    queuedAdmissionRun: (...args: unknown[]) => queuedAdmissionRunMock(...args),
  };
});

vi.mock('../../flows/admission/terminal-resume/dispatcher', () => ({
  retryTerminalFlowRun: (...args: unknown[]) => retryTerminalFlowRunMock(...args),
}));

vi.mock('../../db/repos/briefing-stashes', () => ({
  createBriefingStash: (...args: unknown[]) => createBriefingStashMock(...args),
  listBriefingStashes: vi.fn(),
  deleteBriefingStash: vi.fn(),
}));

vi.mock('../../db/repos/batch-plan-templates', () => ({
  createBatchPlanTemplate: (...args: unknown[]) => createBatchPlanTemplateMock(...args),
  listBatchPlanTemplates: vi.fn(),
  renameBatchPlanTemplate: vi.fn(),
  deleteBatchPlanTemplate: vi.fn(),
}));

vi.mock('../../db/repos/node-runs', () => ({
  listNodeRunsForFlowRun: (...args: unknown[]) => listNodeRunsForFlowRunMock(...args),
}));

vi.mock('../../flows/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../flows/engine')>();
  return {
    ...actual,
    cancelFlowRun: (...args: unknown[]) => cancelFlowRunMock(...args),
    getFlowRunWithNodeRuns: (...args: unknown[]) => getFlowRunWithNodeRunsMock(...args),
    startFlowRun: (...args: unknown[]) => startFlowRunMock(...args),
    resumeFlowRun: (...args: unknown[]) => resumeFlowRunMock(...args),
  };
});

vi.mock('../../flows/admission/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../flows/admission/runtime')>();
  return {
    ...actual,
    getFlowAdmissionSettings: (...args: unknown[]) => getFlowAdmissionSettingsMock(...args),
    moveQueuedFlowAdmission: (...args: unknown[]) => moveQueuedFlowAdmissionMock(...args),
    kickStalledFlowAdmissionDrain: () => kickStalledFlowAdmissionDrainMock(),
    updateFlowAdmissionSettings: (...args: unknown[]) => updateFlowAdmissionSettingsMock(...args),
  };
});

vi.mock('../../flows/batch-mutations', () => ({
  updateStageRunLocal: (...args: unknown[]) => updateStageRunLocalMock(...args),
  patchBatchStageDepsLocal: vi.fn(),
  reassignStageRunLocal: vi.fn(),
}));

vi.mock('../../flows/attachments-upload', () => ({
  uploadAttachmentToStageRun: (...args: unknown[]) => uploadAttachmentToStageRunMock(...args),
}));

vi.mock('../../flows/attachments-data-url', () => ({
  resolveAttachmentToDataUrl: (...args: unknown[]) => resolveAttachmentToDataUrlMock(...args),
}));

// pauseRun's dynamic imports (via flows/resume.ts): the park repo and the executor are stubbed
// (the executor's import graph is heavy Electron machinery).
vi.mock('../../db/repos/task-parking', () => ({
  parkFlowTaskForSubChat: (...args: unknown[]) => parkFlowTaskForSubChatMock(...args),
}));

vi.mock('../../socket/executor', () => ({
  pauseActiveExecutionForSubChat: (...args: unknown[]) =>
    pauseActiveExecutionForSubChatMock(...args),
}));

describe('flowsRouter (local)', () => {
  beforeEach(() => {
    createFlowVersionMock.mockReset();
    copyFlowMock.mockReset();
    createBriefingStashMock.mockReset();
    listFlowsMock.mockReset();
    getFlowByIdMock.mockReset();
    getLatestVersionMock.mockReset();
    getLatestVersionMock.mockResolvedValue(null);
    getLatestRunsForFlowsMock.mockReset();
    getLatestRunsForFlowsMock.mockResolvedValue(new Map());
    getFlowRunMock.mockReset();
    listFlowRunsForFlowMock.mockReset();
    listFlowRunsForFlowMock.mockResolvedValue([]);
    getActiveFlowDrivingStatusByRunMock.mockReset();
    getActiveFlowDrivingStatusByRunMock.mockResolvedValue(new Map());
    flowRunAdmissionSnapshotsForRunsMock.mockReset();
    flowRunAdmissionSnapshotsForRunsMock.mockReturnValue(new Map());
    queuedRunsForFlowsMock.mockReset();
    queuedRunsForFlowsMock.mockReturnValue(new Map());
    queuedFlowAdmissionsMock.mockReset();
    queuedFlowAdmissionsMock.mockReturnValue([]);
    queuedAdmissionRunMock.mockReset();
    queuedAdmissionRunMock.mockReturnValue(null);
    cancelFlowRunMock.mockReset();
    getFlowRunWithNodeRunsMock.mockReset();
    startFlowRunMock.mockReset();
    listNodeRunsForFlowRunMock.mockReset();
    listNodeRunsForFlowRunMock.mockResolvedValue([]);
    getVersionMock.mockReset();
    getVersionMock.mockResolvedValue(null);
    createBatchPlanTemplateMock.mockReset();
    updateStageRunLocalMock.mockReset();
    uploadAttachmentToStageRunMock.mockReset();
    resolveAttachmentToDataUrlMock.mockReset();
    parkFlowTaskForSubChatMock.mockReset();
    pauseActiveExecutionForSubChatMock.mockReset();
    getFlowAdmissionSettingsMock.mockReset();
    updateFlowAdmissionSettingsMock.mockReset();
    moveQueuedFlowAdmissionMock.mockReset();
    kickStalledFlowAdmissionDrainMock.mockReset();
    retryTerminalFlowRunMock.mockReset();
    resumeFlowRunMock.mockReset();
  });

  describe('copy', () => {
    it('copies a flow and returns only the new ID', async () => {
      copyFlowMock.mockResolvedValueOnce({ id: 'flow-copy' });
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.copy({ id: 'flow-source' })).resolves.toEqual({ id: 'flow-copy' });
      expect(copyFlowMock).toHaveBeenCalledWith(expect.anything(), {
        sourceFlowId: 'flow-source',
      });
    });

    it('maps missing, inactive, and foreign sources to the same NOT_FOUND response', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      for (const source of ['missing', 'inactive', 'foreign']) {
        copyFlowMock.mockRejectedValueOnce(new FlowCopyNotFoundError());
        await expect(caller.copy({ id: source })).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Flow not found',
        });
      }
    });

    it('maps a never-saved source to PRECONDITION_FAILED', async () => {
      copyFlowMock.mockRejectedValueOnce(new FlowCopyNoSavedVersionError());
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.copy({ id: 'flow-source' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Save the flow before copying.',
      });
    });

    it('hides unexpected database details behind a generic error', async () => {
      copyFlowMock.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT secret detail'));
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.copy({ id: 'flow-source' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not copy flow',
      });
    });
  });

  describe('admission settings', () => {
    it.each([true, false])(
      'maps a pause-only update (%s) without changing capacity',
      async (paused) => {
        updateFlowAdmissionSettingsMock.mockResolvedValue({ queue_paused: paused });
        const caller = flowsRouter.createCaller({ getWindow: () => null });
        await expect(caller.updateAdmissionSettings({ queue_paused: paused })).resolves.toEqual({
          queue_paused: paused,
        });
        expect(updateFlowAdmissionSettingsMock).toHaveBeenCalledWith({ queuePaused: paused });
      },
    );

    it('preserves snake-case Flow settings and maps mutation input to the controller', async () => {
      const settings = {
        concurrency_limit_enabled: true,
        max_concurrent_runs: 4,
        occupied_runs: 3,
        queued_runs: 2,
        draining: false,
      };
      getFlowAdmissionSettingsMock.mockResolvedValue(settings);
      updateFlowAdmissionSettingsMock.mockResolvedValue({
        ...settings,
        concurrency_limit_enabled: false,
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.getAdmissionSettings()).resolves.toEqual(settings);
      await expect(
        caller.updateAdmissionSettings({
          concurrency_limit_enabled: false,
          max_concurrent_runs: 6,
        }),
      ).resolves.toMatchObject({ concurrency_limit_enabled: false });
      expect(updateFlowAdmissionSettingsMock).toHaveBeenCalledWith({
        concurrencyLimitEnabled: false,
        maxConcurrentRuns: 6,
      });
    });

    it('rejects a maximum outside 1–100 before updating config', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.updateAdmissionSettings({ max_concurrent_runs: 101 })).rejects.toThrow();
      expect(updateFlowAdmissionSettingsMock).not.toHaveBeenCalled();
    });

    it('accepts 100 and forwards only the provided setting', async () => {
      updateFlowAdmissionSettingsMock.mockResolvedValue({});
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await caller.updateAdmissionSettings({ max_concurrent_runs: 100 });

      expect(updateFlowAdmissionSettingsMock).toHaveBeenCalledWith({ maxConcurrentRuns: 100 });
    });

    it('rejects an empty update before updating config', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.updateAdmissionSettings({})).rejects.toThrow(
        'At least one admission setting is required.',
      );
      expect(updateFlowAdmissionSettingsMock).not.toHaveBeenCalled();
    });
  });

  describe('Work Queue admissions', () => {
    it('kicks a stalled drain on every poll without waiting on it', async () => {
      queuedFlowAdmissionsMock.mockReturnValueOnce([]);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.workQueueAdmissions()).resolves.toEqual([]);
      expect(kickStalledFlowAdmissionDrainMock).toHaveBeenCalledOnce();
    });

    it('returns only the authenticated user projection with the raw Flow DTO contract', async () => {
      queuedFlowAdmissionsMock.mockReturnValueOnce([
        {
          batchId: null,
          flowName: 'Release checks',
          priorityClass: 'start',
          projectName: 'Frink',
          ticket: 12,
          triggerContext: { source: 'shortcut', fullContent: { primary_id: 7 } },
        },
        {
          batchId: 'batch-9',
          flowName: 'Migrate repo',
          priorityClass: 'start',
          projectName: 'Frink',
          ticket: 13,
          triggerContext: null,
        },
      ]);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.workQueueAdmissions()).resolves.toEqual([
        {
          flow_name: 'Release checks',
          is_batch_member: false,
          priority_class: 'start',
          project_name: 'Frink',
          ticket: 12,
          trigger_context: { source: 'shortcut', fullContent: { primary_id: 7 } },
        },
        {
          flow_name: 'Migrate repo',
          is_batch_member: true,
          priority_class: 'start',
          project_name: 'Frink',
          ticket: 13,
          trigger_context: null,
        },
      ]);
      expect(queuedFlowAdmissionsMock).toHaveBeenCalledWith(expect.anything());
    });

    it('validates tickets and passes authenticated ownership to the serialized mutation', async () => {
      moveQueuedFlowAdmissionMock.mockResolvedValueOnce({ status: 'moved' });
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(
        caller.moveWorkQueueAdmission({ ticket: 12, target_ticket: 14 }),
      ).resolves.toEqual({ status: 'moved' });
      expect(moveQueuedFlowAdmissionMock).toHaveBeenCalledWith(12, 14);
      await expect(
        caller.moveWorkQueueAdmission({ ticket: 0, target_ticket: 14 }),
      ).rejects.toThrow();
    });

    it('removes a queued ticket as a dequeue rather than a plain run cancel', async () => {
      queuedAdmissionRunMock.mockReturnValueOnce({ flowRunId: 'run-12' });
      cancelFlowRunMock.mockResolvedValueOnce({ id: 'run-12', status: 'cancelled' });
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.cancelWorkQueueAdmission({ ticket: 12 })).resolves.toEqual({
        status: 'removed',
      });
      expect(queuedAdmissionRunMock).toHaveBeenCalledWith(expect.anything(), 12);
      expect(cancelFlowRunMock).toHaveBeenCalledWith('run-12', {
        queuedOnly: { ticket: 12 },
      });
      await expect(caller.cancelWorkQueueAdmission({ ticket: 0 })).rejects.toThrow();
    });

    it("reports stale without cancelling when the ticket is no longer this user's queued work", async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.cancelWorkQueueAdmission({ ticket: 12 })).resolves.toEqual({
        status: 'stale',
      });
      expect(cancelFlowRunMock).not.toHaveBeenCalled();
    });

    it('reports stale when the admission was claimed before the engine could dequeue it', async () => {
      queuedAdmissionRunMock.mockReturnValueOnce({ flowRunId: 'run-12' });
      cancelFlowRunMock.mockResolvedValueOnce(null);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.cancelWorkQueueAdmission({ ticket: 12 })).resolves.toEqual({
        status: 'stale',
      });
    });
  });

  describe('saveVersion', () => {
    it('maps FlowVersionConflictError to TRPC CONFLICT', async () => {
      createFlowVersionMock.mockRejectedValueOnce(new FlowVersionConflictError('flow-1', 0, 3));
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.saveVersion({
          flowId: '550e8400-e29b-41d4-a716-446655440000',
          graph: {
            nodes: [
              { id: 'a', blockType: 'manual_trigger' },
              { id: 'b', blockType: 'agent', config: { instructions: 'step' } },
            ],
            edges: [{ id: 'e-ab', source: 'a', target: 'b' }],
          },
          expectedVersionNumber: 0,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('sets TRPCError cause to the FlowVersionConflictError', async () => {
      const conflict = new FlowVersionConflictError('flow-1', 0, 3);
      createFlowVersionMock.mockRejectedValueOnce(conflict);
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.saveVersion({
          flowId: '550e8400-e29b-41d4-a716-446655440000',
          graph: {
            nodes: [{ id: 'a', blockType: 'manual_trigger' }],
            edges: [],
          },
          expectedVersionNumber: 0,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof TRPCError && err.code === 'CONFLICT' && err.cause === conflict;
      });
    });

    it('re-throws non-conflict exceptions unchanged', async () => {
      createFlowVersionMock.mockRejectedValueOnce(new Error('disk full'));
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.saveVersion({
          flowId: '550e8400-e29b-41d4-a716-446655440000',
          graph: { nodes: [{ id: 'a', blockType: 'manual_trigger' }], edges: [] },
        }),
      ).rejects.toThrow('disk full');
    });

    it('passes graph settings through to createFlowVersion without stripping', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440000';
      const projectId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      createFlowVersionMock.mockResolvedValueOnce({
        id: 'v1',
        flowId,
        versionNumber: 1,
        graph: {},
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await caller.saveVersion({
        flowId,
        graph: {
          nodes: [{ id: 'a', blockType: 'manual_trigger' }],
          edges: [],
          settings: {
            defaultModel: 'claude-sonnet-4-5',
            defaultProjectId: projectId,
          },
        },
      });
      expect(createFlowVersionMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          flowId,
          graph: expect.objectContaining({
            settings: {
              defaultModel: 'claude-sonnet-4-5',
              defaultProjectId: projectId,
            },
          }),
        }),
      );
    });
  });

  describe('list', () => {
    it('resolves to adapted flow rows when authenticated', async () => {
      listFlowsMock.mockResolvedValueOnce([
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          projectId: null,
          name: 'Alpha',
          description: null,
          isActive: true,
          isEnabled: true,
          agentInvocable: false,
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      ]);
      getLatestVersionMock.mockResolvedValueOnce({
        graph: { nodes: [{ blockType: 'manual_trigger' }, { blockType: 'agent' }] },
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      const result = await caller.list();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'Alpha',
        node_count: 2,
        trigger_type: 'manual_trigger',
        // No active run for this flow → indicator fields null (default empty map).
        latest_run_id: null,
        latest_run_status: null,
        latest_run_active_task_status: null,
        latest_run_admission_state: null,
        latest_run_queue_position: null,
        latest_run_admission_requested_at: null,
      });
      expect(listFlowsMock).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it('enriches each flow with its latest active run (running indicator)', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440001';
      listFlowsMock.mockResolvedValueOnce([
        {
          id: flowId,
          projectId: null,
          name: 'Alpha',
          description: null,
          isActive: true,
          isEnabled: true,
          agentInvocable: false,
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      ]);
      getLatestVersionMock.mockResolvedValueOnce({
        graph: { nodes: [{ blockType: 'manual_trigger' }] },
      });
      // Paused-but-working run (engine parks at `paused` during an async agent hand-off): the
      // active driving-task status threads through so the renderer can relabel it "Running".
      getLatestRunsForFlowsMock.mockResolvedValueOnce(
        new Map([[flowId, { id: 'run-1', status: 'paused', activeTaskStatus: 'running' }]]),
      );
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            'run-1',
            {
              runStatus: 'paused',
              admission: {
                admissionState: 'active',
                queuePosition: null,
                requestedAt: new Date('2026-08-01T10:00:00Z'),
              },
            },
          ],
        ]),
      );
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      const result = await caller.list();
      expect(result[0]).toMatchObject({
        id: flowId,
        latest_run_id: 'run-1',
        latest_run_status: 'paused',
        latest_run_active_task_status: 'running',
        latest_run_admission_state: 'active',
        latest_run_queue_position: null,
        latest_run_admission_requested_at: '2026-08-01T10:00:00.000Z',
      });
      expect(getLatestRunsForFlowsMock).toHaveBeenCalledWith(expect.anything(), [flowId]);
      expect(flowRunAdmissionSnapshotsForRunsMock).toHaveBeenCalledWith(expect.anything(), [
        'run-1',
      ]);
    });

    it('surfaces a queued terminal resume only when no active run exists', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440001';
      const flowRows = [
        {
          id: flowId,
          projectId: null,
          name: 'Alpha',
          description: null,
          isActive: true,
          isEnabled: true,
          agentInvocable: false,
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      ];
      listFlowsMock.mockResolvedValueOnce(flowRows);
      queuedRunsForFlowsMock.mockReturnValueOnce(
        new Map([[flowId, { id: 'run-resume', status: 'cancelled', activeTaskStatus: null }]]),
      );
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            'run-resume',
            {
              runStatus: 'cancelled',
              admission: {
                admissionState: 'queued',
                queuePosition: 1,
                requestedAt: new Date('2026-08-01T10:00:00Z'),
              },
            },
          ],
        ]),
      );

      await expect(flowsRouter.createCaller({ getWindow: () => null }).list()).resolves.toEqual([
        expect.objectContaining({
          latest_run_id: 'run-resume',
          latest_run_status: 'cancelled',
          latest_run_admission_state: 'queued',
          latest_run_queue_position: 1,
        }),
      ]);

      getLatestRunsForFlowsMock.mockResolvedValueOnce(
        new Map([[flowId, { id: 'run-active', status: 'running', activeTaskStatus: null }]]),
      );
      queuedRunsForFlowsMock.mockReturnValueOnce(
        new Map([[flowId, { id: 'run-resume', status: 'cancelled', activeTaskStatus: null }]]),
      );
      listFlowsMock.mockResolvedValueOnce(flowRows);

      await expect(flowsRouter.createCaller({ getWindow: () => null }).list()).resolves.toEqual([
        expect.objectContaining({ latest_run_id: 'run-active', latest_run_status: 'running' }),
      ]);
    });
  });

  describe('listRuns', () => {
    it('returns snake-case admission visibility for each run', async () => {
      const createdAt = new Date('2026-08-01T09:00:00Z');
      listFlowRunsForFlowMock.mockResolvedValueOnce([
        {
          id: 'run-1',
          flowVersionId: 'version-1',
          status: 'pending',
          triggerContext: null,
          idempotencyKey: null,
          batchId: null,
          startedAt: null,
          completedAt: null,
          createdAt,
        },
      ]);
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            'run-1',
            {
              runStatus: 'pending',
              admission: {
                admissionState: 'queued',
                queuePosition: 3,
                requestedAt: new Date('2026-08-01T10:00:00Z'),
              },
            },
          ],
        ]),
      );
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.listRuns({ flowId: 'flow-1' })).resolves.toEqual([
        expect.objectContaining({
          id: 'run-1',
          admission_state: 'queued',
          queue_position: 3,
          admission_requested_at: '2026-08-01T10:00:00.000Z',
        }),
      ]);
      expect(flowRunAdmissionSnapshotsForRunsMock).toHaveBeenCalledWith(expect.anything(), [
        'run-1',
      ]);
    });
  });

  describe('startRun', () => {
    it('returns queued admission metadata from the canonical visibility snapshot', async () => {
      const run = {
        id: 'run-queued',
        flowVersionId: 'version-1',
        status: 'pending',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-08-01T10:00:00Z'),
      };
      startFlowRunMock.mockResolvedValueOnce({
        run,
        version: { versionNumber: 5 },
        isReplay: false,
      });
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            run.id,
            {
              runStatus: 'pending',
              startedAt: null,
              completedAt: null,
              admission: {
                admissionState: 'queued',
                queuePosition: 3,
                requestedAt: new Date('2026-08-01T10:00:00Z'),
              },
            },
          ],
        ]),
      );

      await expect(
        flowsRouter.createCaller({ getWindow: () => null }).startRun({ flowId: 'flow-1' }),
      ).resolves.toMatchObject({
        id: run.id,
        status: 'pending',
        admission_state: 'queued',
        queue_position: 3,
        admission_requested_at: '2026-08-01T10:00:00.000Z',
        // The executed (saved) version, so the editor can name it when the canvas is dirty.
        version_number: 5,
      });
      expect(flowRunAdmissionSnapshotsForRunsMock).toHaveBeenCalledWith(expect.anything(), [
        run.id,
      ]);
    });

    it('rejects a run cancelled before admission instead of reporting it as started', async () => {
      const run = {
        id: 'run-cancelled',
        flowVersionId: 'version-1',
        status: 'pending',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-08-01T10:00:00Z'),
      };
      startFlowRunMock.mockResolvedValueOnce({
        run,
        version: { versionNumber: 5 },
        isReplay: false,
      });
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            run.id,
            {
              runStatus: 'cancelled',
              startedAt: null,
              completedAt: new Date('2026-08-01T10:00:01Z'),
              admission: null,
            },
          ],
        ]),
      );

      await expect(
        flowsRouter.createCaller({ getWindow: () => null }).startRun({ flowId: 'flow-1' }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Flow run did not start (cancelled).',
      });
    });
  });

  describe('getRun', () => {
    // Recovery resolution reads the restart marker and step tasks from a real, empty database.
    beforeEach(() => {
      vi.mocked(getDatabase).mockReturnValueOnce(freshDb());
    });

    it('returns admission visibility for selected queued details', async () => {
      const run = {
        id: 'run-1',
        flowVersionId: 'version-1',
        status: 'cancelled',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: new Date('2026-08-01T09:00:00Z'),
        completedAt: new Date('2026-08-01T09:05:00Z'),
        createdAt: new Date('2026-08-01T09:00:00Z'),
      };
      getFlowRunWithNodeRunsMock.mockResolvedValueOnce({ run, nodeRuns: [] });
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            run.id,
            {
              runStatus: 'cancelled',
              admission: {
                admissionState: 'queued',
                queuePosition: 2,
                requestedAt: new Date('2026-08-01T10:00:00Z'),
              },
            },
          ],
        ]),
      );

      await expect(
        flowsRouter.createCaller({ getWindow: () => null }).getRun({ runId: run.id }),
      ).resolves.toMatchObject({
        admission_state: 'queued',
        queue_position: 2,
        admission_requested_at: '2026-08-01T10:00:00.000Z',
      });
    });

    it('returns run status and admission from the same visibility snapshot', async () => {
      const run = {
        id: 'run-1',
        flowVersionId: 'version-1',
        status: 'cancelled',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: new Date('2026-08-01T09:00:00Z'),
        completedAt: new Date('2026-08-01T09:05:00Z'),
        createdAt: new Date('2026-08-01T09:00:00Z'),
      };
      getFlowRunWithNodeRunsMock.mockResolvedValueOnce({ run, nodeRuns: [] });
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([
          [
            run.id,
            {
              runStatus: 'running',
              admission: {
                admissionState: 'active',
                queuePosition: null,
                requestedAt: new Date('2026-08-01T10:00:00Z'),
              },
            },
          ],
        ]),
      );

      await expect(
        flowsRouter.createCaller({ getWindow: () => null }).getRun({ runId: run.id }),
      ).resolves.toMatchObject({ status: 'running', admission_state: 'active' });
    });

    it("carries the run's recovery actions, resolved against its visible status", async () => {
      const run = {
        id: 'run-1',
        flowVersionId: 'version-1',
        status: 'running',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-08-01T09:00:00Z'),
      };
      // A started non-agent step with no session to continue: Retry, behind a side-effects check.
      const nodeRuns = [
        { id: 'nr-1', blockType: 'run_command', status: 'awaiting_input', startedAt: new Date() },
      ];
      getFlowRunWithNodeRunsMock.mockResolvedValueOnce({ run, nodeRuns });
      flowRunAdmissionSnapshotsForRunsMock.mockReturnValueOnce(
        new Map([[run.id, { runStatus: 'paused', admission: null }]]),
      );

      await expect(
        flowsRouter.createCaller({ getWindow: () => null }).getRun({ runId: run.id }),
      ).resolves.toMatchObject({
        recoveries: [{ nodeRunId: 'nr-1', kind: 'retry', confirmSideEffects: true }],
      });
      // The steps getRun already read are reused, not queried a second time.
      expect(listNodeRunsForFlowRunMock).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    const flowId = '550e8400-e29b-41d4-a716-446655440000';

    it('resolves to adapted flow-with-version when found', async () => {
      getFlowByIdMock.mockResolvedValueOnce({
        id: flowId,
        projectId: null,
        name: 'Beta',
        description: 'd',
        isActive: true,
        isEnabled: true,
        agentInvocable: false,
        createdAt: new Date('2024-01-02T00:00:00.000Z'),
        updatedAt: new Date('2024-01-02T00:00:00.000Z'),
      });
      getLatestVersionMock.mockResolvedValueOnce({
        id: '550e8400-e29b-41d4-a716-446655440099',
        versionNumber: 1,
        graph: { nodes: [], edges: [] },
        createdAt: new Date('2024-01-02T01:00:00.000Z'),
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      const result = await caller.get({ id: flowId });
      expect(result).toMatchObject({
        id: flowId,
        name: 'Beta',
        latest_version_id: '550e8400-e29b-41d4-a716-446655440099',
        version_number: 1,
      });
      expect(getFlowByIdMock).toHaveBeenCalledWith(expect.anything(), flowId);
    });

    it('throws NOT_FOUND when the flow does not exist', async () => {
      getFlowByIdMock.mockResolvedValueOnce(null);
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.get({ id: flowId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('createStash', () => {
    const stashInput = {
      name: 'Epic stash',
      content: 'Briefing body',
      sourceFlowId: null as string | null,
      sourceFlowName: null as string | null,
    };

    it('returns the adapted briefing stash on success', async () => {
      createBriefingStashMock.mockResolvedValueOnce({
        id: '550e8400-e29b-41d4-a716-4466554400aa',
        name: 'Epic stash',
        content: 'Briefing body',
        sourceFlowId: null,
        sourceFlowName: null,
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.createStash(stashInput)).resolves.toMatchObject({
        id: '550e8400-e29b-41d4-a716-4466554400aa',
        name: 'Epic stash',
        content: 'Briefing body',
      });
      expect(createBriefingStashMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: stashInput.name,
          content: stashInput.content,
          sourceFlowId: null,
          sourceFlowName: null,
        }),
      );
    });

    it('re-throws repo exceptions', async () => {
      createBriefingStashMock.mockRejectedValueOnce(new Error('disk failure'));
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.createStash(stashInput)).rejects.toThrow('disk failure');
    });
  });

  describe('cancelRun', () => {
    const runId = '550e8400-e29b-41d4-a716-446655440010';

    it('returns the adapted run detail when found', async () => {
      cancelFlowRunMock.mockResolvedValueOnce({
        id: runId,
        flowVersionId: '550e8400-e29b-41d4-a716-446655440011',
        status: 'cancelled',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        completedAt: new Date('2024-01-01T00:01:00.000Z'),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      const result = await caller.cancelRun({ runId });
      expect(result).toMatchObject({ id: runId, status: 'cancelled', nodeRuns: [] });
      expect(cancelFlowRunMock).toHaveBeenCalledWith(runId);
    });

    it('throws NOT_FOUND when run does not exist', async () => {
      cancelFlowRunMock.mockResolvedValueOnce(null);
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.cancelRun({ runId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('re-throws engine exceptions', async () => {
      cancelFlowRunMock.mockRejectedValueOnce(new Error('engine failure'));
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.cancelRun({ runId })).rejects.toThrow('engine failure');
    });
  });

  describe('resumeRun', () => {
    const runId = '550e8400-e29b-41d4-a716-446655440030';
    const input = { runId, action: 'retry', nodeRunId: 'nr-1', kind: 'continue' } as const;

    it('forwards the displayed recovery kind and returns the refreshed run', async () => {
      const run = {
        id: runId,
        flowVersionId: '550e8400-e29b-41d4-a716-446655440031',
        status: 'running',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        completedAt: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      getFlowRunWithNodeRunsMock.mockResolvedValueOnce({ run, nodeRuns: [] });
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.resumeRun(input)).resolves.toMatchObject({
        id: runId,
        status: 'running',
        nodeRuns: [],
      });
      expect(resumeFlowRunMock).toHaveBeenCalledWith(runId, 'retry', 'nr-1', undefined, 'continue');
      expect(getVersionMock).toHaveBeenCalledWith(expect.anything(), run.flowVersionId);
    });

    it('throws NOT_FOUND when the run vanished after resuming', async () => {
      getFlowRunWithNodeRunsMock.mockResolvedValueOnce(null);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.resumeRun(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('passes a PRECONDITION_FAILED refusal through unchanged', async () => {
      const refusal = new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Step moved on' });
      resumeFlowRunMock.mockRejectedValueOnce(refusal);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.resumeRun(input)).rejects.toBe(refusal);
      expect(getFlowRunWithNodeRunsMock).not.toHaveBeenCalled();
    });
  });

  describe('retryRunFromLastNode', () => {
    it('maps terminal admission rejection to PRECONDITION_FAILED', async () => {
      const runId = '550e8400-e29b-41d4-a716-446655440020';
      getFlowRunMock.mockResolvedValueOnce({
        id: runId,
        flowVersionId: '550e8400-e29b-41d4-a716-446655440021',
        status: 'failed',
        triggerContext: null,
        idempotencyKey: null,
        batchId: null,
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        completedAt: new Date('2024-01-01T00:01:00.000Z'),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      retryTerminalFlowRunMock.mockRejectedValueOnce(
        new TerminalResumeAdmissionError('resume admission was cancelled'),
      );
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.retryRunFromLastNode({ runId, kind: 'retry' })).rejects.toMatchObject({
        name: 'TRPCError',
        code: 'PRECONDITION_FAILED',
        message: 'Flow retry could not be admitted: resume admission was cancelled',
      });
      expect(retryTerminalFlowRunMock).toHaveBeenCalledWith(expect.anything(), runId, 'retry');
    });

    it("surfaces a deleted chat's refusal in plain words, without the admission prefix", async () => {
      const runId = '550e8400-e29b-41d4-a716-446655440024';
      getFlowRunMock.mockResolvedValueOnce({ id: runId, status: 'failed' });
      retryTerminalFlowRunMock.mockRejectedValueOnce(new TerminalResumeChatDeletedError());
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.retryRunFromLastNode({ runId, kind: 'retry' })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof TRPCError &&
          error.code === 'PRECONDITION_FAILED' &&
          error.message === "This run's chat was deleted — start the flow again to re-run it.",
      );
    });

    it('re-throws unexpected retry faults instead of masking them as admission rejection', async () => {
      const runId = '550e8400-e29b-41d4-a716-446655440022';
      getFlowRunMock.mockResolvedValueOnce({ id: runId, status: 'failed' });
      const fault = new TypeError('unexpected retry bug');
      retryTerminalFlowRunMock.mockRejectedValueOnce(fault);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.retryRunFromLastNode({ runId, kind: 'retry' })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof TRPCError &&
          error.code === 'INTERNAL_SERVER_ERROR' &&
          error.cause === fault,
      );
    });

    it('reaches retrySettledFlowRun for a batch member — no router-level batch block', async () => {
      const runId = '550e8400-e29b-41d4-a716-446655440023';
      getFlowRunMock.mockResolvedValueOnce({
        id: runId,
        flowVersionId: '550e8400-e29b-41d4-a716-446655440021',
        userId: 'user-1',
        status: 'failed',
        triggerContext: null,
        idempotencyKey: null,
        batchId: 'batch-1',
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        completedAt: new Date('2024-01-01T00:01:00.000Z'),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      retryTerminalFlowRunMock.mockResolvedValueOnce(true);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      await expect(caller.retryRunFromLastNode({ runId, kind: 'retry' })).resolves.toEqual({
        ok: true,
      });
      expect(retryTerminalFlowRunMock).toHaveBeenCalledWith(expect.anything(), runId, 'retry');
    });
  });

  describe('pauseRun', () => {
    const subChatId = 'sub-pause-1';

    it('parks FIRST, then aborts the in-flight turn (ordering is the split-brain guard)', async () => {
      const order: string[] = [];
      parkFlowTaskForSubChatMock.mockImplementationOnce(async () => {
        order.push('park');
        return 'task-1';
      });
      pauseActiveExecutionForSubChatMock.mockImplementationOnce(() => {
        order.push('abort');
        return true;
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      const result = await caller.pauseRun({ subChatId });

      expect(result).toEqual({ paused: true });
      expect(order).toEqual(['park', 'abort']);
      expect(parkFlowTaskForSubChatMock).toHaveBeenCalledWith(expect.anything(), subChatId, {
        kind: 'user-pause',
      });
    });

    it('returns paused:false and never aborts when nothing was parked (batch member / no running task)', async () => {
      parkFlowTaskForSubChatMock.mockResolvedValueOnce(null);
      const caller = flowsRouter.createCaller({ getWindow: () => null });

      expect(await caller.pauseRun({ subChatId })).toEqual({ paused: false });
      expect(pauseActiveExecutionForSubChatMock).not.toHaveBeenCalled();
    });
  });

  describe('getBriefings', () => {
    const projectId = '550e8400-e29b-41d4-a716-446655440099';

    it('returns an empty array (cross-machine briefings deferred)', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.getBriefings({ projectId })).resolves.toEqual([]);
    });

    it('returns an empty array when called with no input', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.getBriefings()).resolves.toEqual([]);
    });
  });

  describe('createBatchPlanTemplate', () => {
    it('rejects when dependsOn references a stageNumber not present in the same stages array', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.createBatchPlanTemplate({
          name: 'My template',
          stages: [
            { stageNumber: 1, name: 'A', dependsOn: [] },
            { stageNumber: 2, name: 'B', dependsOn: [99] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(createBatchPlanTemplateMock).not.toHaveBeenCalled();
    });

    it('calls createBatchPlanTemplate when every dependsOn references an existing stageNumber', async () => {
      createBatchPlanTemplateMock.mockResolvedValueOnce({
        id: '550e8400-e29b-41d4-a716-446655440099',
        name: 'DAG',
        stages: [],
        schemaVersion: 1,
        sourceFlowId: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      const stages = [
        { stageNumber: 1, name: 'Planning', dependsOn: [] as number[] },
        { stageNumber: 2, name: 'Build', dependsOn: [1] },
      ];
      await caller.createBatchPlanTemplate({ name: 'DAG', stages });
      expect(createBatchPlanTemplateMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: 'DAG', stages, sourceFlowId: null }),
      );
    });

    it('rejects duplicate stageNumber values', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.createBatchPlanTemplate({
          name: 'Dup',
          stages: [
            { stageNumber: 1, name: 'A', dependsOn: [] },
            { stageNumber: 1, name: 'B', dependsOn: [] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(createBatchPlanTemplateMock).not.toHaveBeenCalled();
    });

    it('rejects cyclic dependsOn', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.createBatchPlanTemplate({
          name: 'Cycle',
          stages: [
            { stageNumber: 1, name: 'A', dependsOn: [2] },
            { stageNumber: 2, name: 'B', dependsOn: [1] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(createBatchPlanTemplateMock).not.toHaveBeenCalled();
    });

    it('attaches DAG validation failure to stages[N] when validateDag provides invalidIndex', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      try {
        await caller.createBatchPlanTemplate({
          name: 'Bad ref',
          stages: [
            { stageNumber: 1, name: 'A', dependsOn: [] },
            { stageNumber: 2, name: 'B', dependsOn: [99] },
          ],
        });
        expect.fail('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).cause).toBeInstanceOf(ZodError);
        const issues = ((e as TRPCError).cause as ZodError).issues;
        expect(issues[0]?.path).toEqual(['stages', 1]);
      }
      expect(createBatchPlanTemplateMock).not.toHaveBeenCalled();
    });

    it('attaches cyclic DAG failure to stages root path when no specific stage index', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      try {
        await caller.createBatchPlanTemplate({
          name: 'Cycle path',
          stages: [
            { stageNumber: 1, name: 'A', dependsOn: [2] },
            { stageNumber: 2, name: 'B', dependsOn: [1] },
          ],
        });
        expect.fail('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).cause).toBeInstanceOf(ZodError);
        const issues = ((e as TRPCError).cause as ZodError).issues;
        expect(issues[0]?.path).toEqual(['stages']);
      }
    });

    it('attaches self-dependency failure to stages[0] for a single-stage graph', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      try {
        await caller.createBatchPlanTemplate({
          name: 'Self',
          stages: [{ stageNumber: 3, name: 'A', dependsOn: [3] }],
        });
        expect.fail('expected rejection');
      } catch (e) {
        expect((e as TRPCError).cause).toBeInstanceOf(ZodError);
        expect(((e as TRPCError).cause as ZodError).issues[0]?.path).toEqual(['stages', 0]);
      }
    });
  });

  describe('updateStageRun attachments input validation', () => {
    const FLOW_ID = '550e8400-e29b-41d4-a716-446655440001';
    const RUN_ID = '660e8400-e29b-41d4-a716-446655440002';

    it('accepts an empty attachments array', async () => {
      updateStageRunLocalMock.mockResolvedValueOnce({ run: { id: RUN_ID, trigger_context: {} } });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await caller.updateStageRun({ flowId: FLOW_ID, runId: RUN_ID, attachments: [] });
      expect(updateStageRunLocalMock).toHaveBeenCalledOnce();
    });

    it('accepts a valid attachments array with type string', async () => {
      updateStageRunLocalMock.mockResolvedValueOnce({ run: { id: RUN_ID, trigger_context: {} } });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await caller.updateStageRun({
        flowId: FLOW_ID,
        runId: RUN_ID,
        attachments: [
          { url: 'https://cdn.example.com/img.png', type: 'image/png' },
          { url: 'https://cdn.example.com/shot.webp', type: 'image/webp', label: 'After' },
        ],
      });
      expect(updateStageRunLocalMock).toHaveBeenCalledOnce();
    });

    it('rejects attachments where type is an empty string', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      try {
        await caller.updateStageRun({
          flowId: FLOW_ID,
          runId: RUN_ID,
          attachments: [{ url: 'https://cdn.example.com/img.png', type: '' }],
        });
        expect.fail('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).cause).toBeInstanceOf(ZodError);
      }
    });

    it('rejects when url is empty', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      try {
        await caller.updateStageRun({
          flowId: FLOW_ID,
          runId: RUN_ID,
          attachments: [{ url: '', type: 'image' }],
        });
        expect.fail('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).cause).toBeInstanceOf(ZodError);
      }
    });

    it('rejects when more than 10 attachments provided', async () => {
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      const attachments = Array.from({ length: 11 }, (_, i) => ({
        url: `https://cdn.example.com/img${i}.png`,
        type: 'image',
      }));
      try {
        await caller.updateStageRun({ flowId: FLOW_ID, runId: RUN_ID, attachments });
        expect.fail('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError);
        expect((e as TRPCError).cause).toBeInstanceOf(ZodError);
      }
    });
  });

  describe('uploadAndAttachImage', () => {
    const FLOW_ID = '550e8400-e29b-41d4-a716-446655440000';
    const RUN_ID = '550e8400-e29b-41d4-a716-446655440001';

    it('returns the upload result on success', async () => {
      const uploadResult = {
        url: 'frink-attachment://run/upload.png',
        filename: 'upload.png',
        run: { id: RUN_ID, trigger_context: {} },
      };
      uploadAttachmentToStageRunMock.mockResolvedValueOnce(uploadResult);
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      // Flows router opts out of caseConvertOutput (publicProcedureRaw): output stays
      // snake_case to match the DbFlow* DTO contract the renderer consumes.
      await expect(
        caller.uploadAndAttachImage({
          flowId: FLOW_ID,
          runId: RUN_ID,
          data: 'abc',
          filename: 'test.png',
          mimeType: 'image/png',
        }),
      ).resolves.toEqual({
        url: 'frink-attachment://run/upload.png',
        filename: 'upload.png',
        run: { id: RUN_ID, trigger_context: {} },
      });
    });

    it('re-throws upload exceptions', async () => {
      uploadAttachmentToStageRunMock.mockRejectedValueOnce(new Error('upload failed'));
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.uploadAndAttachImage({
          flowId: FLOW_ID,
          runId: RUN_ID,
          data: 'abc',
          filename: 'test.png',
          mimeType: 'image/png',
        }),
      ).rejects.toThrow('upload failed');
    });
  });

  describe('fetchAttachmentDataUrl', () => {
    const ATTACHMENT_URL = 'frink-attachment://run-1/file.png';

    it('returns { dataUrl } when the resolver succeeds', async () => {
      resolveAttachmentToDataUrlMock.mockResolvedValueOnce({
        ok: true,
        dataUrl: 'data:image/png;base64,QQ==',
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.fetchAttachmentDataUrl({ url: ATTACHMENT_URL })).resolves.toEqual({
        dataUrl: 'data:image/png;base64,QQ==',
      });
      expect(resolveAttachmentToDataUrlMock).toHaveBeenCalledWith(ATTACHMENT_URL);
    });

    it('throws NOT_FOUND when the resolver reports failure (e.g. unsupported protocol)', async () => {
      resolveAttachmentToDataUrlMock.mockResolvedValueOnce({
        ok: false,
        message: 'Unsupported protocol https:',
      });
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(
        caller.fetchAttachmentDataUrl({ url: 'https://api.example.com/file.png' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Unsupported protocol https:' });
    });

    it('propagates errors thrown by the resolver', async () => {
      resolveAttachmentToDataUrlMock.mockRejectedValueOnce(new Error('read failed'));
      const caller = flowsRouter.createCaller({ getWindow: () => null });
      await expect(caller.fetchAttachmentDataUrl({ url: ATTACHMENT_URL })).rejects.toThrow(
        'read failed',
      );
    });
  });

  // interruptedRunForChat is a thin delegation to describeInterruptedRunForChat; its behaviour is
  // covered against a real db in flows/resume-mode.test.ts rather than through router mocks.
});
