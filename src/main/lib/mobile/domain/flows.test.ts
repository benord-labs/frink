import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowVersion } from '../../db/repos/flow-versions';
import { createFlow } from '../../db/repos/flows';
import { chats, flowRuns, nodeRuns, subChats, tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb } from '../../db/test-utils/fresh-db';
import type { DbNodeRun } from '../../../../shared/types/flow-run';
import { mobileRequestSchema } from '../../../../shared/types/remote/mobile';
import { flowResumeActionToken, resumeSnapshotForNode } from '../../flows/rerun/resume-snapshot';
const fixture = vi.hoisted(() => ({
  db: null as unknown,
  getRun: vi.fn(),
  getFlow: vi.fn(),
  list: vi.fn(),
  listRuns: vi.fn(),
  getVersion: vi.fn(),
  resumeRun: vi.fn(),
  getDriving: vi.fn(),
  getLink: vi.fn(),
  ready: vi.fn(),
  getSubChat: vi.fn(),
}));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireExecutionReady: fixture.ready,
  mobileCallers: {
    flows: {
      getRun: fixture.getRun,
      get: fixture.getFlow,
      list: fixture.list,
      listRuns: fixture.listRuns,
      resumeRun: fixture.resumeRun,
    },
    tasks: {
      getFlowChatForNodeRun: fixture.getLink,
      getDrivingTaskForSubChat: fixture.getDriving,
    },
  },
  record: (value: unknown) => (value && typeof value === 'object' ? value : {}),
  text: (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback),
}));
vi.mock('../../db', () => ({ getDatabase: () => fixture.db }));
vi.mock('../../db/repos/flow-versions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/repos/flow-versions')>()),
  getVersion: fixture.getVersion,
}));
vi.mock('../../db/repos/sub-chats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/repos/sub-chats')>()),
  getSubChatById: fixture.getSubChat,
}));
import { readMobileFlow, readMobileFlows, readMobileRun, resumeMobileNode } from './flows';

const request = {
  type: 'resumeNode' as const,
  runId: 'run',
  nodeRunId: 'node',
  action: 'approve' as const,
  actionToken: '',
};
const node = {
  id: 'node',
  block_type: 'agent',
  status: 'awaiting_input',
  node_output: {},
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.getRun.mockResolvedValue({
    id: 'run',
    status: 'paused',
    nodeRuns: [node],
  });
  fixture.getLink.mockResolvedValue({ chatId: 'chat', subChatId: 'sub' });
  fixture.getDriving.mockResolvedValue({
    task: {
      id: 'task',
      flowRunId: 'run',
      nodeRunId: 'node',
      status: 'plan_ready',
    },
  });
  fixture.getSubChat.mockResolvedValue({
    mode: 'plan',
    messages: [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: { status: 'awaiting_approval', planText: 'Reviewable plan' },
          },
        ],
      },
    ],
  });
  request.actionToken = flowResumeActionToken(
    resumeSnapshotForNode(
      node as DbNodeRun,
      [node as DbNodeRun],
      { id: 'task', status: 'plan_ready', result: null },
      {
        subChatId: 'sub',
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool-frink-plan',
                input: { status: 'awaiting_approval', planText: 'Reviewable plan' },
              },
            ],
          },
        ],
      },
    ),
  );
});

describe('mobile Flow actions', () => {
  it('reads the current saved definition separately from its historical runs', async () => {
    fixture.db = freshDb();
    fixture.getFlow.mockResolvedValue({
      id: 'flow',
      name: 'Updated Flow',
      is_enabled: true,
      version_number: 3,
      graph: {
        nodes: [
          { id: 'start', blockType: 'manual_trigger' },
          { id: 'current', blockType: 'agent', config: { instructions: 'Current instructions' } },
        ],
        edges: [{ id: 'next', source: 'start', target: 'current' }],
      },
    });
    const olderRun = {
      id: 'older-run',
      status: 'completed',
      created_at: '2026-09-28T07:59:00Z',
      started_at: '2026-09-28T08:00:00Z',
      completed_at: '2026-09-28T08:04:00Z',
    };
    fixture.listRuns.mockResolvedValue([olderRun]);
    await expect(readMobileFlow({ id: 'flow' })).resolves.toMatchObject({
      definition: {
        versionNumber: 3,
        nodes: [{ id: 'start' }, { id: 'current', instructions: 'Current instructions' }],
        edges: [{ id: 'next', source: 'start', target: 'current' }],
      },
      runs: {
        items: [
          {
            id: 'older-run',
            status: 'completed',
            createdAt: '2026-09-28T07:59:00Z',
            startedAt: '2026-09-28T08:00:00Z',
            completedAt: '2026-09-28T08:04:00Z',
          },
        ],
        hasMore: false,
      },
    });
    expect(fixture.getVersion).not.toHaveBeenCalled();
    expect(fixture.listRuns).toHaveBeenCalledWith({ flowId: 'flow', limit: 21 });
  });

  it('windows runs by runLimit, fetching one extra row to report more', async () => {
    fixture.db = freshDb();
    fixture.getFlow.mockResolvedValue({ id: 'flow', graph: null });
    fixture.listRuns.mockResolvedValue(
      ['run-3', 'run-2', 'run-1'].map((id) => ({ id, status: 'completed', created_at: 'at' })),
    );
    const result = await readMobileFlow({ id: 'flow', runLimit: 2 });
    expect(fixture.listRuns).toHaveBeenLastCalledWith({ flowId: 'flow', limit: 3 });
    expect(result.runs.items.map((run) => run.id)).toEqual(['run-3', 'run-2']);
    expect(result.runs.hasMore).toBe(true);
    await readMobileFlow({ id: 'flow', runLimit: 100 });
    expect(fixture.listRuns).toHaveBeenLastCalledWith({ flowId: 'flow', limit: 100 });
  });

  it('rejects mobile retry requests while accepting approval and skip', () => {
    expect(mobileRequestSchema.safeParse({ ...request, action: 'retry' }).success).toBe(false);
    expect(mobileRequestSchema.safeParse(request).success).toBe(true);
    expect(mobileRequestSchema.safeParse({ ...request, action: 'skip' }).success).toBe(true);
  });
  it('approves a current plan-ready agent node through the existing resume procedure', async () => {
    await resumeMobileNode(request);
    expect(fixture.resumeRun).toHaveBeenCalledWith({
      runId: 'run',
      nodeRunId: 'node',
      action: 'approve',
      expectedSnapshot: expect.objectContaining({ status: 'awaiting_input', attemptIds: ['node'] }),
    });
  });
  it('rejects a token from an earlier plan before invoking the resume engine', async () => {
    fixture.getSubChat.mockResolvedValue({
      mode: 'plan',
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool-frink-plan',
              input: { status: 'awaiting_approval', planText: 'A different plan' },
            },
          ],
        },
      ],
    });
    await expect(resumeMobileNode(request)).rejects.toMatchObject({ status: 409 });
    expect(fixture.resumeRun).not.toHaveBeenCalled();
  });
  it('refuses an old attempt even while its original row remains awaiting input', async () => {
    fixture.getRun.mockResolvedValue({
      id: 'run',
      status: 'paused',
      nodeRuns: [node, { ...node, id: 'new-attempt' }],
    });
    await expect(resumeMobileNode(request)).rejects.toMatchObject({ status: 409 });
    expect(fixture.resumeRun).not.toHaveBeenCalled();
  });
  it('never mistakes an agent question for plan approval', async () => {
    fixture.getRun.mockResolvedValue({
      id: 'run',
      status: 'paused',
      nodeRuns: [{ ...node, node_output: { signal: 'awaiting_input' } }],
    });
    await expect(resumeMobileNode(request)).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.resumeRun).not.toHaveBeenCalled();
  });
  it('does not offer blind plan approval without the current full plan', async () => {
    fixture.getSubChat.mockResolvedValue({ mode: 'plan', messages: [] });
    await expect(resumeMobileNode(request)).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.resumeRun).not.toHaveBeenCalled();
  });
  it('rejects a stale plan driver and a settled run', async () => {
    fixture.getDriving.mockResolvedValue({
      task: { flowRunId: 'run', nodeRunId: 'next-node', status: 'plan_ready' },
    });
    await expect(resumeMobileNode(request)).rejects.toMatchObject({
      status: 409,
    });
    fixture.getRun.mockResolvedValue({
      id: 'run',
      status: 'completed',
      nodeRuns: [node],
    });
    await expect(resumeMobileNode(request)).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.resumeRun).not.toHaveBeenCalled();
  });
  it('approves a dedicated approval block but refuses skipping a genuine question', async () => {
    fixture.getRun.mockResolvedValue({
      id: 'run',
      status: 'paused',
      nodeRuns: [{ ...node, block_type: 'approval' }],
    });
    await resumeMobileNode(request);
    fixture.getRun.mockResolvedValue({
      id: 'run',
      status: 'paused',
      nodeRuns: [{ ...node, node_output: { signal: 'awaiting_input' } }],
    });
    await expect(resumeMobileNode({ ...request, action: 'skip' })).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.resumeRun).toHaveBeenCalledTimes(1);
  });
});

describe('mobile Flow projection queries', () => {
  it('batches node links and full plans while preserving newest run and task ownership', async () => {
    const db = freshDb();
    fixture.db = db;
    const seeded = await seedFlowRun(db, { nodes: [], edges: [] });
    await db.insert(chats).values({ id: 'chat' });
    const planText = 'A complete reviewable plan.\n'.repeat(1000).trim();
    const planMessages = JSON.stringify([
      {
        id: 'plan',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: { status: 'awaiting_approval', planText },
          },
        ],
      },
    ]);
    const projectedNodes = Array.from({ length: 20 }, (_, index) => ({
      ...node,
      id: `node-${index}`,
      node_id: `graph-${index}`,
      started_at: '2026-09-28T08:00:00Z',
      completed_at: null,
    }));
    for (let index = 0; index < projectedNodes.length; index++) {
      await db.insert(subChats).values({
        id: `sub-${index}`,
        chatId: 'chat',
        mode: 'plan',
        messages: planMessages,
      });
      await db.insert(nodeRuns).values({
        id: `node-${index}`,
        flowRunId: seeded.flowRunId,
        nodeId: `graph-${index}`,
        blockType: 'agent',
        status: 'awaiting_input',
      });
      await db.insert(tasks).values({
        id: `task-${index}`,
        description: 'Plan',
        source: 'flow',
        status: 'plan_ready',
        flowRunId: seeded.flowRunId,
        nodeRunId: `node-${index}`,
        result: { chatId: 'chat', subChatId: `sub-${index}` },
        createdAt: new Date(1000),
      });
    }
    // A later taskless run owns sub-0, while a later terminal task owns sub-1.
    await db.insert(flowRuns).values({
      id: 'newer-run',
      flowVersionId: seeded.versionId,
      status: 'running',
      triggerContext: { subChatId: 'sub-0' },
      createdAt: new Date(Date.now() + 1000),
    });
    await db.insert(tasks).values({
      id: 'newer-task',
      description: 'Finished',
      source: 'flow',
      status: 'done',
      flowRunId: seeded.flowRunId,
      result: { chatId: 'chat', subChatId: 'sub-1' },
      createdAt: new Date(1000),
    });
    fixture.getRun.mockResolvedValue({
      id: seeded.flowRunId,
      status: 'paused',
      flow_version_id: seeded.versionId,
      nodeRuns: [...projectedNodes].reverse(),
      graph: { nodes: [] },
    });
    fixture.getVersion.mockResolvedValue({ flowId: seeded.flowId });
    fixture.getFlow.mockResolvedValue({ id: seeded.flowId, name: 'Flow' });
    const queries = vi.spyOn(db.$client, 'prepare');
    const result = await readMobileRun(seeded.flowRunId);
    expect(queries).toHaveBeenCalledTimes(2);
    expect(result.nodes.map((entry) => entry.id)).toEqual(
      projectedNodes.map((entry) => entry.id).reverse(),
    );
    expect(result.nodes.find((entry) => entry.id === 'node-2')).toMatchObject({
      chatId: 'chat',
      subChatId: 'sub-2',
      detail: planText,
      actions: ['approve', 'skip'],
      startedAt: '2026-09-28T08:00:00Z',
      completedAt: null,
    });
    expect(result.nodes.find((entry) => entry.id === 'node-0')?.actions).toEqual([]);
    expect(result.nodes.find((entry) => entry.id === 'node-1')?.actions).toEqual([]);
    expect(fixture.getLink).not.toHaveBeenCalled();
    expect(fixture.getDriving).not.toHaveBeenCalled();
    expect(fixture.getSubChat).not.toHaveBeenCalled();
  });

  it("adds each Flow's newest run of any status in one query, capped at 200 Flows", async () => {
    const db = freshDb();
    fixture.db = db;
    const busy = await createFlow(db, { name: 'Busy' });
    const idle = await createFlow(db, { name: 'Idle' });
    const version = await createFlowVersion(db, {
      flowId: busy.id,
      graph: { nodes: [], edges: [] },
    });
    const at = (seconds: number) => new Date(seconds * 1000);
    // run-x and run-y start in the same second; the id breaks the tie as the run list does.
    await db.insert(flowRuns).values([
      { id: 'run-older', flowVersionId: version.id, status: 'running', createdAt: at(1000) },
      {
        id: 'run-x',
        flowVersionId: version.id,
        status: 'completed',
        createdAt: at(2000),
        completedAt: at(2500),
      },
      {
        id: 'run-y',
        flowVersionId: version.id,
        status: 'failed',
        createdAt: at(2000),
        startedAt: at(2100),
        completedAt: at(2600),
      },
    ]);
    fixture.list.mockResolvedValue(
      [busy.id, idle.id, ...Array.from({ length: 199 }, (_, index) => `flow-${index}`)].map(
        (id) => ({ id, name: 'Flow', is_enabled: true }),
      ),
    );
    const queries = vi.spyOn(db.$client, 'prepare');
    const result = await readMobileFlows();
    expect(queries).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(200);
    expect(result[0].lastRun).toEqual({
      id: 'run-y',
      status: 'failed',
      at: at(2600).toISOString(),
    });
    expect(result[1].lastRun).toBeNull();
  });
});

describe('mobile Flow list status', () => {
  const flow = (fields: Record<string, unknown>) => ({
    id: 'flow',
    name: 'Flow',
    is_enabled: true,
    latest_run_id: 'run',
    ...fields,
  });

  it('sends the display status the desktop list shows, not the engine status', async () => {
    fixture.db = freshDb();
    fixture.list.mockResolvedValue([
      flow({ id: 'working', latest_run_status: 'paused', latest_run_active_task_status: 'running' }),
      flow({ id: 'plan', latest_run_status: 'paused', latest_run_active_task_status: 'plan_ready' }),
      flow({ id: 'approval', latest_run_status: 'paused', latest_run_active_task_status: null }),
      flow({ id: 'queued', latest_run_status: 'pending', latest_run_admission_state: 'queued' }),
      flow({ id: 'idle', latest_run_id: null, latest_run_status: null }),
    ]);
    const statuses = (await readMobileFlows()).map((entry) => [entry.id, entry.status]);
    expect(statuses).toEqual([
      ['working', 'running'],
      ['plan', 'awaiting_input'],
      ['approval', 'awaiting_input'],
      ['queued', 'queued'],
      ['idle', null],
    ]);
  });
});
