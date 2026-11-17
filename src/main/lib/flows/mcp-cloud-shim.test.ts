import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { kind: 'test-db' },
  startFlowRun: vi.fn(),
  flowRunAdmissionSnapshotsForRuns: vi.fn(),
}));

vi.mock('../db', () => ({ getDatabase: () => mocks.db }));
vi.mock('./start', () => ({ startFlowRun: mocks.startFlowRun }));
vi.mock('./admission/visibility', () => ({
  flowRunAdmissionSnapshotsForRuns: mocks.flowRunAdmissionSnapshotsForRuns,
}));
vi.mock('./batch-dispatch', () => ({ startFlowBatchLocal: vi.fn() }));
vi.mock('./batch-runs-list', () => ({ listBatchRunsForBatch: vi.fn() }));
vi.mock('./batch-stage-detail', () => ({ listBatchStageDetail: vi.fn() }));

import { createFlow } from '../db/repos/flows';
import { freshDb } from '../db/test-utils/fresh-db';
import { createFlowVersion, startFlowRun } from './mcp-cloud-shim';
import { type FlowVersionCommittedEvent, subscribeFlowVersionCommitted } from './version-events';

const RUN = {
  id: 'run-1',
  flowVersionId: 'version-1',
  userId: 'user-1',
  status: 'pending',
  triggerContext: null,
  idempotencyKey: null,
  batchId: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date('2026-08-03T10:00:00.000Z'),
};

describe('MCP local flow start admission response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startFlowRun.mockResolvedValue({ run: RUN, version: {}, isReplay: false });
  });

  it.each([
    {
      label: 'queued',
      runStatus: 'pending',
      admissionState: 'queued',
      queuePosition: 3,
      startedAt: null,
      completedAt: null,
    },
    {
      label: 'active',
      runStatus: 'running',
      admissionState: 'active',
      queuePosition: null,
      startedAt: new Date('2026-08-03T10:01:00.000Z'),
      completedAt: null,
    },
    {
      label: 'fast completion',
      runStatus: 'completed',
      admissionState: 'releasing',
      queuePosition: null,
      startedAt: new Date('2026-08-03T10:01:00.000Z'),
      completedAt: new Date('2026-08-03T10:01:01.000Z'),
    },
  ])(
    'returns the $label admission snapshot in the run DTO',
    async ({ runStatus, admissionState, queuePosition, startedAt, completedAt }) => {
      const requestedAt = new Date('2026-08-03T10:01:00.000Z');
      mocks.flowRunAdmissionSnapshotsForRuns.mockReturnValue(
        new Map([
          [
            RUN.id,
            {
              runStatus,
              startedAt,
              completedAt,
              admission: { admissionState, queuePosition, requestedAt },
            },
          ],
        ]),
      );

      const result = await startFlowRun('flow-1');

      expect(mocks.flowRunAdmissionSnapshotsForRuns).toHaveBeenCalledWith(mocks.db, [RUN.id]);
      expect(result).toMatchObject({
        id: RUN.id,
        status: runStatus,
        admission_state: admissionState,
        queue_position: queuePosition,
        admission_requested_at: requestedAt.toISOString(),
        started_at: startedAt?.toISOString() ?? null,
        completed_at: completedAt?.toISOString() ?? null,
      });
    },
  );
});

// The agent's save path (frink_flows_patch -> this shim) told no open editor anything.
describe('MCP flow version save announces itself', () => {
  const graph = (instructions: string) => ({
    nodes: [
      { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
      { id: 'a', blockType: 'agent', config: { instructions }, position: { x: 0, y: 1 } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'a' }],
  });

  it('pushes an agent-sourced event carrying the version number the tool reports back', async () => {
    const db = freshDb();
    Object.assign(mocks, { db });
    const flow = await createFlow(db, { name: 'F' });
    const events: FlowVersionCommittedEvent[] = [];
    const unsubscribe = subscribeFlowVersionCommitted((e) => events.push(e));

    const saved = await createFlowVersion(flow.id, { graph: graph('agent edit') });
    // Re-sending the same graph appends nothing, so there is nothing to announce.
    await createFlowVersion(flow.id, {
      graph: graph('agent edit'),
      expectedVersionNumber: saved.version_number,
    });
    unsubscribe();

    expect(events).toEqual([
      { flowId: flow.id, versionNumber: saved.version_number, source: 'agent' },
    ]);
  });
});
