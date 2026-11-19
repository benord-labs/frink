import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundledWorker } from '../../file-search/content-search-runner';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

const BASE = {
  limit: 50,
  matchCase: false,
  wholeWord: false,
  useRegex: false,
  searchKey: 'sidebar',
};

async function callerFor(windowId: number) {
  const { filesRouter } = await import('./files');
  return filesRouter.createCaller({ getWindow: () => null, senderWebContentsId: windowId });
}

describe('filesRouter.searchContent through the worker', () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-search-content-'));
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        ssr: join(__dirname, '../../file-search/content-search-worker.ts'),
        rollupOptions: { output: { format: 'cjs' } },
      },
    });
    const [result] = Array.isArray(output) ? output : [output];
    if (!result || !('output' in result)) throw new Error('worker bundle not built');
    // The packaged app reads the electron-vite bundle; this is the same entry, bundled by vite.
    const code = result.output[0].code;
    bundledWorker.read = () => code;
    await writeFile(join(projectPath, 'keep.ts'), 'needle', 'utf8');
    await writeFile(join(projectPath, 'skip.md'), 'needle', 'utf8');
    // `(a+)+$` backtracks for seconds on this line, so a search on it is still running.
    await writeFile(join(projectPath, 'slow.txt'), `${'a'.repeat(32)}b`, 'utf8');
  }, 60_000);

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('runs the bundled worker with the globs compiled in main and reports a bad regex', async () => {
    const caller = await callerFor(1);

    const filtered = await caller.searchContent({
      ...BASE,
      projectPath,
      query: 'needle',
      includeGlobs: '*.ts, *.md',
      excludeGlobs: '*.md',
    });
    const invalid = await caller.searchContent({
      ...BASE,
      projectPath,
      query: '(',
      useRegex: true,
    });

    expect(filtered).toMatchObject({ invalidRegex: false, timedOut: false });
    expect(filtered.matches.map((m) => m.filePath)).toEqual(['keep.ts']);
    expect(invalid).toEqual({ matches: [], invalidRegex: true, timedOut: false });
  });

  it('searches a folder whose path is longer than the key limit, beside another folder in the same box', async () => {
    const caller = await callerFor(1);
    // The key names the box; the folder is not part of what the renderer sends.
    const deep = join(projectPath, 'nested-folder-name-'.repeat(8));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'deep.ts'), 'needle', 'utf8');

    const [inDeep, inRoot] = await Promise.all([
      caller.searchContent({ ...BASE, projectPath: deep, query: 'needle' }),
      caller.searchContent({ ...BASE, projectPath, query: 'needle', includeGlobs: 'keep.ts' }),
    ]);

    expect(deep.length).toBeGreaterThan(100);
    expect(inDeep.matches.map((m) => m.filePath)).toEqual(['deep.ts']);
    expect(inRoot.matches.map((m) => m.filePath)).toEqual(['keep.ts']);
  });

  it('a new search in the same window stops the old one; another window with the same key does not', async () => {
    const windowA = await callerFor(1);
    const windowB = await callerFor(2);
    const slow = windowA.searchContent({
      ...BASE,
      projectPath,
      query: '(a+)+$',
      useRegex: true,
    });
    let slowSettled = false;
    slow.then(
      () => (slowSettled = true),
      () => (slowSettled = true),
    );

    // Every window names its search boxes the same way (`sidebar`, `pane:N`), so keys collide.
    const other = await windowB.searchContent({
      ...BASE,
      projectPath,
      query: 'needle',
    });
    expect(other.matches.length).toBeGreaterThan(0);
    expect(slowSettled).toBe(false);

    const replacement = windowA.searchContent({
      ...BASE,
      projectPath,
      query: 'needle',
    });
    await expect(slow).rejects.toMatchObject({ code: 'CLIENT_CLOSED_REQUEST' });
    await expect(replacement).resolves.toMatchObject({ timedOut: false });
  }, 20_000);
});
