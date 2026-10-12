import { beforeEach, describe, expect, it } from 'vitest';
import type { RunAttachment } from '../../../../shared/types/run-attachment';
import { seedBatchStage } from '../../flows/batch-test-factories';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { appendStageRunAttachment, getBatchStageRun, listRunsForStage } from './batch-stage-runs';

let db: TestDb;

const att = (n: number): RunAttachment => ({
  url: `frink-attachment://r/${n}.png`,
  type: 'image/png',
  label: `${n}.png`,
  mimeType: 'image/png',
});

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

beforeEach(() => {
  db = freshDb();
});

describe('appendStageRunAttachment', () => {
  it('appends onto the current trigger_context and keeps its other keys', async () => {
    const runId = await seedRun({
      label: 'x',
      customInstructions: 'be brief',
      attachments: [att(1)],
    });

    const result = appendStageRunAttachment(db, runId, att(2), 10);

    const expected = { label: 'x', customInstructions: 'be brief', attachments: [att(1), att(2)] };
    expect(result).toEqual({ ok: true, triggerContext: expected });
    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual(expected);
  });

  it('starts a list when trigger_context has no attachments array', async () => {
    const runId = await seedRun({ label: 'x' });

    appendStageRunAttachment(db, runId, att(1), 10);

    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual({
      label: 'x',
      attachments: [att(1)],
    });
  });

  it('refuses at the cap and leaves the row unchanged', async () => {
    const full = { attachments: [att(1), att(2)] };
    const runId = await seedRun(full);

    expect(appendStageRunAttachment(db, runId, att(3), 2)).toEqual({ ok: false, reason: 'cap' });
    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual(full);
  });

  it('refuses to rewrite a trigger_context whose attachments it cannot read', async () => {
    const corrupt = { label: 'x', attachments: 'not-a-list' };
    const runId = await seedRun(corrupt);

    expect(appendStageRunAttachment(db, runId, att(1), 10)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect((await getBatchStageRun(db, runId))?.triggerContext).toEqual(corrupt);
  });

  it('reports a missing run', () => {
    expect(appendStageRunAttachment(db, 'nope', att(1), 10)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
