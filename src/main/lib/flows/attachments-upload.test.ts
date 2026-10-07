import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  appendRunAttachment,
  listRunsForStage,
  type RunTriggerContext,
  updateRunTriggerContext,
} from '../db/repos/batch-stage-runs';
import { batchStageRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { readAttachmentImage, writeAttachment } from './attachments-storage';
import { type UploadDeps, uploadAttachmentToStageRun } from './attachments-upload';
import { updateStageRunLocal } from './batch-mutations';
import { seedBatchFlow, seedBatchStage } from './batch-test-factories';

// Upload appends atomically: it never writes status, never exceeds the cap under
// concurrency, refuses runs that left 'pending', and only ever rolls back its own file.

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

let db: TestDb;
let root: string;
let flowId: string;
let runId: string;
let write: ReturnType<typeof vi.fn<typeof writeAttachment>>;

const runDir = () => join(root, runId);
const filesOnDisk = () => (existsSync(runDir()) ? readdirSync(runDir()) : []);

async function readRun() {
  const [row] = await db.select().from(batchStageRuns).where(eq(batchStageRuns.id, runId));
  return row;
}

const storedAttachmentsSchema = z.object({
  attachments: z.array(z.object({ url: z.string(), label: z.string().optional() })).default([]),
});

function attachmentsOf(row: { triggerContext: unknown }) {
  return storedAttachmentsSchema.parse(row.triggerContext ?? {}).attachments;
}

const deps = (overrides: Partial<UploadDeps> = {}): UploadDeps => ({
  db,
  root,
  write,
  append: appendRunAttachment,
  ...overrides,
});

const upload = (
  filename = 'image.png',
  data = PNG_BASE64,
  mimeType = 'image/png',
  overrides: Partial<UploadDeps> = {},
) => uploadAttachmentToStageRun({ flowId, runId, data, filename, mimeType }, deps(overrides));

/** A write that lands the file, then lets the test change the row before the append. */
const writeThen = (sideEffect: () => Promise<void>) =>
  vi.fn<typeof writeAttachment>(async (...args) => {
    const written = await writeAttachment(...args);
    await sideEffect();
    return written;
  });

type SeedContext = Parameters<typeof seedBatchStage>[2]['triggerContext'];

async function seedRun(triggerContext: SeedContext = { label: 'run-0' }) {
  const stage = await seedBatchStage(db, 'batch-upload', {
    stageNumber: 1,
    runCount: 1,
    triggerContext,
  });
  [{ id: runId }] = await listRunsForStage(db, stage.id);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'frink-attach-'));
  db = freshDb();
  write = vi.fn<typeof writeAttachment>(writeAttachment);
  ({ flowId } = await seedBatchFlow(db));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('uploadAttachmentToStageRun', () => {
  it('stores under a generated name and labels the entry with the client filename', async () => {
    await seedRun();
    const result = await upload('Screenshot 2026-10-05 at 10.00.00.png');

    const [entry] = attachmentsOf(await readRun());
    expect(entry.label).toBe('Screenshot 2026-10-05 at 10.00.00.png');
    expect(entry.url).toBe(result.url);
    expect(result.url).toBe(`frink-attachment://${runId}/${result.filename}`);
    expect(result.filename).toMatch(/^[A-Za-z0-9-]+\.png$/);
    expect(filesOnDisk()).toEqual([result.filename]);
    expect(result.run.trigger_context).toEqual((await readRun()).triggerContext);
  });

  it('gives same-named uploads distinct files', async () => {
    await seedRun();
    const a = await upload('image.png', Buffer.from('first').toString('base64'));
    const b = await upload('image.png', Buffer.from('second').toString('base64'));

    expect(a.url).not.toBe(b.url);
    expect(readFileSync(join(runDir(), a.filename), 'utf8')).toBe('first');
    expect(readFileSync(join(runDir(), b.filename), 'utf8')).toBe('second');
  });

  it.each([
    ['dispatched', 'flow-run-1'],
    ['completed', null],
  ] as const)(
    'never rewrites status when the run becomes %s mid-upload, and rolls back its file',
    async (status, flowRunId) => {
      await seedRun();
      const racingWrite = writeThen(async () => {
        await db
          .update(batchStageRuns)
          .set({ status, flowRunId })
          .where(eq(batchStageRuns.id, runId));
      });

      await expect(
        upload('image.png', PNG_BASE64, 'image/png', { write: racingWrite }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const row = await readRun();
      expect(row.status).toBe(status);
      expect(row.flowRunId).toBe(flowRunId);
      expect(attachmentsOf(row)).toEqual([]);
      expect(filesOnDisk()).toEqual([]);
    },
  );

  it('refuses a run that is no longer pending without writing a file', async () => {
    await seedRun();
    await db
      .update(batchStageRuns)
      .set({ status: 'dispatched' })
      .where(eq(batchStageRuns.id, runId));

    await expect(upload()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(write).not.toHaveBeenCalled();
  });

  it('lets exactly one of two concurrent uploads take the last slot', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      url: `https://example.com/${i}.png`,
      type: 'image/png',
    }));
    await seedRun({ attachments: nine });

    const results = await Promise.allSettled([upload('a.png'), upload('b.png')]);

    const [winner, ...otherWinners] = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    const losers = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(otherWinners).toEqual([]);
    expect(losers).toEqual([expect.objectContaining({ code: 'CONFLICT' })]);

    expect(attachmentsOf(await readRun())).toHaveLength(10);
    expect(filesOnDisk()).toEqual([winner.filename]);
  });

  it('keeps an earlier attachment intact when a later upload is rejected', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      url: `https://example.com/${i}.png`,
      type: 'image/png',
    }));
    await seedRun({ attachments: eight });
    const first = await upload('image.png', Buffer.from('first').toString('base64'));

    // Both pass the pre-check; only one fits.
    await Promise.allSettled([upload('image.png'), upload('image.png')]);

    expect(attachmentsOf(await readRun())).toHaveLength(10);
    expect(readFileSync(join(runDir(), first.filename), 'utf8')).toBe('first');
    expect(filesOnDisk()).toHaveLength(2);
  });
});

describe('uploadAttachmentToStageRun edge cases', () => {
  it('rejects an unsupported mime type before touching disk', async () => {
    await seedRun();
    await expect(upload('doc.pdf', PNG_BASE64, 'application/pdf')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for an unknown run without touching disk', async () => {
    await seedRun();
    runId = 'doesnotexist';
    await expect(upload()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a run already over the cap (e.g. seeded via MCP) without writing a file', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      url: `https://example.com/${i}.png`,
      type: 'image/png',
    }));
    await seedRun({ attachments: eleven });
    await expect(upload()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND and removes its file when the run is deleted mid-upload', async () => {
    await seedRun();
    const racingWrite = writeThen(async () => {
      await db.delete(batchStageRuns).where(eq(batchStageRuns.id, runId));
    });

    await expect(
      upload('image.png', PNG_BASE64, 'image/png', { write: racingWrite }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(filesOnDisk()).toEqual([]);
  });

  it('rethrows a DB failure during the append and removes its file', async () => {
    await seedRun();
    const failingAppend: typeof appendRunAttachment = () => {
      throw new Error('SQLITE_BUSY');
    };

    await expect(
      upload('image.png', PNG_BASE64, 'image/png', { append: failingAppend }),
    ).rejects.toThrow('SQLITE_BUSY');
    expect(filesOnDisk()).toEqual([]);
    expect(attachmentsOf(await readRun())).toEqual([]);
  });

  it('preserves unrelated trigger_context keys when appending', async () => {
    await seedRun({ label: 'run-0', customInstructions: 'be brief', _config: { model: 'x' } });
    const result = await upload();

    const { triggerContext } = await readRun();
    expect(triggerContext).toMatchObject({
      label: 'run-0',
      customInstructions: 'be brief',
      _config: { model: 'x' },
    });
    expect(result.run.trigger_context).toEqual(triggerContext);
  });

  it('replaces a non-array attachments value instead of throwing', async () => {
    await seedRun({ attachments: 'garbage' });
    await upload();
    expect(attachmentsOf(await readRun())).toHaveLength(1);
  });

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])(
    'stores %s with a .%s extension the executor reads back with the right media type',
    async (mimeType, ext) => {
      await seedRun();
      const result = await upload(`photo.${ext}`, PNG_BASE64, mimeType);

      expect(result.filename.endsWith(`.${ext}`)).toBe(true);
      const read = await readAttachmentImage(result.url, root);
      expect(read).toMatchObject({ ok: true, mime: mimeType, base64: PNG_BASE64 });
    },
  );
});

describe('appendRunAttachment', () => {
  const attachment = { url: 'frink-attachment://r/x.png', type: 'image/png' };

  it.each(['queued', 'dispatched', 'completed', 'failed', 'cancelled'] as const)(
    'refuses a %s run and leaves trigger_context untouched',
    async (status) => {
      await seedRun({ label: 'keep' });
      await db.update(batchStageRuns).set({ status }).where(eq(batchStageRuns.id, runId));

      expect(appendRunAttachment(db, runId, attachment, 10)).toEqual({ kind: 'not_pending' });
      expect((await readRun()).triggerContext).toEqual({ label: 'keep' });
    },
  );

  it('accepts the append that reaches max exactly, then refuses the next', async () => {
    await seedRun({ attachments: [] });
    expect(appendRunAttachment(db, runId, attachment, 1).kind).toBe('ok');
    expect(appendRunAttachment(db, runId, attachment, 1)).toEqual({ kind: 'cap_exceeded' });
  });

  it('creates the attachments array when trigger_context is null', async () => {
    await seedRun();
    await db
      .update(batchStageRuns)
      .set({ triggerContext: null })
      .where(eq(batchStageRuns.id, runId));

    const result = appendRunAttachment(db, runId, attachment, 10);
    expect(result).toEqual({ kind: 'ok', triggerContext: { attachments: [attachment] } });
  });
});

describe('updateRunTriggerContext', () => {
  it('returns null and never calls patch for a missing run', () => {
    const patch = vi.fn((tc: RunTriggerContext) => tc);
    expect(updateRunTriggerContext(db, 'missing', patch)).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('updateStageRunLocal', () => {
  it('merges configOverrides into the existing _config and leaves other keys alone', async () => {
    await seedRun({ label: 'run-0', _config: { model: 'a', effort: 'high' } });

    const { run } = await updateStageRunLocal({ runId, configOverrides: { model: 'b' } }, db);

    expect(run.trigger_context).toEqual({
      label: 'run-0',
      _config: { model: 'b', effort: 'high' },
    });
    expect((await readRun()).triggerContext).toEqual(run.trigger_context);
  });

  it('replaces attachments with the given list (removal) without touching disk', async () => {
    await seedRun();
    const a = await upload('a.png');
    await upload('b.png');

    await updateStageRunLocal(
      { runId, attachments: [{ url: a.url, type: 'image/png', label: 'a.png' }] },
      db,
    );

    expect(attachmentsOf(await readRun()).map((x) => x.url)).toEqual([a.url]);
    expect(filesOnDisk()).toHaveLength(2);
  });

  it('patches against the latest trigger_context, keeping an append made since the caller read', async () => {
    await seedRun();
    const uploaded = await upload();

    const { run } = await updateStageRunLocal({ runId, label: 'renamed' }, db);

    expect(run.trigger_context.label).toBe('renamed');
    expect(attachmentsOf(await readRun()).map((a) => a.url)).toEqual([uploaded.url]);
  });

  it('throws NOT_FOUND for a missing run', async () => {
    await expect(updateStageRunLocal({ runId: 'missing', label: 'x' }, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
