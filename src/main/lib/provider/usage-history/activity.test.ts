import { describe, expect, it } from 'vitest';
import { flowRuns, flows, flowVersions, tasks } from '../../db/schema';
import { freshDb } from '../../db/test-utils/fresh-db';
import { getUsageActivity } from './activity';

describe('getUsageActivity', () => {
  it('counts flow runs, finished tasks and the most-run flows', () => {
    const db = freshDb();
    const [triage, digest] = db
      .insert(flows)
      .values([{ name: 'Triage' }, { name: 'Digest' }])
      .returning()
      .all();
    const versions = db
      .insert(flowVersions)
      .values([
        { flowId: triage.id, versionNumber: 1, graph: { nodes: [], edges: [] } },
        { flowId: digest.id, versionNumber: 1, graph: { nodes: [], edges: [] } },
      ])
      .returning()
      .all();
    db.insert(flowRuns)
      .values([
        { flowVersionId: versions[0].id },
        { flowVersionId: versions[0].id },
        { flowVersionId: versions[1].id },
      ])
      .run();
    db.insert(tasks)
      .values(
        ['done', 'completed', 'running'].map((status) => ({
          description: 'x',
          source: 'test',
          status,
        })),
      )
      .run();

    expect(getUsageActivity(db)).toEqual({
      flowRuns: 3,
      tasksFinished: 2,
      topFlows: [
        { name: 'Triage', runs: 2 },
        { name: 'Digest', runs: 1 },
      ],
    });
  });

  it('is all zeros on a fresh install', () => {
    expect(getUsageActivity(freshDb())).toEqual({ flowRuns: 0, tasksFinished: 0, topFlows: [] });
  });
});
