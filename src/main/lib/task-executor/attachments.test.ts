import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeAttachment } from '../flows/attachments-storage';
import { fetchAttachmentImages } from './attachment-images';

// Minimal mocks so the module can be imported without full Electron env
const electronPaths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getPath: vi.fn(() => electronPaths.userData) },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function pngBuffer(): Uint8Array {
  // 4-byte PNG magic: 0x89 P N G
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

describe('fetchAttachmentImages', () => {
  it('returns empty array for no attachments', async () => {
    const warnings: string[] = [];
    expect(await fetchAttachmentImages(undefined, warnings)).toEqual([]);
    expect(await fetchAttachmentImages([], warnings)).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it('returns empty array for non-array input', async () => {
    const warnings: string[] = [];
    expect(await fetchAttachmentImages('not-array', warnings)).toEqual([]);
    expect(await fetchAttachmentImages(null, warnings)).toEqual([]);
  });

  it('skips malformed items without url', async () => {
    const warnings: string[] = [];
    const result = await fetchAttachmentImages([{ type: 'image' }], warnings);
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(0);
  });
});

// The real storage module writes under app.getPath('userData'), pointed here at a
// throwaway directory of this suite's own so a parallel run cannot collide with it.
describe('fetchAttachmentImages from the local attachment store', () => {
  const runId = 'stage-run';

  beforeAll(async () => {
    electronPaths.userData = await mkdtemp(join(tmpdir(), 'frink-attachments-'));
  });

  afterAll(async () => {
    await rm(electronPaths.userData, { recursive: true, force: true });
  });

  it('returns the bytes of an image stored on the run', async () => {
    const base64 = Buffer.from(pngBuffer()).toString('base64');
    const stored = await writeAttachment(runId, 'diagram.png', base64);

    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: stored.url, type: 'image/png', label: 'Diagram' }],
      warnings,
    );

    expect(warnings).toEqual([]);
    expect(result).toHaveLength(1);
    expect(result[0]?.base64Data).toBe(base64);
    expect(result[0]?.mediaType).toBe('image/png');
    expect(result[0]?.filename).toBe('Diagram');
  });

  it('uses the declared mimeType over the type inferred from the stored file', async () => {
    const stored = await writeAttachment(
      runId,
      'shot.png',
      Buffer.from(pngBuffer()).toString('base64'),
    );

    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: stored.url, type: 'image/webp', mimeType: 'image/webp' }],
      warnings,
    );

    expect(result[0]?.mediaType).toBe('image/webp');
  });

  it('warns when the stored file is gone', async () => {
    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: `frink-attachment://${runId}/deleted.png`, type: 'image/png', label: 'Mockup' }],
      warnings,
    );

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Mockup');
    expect(warnings[0]).toContain('upload it again');
  });

  it('warns for a link instead of loading it over the network', async () => {
    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: 'https://cdn.example.com/img.png', type: 'image', label: 'Spec' }],
      warnings,
    );

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('This is a link');
  });

  it('skips a stored file that is not a supported image type', async () => {
    const stored = await writeAttachment(
      runId,
      'notes.txt',
      Buffer.from('plain text').toString('base64'),
    );

    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: stored.url, type: 'image', label: 'Notes' }],
      warnings,
    );

    expect(result).toEqual([]);
    expect(warnings[0]).toContain('not a supported image type');
  });

  it('skips a stored image over the 5MB limit', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64');
    const stored = await writeAttachment(runId, 'huge.png', oversized);

    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: stored.url, type: 'image/png', label: 'Huge' }],
      warnings,
    );

    expect(result).toEqual([]);
    expect(warnings[0]).toContain('5MB');
  });

  it('returns the readable images and warns for the rest', async () => {
    const base64 = Buffer.from(pngBuffer()).toString('base64');
    const first = await writeAttachment(runId, 'one.png', base64);
    const second = await writeAttachment(runId, 'two.png', base64);

    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [
        { url: first.url, type: 'image/png', label: 'Good 1' },
        { url: `frink-attachment://${runId}/gone.png`, type: 'image/png', label: 'Bad' },
        { url: second.url, type: 'image/png', label: 'Good 2' },
      ],
      warnings,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.filename).toBe('Good 1');
    expect(result[1]?.filename).toBe('Good 2');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Bad');
  });

  it('sends an image whose filename extension is not a known one', async () => {
    const base64 = Buffer.from(pngBuffer()).toString('base64');
    const stored = await writeAttachment(runId, 'photo.jfif', base64);

    const warnings: string[] = [];
    const result = await fetchAttachmentImages(
      [{ url: stored.url, type: 'image/jpeg', label: 'Photo', mimeType: 'image/jpeg' }],
      warnings,
    );

    expect(warnings).toEqual([]);
    expect(result[0]?.base64Data).toBe(base64);
    expect(result[0]?.mediaType).toBe('image/jpeg');
  });
});
