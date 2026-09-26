import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  batchStages,
  flowKvState,
  flowRuns,
  flows,
  flowTriggerBindings,
  flowVersions,
  nodeRuns,
  projects,
} from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { createFlowVersion } from './flow-versions';
import { copyFlow, createFlow, FlowCopyNoSavedVersionError, FlowCopyNotFoundError } from './flows';

const graph = (instructions: string, briefing = '') => ({
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'agent', blockType: 'agent', config: { instructions }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'edge', source: 'trigger', target: 'agent' }],
  settings: { briefing },
});

describe('copyFlow', () => {
  let db: TestDb;

  beforeEach(() => {
    db = freshDb();
  });

  it('copies metadata, the latest graph, a fresh batch ID, and inactive binding snapshots', async () => {
    const project = db
      .insert(projects)
      .values({ name: 'Project', path: '/tmp/copy-flow-project' })
      .returning()
      .get();
    const source = await createFlow(db, {
      projectId: project.id,
      name: 'Release review',
      description: 'Review a release',
      isEnabled: true,
      agentInvocable: true,
    });
    await createFlowVersion(db, { flowId: source.id, graph: graph('old') });
    const latest = await createFlowVersion(db, {
      flowId: source.id,
      graph: graph('latest', 'Shared launch briefing'),
      expectedVersionNumber: 1,
    });
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-01-02T00:00:00Z');
    db.insert(flowTriggerBindings)
      .values([
        {
          flowId: source.id,
          projectId: project.id,
          triggerType: 'post_task_trigger',
          config: { source: 'disabled-newer' },
          isActive: false,
          lastError: 'old error',
          lastErrorAt: newer,
          createdAt: newer,
          updatedAt: newer,
        },
        {
          flowId: source.id,
          projectId: project.id,
          triggerType: 'post_task_trigger',
          config: { source: 'active-preferred' },
          isActive: true,
          createdAt: older,
          updatedAt: older,
        },
        {
          flowId: source.id,
          projectId: null,
          triggerType: 'schedule_trigger',
          config: { cron: 'old' },
          isActive: false,
          createdAt: older,
          updatedAt: older,
        },
        {
          flowId: source.id,
          projectId: null,
          triggerType: 'schedule_trigger',
          config: { cron: 'newest-disabled' },
          isActive: false,
          lastError: 'clear me',
          lastErrorAt: newer,
          createdAt: newer,
          updatedAt: newer,
        },
      ])
      .run();

    const result = await copyFlow(db, { sourceFlowId: source.id });

    expect(result).toEqual({ id: expect.any(String) });
    const copied = db.select().from(flows).where(eq(flows.id, result.id)).get();
    expect(copied).toMatchObject({
      name: 'Release review (copy)',
      description: 'Review a release',
      projectId: project.id,
      isActive: true,
      isEnabled: false,
      agentInvocable: true,
    });
    const versions = db.select().from(flowVersions).where(eq(flowVersions.flowId, result.id)).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.versionNumber).toBe(1);
    const copiedGraph = versions[0]?.graph as ReturnType<typeof graph> & {
      settings: { briefing: string; currentBatchId?: string };
    };
    const sourceGraph = latest.graph as typeof copiedGraph;
    expect(copiedGraph.nodes[1]?.config?.instructions).toBe('latest');
    expect(copiedGraph.nodes.map((node) => node.id)).toEqual(['trigger', 'agent']);
    expect(copiedGraph.edges[0]?.id).toBe('edge');
    expect(copiedGraph.settings.currentBatchId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(copiedGraph.settings.currentBatchId).not.toBe(sourceGraph.settings.currentBatchId);

    const bindings = db
      .select()
      .from(flowTriggerBindings)
      .where(eq(flowTriggerBindings.flowId, result.id))
      .all();
    expect(bindings).toHaveLength(2);
    expect(bindings.every((binding) => !binding.isActive)).toBe(true);
    expect(
      bindings.every((binding) => binding.lastError === null && binding.lastErrorAt === null),
    ).toBe(true);
    expect(bindings.map((binding) => binding.id)).not.toContain(
      db
        .select({ id: flowTriggerBindings.id })
        .from(flowTriggerBindings)
        .where(eq(flowTriggerBindings.flowId, source.id))
        .get()?.id,
    );
    expect(bindings.map((binding) => binding.config)).toEqual(
      expect.arrayContaining([{ source: 'active-preferred' }, { cron: 'newest-disabled' }]),
    );
  });

  it('removes a batch ID when the copied briefing is empty', async () => {
    const source = await createFlow(db, { name: 'Empty briefing' });
    const saved = graph('go');
    saved.settings = { briefing: '', currentBatchId: 'not-server-owned' } as typeof saved.settings;
    db.insert(flowVersions).values({ flowId: source.id, versionNumber: 1, graph: saved }).run();

    const copied = await copyFlow(db, { sourceFlowId: source.id });
    const version = db.select().from(flowVersions).where(eq(flowVersions.flowId, copied.id)).get();
    expect(
      (version?.graph as { settings: Record<string, unknown> }).settings.currentBatchId,
    ).toBeUndefined();
  });

  it.each([
    ['missing', 'missing'],
    ['inactive', 'inactive'],
  ])('rejects a %s source without inserting rows', async (_case, sourceId) => {
    const source = await createFlow(db, {
      id: sourceId === 'missing' ? 'source' : sourceId,
      name: 'Source',
      isActive: sourceId !== 'inactive',
    });
    await createFlowVersion(db, { flowId: source.id, graph: graph('saved') });
    const before = db.select().from(flows).all().length;
    await expect(copyFlow(db, { sourceFlowId: sourceId })).rejects.toBeInstanceOf(
      FlowCopyNotFoundError,
    );
    expect(db.select().from(flows).all()).toHaveLength(before);
  });

  it('rejects a never-saved source without inserting rows', async () => {
    const source = await createFlow(db, { name: 'Unsaved' });
    await expect(copyFlow(db, { sourceFlowId: source.id })).rejects.toBeInstanceOf(
      FlowCopyNoSavedVersionError,
    );
    expect(db.select().from(flows).all()).toHaveLength(1);
  });

  it('keeps long and Unicode names within the 200-character limit', async () => {
    const source = await createFlow(db, { name: `${'x'.repeat(192)}😀tail` });
    await createFlowVersion(db, { flowId: source.id, graph: graph('saved') });
    const copied = await copyFlow(db, { sourceFlowId: source.id });
    const copiedName = db.select().from(flows).where(eq(flows.id, copied.id)).get()?.name ?? '';
    expect(copiedName.endsWith(' (copy)')).toBe(true);
    expect(copiedName.length).toBeLessThanOrEqual(200);
    expect(copiedName).not.toContain('\uFFFD');
  });

  it.each(['flow_versions', 'flow_trigger_bindings'])(
    'rolls back all inserts when %s fails',
    async (table) => {
      const source = await createFlow(db, { name: 'Rollback' });
      await createFlowVersion(db, { flowId: source.id, graph: graph('saved') });
      if (table === 'flow_trigger_bindings') {
        db.insert(flowTriggerBindings)
          .values({
            flowId: source.id,
            triggerType: 'schedule_trigger',
            config: { cron: '* * * * *' },
            isActive: true,
          })
          .run();
      }
      db.run(
        sql.raw(`CREATE TRIGGER fail_copy BEFORE INSERT ON ${table}
        WHEN (SELECT name FROM flows WHERE id = NEW.flow_id) LIKE '% (copy)'
        BEGIN SELECT RAISE(ABORT, 'forced copy failure'); END`),
      );

      await expect(copyFlow(db, { sourceFlowId: source.id })).rejects.toThrow(
        'forced copy failure',
      );
      expect(db.select().from(flows).all()).toHaveLength(1);
      expect(db.select().from(flowVersions).all()).toHaveLength(1);
    },
  );

  it('does not copy historical versions or runtime state', async () => {
    const source = await createFlow(db, { name: 'Stateful' });
    await createFlowVersion(db, { flowId: source.id, graph: graph('v1') });
    const latest = await createFlowVersion(db, {
      flowId: source.id,
      graph: graph('v2', 'Batch briefing'),
      expectedVersionNumber: 1,
    });
    const sourceBatchId = (latest.graph as { settings: { currentBatchId: string } }).settings
      .currentBatchId;
    const run = db
      .insert(flowRuns)
      .values({
        flowVersionId: latest.id,
        status: 'completed',
        batchId: sourceBatchId,
      })
      .returning()
      .get();
    db.insert(nodeRuns)
      .values({ flowRunId: run.id, nodeId: 'agent', blockType: 'agent', status: 'completed' })
      .run();
    db.insert(flowKvState)
      .values({ flowId: source.id, key: 'cursor', value: { at: 3 } })
      .run();
    db.insert(batchStages)
      .values({ batchId: sourceBatchId, stageNumber: 1, name: 'Source stage' })
      .run();

    const copied = await copyFlow(db, { sourceFlowId: source.id });
    const copiedVersion = db
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, copied.id))
      .get();
    const copiedBatchId = (copiedVersion?.graph as { settings: { currentBatchId: string } })
      .settings.currentBatchId;
    expect(
      db
        .select()
        .from(flowRuns)
        .where(eq(flowRuns.flowVersionId, copiedVersion?.id ?? ''))
        .all(),
    ).toHaveLength(0);
    expect(
      db.select().from(flowKvState).where(eq(flowKvState.flowId, copied.id)).all(),
    ).toHaveLength(0);
    expect(
      db.select().from(batchStages).where(eq(batchStages.batchId, copiedBatchId)).all(),
    ).toHaveLength(0);
    expect(
      db
        .select()
        .from(flowVersions)
        .where(and(eq(flowVersions.flowId, copied.id), eq(flowVersions.versionNumber, 2)))
        .all(),
    ).toHaveLength(0);
  });

  it('copies one internally consistent snapshot at either save/copy ordering', async () => {
    const beforeSave = await createFlow(db, { name: 'Before save' });
    await createFlowVersion(db, { flowId: beforeSave.id, graph: graph('v1') });
    const firstCopy = await copyFlow(db, { sourceFlowId: beforeSave.id });
    await createFlowVersion(db, {
      flowId: beforeSave.id,
      graph: graph('v2'),
      expectedVersionNumber: 1,
    });
    const afterSave = await copyFlow(db, { sourceFlowId: beforeSave.id });
    const copiedInstruction = (flowId: string) => {
      const row = db.select().from(flowVersions).where(eq(flowVersions.flowId, flowId)).get();
      return (row?.graph as ReturnType<typeof graph>).nodes[1]?.config?.instructions;
    };
    expect(copiedInstruction(firstCopy.id)).toBe('v1');
    expect(copiedInstruction(afterSave.id)).toBe('v2');
  });
});
