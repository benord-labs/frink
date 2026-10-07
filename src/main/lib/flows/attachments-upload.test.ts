import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunAttachment } from '../../../shared/types/run-attachment';
import {
  getBatchStageRun,
  listRunsForStage,
  stageRunTriggerContextSchema,
} from '../db/repos/batch-stage-runs';
import { batchStageRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { deleteAttachmentFile, readAttachmentImage, writeAttachment } from './attachments-storage';
import { uploadAttachmentToStageRun } from './attachments-upload';
import { seedBatchStage } from './batch-test-factories';

// Real in-memory SQLite + real files under a temp root: the unit under test is
// the read → disk write → append sequence when uploads overlap.

type SeedTriggerContext = Parameters<typeof seedBatchStage>[2]['triggerContext'];

let db: TestDb;
let root: string;
/** Runs while an upload is between its disk write and its DB append. */
let afterWrite: (() => void) | null;

const PNG = Buffer.from('png-bytes').toString('base64');

const existingAtt = (n: number): RunAttachment => ({
  url: `frink-attachment://seed/${n}.png`,
  type: 'image/png',
  label: `${n}.png`,
  mimeType: 'image/png',
});

async function seedRun(triggerContext: SeedTriggerContext = {}): Promise<string> {
  const stage = await seedBatchStage(db, 'batch-1', {
    stageNumber: 1,
    runCount: 1,
    triggerContext,
  });
  const [run] = await listRunsForStage(db, stage.id);
  return run.id;
}

const upload = (runId: string, filename: string, mimeType = 'image/png') =>
  uploadAttachmentToStageRun(
    { flowId: 'f', runId, data: PNG, filename, mimeType },
    {
      db,
      writeAttachment: async (r, f, data) => {
        const written = await writeAttachment(r, f, data, root);
        afterWrite?.();
        return written;
      },
      deleteAttachmentFile: (r, f) => deleteAttachmentFile(r, f, root),
    },
  );

async function storedAttachments(runId: string): Promise<RunAttachment[]> {
  const row = await getBatchStageRun(db, runId);
  return stageRunTriggerContextSchema.parse(row?.triggerContext ?? null).attachments;
}

const filesOnDisk = (runId: string) => readdirSync(join(root, runId));

beforeEach(() => {
  db = freshDb();
  root = mkdtempSync(join(tmpdir(), 'frink-attachments-'));
  afterWrite = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('uploadAttachmentToStageRun — concurrent uploads', () => {
  it('keeps every entry when two uploads to one run overlap', async () => {
    const runId = await seedRun();

    const [a, b] = await Promise.all([upload(runId, 'a.png'), upload(runId, 'b.png')]);

    const stored = await storedAttachments(runId);
    expect(stored.map((s) => s.url).sort()).toEqual([a.url, b.url].sort());
    expect(filesOnDisk(runId)).toHaveLength(2);
  });

  it('enforces the cap across overlapping uploads and deletes the losers’ files', async () => {
    const runId = await seedRun({
      attachments: Array.from({ length: 9 }, (_, i) => existingAtt(i)),
    });

    const outcomes = await Promise.allSettled([
      upload(runId, 'a.png'),
      upload(runId, 'b.png'),
      upload(runId, 'c.png'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'CONFLICT' });
    expect(await storedAttachments(runId)).toHaveLength(10);
    expect(filesOnDisk(runId)).toHaveLength(1);
  });

  it('stores same-named uploads as separate files', async () => {
    const runId = await seedRun();

    const [a, b] = await Promise.all([upload(runId, 'image.png'), upload(runId, 'image.png')]);

    expect(a.url).not.toBe(b.url);
    expect(filesOnDisk(runId)).toHaveLength(2);
    const stored = await storedAttachments(runId);
    expect(stored.map((s) => s.label)).toEqual(['image.png', 'image.png']);
    // The returned URL must resolve to the stored (prefixed) file, not the original name.
    for (const { url } of [a, b]) {
      expect(await readAttachmentImage(url, root)).toEqual({
        ok: true,
        mime: 'image/png',
        base64: PNG,
      });
    }
  });
  it('keeps a trigger_context edit saved while the upload is writing to disk', async () => {
    const runId = await seedRun({ label: 'run' });
    afterWrite = () => {
      db.update(batchStageRuns)
        .set({ triggerContext: { label: 'run', customInstructions: 'be brief' } })
        .where(eq(batchStageRuns.id, runId))
        .run();
    };

    const result = await upload(runId, 'a.png');

    const tc = (await getBatchStageRun(db, runId))?.triggerContext;
    expect(tc).toMatchObject({ label: 'run', customInstructions: 'be brief' });
    expect(tc).toEqual(result.run.trigger_context);
    expect(await storedAttachments(runId)).toHaveLength(1);
  });

  it('deletes the file when the run disappears before the append', async () => {
    const runId = await seedRun();
    afterWrite = () => {
      db.delete(batchStageRuns).where(eq(batchStageRuns.id, runId)).run();
    };

    await expect(upload(runId, 'a.png')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(filesOnDisk(runId)).toHaveLength(0);
  });

  it('deletes its file when the stored attachments are unreadable', async () => {
    const runId = await seedRun({ attachments: 'not-a-list' });

    await expect(upload(runId, 'a.png')).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(filesOnDisk(runId)).toHaveLength(0);
  });

  it('rejects an upload to a missing run without writing', async () => {
    await expect(upload('missing', 'a.png')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('uploadAttachmentToStageRun — real-world filenames', () => {
  it('accepts a macOS screenshot name with spaces and keeps it as the label', async () => {
    const runId = await seedRun();
    const name = 'Screenshot 2026-10-06 at 09.21.54.png';

    const result = await upload(runId, name);

    expect((await storedAttachments(runId)).map((s) => s.label)).toEqual([name]);
    expect(await readAttachmentImage(result.url, root)).toMatchObject({
      ok: true,
      mime: 'image/png',
    });
  });

  it('accepts a filename longer than the filesystem name limit, keeping its extension', async () => {
    const runId = await seedRun();
    const name = `${'a'.repeat(300)}.webp`;

    const result = await upload(runId, name, 'image/webp');

    expect(filesOnDisk(runId)[0].length).toBeLessThanOrEqual(255);
    expect(await readAttachmentImage(result.url, root)).toMatchObject({
      ok: true,
      mime: 'image/webp',
    });
  });
});
