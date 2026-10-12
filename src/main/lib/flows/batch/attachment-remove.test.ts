import { beforeEach, describe, expect, it } from 'vitest';
import type { RunAttachment } from '../../../../shared/types/run-attachment';
import {
  getBatchStageRun,
  listRunsForStage,
  setStageRunStatus,
} from '../../db/repos/batch-stage-runs';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { seedBatchStage } from '../batch-test-factories';
import { removeAttachmentFromStageRun } from './attachment-remove';

let db: TestDb;

const att = (n: number): RunAttachment => ({
  url: `frink-attachment://r/${n}.png`,
  type: 'image/png',
  label: `${n}.png`,
});

async function seedRun(attachments: RunAttachment[]): Promise<string> {
  const stage = await seedBatchStage(db, 'batch-1', {
    stageNumber: 1,
    runCount: 1,
    triggerContext: { attachments },
  });
  const [run] = await listRunsForStage(db, stage.id);
  return run.id;
}

beforeEach(() => {
  db = freshDb();
});

describe('removeAttachmentFromStageRun', () => {
  it('removes the named attachment and returns the stored context', async () => {
    const runId = await seedRun([att(1), att(2)]);

    const { run } = removeAttachmentFromStageRun({ runId, url: att(1).url }, db);

    expect(run).toEqual({ id: runId, trigger_context: { attachments: [att(2)] } });
    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual({ attachments: [att(2)] });
  });

  // Catches: a refusal surfacing as a generic error, so the pane cannot tell the person why.
  it('refuses a run that has left pending with a message the pane can show', async () => {
    const runId = await seedRun([att(1)]);
    await setStageRunStatus(db, runId, 'dispatched');

    expect(() => removeAttachmentFromStageRun({ runId, url: att(1).url }, db)).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        message: 'Images can only be removed before the run starts',
      }),
    );
  });

  it('reports a missing run', () => {
    expect(() => removeAttachmentFromStageRun({ runId: 'nope', url: att(1).url }, db)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
