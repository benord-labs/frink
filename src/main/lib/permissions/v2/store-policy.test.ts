import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPolicyCache, getPolicyDoc, getPolicyFilePath } from './store-policy';

let tmpDir: string;
let counter = 0;

async function writeTmp(content: string): Promise<string> {
  if (!tmpDir) tmpDir = await mkdtemp(join(tmpdir(), 'frink-policy-'));
  const path = join(tmpDir, `policy-${counter++}.json`);
  await writeFile(path, content, 'utf-8');
  return path;
}

beforeEach(() => {
  __resetPolicyCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPolicyDoc', () => {
  it('returns empty doc when file is absent (ENOENT silent)', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const errSpy = vi.spyOn(log, 'error');
    const doc = await getPolicyDoc('/nonexistent/path/managed-permissions.json');
    expect(doc).toEqual({ allow: [], deny: [], ask: [] });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns empty doc and logs warn on malformed JSON', async () => {
    const tmp = await writeTmp('not json {{{');
    const warnSpy = vi.spyOn(log, 'warn');
    const doc = await getPolicyDoc(tmp);
    expect(doc).toEqual({ allow: [], deny: [], ask: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed JSON'),
      expect.objectContaining({ path: tmp }),
    );
  });

  it('returns empty doc when file lacks permissions key', async () => {
    const tmp = await writeTmp(JSON.stringify({ model: 'sonnet' }));
    expect(await getPolicyDoc(tmp)).toEqual({ allow: [], deny: [], ask: [] });
  });

  it('extracts allow/deny/ask from valid file', async () => {
    const tmp = await writeTmp(
      JSON.stringify({
        permissions: { allow: ['Bash(rm:*)'], deny: ['Bash(rm -rf /:*)'] },
      }),
    );
    const doc = await getPolicyDoc(tmp);
    expect(doc.allow).toEqual(['Bash(rm:*)']);
    expect(doc.deny).toEqual(['Bash(rm -rf /:*)']);
    expect(doc.ask).toEqual([]);
  });

  it('caches across calls (mutating file does not invalidate)', async () => {
    const tmp = await writeTmp(JSON.stringify({ permissions: { allow: ['A'] } }));
    const a = await getPolicyDoc(tmp);
    await writeFile(tmp, JSON.stringify({ permissions: { allow: ['B'] } }), 'utf-8');
    const b = await getPolicyDoc(tmp);
    expect(b).toBe(a);
  });

  it('rebuilds cache when path changes (test override safety)', async () => {
    const t1 = await writeTmp(JSON.stringify({ permissions: { allow: ['A'] } }));
    const t2 = await writeTmp(JSON.stringify({ permissions: { allow: ['B'] } }));
    expect((await getPolicyDoc(t1)).allow).toEqual(['A']);
    expect((await getPolicyDoc(t2)).allow).toEqual(['B']);
  });

  it('rejects non-array allow/deny/ask without throwing', async () => {
    const tmp = await writeTmp(JSON.stringify({ permissions: { allow: 'oops', deny: null } }));
    expect(await getPolicyDoc(tmp)).toEqual({ allow: [], deny: [], ask: [] });
  });

  it('drops non-string entries inside allow/deny/ask arrays', async () => {
    const tmp = await writeTmp(
      JSON.stringify({
        permissions: { allow: ['Bash(npm:*)', { tool: 'Bash' }, 42, null, 'Edit(src/**)'] },
      }),
    );
    const doc = await getPolicyDoc(tmp);
    expect(doc.allow).toEqual(['Bash(npm:*)', 'Edit(src/**)']);
  });

  it('logs error (not warn) on EACCES', async () => {
    if (process.platform === 'win32') return; // chmod is a no-op on Windows
    const tmp = await writeTmp(JSON.stringify({ permissions: { allow: ['A'] } }));
    await chmod(tmp, 0o000);
    const errSpy = vi.spyOn(log, 'error');
    const warnSpy = vi.spyOn(log, 'warn');
    try {
      const doc = await getPolicyDoc(tmp);
      expect(doc).toEqual({ allow: [], deny: [], ask: [] });
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('EACCES'),
        expect.objectContaining({ path: tmp }),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('malformed JSON'),
        expect.anything(),
      );
    } finally {
      await chmod(tmp, 0o644);
    }
  });

  it('concurrent first-reads share a single in-flight Promise', async () => {
    // Reference equality is sufficient proof: two separate loadPolicy() calls
    // each construct distinct PermissionsDoc objects, so a === b only if both
    // callers awaited the same memoised in-flight Promise.
    const tmp = await writeTmp(JSON.stringify({ permissions: { allow: ['A'] } }));
    const [a, b] = await Promise.all([getPolicyDoc(tmp), getPolicyDoc(tmp)]);
    expect(a).toBe(b);
  });

  it('honours FRINK_MANAGED_PERMISSIONS_PATH env override', async () => {
    const tmp = await writeTmp(JSON.stringify({ permissions: { allow: ['from-env'] } }));
    const prev = process.env.FRINK_MANAGED_PERMISSIONS_PATH;
    process.env.FRINK_MANAGED_PERMISSIONS_PATH = tmp;
    try {
      __resetPolicyCache();
      expect(getPolicyFilePath()).toBe(tmp);
      const doc = await getPolicyDoc();
      expect(doc.allow).toEqual(['from-env']);
    } finally {
      if (prev === undefined) delete process.env.FRINK_MANAGED_PERMISSIONS_PATH;
      else process.env.FRINK_MANAGED_PERMISSIONS_PATH = prev;
    }
  });

  it('logs info once on successful policy load', async () => {
    const tmp = await writeTmp(JSON.stringify({ permissions: { allow: ['A', 'B'] } }));
    const infoSpy = vi.spyOn(log, 'info');
    await getPolicyDoc(tmp);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('managed policy loaded'),
      expect.objectContaining({ path: tmp, allow: 2, deny: 0, ask: 0 }),
    );
  });
});
