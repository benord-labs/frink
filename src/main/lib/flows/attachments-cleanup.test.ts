import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';
import { listRunsForStage } from '../db/repos/batch-stage-runs';
import { batchStageRuns, flowRuns, tasks } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { sweepOrphanedAttachments } from './attachments-cleanup';
import { seedBatchFlow, seedBatchStage } from './batch-test-factories';

let db: TestDb;
let root: string;
let versionId: string;

type SeedContext = Parameters<typeof seedBatchStage>[2]['triggerContext'];

const url = (runId: string, name: string) => ({
  url: `frink-attachment://${runId}/${name}`,
  type: 'image/png',
});

function touch(...segments: string[]) {
  const full = join(root, ...segments);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
  return full;
}

let userData: string;
const sweep = () => sweepOrphanedAttachments({ db, root });

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'frink-sweep-'));
  root = join(userData, 'flow-attachments');
  db = freshDb();
  ({ versionId } = await seedBatchFlow(db));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('sweepOrphanedAttachments', () => {
  it('removes only unreferenced plain files in live runs, plus dead-run directories', async () => {
    const stage = await seedBatchStage(db, 'batch-sweep', { stageNumber: 1, runCount: 2 });
    const [a, b] = await listRunsForStage(db, stage.id);
    const { updateRunTriggerContext } = await import('../db/repos/batch-stage-runs');
    updateRunTriggerContext(db, a.id, () => ({
      attachments: [url(a.id, 'kept.png'), { url: 'https://example.com/x.png', type: 'image' }],
    }));
    // Run b references a file that lives in run a's directory.
    updateRunTriggerContext(db, b.id, () => ({ attachments: [url(a.id, 'shared.png')] }));

    const kept = touch(a.id, 'kept.png');
    const shared = touch(a.id, 'shared.png');
    const leaked = touch(a.id, 'leaked.png');
    const target = touch('outside.png');
    const link = join(root, a.id, 'link.png');
    symlinkSync(target, link);
    const deadRunFile = touch('deadrun123', 'old.png');

    const result = await sweep();

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(leaked)).toBe(false);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(deadRunFile)).toBe(false);
    expect(result).toMatchObject({ removed: 1, removedFiles: 1 });
  });

  it('reclaims a crash leftover even after startup recovery already dispatched its run', async () => {
    const stage = await seedBatchStage(db, 'batch-sweep', { stageNumber: 1, runCount: 1 });
    const [run] = await listRunsForStage(db, stage.id);
    await db
      .update(batchStageRuns)
      .set({ status: 'dispatched', flowRunId: 'flow-run-1', triggerContext: { attachments: [] } })
      .where(eq(batchStageRuns.id, run.id));
    const leftover = touch(run.id, 'crashed-upload.png');

    const result = await sweep();

    expect(existsSync(leftover)).toBe(false);
    expect(result.removedFiles).toBe(1);
  });

  it('keeps files a flow run or task copy still references after the stage run dropped them', async () => {
    const stage = await seedBatchStage(db, 'batch-sweep', { stageNumber: 1, runCount: 1 });
    const [run] = await listRunsForStage(db, stage.id);
    const flowRun = db
      .insert(flowRuns)
      .values({
        flowVersionId: versionId,
        triggerContext: { attachments: [url(run.id, 'flow.png')] },
      })
      .returning()
      .get();
    db.insert(tasks)
      .values({
        description: 'agent step',
        source: 'flow',
        flowRunId: flowRun.id,
        triggerContext: { attachments: [url(run.id, 'task.png')] },
      })
      .run();
    await db
      .update(batchStageRuns)
      .set({ status: 'dispatched', flowRunId: flowRun.id, triggerContext: { attachments: [] } })
      .where(eq(batchStageRuns.id, run.id));
    const flowCopy = touch(run.id, 'flow.png');
    const taskCopy = touch(run.id, 'task.png');
    const leftover = touch(run.id, 'leftover.png');

    const result = await sweep();

    expect(existsSync(flowCopy)).toBe(true);
    expect(existsSync(taskCopy)).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(result.removedFiles).toBe(1);
  });

  it('keeps files a surviving flow run or task references after their stage run row is gone', async () => {
    const goneRunId = 'gonerun123';
    const flowRun = db
      .insert(flowRuns)
      .values({
        flowVersionId: versionId,
        idempotencyKey: goneRunId,
        triggerContext: { attachments: [url(goneRunId, 'flow.png')] },
      })
      .returning()
      .get();
    db.insert(tasks)
      .values({
        description: 'agent step',
        source: 'flow',
        flowRunId: flowRun.id,
        triggerContext: { attachments: [url(goneRunId, 'task.png')] },
      })
      .run();
    const flowCopy = touch(goneRunId, 'flow.png');
    const taskCopy = touch(goneRunId, 'task.png');
    const leftover = touch(goneRunId, 'leftover.png');

    const result = await sweep();

    expect(existsSync(flowCopy)).toBe(true);
    expect(existsSync(taskCopy)).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(result).toMatchObject({ removed: 0, removedFiles: 1 });
  });

  it('tolerates malformed trigger_context shapes without throwing or deleting referenced files', async () => {
    const stage = await seedBatchStage(db, 'batch-sweep', { stageNumber: 1, runCount: 4 });
    const [a, b, c, d] = await listRunsForStage(db, stage.id);
    const storedContexts: Array<[string, SeedContext | null]> = [
      [a.id, { attachments: [null, 42, { url: 7 }, { url: '' }, url(a.id, 'kept.png')] }],
      [b.id, { attachments: 'not-an-array' }],
      [c.id, null],
      [
        d.id,
        {
          attachments: [
            { url: `frink-attachment://${d.id}/a/b.png`, type: 'image' },
            { url: `frink-attachment://${d.id}/`, type: 'image' },
            { url: 'file:///etc/passwd', type: 'image' },
          ],
        },
      ],
    ];
    for (const [id, triggerContext] of storedContexts) {
      await db.update(batchStageRuns).set({ triggerContext }).where(eq(batchStageRuns.id, id));
    }
    const kept = touch(a.id, 'kept.png');
    const leaked = touch(b.id, 'leaked.png');

    const result = await sweep();

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(leaked)).toBe(false);
    expect(result).toMatchObject({ removed: 0, removedFiles: 1 });
  });

  it('leaves non-file entries inside a live run directory alone', async () => {
    const stage = await seedBatchStage(db, 'batch-sweep', { stageNumber: 1, runCount: 1 });
    const [run] = await listRunsForStage(db, stage.id);
    const nested = touch(run.id, 'subdir', 'inner.png');

    await sweep();

    expect(existsSync(nested)).toBe(true);
  });

  it('is a no-op when the attachments root does not exist', async () => {
    await expect(sweep()).resolves.toEqual({
      scanned: 0,
      removed: 0,
      removedFiles: 0,
    });
  });
});
