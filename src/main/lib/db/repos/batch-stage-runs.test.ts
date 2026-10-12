import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunAttachment } from '../../../../shared/types/run-attachment';
import { seedBatchStage } from '../../flows/batch-test-factories';
import { batchStageRuns } from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  appendStageRunAttachment,
  getBatchStageRun,
  listRunsForStage,
  removeStageRunAttachment,
  setStageRunStatus,
} from './batch-stage-runs';

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

describe('removeStageRunAttachment', () => {
  const stored = async (runId: string) => (await getBatchStageRun(db, runId))?.triggerContext;

  it('removes only the named attachment, even one a stale client never knew was stored', async () => {
    // Stored [A, B, C]; a client that only saw [A, B] removes A.
    const runId = await seedRun({ label: 'x', attachments: [att(1), att(2), att(3)] });

    const result = removeStageRunAttachment(db, runId, att(1).url);

    const expected = { label: 'x', attachments: [att(2), att(3)] };
    expect(result).toEqual({ ok: true, triggerContext: expected, removed: true });
    expect(await stored(runId)).toEqual(expected);
  });

  it('leaves the row unchanged when the URL is not stored', async () => {
    const runId = await seedRun({ attachments: [att(1)] });

    const result = removeStageRunAttachment(db, runId, att(9).url);

    expect(result).toEqual({ ok: true, triggerContext: { attachments: [att(1)] }, removed: false });
    expect(await stored(runId)).toEqual({ attachments: [att(1)] });
  });

  it('treats a context with no attachments list as nothing to remove', async () => {
    const runId = await seedRun({ label: 'x' });

    expect(removeStageRunAttachment(db, runId, att(1).url)).toMatchObject({ removed: false });
    expect(await stored(runId)).toEqual({ label: 'x' });
  });

  // Catches: tool-written entries (no type, null, a bare string) making the removal throw
  // or being dropped as a side effect.
  it('removes and keeps entries written without the upload fields', async () => {
    const bare = { url: 'https://example.com/a.png' };
    const other = { url: 'https://example.com/b.png', note: 'from a tool' };
    const runId = await seedRun({ attachments: [bare, null, 'https://example.com/c.png', other] });

    removeStageRunAttachment(db, runId, bare.url);

    expect(await stored(runId)).toEqual({
      attachments: [null, 'https://example.com/c.png', other],
    });
  });

  it('removes every entry that shares the URL', async () => {
    const runId = await seedRun({ attachments: [att(1), att(2), att(1)] });

    removeStageRunAttachment(db, runId, att(1).url);

    expect(await stored(runId)).toEqual({ attachments: [att(2)] });
  });

  it('refuses a run that is no longer pending and leaves it unchanged', async () => {
    const runId = await seedRun({ attachments: [att(1), att(2)] });
    await setStageRunStatus(db, runId, 'dispatched');

    expect(removeStageRunAttachment(db, runId, att(1).url)).toEqual({
      ok: false,
      reason: 'not_pending',
    });
    expect(await stored(runId)).toEqual({ attachments: [att(1), att(2)] });
  });

  // Catches: a pending run already linked to a flow run (begun work awaiting recovery) being
  // treated as unstarted, so its copied context points at a file the removal deleted.
  it('refuses a pending run that is already linked to a flow run', async () => {
    const runId = await seedRun({ attachments: [att(1)] });
    await db
      .update(batchStageRuns)
      .set({ flowRunId: 'flow-run-1' })
      .where(eq(batchStageRuns.id, runId));

    expect(removeStageRunAttachment(db, runId, att(1).url)).toEqual({
      ok: false,
      reason: 'not_pending',
    });
    expect(await stored(runId)).toEqual({ attachments: [att(1)] });
  });

  it('reports a missing run', () => {
    expect(removeStageRunAttachment(db, 'nope', att(1).url)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
