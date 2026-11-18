import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunAttachment } from '../../../shared/types/run-attachment';
import {
  getBatchStageRun,
  listRunsForStage,
  removeStageRunAttachment,
  stageRunTriggerContextSchema,
} from '../db/repos/batch-stage-runs';
import { batchStageRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { PASTED_FILE_MAX_BYTES } from '../../../shared/pasted-file-limits';
import {
  MAX_IMAGE_BYTES,
  copyAttachment,
  deleteAttachmentFile,
  readAttachmentImage,
  writeAttachment,
} from './attachments-storage';
import { attachFileToStageRun, uploadAttachmentToStageRun } from './attachments-upload';
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

const upload = (runId: string, filename: string, mimeType = 'image/png', data = PNG) =>
  uploadAttachmentToStageRun(
    { flowId: 'f', runId, data, filename, mimeType },
    {
      db,
      writeAttachment: async (r, f, data) => {
        const written = await writeAttachment(r, f, data, root);
        afterWrite?.();
        return written;
      },
      copyAttachment: (r, f, from) => copyAttachment(r, f, from, root),
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

  // Catches: a removal sent while an upload is in flight dropping the upload's entry, or
  // the upload's append resurrecting the removed one (the story's same-pane case).
  it('keeps an upload and honours a removal that commits while it is writing', async () => {
    const runId = await seedRun({ attachments: [existingAtt(1), existingAtt(2)] });
    afterWrite = () => removeStageRunAttachment(db, runId, existingAtt(1).url);

    const result = await upload(runId, 'c.png');

    expect((await storedAttachments(runId)).map((a) => a.url)).toEqual([
      existingAtt(2).url,
      result.url,
    ]);
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

  it.each([
    ['dispatched', 'flow-run-1'],
    ['completed', null],
  ] as const)(
    'refuses the append and keeps status when the run becomes %s while writing to disk',
    async (status, flowRunId) => {
      const runId = await seedRun();
      afterWrite = () => {
        db.update(batchStageRuns)
          .set({ status, flowRunId })
          .where(eq(batchStageRuns.id, runId))
          .run();
      };

      await expect(upload(runId, 'a.png')).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(await getBatchStageRun(db, runId)).toMatchObject({ status, flowRunId });
      expect(await storedAttachments(runId)).toHaveLength(0);
      expect(filesOnDisk(runId)).toHaveLength(0);
    },
  );

  it.each(['queued', 'dispatched', 'completed', 'failed', 'cancelled'] as const)(
    'rejects an upload to a %s run without writing',
    async (status) => {
      const runId = await seedRun();
      db.update(batchStageRuns).set({ status }).where(eq(batchStageRuns.id, runId)).run();

      await expect(upload(runId, 'a.png')).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(existsSync(join(root, runId))).toBe(false);
    },
  );

  it('deletes its file when the append itself throws', async () => {
    const runId = await seedRun();
    afterWrite = () => {
      db.run(sql`DROP TABLE batch_stage_runs`);
    };

    await expect(upload(runId, 'a.png')).rejects.toThrow();
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

describe('uploadAttachmentToStageRun — size limit', () => {
  const bytes = (size: number) => Buffer.alloc(size, 0x5a).toString('base64');

  it('accepts a file of exactly the limit', async () => {
    const runId = await seedRun();

    await upload(runId, 'shot.png', 'image/png', bytes(MAX_IMAGE_BYTES));

    const [stored] = filesOnDisk(runId);
    expect(statSync(join(root, runId, stored)).size).toBe(MAX_IMAGE_BYTES);
    expect(await storedAttachments(runId)).toHaveLength(1);
  });

  it('rejects a file one byte over the limit before writing anything', async () => {
    const runId = await seedRun();

    await expect(
      upload(runId, 'shot.png', 'image/png', bytes(MAX_IMAGE_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    expect(existsSync(join(root, runId))).toBe(false);
    expect(await storedAttachments(runId)).toHaveLength(0);
  });

  // Stray padding makes the pre-write size read 2 bytes small, so an oversized payload
  // reaches disk; the post-decode check has to reject it and remove the written file.
  it('rolls back an oversized file that slipped past the pre-write check', async () => {
    const runId = await seedRun();

    await expect(
      upload(runId, 'shot.png', 'image/png', `${bytes(MAX_IMAGE_BYTES + 1)}==`),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    expect(filesOnDisk(runId)).toHaveLength(0);
    expect(await storedAttachments(runId)).toHaveLength(0);
  });
});

describe('attachFileToStageRun', () => {
  let source: string;
  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), 'frink-attach-source-'));
  });
  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
  });

  const attach = (runId: string, sourcePath: string) =>
    attachFileToStageRun(
      { flowId: 'f', runId, sourcePath },
      {
        db,
        writeAttachment: (r, f, data) => writeAttachment(r, f, data, root),
        copyAttachment: (r, f, from) => copyAttachment(r, f, from, root),
        deleteAttachmentFile: (r, f) => deleteAttachmentFile(r, f, root),
      },
    );

  const sourceFile = (name: string, content: string | Uint8Array) => {
    const path = join(source, name);
    writeFileSync(path, content);
    return path;
  };

  it('copies a CSV into the run and records it as a file the agent reads', async () => {
    const runId = await seedRun();

    const { attachment } = await attach(runId, sourceFile('report.csv', 'a,b\n1,2\n'));

    expect(attachment).toMatchObject({ type: 'file', label: 'report.csv' });
    expect(await storedAttachments(runId)).toEqual([attachment]);
    const [stored] = filesOnDisk(runId);
    expect(readFileSync(join(root, runId, stored), 'utf-8')).toBe('a,b\n1,2\n');
  });

  it('sends a real image inline whatever its name says', async () => {
    const runId = await seedRun();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const { attachment } = await attach(runId, sourceFile('scan.dat', png));

    expect(attachment).toMatchObject({ type: 'image/png', mimeType: 'image/png' });
    // The run-panel preview reads the type from the bytes too, not the `.dat` name.
    expect(await readAttachmentImage(attachment.url, root)).toMatchObject({ mime: 'image/png' });
  });

  // A signature is matched whole: a text file can begin with a few of an image's bytes.
  it('reads a CSV that begins like a WebP header as a file, and a real WebP as an image', async () => {
    const runId = await seedRun();
    const webp = new TextEncoder().encode('RIFF\x24\x00\x00\x00WEBPVP8 ');

    const csv = await attach(runId, sourceFile('rides.csv', 'RIDE_ID,WEBSITE\n1,a\n'));
    const image = await attach(runId, sourceFile('photo.webp', webp));

    expect(csv.attachment.type).toBe('file');
    expect(image.attachment.type).toBe('image/webp');
  });

  it('refuses a file over 20MB before copying anything', async () => {
    const runId = await seedRun();
    const path = sourceFile('huge.csv', '');
    truncateSync(path, PASTED_FILE_MAX_BYTES + 1);

    await expect(attach(runId, path)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(existsSync(join(root, runId))).toBe(false);
  });

  // Over 5MB an image cannot go inline (claim would drop it), so it must be read by path.
  it('hands an image over 5MB to the agent as a file', async () => {
    const runId = await seedRun();
    const png = new Uint8Array(MAX_IMAGE_BYTES + 1);
    png.set([0x89, 0x50, 0x4e, 0x47]);

    const { attachment } = await attach(runId, sourceFile('retina.png', png));

    expect(attachment).toMatchObject({ type: 'file', label: 'retina.png' });
  });

  it('accepts a file of exactly 20MB', async () => {
    const runId = await seedRun();
    const path = sourceFile('edge.csv', '');
    truncateSync(path, PASTED_FILE_MAX_BYTES);

    await expect(attach(runId, path)).resolves.toMatchObject({ attachment: { type: 'file' } });
  });

  it('refuses a folder or a missing file in plain words', async () => {
    const runId = await seedRun();

    await expect(attach(runId, source)).rejects.toThrow("Folders can't be attached.");
    await expect(attach(runId, join(source, 'gone.csv'))).rejects.toThrow(
      "couldn't open this file",
    );
  });

  it('removes a copy that came out over 20MB because the file grew meanwhile', async () => {
    const runId = await seedRun();
    const deleted: string[] = [];

    const growing = attachFileToStageRun(
      { flowId: 'f', runId, sourcePath: sourceFile('log.txt', 'small at first') },
      {
        db,
        writeAttachment,
        copyAttachment: async (_r, filename) => ({
          url: `frink-attachment://${runId}/${filename}`,
          filename,
          byteLength: PASTED_FILE_MAX_BYTES + 1,
          path: join(root, runId, filename),
        }),
        deleteAttachmentFile: async (_r, f) => {
          deleted.push(f);
        },
      },
    );

    await expect(growing).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(deleted).toHaveLength(1);
    expect(await storedAttachments(runId)).toEqual([]);
  });

  it('removes a half-copied file and explains when the copy fails', async () => {
    const runId = await seedRun();
    const path = sourceFile('notes.txt', 'hi');
    const deleted: string[] = [];

    const failing = attachFileToStageRun(
      { flowId: 'f', runId, sourcePath: path },
      {
        db,
        writeAttachment,
        copyAttachment: () => Promise.reject(new Error('ENOSPC: no space left on device')),
        deleteAttachmentFile: async (_r, f) => {
          deleted.push(f);
        },
      },
    );

    await expect(failing).rejects.toThrow("couldn't open this file");
    expect(deleted).toHaveLength(1);
    expect(await storedAttachments(runId)).toEqual([]);
  });

  it('refuses a run that has started before copying anything', async () => {
    const runId = await seedRun();
    db.update(batchStageRuns).set({ status: 'running' }).where(eq(batchStageRuns.id, runId)).run();

    await expect(attach(runId, sourceFile('notes.txt', 'hi'))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(existsSync(join(root, runId))).toBe(false);
  });
});
