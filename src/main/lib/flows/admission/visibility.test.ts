import { describe, expect, it } from 'vitest';
import { flowRuns, flows, flowVersions } from '../../db/schema';
import { freshDb } from '../../db/test-utils/fresh-db';
import { flowRunAdmissionSnapshotsForRuns, workQueueHeldRuns } from './visibility';

const triggeredBy = (blockType: string) => ({ nodes: [{ id: 't', blockType }], edges: [] });
const at = (seconds: number) => new Date(seconds * 1000);

describe('runs held for Start', () => {
  it('lists the newest a page at a time, counts every held run, and reads as held', async () => {
    const db = freshDb();
    db.insert(flows).values({ id: 'flow-1', name: 'Triage' }).run();
    db.insert(flowVersions)
      .values([
        { id: 'v1', flowId: 'flow-1', versionNumber: 1, graph: triggeredBy('webhook_trigger') },
        { id: 'v2', flowId: 'flow-1', versionNumber: 2, graph: triggeredBy('schedule_trigger') },
      ])
      .run();
    db.insert(flowRuns)
      .values([
        { id: 'old', flowVersionId: 'v1', heldAt: at(1) },
        { id: 'mid', flowVersionId: 'v1', heldAt: at(2) },
        { id: 'new', flowVersionId: 'v2', heldAt: at(3) },
        { id: 'dismissed', flowVersionId: 'v2', status: 'cancelled', heldAt: at(4) },
        { id: 'queued', flowVersionId: 'v2' },
      ])
      .run();

    const page = await workQueueHeldRuns(db, 2);

    expect(page.total).toBe(3);
    expect(page.runs.map((run) => [run.flow_run_id, run.starts_on_latest_version])).toEqual([
      ['new', true],
      ['mid', false],
    ]);
    const snapshots = flowRunAdmissionSnapshotsForRuns(db, ['old', 'dismissed', 'queued']);
    expect(snapshots.get('old')?.admission).toEqual({
      admissionState: 'held',
      queuePosition: null,
      requestedAt: at(1),
    });
    expect(snapshots.get('dismissed')?.admission).toBeNull();
    expect(snapshots.get('queued')?.admission).toBeNull();
  });
});
