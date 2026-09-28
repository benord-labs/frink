import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { readMobileFlow, readMobileRun, resumeMobileNode } from './flows';

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
    fixture.listRuns.mockResolvedValue([
      { id: 'older-run', status: 'completed', started_at: '2026-09-28T08:00:00Z' },
    ]);
    await expect(readMobileFlow('flow')).resolves.toMatchObject({
      definition: {
        versionNumber: 3,
        nodes: [{ id: 'start' }, { id: 'current', instructions: 'Current instructions' }],
        edges: [{ id: 'next', source: 'start', target: 'current' }],
      },
      runs: [{ id: 'older-run', status: 'completed', startedAt: '2026-09-28T08:00:00Z' }],
    });
    expect(fixture.getVersion).not.toHaveBeenCalled();
    expect(fixture.listRuns).toHaveBeenCalledWith({ flowId: 'flow', limit: 30 });
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
    });
    expect(result.nodes.find((entry) => entry.id === 'node-0')?.actions).toEqual([]);
    expect(result.nodes.find((entry) => entry.id === 'node-1')?.actions).toEqual([]);
    expect(fixture.getLink).not.toHaveBeenCalled();
    expect(fixture.getDriving).not.toHaveBeenCalled();
    expect(fixture.getSubChat).not.toHaveBeenCalled();
  });
});
