import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from './skill-fs';
import {
  dropFile,
  linkExpectation,
  lstatOrNull,
  replaceFile,
  replaceFolder,
  throughLink,
} from './skill-guarded-write';

describe('guarded writes into a projected copy', () => {
  let base: string;
  let source: string;
  let copy: string;
  const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), 'utf8');
  /** Everything beside the copy: scratch files must never be left behind. */
  const besideCopy = async () => (await fs.readdir(base)).filter((n) => n !== 'src');

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'guarded-write-'));
    source = path.join(base, 'src');
    copy = path.join(base, 'copy');
    await fs.mkdir(source);
    await fs.mkdir(copy);
    await fs.writeFile(path.join(source, 'a.md'), 'new\n');
    await fs.writeFile(path.join(copy, 'a.md'), 'old\n');
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('replaces a file that still matches what was compared', async () => {
    expect(await replaceFile(source, copy, 'a.md', sha256('old\n'), false)).not.toBeNull();
    expect(await read(copy, 'a.md')).toBe('new\n');
    expect(await besideCopy()).toEqual(['copy']);
  });

  it('returns the hash of what it placed, even if the source changed since the comparison', async () => {
    await fs.writeFile(path.join(source, 'a.md'), 'changed again\n');
    expect(await replaceFile(source, copy, 'a.md', sha256('old\n'), false)).toBe(
      sha256('changed again\n'),
    );
  });

  it('puts back a file edited after the comparison and leaves no scratch file', async () => {
    await fs.writeFile(path.join(copy, 'a.md'), 'edited meanwhile\n');
    expect(await replaceFile(source, copy, 'a.md', sha256('old\n'), false)).toBeNull();
    expect(await read(copy, 'a.md')).toBe('edited meanwhile\n');
    expect(await besideCopy()).toEqual(['copy']);
  });

  it('changes nothing when the source copy fails', async () => {
    await fs.rm(path.join(source, 'a.md'));
    await expect(replaceFile(source, copy, 'a.md', sha256('old\n'), false)).rejects.toThrow();
    expect(await read(copy, 'a.md')).toBe('old\n');
  });

  it('keeps a symlink in place when the source copy fails', async () => {
    await fs.rm(path.join(copy, 'a.md'));
    await fs.symlink(path.join(base, 'elsewhere.md'), path.join(copy, 'a.md'));
    await fs.rm(path.join(source, 'a.md'));
    await expect(replaceFile(source, copy, 'a.md', undefined, false)).rejects.toThrow();
    expect((await fs.lstat(path.join(copy, 'a.md'))).isSymbolicLink()).toBe(true);
  });

  it('puts back a file that appeared where nothing was expected', async () => {
    await fs.writeFile(path.join(copy, 'b.md'), 'appeared\n');
    await fs.writeFile(path.join(source, 'b.md'), 'source b\n');
    expect(await replaceFile(source, copy, 'b.md', undefined, false)).toBeNull();
    expect(await read(copy, 'b.md')).toBe('appeared\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps an unreadable file that appeared where nothing was expected',
    async () => {
      await fs.writeFile(path.join(copy, 'b.md'), 'appeared\n');
      await fs.chmod(path.join(copy, 'b.md'), 0o000);
      await fs.writeFile(path.join(source, 'b.md'), 'source b\n');
      expect(await replaceFile(source, copy, 'b.md', undefined, false)).toBeNull();
      await fs.chmod(path.join(copy, 'b.md'), 0o644);
      expect(await read(copy, 'b.md')).toBe('appeared\n');
    },
  );

  it('replaces an empty folder only when it was already there at the comparison', async () => {
    await fs.mkdir(path.join(copy, 'b.md'));
    await fs.writeFile(path.join(source, 'b.md'), 'source b\n');
    expect(await replaceFile(source, copy, 'b.md', undefined, false)).toBeNull();
    expect((await fs.lstat(path.join(copy, 'b.md'))).isDirectory()).toBe(true);
    expect(await replaceFile(source, copy, 'b.md', undefined, true)).not.toBeNull();
    expect(await read(copy, 'b.md')).toBe('source b\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'aborts instead of skipping when an empty folder cannot be removed',
    async () => {
      await fs.mkdir(path.join(copy, 'sub'));
      await fs.mkdir(path.join(copy, 'sub', 'b.md'));
      await fs.mkdir(path.join(source, 'sub'));
      await fs.writeFile(path.join(source, 'sub', 'b.md'), 'source b\n');
      await fs.chmod(path.join(copy, 'sub'), 0o500);
      try {
        await expect(replaceFile(source, copy, 'sub/b.md', undefined, true)).rejects.toThrow();
      } finally {
        await fs.chmod(path.join(copy, 'sub'), 0o755);
      }
      expect((await fs.lstat(path.join(copy, 'sub', 'b.md'))).isDirectory()).toBe(true);
    },
  );

  it('never replaces a folder that has something in it', async () => {
    await fs.mkdir(path.join(copy, 'b.md'));
    await fs.writeFile(path.join(copy, 'b.md', 'mine.md'), 'mine\n');
    await fs.writeFile(path.join(source, 'b.md'), 'source b\n');
    expect(await replaceFile(source, copy, 'b.md', undefined, true)).toBeNull();
    expect(await read(copy, 'b.md/mine.md')).toBe('mine\n');
  });

  it('drops a file that still matches, and the folders it leaves empty', async () => {
    await fs.mkdir(path.join(copy, 'deep', 'er'), { recursive: true });
    await fs.writeFile(path.join(copy, 'deep', 'er', 'x.md'), 'x\n');
    expect(await dropFile(copy, 'deep/er/x.md', sha256('x\n'))).toBe(true);
    expect(existsSync(path.join(copy, 'deep'))).toBe(false);
    expect(await besideCopy()).toEqual(['copy']);
  });

  it('puts back a dropped file edited after the comparison', async () => {
    await fs.writeFile(path.join(copy, 'a.md'), 'edited meanwhile\n');
    expect(await dropFile(copy, 'a.md', sha256('old\n'))).toBe(false);
    expect(await read(copy, 'a.md')).toBe('edited meanwhile\n');
  });

  it('reports a dropped file that vanished as not done, so it is looked at again', async () => {
    await fs.rm(path.join(copy, 'a.md'));
    expect(await dropFile(copy, 'a.md', sha256('old\n'))).toBe(false);
  });

  it('replaces a symlink only while it still holds the recorded link text', async () => {
    await fs.rm(path.join(copy, 'a.md'));
    await fs.symlink('../elsewhere.md', path.join(copy, 'a.md'));
    expect(
      await replaceFile(source, copy, 'a.md', linkExpectation('../other.md'), false),
    ).toBeNull();
    expect(await fs.readlink(path.join(copy, 'a.md'))).toBe('../elsewhere.md');
    expect(
      await replaceFile(source, copy, 'a.md', linkExpectation('../elsewhere.md'), false),
    ).not.toBeNull();
    expect(await read(copy, 'a.md')).toBe('new\n');
    expect((await lstatOrNull(path.join(copy, 'a.md')))?.isFile()).toBe(true);
    expect(await besideCopy()).toEqual(['copy']);
  });

  it('keeps a leftover symlink when the source copy fails', async () => {
    await fs.rm(path.join(copy, 'a.md'));
    await fs.symlink('../elsewhere.md', path.join(copy, 'a.md'));
    await fs.rm(path.join(source, 'a.md'));
    await expect(
      replaceFile(source, copy, 'a.md', linkExpectation('../elsewhere.md'), false),
    ).rejects.toThrow();
    expect(await fs.readlink(path.join(copy, 'a.md'))).toBe('../elsewhere.md');
  });

  it('replaces a folder symlink with a fully staged real folder, or leaves it on failure', async () => {
    await fs.mkdir(path.join(source, 'refs'));
    await fs.writeFile(path.join(source, 'refs', 'x.md'), 'x\n');
    await fs.symlink('../somewhere', path.join(copy, 'refs'), 'dir');
    await fs.chmod(path.join(source, 'refs', 'x.md'), 0o000);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await expect(
        replaceFolder(source, copy, 'refs', linkExpectation('../somewhere')),
      ).rejects.toThrow();
      expect(await fs.readlink(path.join(copy, 'refs'))).toBe('../somewhere');
    }
    await fs.chmod(path.join(source, 'refs', 'x.md'), 0o644);
    expect(
      await replaceFolder(source, copy, 'refs', linkExpectation('../somewhere')),
    ).not.toBeNull();
    expect(await read(copy, 'refs/x.md')).toBe('x\n');
    expect(await besideCopy()).toEqual(['copy']);
  });

  it('never replaces a symlink reached through a symlinked folder', async () => {
    await fs.mkdir(path.join(base, 'outside'));
    await fs.symlink('x', path.join(base, 'outside', 'l.md'));
    await fs.symlink(path.join(base, 'outside'), path.join(copy, 'via'), 'dir');
    await fs.writeFile(path.join(source, 'l.md'), 'src\n');
    expect(await replaceFile(source, copy, 'via/l.md', linkExpectation('x'), false)).toBeNull();
    expect(await fs.readlink(path.join(base, 'outside', 'l.md'))).toBe('x');
    await fs.rm(path.join(copy, 'via'));
    await fs.rm(path.join(base, 'outside'), { recursive: true });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'treats only a missing path as absent, never a path it cannot look at',
    async () => {
      await fs.chmod(copy, 0o600);
      try {
        await expect(lstatOrNull(path.join(copy, 'a.md'))).rejects.toThrow();
        await expect(replaceFile(source, copy, 'a.md', undefined, false)).rejects.toThrow();
      } finally {
        await fs.chmod(copy, 0o755);
      }
      expect(await read(copy, 'a.md')).toBe('old\n');
    },
  );

  it('spots a symlinked folder on the way to a path, but not the path itself', async () => {
    await fs.symlink(path.join(base, 'elsewhere'), path.join(copy, 'linked'), 'dir');
    expect(await throughLink(copy, 'linked/x.md')).toBe(true);
    expect(await throughLink(copy, 'linked')).toBe(false);
    expect(await throughLink(copy, 'a.md')).toBe(false);
  });
});
