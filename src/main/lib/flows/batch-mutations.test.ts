import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendStageRunAttachment,
  getBatchStageRun,
  listRunsForStage,
} from '../db/repos/batch-stage-runs';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { updateStageRunLocal } from './batch-mutations';
import { seedBatchStage } from './batch-test-factories';

let db: TestDb;

async function seedRun(
  triggerContext: Parameters<typeof seedBatchStage>[2]['triggerContext'],
): Promise<string> {
  const stage = await seedBatchStage(db, 'batch-1', {
    stageNumber: 1,
    runCount: 1,
    triggerContext,
  });
  const [run] = await listRunsForStage(db, stage.id);
  return run.id;
}

const attachment = {
  url: 'frink-attachment://r/a.png',
  type: 'image/png',
  label: 'a.png',
  mimeType: 'image/png',
};

beforeEach(() => {
  db = freshDb();
});

describe('updateStageRunLocal', () => {
  it('keeps an attachment appended while the edit is in flight', async () => {
    const runId = await seedRun({ label: 'run' });

    // The append lands as another request's continuation, between the edit's read and write.
    const edit = updateStageRunLocal({ runId, customInstructions: 'be brief' }, db);
    queueMicrotask(() => appendStageRunAttachment(db, runId, attachment, 10));
    await edit;

    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual({
      label: 'run',
      customInstructions: 'be brief',
      attachments: [attachment],
    });
  });

  it('merges config overrides into the existing _config and leaves other keys alone', async () => {
    const runId = await seedRun({ label: 'run', _config: { model: 'a', effort: 'low' } });

    const { run } = await updateStageRunLocal({ runId, configOverrides: { effort: 'high' } }, db);

    const expected = { label: 'run', _config: { model: 'a', effort: 'high' } };
    expect(run.trigger_context).toEqual(expected);
    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual(expected);
  });

  it('reports a missing run', async () => {
    await expect(updateStageRunLocal({ runId: 'nope', label: 'x' }, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
